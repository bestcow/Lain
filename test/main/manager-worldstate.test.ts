// #13 — 레인 world-state 주입 !resume 게이트 회귀 고정: <world-state>는 새 SDK 세션 첫 턴에만
// 주입한다(navichat handoffInject 동형). resume 턴마다 재주입하면 트랜스크립트에 사본이 턴 수만큼
// 누적된다(비용 중복·압축 가속). 안전성: world_state 갱신은 performCompact뿐이고 압축은 항상 세션을
// 끊으므로 첫 턴 주입만으로 손실 없음 — compact 후·retryFresh 후 자연 재주입도 함께 고정.
// #7 — 레인 턴 result의 소비 토큰이 전역 롤링 사용량(usage.ts recordUsage)에 적재되는지 고정.
// 실 store(임시 DATA_DIR의 격리 DB)로 세션/월드스테이트 상태를 굴리고, query는 전역 SDK 스텁으로 캡처.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'

vi.mock('../../src/main/paths', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const TMP = path.join(os.tmpdir(), 'lain-mgr-worldstate-test')
  fs.rmSync(TMP, { recursive: true, force: true })
  return {
    DATA_DIR: TMP,
    PROJECT_ROOT: process.cwd(),
    AGENT_CWD: process.cwd(),
    BENCH_DIR: path.join(TMP, 'bench'),
    CLAUDE_BIN: 'claude',
    SELF_SRC_DIR: null,
  }
})
// 압축 요약은 LLM 호출 — 결정론 스텁으로 대체(성공 경로).
vi.mock('../../src/main/compact', () => ({
  summarizeWorldState: vi.fn(async () => '압축된-월드-v2'),
}))
// 제목 자동요약도 LLM 경유 — 스텁(쿼리 스크립트 오염 방지).
vi.mock('../../src/main/title', () => ({ summarizeConversationTitle: vi.fn() }))

import { sendToManager } from '../../src/main/manager'
import {
  initStore,
  ensureActiveConversation,
  saveSettings,
  setConversationWorldState,
  setConversationSdkSession,
  setConversationContextTokens,
  conversationSdkSession,
} from '../../src/main/store'
import { resetUsage, recentUsageTokens } from '../../src/main/usage'
import type { ChatEvent } from '../../src/shared/types'

let conv = ''

// 시도(턴)별 스트림 스크립트 — 프롬프트를 캡처하고 result 하나(usage 100tok)를 흘린다.
function stubTurns(...turns: Array<{ throwMsg?: string; sessionId?: string }>): string[] {
  const prompts: string[] = []
  let i = 0
  vi.mocked(query).mockImplementation(((args: any) => {
    const t = turns[Math.min(i, turns.length - 1)]
    i++
    prompts.push(String(args.prompt))
    return (async function* () {
      if (t.throwMsg) throw new Error(t.throwMsg)
      yield {
        type: 'result',
        subtype: 'success',
        session_id: t.sessionId ?? 's1',
        usage: { input_tokens: 70, output_tokens: 30 },
      }
    })()
  }) as any)
  return prompts
}

beforeAll(() => {
  initStore() // 임시 DATA_DIR에 격리 DB 생성(앱에선 index.ts가 부팅 시 호출)
  // 빠른 레인 off(본체 경로 고정) · 압축 임계 50k(월드스테이트 주입 활성) · 워치독 off(타이머 무간섭)
  saveSettings({ managerFastChat: false, contextCompactThreshold: 50_000, turnWatchdogMin: 0 })
  conv = ensureActiveConversation('manager')
})

beforeEach(() => {
  vi.mocked(query).mockReset()
  resetUsage()
})

describe('sendToManager — world-state 첫 턴만 주입(#13) + recordUsage(#7)', () => {
  it('새 SDK 세션 첫 턴: <world-state> 주입 + result 토큰이 롤링 사용량에 적재', async () => {
    setConversationWorldState(conv, '월드-W1')
    setConversationSdkSession(conv, '') // 새 세션
    const prompts = stubTurns({ sessionId: 's1' })
    await sendToManager('턴1', () => {}, false, [], 0, conv)
    expect(prompts[0]).toContain('<world-state>')
    expect(prompts[0]).toContain('월드-W1')
    expect(recentUsageTokens()).toBe(100) // input 70 + output 30
  })

  it('resume 턴: <world-state> 미주입(사본 누적 방지) — 사용량은 계속 적재', async () => {
    expect(conversationSdkSession(conv)).toBe('s1') // 직전 턴 result가 세션을 저장했다
    const prompts = stubTurns({ sessionId: 's1' })
    await sendToManager('턴2', () => {}, false, [], 0, conv)
    expect(prompts[0]).not.toContain('<world-state>')
    expect(prompts[0]).not.toContain('월드-W1')
    expect(recentUsageTokens()).toBe(100) // 이번 턴 몫만(beforeEach에서 리셋)
  })

  it('압축(performCompact) 후: 세션이 끊기고 새 world-state가 다시 주입된다', async () => {
    setConversationContextTokens(conv, 60_000) // 임계(50k) 초과 → 턴 진입 시 자동 압축
    const prompts = stubTurns({ sessionId: 's3' })
    const events: ChatEvent[] = []
    await sendToManager('턴3', (e) => events.push(e), false, [], 0, conv)
    expect(events.some((e) => e.kind === 'tool' && /압축/.test(e.text))).toBe(true)
    expect(prompts[0]).toContain('<world-state>')
    expect(prompts[0]).toContain('압축된-월드-v2') // summarizeWorldState 스텁 산출물
  })

  it('retryFresh(세션 소실) 재시도 턴: 세션이 비워져 world-state가 자연 재주입된다', async () => {
    expect(conversationSdkSession(conv)).toBe('s3')
    const prompts = stubTurns(
      { throwMsg: 'No conversation found with session ID: s3' },
      { sessionId: 's4' },
    )
    await sendToManager('턴4', () => {}, false, [], 0, conv)
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toContain('<world-state>') // resume 턴 — 미주입
    expect(prompts[1]).toContain('<world-state>') // 세션 폐기 후 재시도 — 재주입
    expect(prompts[1]).toContain('압축된-월드-v2')
  })
})
