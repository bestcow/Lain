// test/main/briefing-timeout.test.ts
// 외부 IO/SDK 행 버그 사냥 — generateBriefing()의 judge query()에 타임아웃이 없으면, SDK가 응답을
// 영원히 안 줄 때(네트워크 정체 등) 브리핑 생성이 영원히 안 끝난다. scheduler.briefNow()는
// fire-and-forget(setTimeout(() => void briefNow(), 2500))이라 앱이 멈추진 않지만, 좀비 Promise가
// 남고 브리핑도 영영 안 나온다 — 그 자체가 관찰 가능한 행 버그다. 실제 SDK/DB는 전혀 안 쓴다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

vi.mock('../../src/main/agentopts', () => ({ judgeQueryOptions: () => ({}) }))
vi.mock('../../src/main/paths', () => ({
  AGENT_CWD: '.',
  CLAUDE_BIN: 'claude',
  DATA_DIR: path.join(os.tmpdir(), 'lain-briefing-timeout-test'),
}))
vi.mock('../../src/main/store', () => ({
  getSettings: () => ({ userTitle: '유저' }),
  listProjects: () => [],
  listTasks: () => [],
  listApprovals: () => [],
  getActiveConversation: () => null,
  listConversationDialogue: () => [],
  getConversationWorldState: () => '',
  // L6 — briefing.ts status 배열이 loopStats(7)을 호출하므로 목에도 있어야 한다(집계 없음 = total 0).
  loopStats: () => ({
    days: 7,
    total: 0,
    done: 0,
    error: 0,
    cancelled: 0,
    firstPass: 0,
    reworked: 0,
    topFailReasons: [],
  }),
}))

import { generateBriefing } from '../../src/main/briefing'

beforeEach(() => {
  vi.mocked(query).mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('generateBriefing — SDK 무응답(행) 타임아웃', () => {
  it('60초 내 응답이 없으면 abort되어 null을 반환한다(무한 대기하지 않는다)', async () => {
    vi.mocked(query).mockImplementation(((args: any) => {
      const signal: AbortSignal | undefined = args?.options?.abortController?.signal
      return (async function* () {
        // title-maxturns.test.ts와 동일한 계약 — abortController가 실제로 전달되지 않으면 이 Promise가
        // 절대 안 풀려 테스트가 5초 기본 타임아웃으로 실패한다(재현 지점).
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '절대 안 나옴' }] } }
      })()
    }) as any)

    vi.useFakeTimers()
    let settled = false
    let result: string | null = 'unset'
    const p = generateBriefing().then((r) => {
      settled = true
      result = r
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false) // 아직 타임아웃 전 — pending 유지돼야 함

    await vi.advanceTimersByTimeAsync(60_000)
    await p
    expect(settled).toBe(true)
    expect(result).toBeNull() // 텍스트를 못 받았으니 결정론 요약만(null) 반환
  })
})
