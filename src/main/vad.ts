// VAD 엔드포인팅 — 에너지 기반 발화 감지 + 침묵 타임아웃. 순수 로직(테스트 가능).
export function frameEnergy(frame: Int16Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768
    sum += v * v
  }
  return Math.sqrt(sum / frame.length)
}

export type VadConfig = {
  energyThreshold: number // 발화 판정 RMS 임계
  silenceMs: number       // 이 시간 침묵 지속 시 턴 종료(엔드포인팅)
  minUtteranceMs: number  // 이보다 짧은 발화는 잡음으로 폐기
  frameMs: number         // 프레임 1개의 길이(ms)
}
export type UtteranceEvent =
  | { kind: 'speech-start' }
  | { kind: 'utterance-end'; frames: Int16Array[]; durationMs: number }

/** 48kHz stereo s16le Buffer → 16kHz mono Int16Array (3:1 데시메이션 + 채널 평균). */
export function downsampleTo16kMono(buf: Buffer): Int16Array {
  const stereo = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
  const monoLen = Math.floor(stereo.length / 2 / 3)
  const out = new Int16Array(monoLen)
  for (let i = 0; i < monoLen; i++) {
    const src = i * 3 * 2
    out[i] = (stereo[src] + stereo[src + 1]) / 2
  }
  return out
}

export function createEndpointer(cfg: VadConfig) {
  let speaking = false
  let buf: Int16Array[] = []
  let silenceMs = 0
  return {
    push(frame: Int16Array): UtteranceEvent | null {
      const active = frameEnergy(frame) >= cfg.energyThreshold
      if (active) {
        const started = !speaking
        speaking = true
        silenceMs = 0
        buf.push(frame)
        return started ? { kind: 'speech-start' } : null
      }
      if (!speaking) return null
      // 발화 중 침묵 — 꼬리도 포함해 버퍼링하다 타임아웃이면 종료 판정
      buf.push(frame)
      silenceMs += cfg.frameMs
      if (silenceMs < cfg.silenceMs) return null
      const frames = buf
      const durationMs = frames.length * cfg.frameMs - silenceMs
      speaking = false
      buf = []
      silenceMs = 0
      if (durationMs < cfg.minUtteranceMs) return null // 잡음 폐기
      return { kind: 'utterance-end', frames, durationMs }
    },
    flush(): UtteranceEvent | null {
      if (!speaking || buf.length === 0) return null
      const frames = buf
      const durationMs = frames.length * cfg.frameMs - silenceMs
      speaking = false
      buf = []
      silenceMs = 0
      if (durationMs < cfg.minUtteranceMs) return null
      return { kind: 'utterance-end', frames, durationMs }
    },
  }
}
