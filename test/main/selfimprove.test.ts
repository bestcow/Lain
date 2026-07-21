import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import type { ChatMessage } from '../../src/shared/types'

// selfimprove.ts는 top-level에서 SDK/store/paths를 import한다 — 순수 게이트(isCorrectionSignal·
// shouldSkipTurnReview)만 시험하려면 이 부수효과 모듈들을 모킹해 SQLite/electron app 로드를 피한다.
vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(process.cwd(), 'data'),
  AGENT_CWD: process.cwd(),
  CLAUDE_BIN: 'claude',
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
vi.mock('../../src/main/store', () => ({
  getSettings: vi.fn(() => ({ turnReviewEnabled: false, judgeModel: 'sonnet' })),
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
  insertLesson: vi.fn(),
  listConversationDialogue: vi.fn(() => []),
  listAgentSkills: vi.fn(() => []),
  listTasks: vi.fn(() => []),
  lessonsForProject: vi.fn(() => []),
  ensureActiveConversation: vi.fn(() => 'conv-active'),
}))
vi.mock('../../src/main/safety', () => ({
  redactSecrets: (s: string) => s,
  scanLessonInjection: () => ({ blocked: false }),
}))

import { isCorrectionSignal, shouldSkipTurnReview, parseTurnReview } from '../../src/main/selfimprove'

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

// 다이제스트용 최소 메시지 팩토리 — id·role·content만 의미 있음.
const msg = (id: number, role: 'user' | 'assistant', content: string): ChatMessage => ({
  id,
  scope: 'manager',
  role,
  content,
  createdAt: '2026-07-02 00:00:00',
})

describe('shouldSkipTurnReview — 결정론 스킵 게이트(순수)', () => {
  const longDialogue = [
    msg(1, 'user', '현황 알려줘'),
    msg(2, 'assistant', '현황입니다'),
    msg(3, 'user', '작업 시작해'),
    msg(4, 'assistant', '시작했습니다'),
    msg(5, 'user', '결과는?'),
    msg(6, 'assistant', '완료됐습니다'),
  ]

  it('원문 6턴 이상 + 새 메시지 + 마지막 assistant → 리뷰 실행', () => {
    expect(shouldSkipTurnReview(longDialogue, 0).skip).toBe(false)
  })

  it('빈 대화는 스킵', () => {
    expect(shouldSkipTurnReview([], 0)).toEqual({ skip: true, reason: 'empty' })
  })

  it('직전 리뷰 후 무변화(워터마크 이후 새 원문 없음)면 스킵', () => {
    expect(shouldSkipTurnReview(longDialogue, 6)).toEqual({ skip: true, reason: 'unchanged' })
    expect(shouldSkipTurnReview(longDialogue, 99)).toEqual({ skip: true, reason: 'unchanged' })
  })

  it('도구만 쓴 중간 턴(마지막이 assistant 아님)이면 스킵', () => {
    const d = [...longDialogue, msg(7, 'user', '다음 지시')]
    expect(shouldSkipTurnReview(d, 0)).toEqual({ skip: true, reason: 'tool-only' })
  })

  it('젊은 대화(6턴 미만)는 스킵하되, 교정 신호가 있으면 통과', () => {
    const young = [msg(1, 'user', '현황 알려줘'), msg(2, 'assistant', '현황입니다')]
    expect(shouldSkipTurnReview(young, 0)).toEqual({ skip: true, reason: 'young' })
    const corrected = [msg(1, 'user', '아니 그렇게 말고 다시 해'), msg(2, 'assistant', '수정했습니다')]
    expect(shouldSkipTurnReview(corrected, 0).skip).toBe(false)
  })
})

describe('parseTurnReview — judge 출력 파싱(순수)', () => {
  it('학습+스킬 후보를 파싱한다', () => {
    const raw = `설명 텍스트\n\`\`\`json
{"lessons": [{"scope": "global", "trigger": "커밋", "lesson": "커밋 메시지는 한국어로"}],
 "skill_suggestion": {"name": "lain-deploy", "reason": "배포 절차 반복됨"}}
\`\`\``
    const p = parseTurnReview(raw)!
    expect(p.lessons).toEqual([{ scope: 'global', trigger: '커밋', lesson: '커밋 메시지는 한국어로' }])
    expect(p.suggestion).toEqual({ name: 'lain-deploy', reason: '배포 절차 반복됨' })
  })

  it('json 블록 없음/깨진 json → null', () => {
    expect(parseTurnReview('그냥 텍스트')).toBeNull()
    expect(parseTurnReview('```json\n{broken\n```')).toBeNull()
  })

  it('학습은 최대 2건으로 캡, 빈 lesson은 걸러짐', () => {
    const raw = `\`\`\`json
{"lessons": [{"lesson": "a"}, {"lesson": ""}, {"lesson": "b"}, {"lesson": "c"}], "skill_suggestion": null}
\`\`\``
    const p = parseTurnReview(raw)!
    expect(p.lessons.map((l) => l.lesson)).toEqual(['a', 'b'])
    expect(p.suggestion).toBeNull()
  })

  it('스킬 이름은 ascii kebab만 — 위반이면 제안 무시', () => {
    const raw = `\`\`\`json
{"lessons": [], "skill_suggestion": {"name": "한글이름", "reason": "x"}}
\`\`\``
    expect(parseTurnReview(raw)!.suggestion).toBeNull()
  })

  it('scope는 project 외엔 전부 global로 정규화', () => {
    const raw = `\`\`\`json
{"lessons": [{"scope": "weird", "lesson": "x"}, {"scope": "project", "lesson": "y"}]}
\`\`\``
    const p = parseTurnReview(raw)!
    expect(p.lessons[0].scope).toBe('global')
    expect(p.lessons[1].scope).toBe('project')
  })
})

describe('reviewManagerTurn — turnReviewEnabled off면 휴면(회귀 0)', () => {
  it('off면 judge·insertLesson을 부르지 않는다', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const store = await import('../../src/main/store')
    const { reviewManagerTurn } = await import('../../src/main/selfimprove')
    await reviewManagerTurn('conv-1')
    expect(sdk.query).not.toHaveBeenCalled()
    expect(store.insertLesson).not.toHaveBeenCalled()
  })
})
