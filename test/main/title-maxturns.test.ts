// test/main/title-maxturns.test.ts
// 외부 IO/SDK 행·복구 버그 사냥 — title.ts는 두 가지 함정을 가진다.
// (1) maxTurns:1 + 누적 텍스트가 try 블록 안에 스코프돼 있어, SDK가 error_max_turns로 스트림을
//     throw하면(실측, handoff.ts/briefing.ts 주석에 기록된 동일 SDK 동작) 이미 받은 제목 텍스트가
//     setAutoTitle 호출 자체와 함께 통째로 버려진다(SDK maxTurns 함정).
// (2) query() 호출에 타임아웃이 없어 SDK가 응답을 영원히 안 주면(네트워크 정체 등) 제목 생성이
//     fire-and-forget으로 영원히 안 끝난다(좀비 Promise).
// 실제 SDK/네트워크는 전혀 쓰지 않고, 전역 SDK 모킹(test/mocks/sdk.ts, vitest.config.ts alias)의
// query()를 이 파일에서 직접 제어한다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'

vi.mock('../../src/main/agentopts', () => ({ judgeQueryOptions: () => ({}) }))
const needsAutoTitleMock = vi.fn(() => true)
const setAutoTitleMock = vi.fn(() => true)
vi.mock('../../src/main/store', () => ({
  needsAutoTitle: (...args: unknown[]) => needsAutoTitleMock(...args),
  setAutoTitle: (...args: unknown[]) => setAutoTitleMock(...args),
}))
vi.mock('../../src/main/paths', () => ({ AGENT_CWD: '.', CLAUDE_BIN: 'claude' }))

import { summarizeConversationTitle } from '../../src/main/title'

function assistantMsg(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } }
}

beforeEach(() => {
  needsAutoTitleMock.mockReturnValue(true)
  setAutoTitleMock.mockClear()
  setAutoTitleMock.mockReturnValue(true)
  vi.mocked(query).mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('summarizeConversationTitle — maxTurns 산출물 유실 방지', () => {
  it('스트림 도중 error_max_turns류로 throw돼도 이미 받은 텍스트로 제목을 반영한다', async () => {
    vi.mocked(query).mockImplementation((() => {
      return (async function* () {
        yield assistantMsg('요약된 제목')
        // SDK가 maxTurns 도달 시 던지는 것으로 실측된 동작 — 스트림 도중 throw.
        throw new Error('error_max_turns')
      })()
    }) as any)

    await summarizeConversationTitle('conv1', '첫 메시지', 'manager')

    // 버그 상태(구 코드)에서는 throw가 setAutoTitle 호출 자체를 건너뛰어 전혀 호출되지 않는다.
    expect(setAutoTitleMock).toHaveBeenCalledTimes(1)
    expect(setAutoTitleMock).toHaveBeenCalledWith('conv1', '요약된 제목')
  })

  it('maxTurns를 1이 아닌 여유값으로 호출한다(도구 없는 호출도 1은 텍스트 유실 실측)', async () => {
    let capturedMaxTurns: number | undefined
    vi.mocked(query).mockImplementation(((args: any) => {
      capturedMaxTurns = args?.options?.maxTurns
      return (async function* () {
        yield assistantMsg('제목')
      })()
    }) as any)

    await summarizeConversationTitle('conv2', '첫 메시지', 'manager')
    expect(capturedMaxTurns).toBeGreaterThanOrEqual(2)
  })
})

describe('summarizeConversationTitle — SDK 무응답(행) 타임아웃', () => {
  it('60초 내 응답이 없으면 abort되어 함수가 끝난다(무한 대기하지 않는다)', async () => {
    vi.mocked(query).mockImplementation(((args: any) => {
      const signal: AbortSignal | undefined = args?.options?.abortController?.signal
      return (async function* () {
        // 실제 SDK는 abortController.signal이 abort되면 스트림 반복을 중단/거부한다 — 그 계약을
        // 그대로 흉내 낸다. title.ts가 abortController를 실제로 넘기지 않으면 이 signal은 항상
        // undefined라 아래 Promise가 절대 안 풀려 테스트가 타임아웃으로 실패한다(재현 지점).
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
        yield assistantMsg('절대 안 나옴')
      })()
    }) as any)

    vi.useFakeTimers()
    let settled = false
    const p = summarizeConversationTitle('conv3', '첫 메시지', 'manager').then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false) // 아직 타임아웃 전

    await vi.advanceTimersByTimeAsync(60_000)
    await p
    expect(settled).toBe(true)
    // 텍스트를 하나도 못 받았으니 빈 문자열로 넘어간다(실제 setAutoTitle이 빈 문자열은 스킵하는 건
    // store.ts 쪽 책임 — 여기선 title.ts가 무한 대기 없이 끝까지 진행됐는지만 본다).
    expect(setAutoTitleMock).toHaveBeenCalledWith('conv3', '')
  })
})
