import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'

// selfimprove.ts는 top-level에서 SDK/store/paths를 import한다 — 순수 게이트(isCorrectionSignal)만
// 시험하려면 이 부수효과 모듈들을 모킹해 SQLite/electron app 로드를 피한다(manager.test.ts와 동형).
vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(process.cwd(), 'data'),
  AGENT_CWD: process.cwd(),
  CLAUDE_BIN: 'claude',
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
vi.mock('../../src/main/store', () => ({
  getSettings: vi.fn(() => ({ signalReview: false, judgeModel: 'sonnet' })),
  insertLesson: vi.fn(),
  listConversationMessages: vi.fn(() => []),
  ensureActiveConversation: vi.fn(() => 'conv-active'),
}))
vi.mock('../../src/main/safety', () => ({
  redactSecrets: (s: string) => s,
  scanLessonInjection: () => ({ blocked: false }),
}))

import { isCorrectionSignal } from '../../src/main/selfimprove'

describe('isCorrectionSignal — 교정/선호 신호 결정론 게이트', () => {
  it.each([
    ['이거 기억해 둬', true],
    ['앞으로는 한국어로만 답해', true],
    ['항상 절대경로를 써', true],
    ['그 파일은 건드리지 마', true],
    ['커밋 메시지는 영어로 쓰지 마', true],
    ['아니 그렇게 말고 다시 해', true],
    ['그게 아니라 npm run build 부터 돌려', true],
    ['파이썬 말고 타입스크립트로 해줘', true],
    ['난 짧은 답변이 더 좋아', true],
    ['remember to run typecheck first', true],
    ['always use absolute paths', true],
    ["don't touch the config", true],
    ['use tabs instead of spaces', true],
  ])('교정/선호 발화 "%s" → true', (text, expected) => {
    expect(isCorrectionSignal(text)).toBe(expected)
  })

  it.each([
    ['지금 작업 상태 알려줘', false],
    ['프로젝트 목록 보여줘', false],
    ['이거 어떻게 하는 거야?', false],
    ['ok', false],
    ['로그 좀 확인해줘', false],
    ['what is the current status', false],
  ])('단순 질문·지시·잡담 "%s" → false', (text, expected) => {
    expect(isCorrectionSignal(text)).toBe(expected)
  })

  it('빈 문자열·공백·1자 미만은 false(보수적 게이트)', () => {
    expect(isCorrectionSignal('')).toBe(false)
    expect(isCorrectionSignal('   ')).toBe(false)
    expect(isCorrectionSignal('a')).toBe(false)
  })
})

describe('reviewManagerTurn — signalReview off면 휴면(회귀 0)', () => {
  it('off면 judge·insertLesson을 부르지 않는다', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const store = await import('../../src/main/store')
    const { reviewManagerTurn } = await import('../../src/main/selfimprove')
    await reviewManagerTurn('conv-1')
    expect(sdk.query).not.toHaveBeenCalled()
    expect(store.insertLesson).not.toHaveBeenCalled()
  })
})
