// test/main/discord-route.test.ts
import { describe, it, expect } from 'vitest'
import { pcmToWav, routeUtterance } from '../../src/main/discord-route'

describe('pcmToWav — WAV 헤더 래핑', () => {
  it('RIFF/WAVE 헤더와 올바른 길이', () => {
    const pcm = Buffer.alloc(3200) // 0.1s @16kHz mono 16bit
    const wav = pcmToWav(pcm, 16000)
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.subarray(8, 12).toString()).toBe('WAVE')
    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.readUInt32LE(24)).toBe(16000) // sample rate
  })
})

describe('routeUtterance — 하이브리드 라우팅', () => {
  const deps = (over: any = {}) =>
    ({
      conversationId: 'c1',
      emit: () => {},
      voiceQuickReply: async () => 'act', // 기본: 승격
      requestConfirm: () => {},
      sendToManager: async () => {},
      ...over,
    }) as any

  it('빈 transcript는 빠른 경로도 본체도 호출하지 않는다', async () => {
    let vq = false, sm = false
    await routeUtterance('   ', deps({
      voiceQuickReply: async () => { vq = true; return 'act' },
      sendToManager: async () => { sm = true },
    }))
    expect(vq).toBe(false)
    expect(sm).toBe(false)
  })

  it("빠른 경로가 답하면(answered) 본체로 승격하지 않는다", async () => {
    let sm = false
    await routeUtterance('현황 보고해', deps({
      voiceQuickReply: async () => 'answered',
      sendToManager: async () => { sm = true },
    }))
    expect(sm).toBe(false)
  })

  it("실행 요청(act)이면 origin=discord로 본체에 승격한다", async () => {
    const calls: any[] = []
    await routeUtterance('블로그에 메시지 보내', deps({
      voiceQuickReply: async () => 'act',
      sendToManager: async (...args: any[]) => { calls.push(args) },
    }))
    expect(calls[0][0]).toBe('블로그에 메시지 보내')
    expect(calls[0][6]).toBe('discord') // origin 위치
  })

  it("파괴적 작업(confirm)이면 본체 대신 확인을 요청한다", async () => {
    let confirmed: string | null = null, sm = false
    await routeUtterance('블로그 배포해', deps({
      voiceQuickReply: async () => 'confirm',
      requestConfirm: (t: string) => { confirmed = t },
      sendToManager: async () => { sm = true },
    }))
    expect(confirmed).toBe('블로그 배포해')
    expect(sm).toBe(false)
  })
})
