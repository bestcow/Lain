import { describe, it, expect, vi } from 'vitest'
vi.mock('../../src/main/store', () => ({ listPlanItems: () => [], getSettings: () => ({}), markPlanReminded: vi.fn() }))
vi.mock('../../src/main/notify', () => ({ notifyUser: vi.fn() }))
import { plannerDigestLine } from '../../src/main/planner'
import { parseLocal } from '../../src/shared/planmath'
import type { PlanItem } from '../../src/shared/types'
const base = (over: Partial<PlanItem>): PlanItem => ({
  id: 1, kind: 'event', title: 't', body: '', startAt: null, endAt: null, allDay: false,
  recur: 'none', tagId: null, sectionId: null, done: false, doneAt: null,
  remindOffsetMin: null, remindSentAt: null, snoozeUntil: null, pinned: false,
  sortOrder: 0, origin: 'user', archived: false, createdAt: '2026-07-01T00:00', updatedAt: '2026-07-01T00:00',
  ...over,
} as PlanItem)
const NOW = parseLocal('2026-07-05T09:00')
it('오늘 일정·방치 요약, 없으면 빈 문자열', () => {
  expect(plannerDigestLine([], NOW, { plannerStaleDays: 7 })).toBe('')
  const line = plannerDigestLine(
    [base({ kind: 'event', title: '미팅', startAt: '2026-07-05T15:00' }),
     base({ kind: 'todo', title: '해커톤', updatedAt: '2026-06-01T00:00' })],
    NOW, { plannerStaleDays: 7 })
  expect(line).toContain('오늘 일정 1건')
  expect(line).toContain('방치 1건')
})
