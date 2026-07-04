// test/main/vad.test.ts
import { describe, it, expect } from 'vitest'
import { frameEnergy, createEndpointer, downsampleTo16kMono } from '../../src/main/vad'

describe('downsampleTo16kMono — 48k stereo → 16k mono', () => {
  it('샘플 수가 1/6로 줄어든다', () => {
    const buf = Buffer.alloc(36 * 2) // 36 stereo s16 samples
    const out = downsampleTo16kMono(buf)
    expect(out.length).toBe(Math.floor(36 / 2 / 3))
  })
  it('좌우 채널을 평균한다', () => {
    const stereo = new Int16Array(12) // 6 frames L/R
    for (let i = 0; i < 6; i++) { stereo[i * 2] = 1000; stereo[i * 2 + 1] = 3000 }
    const out = downsampleTo16kMono(Buffer.from(stereo.buffer))
    expect(out[0]).toBe(2000) // (1000+3000)/2
  })
})

describe('frameEnergy — RMS 에너지', () => {
  it('무음 프레임은 0에 가깝다', () => {
    const silent = new Int16Array(480) // 0으로 채워짐
    expect(frameEnergy(silent)).toBeLessThan(0.01)
  })
  it('최대 진폭 프레임은 1에 가깝다', () => {
    const loud = new Int16Array(480).fill(32767)
    expect(frameEnergy(loud)).toBeGreaterThan(0.9)
  })
})

describe('createEndpointer — 발화 구간 분할', () => {
  const cfg = { energyThreshold: 0.1, silenceMs: 800, minUtteranceMs: 300, frameMs: 20 }
  const loud = () => new Int16Array(320).fill(10000)   // 에너지≈0.3 > 0.1
  const quiet = () => new Int16Array(320)               // 에너지 0

  it('발화 시작 시 speech-start 이벤트', () => {
    const ep = createEndpointer(cfg)
    expect(ep.push(loud())).toEqual({ kind: 'speech-start' })
  })

  it('충분한 발화 후 침묵 800ms면 utterance-end', () => {
    const ep = createEndpointer(cfg)
    for (let i = 0; i < 20; i++) ep.push(loud())  // 400ms 발화 (>300 최소)
    let end = null
    for (let i = 0; i < 40; i++) { const e = ep.push(quiet()); if (e) end = e } // 800ms 침묵
    expect(end?.kind).toBe('utterance-end')
    expect((end as any).durationMs).toBeGreaterThanOrEqual(300)
  })

  it('너무 짧은 발화(잡음)는 utterance-end를 내지 않는다', () => {
    const ep = createEndpointer(cfg)
    for (let i = 0; i < 5; i++) ep.push(loud())   // 100ms < 300 최소
    let end = null
    for (let i = 0; i < 40; i++) { const e = ep.push(quiet()); if (e?.kind === 'utterance-end') end = e }
    expect(end).toBeNull()
  })

  describe('flush() — 호출 종료 시 미처리 발화 회수', () => {
    it('발화 중(침묵 타임아웃 전) flush()는 utterance-end를 반환한다', () => {
      const ep = createEndpointer(cfg)
      // 20프레임 × 20ms = 400ms 발화 (> minUtteranceMs 300)
      for (let i = 0; i < 20; i++) ep.push(loud())
      const result = ep.flush()
      expect(result?.kind).toBe('utterance-end')
      // durationMs = 20 * 20 - 0(silenceMs=0) = 400
      expect((result as any).durationMs).toBe(400)
    })

    it('발화 없이 flush()하면 null을 반환한다', () => {
      const ep = createEndpointer(cfg)
      expect(ep.flush()).toBeNull()
    })

    it('utterance-end 이후 flush()는 null을 반환한다', () => {
      const ep = createEndpointer(cfg)
      for (let i = 0; i < 20; i++) ep.push(loud())
      for (let i = 0; i < 40; i++) ep.push(quiet()) // 800ms 침묵 → 엔드포인팅
      expect(ep.flush()).toBeNull()
    })

    it('minUtteranceMs 미만 발화를 flush()하면 null을 반환한다(잡음 게이트 적용)', () => {
      const ep = createEndpointer(cfg)
      // 5프레임 × 20ms = 100ms < minUtteranceMs 300
      for (let i = 0; i < 5; i++) ep.push(loud())
      expect(ep.flush()).toBeNull()
    })
  })
})
