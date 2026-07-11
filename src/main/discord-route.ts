// src/main/discord-route.ts
// 디스코드 음성 라우팅 — PCM→WAV 래핑, Groq Whisper STT, 매니저 라우팅(origin='discord').
import type { ChatEvent } from '../shared/types'

/** 16bit mono PCM → WAV 컨테이너(Groq Whisper 입력용). 순수. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1, bitsPerSample = 16
  const byteRate = sampleRate * numChannels * bitsPerSample / 8
  const blockAlign = numChannels * bitsPerSample / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)            // PCM
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** PCM → Groq Whisper STT. 빈 결과면 '' 반환. (telegram handleVoice와 동일 엔드포인트) */
export async function transcribePcm(pcm: Buffer, groqKey: string): Promise<string> {
  const wav = pcmToWav(pcm, 16000)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utt.wav')
  form.append('model', 'whisper-large-v3')
  form.append('language', 'ko') // 한국어 고정 — 자동감지 제3언어 오인(예 '바이바이'→일본어) 방지. 코드스위칭 영어는 유지됨.
  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}` },
    body: form,
  })
  if (!resp.ok) throw new Error(`groq-whisper ${resp.status}`)
  const { text } = (await resp.json()) as { text: string }
  const { isLikelyWhisperHallucination } = await import('./stt-filter')
  const clean = (text ?? '').trim()
  return isLikelyWhisperHallucination(clean) ? '' : clean // 무음/잡음 환청 차단
}

export type RouteDeps = {
  conversationId: string
  emit: (ev: ChatEvent) => void
  // 하이브리드 빠른 경로 — 'answered'(즉답·끝) / 'act'(본체 승격) / 'confirm'(파괴적 → 확인 요청).
  voiceQuickReply: (
    text: string, emit: (ev: ChatEvent) => void, conversationId?: string,
  ) => Promise<'answered' | 'act' | 'confirm'>
  requestConfirm: (transcript: string) => void // #5 파괴적 작업 — 실행 전 음성 확인 요청
  sendToManager: (
    text: string, emit: (ev: ChatEvent) => void, isRetry?: boolean,
    attachments?: never[], continueRound?: number, conversationId?: string,
    origin?: 'pc' | 'telegram' | 'discord',
  ) => Promise<void>
}

/** transcript 라우팅(origin='discord'). 하이브리드: 단순 문답은 빠른 경로가 즉답(answered),
 *  파괴적 작업은 확인 요청(confirm), 그 외 실행 요청(act)은 무한세션 본체로 승격. 빈 transcript는 무시. */
export async function routeUtterance(transcript: string, deps: RouteDeps): Promise<void> {
  if (!transcript.trim()) return
  const r = await deps.voiceQuickReply(transcript, deps.emit, deps.conversationId)
  if (r === 'answered') return
  if (r === 'confirm') {
    deps.requestConfirm(transcript)
    return
  }
  await deps.sendToManager(transcript, deps.emit, false, [], 0, deps.conversationId, 'discord')
}
