import { describe, it, expect } from 'vitest'
import { nextOccurrence, occurrencesInRange, dueReminders, staleTodos, parseLocal } from '../../src/shared/planmath'
import type { PlanItem } from '../../src/shared/types'

const base = (over: Partial<PlanItem>): PlanItem => ({
  id: 1, kind: 'event', title: 't', body: '', startAt: null, endAt: null, allDay: false,
  recur: 'none', tagId: null, sectionId: null, done: false, doneAt: null,
  remindOffsetMin: null, remindSentAt: null, snoozeUntil: null, pinned: false,
  sortOrder: 0, origin: 'user', archived: false, createdAt: '2026-07-01T00:00', updatedAt: '2026-07-01T00:00',
  ...over,
})
const NOW = parseLocal('2026-07-05T14:00')

describe('nextOccurrence', () => {
  it('none은 startAt 그대로(과거 포함)', () => {
    expect(nextOccurrence({ startAt: '2026-07-01T10:00', recur: 'none' }, NOW)).toBe('2026-07-01T10:00')
  })
  it('daily는 오늘 시각이 지났으면 내일', () => {
    expect(nextOccurrence({ startAt: '2026-07-01T10:00', recur: 'daily' }, NOW)).toBe('2026-07-06T10:00')
    expect(nextOccurrence({ startAt: '2026-07-01T18:00', recur: 'daily' }, NOW)).toBe('2026-07-05T18:00')
  })
  it('weekly:3(수)', () => {
    // 2026-07-05는 일요일 → 다음 수요일 7/8
    expect(nextOccurrence({ startAt: '2026-06-03T09:00', recur: 'weekly:3' }, NOW)).toBe('2026-07-08T09:00')
  })
  it('monthly:31은 말일 클램프(6→30, 2→28)', () => {
    expect(nextOccurrence({ startAt: '2026-01-31T12:00', recur: 'monthly:31' }, parseLocal('2026-06-01T00:00'))).toBe('2026-06-30T12:00')
  })
})

describe('occurrencesInRange', () => {
  it('daily 7일 구간 = 7건', () => {
    expect(occurrencesInRange({ startAt: '2026-07-01T08:00', recur: 'daily' }, '2026-07-05T00:00', '2026-07-12T00:00')).toHaveLength(7)
  })
  it('none은 구간 안일 때만 1건', () => {
    expect(occurrencesInRange({ startAt: '2026-07-06T08:00', recur: 'none' }, '2026-07-05T00:00', '2026-07-12T00:00')).toEqual(['2026-07-06T08:00'])
    expect(occurrencesInRange({ startAt: '2026-08-01T08:00', recur: 'none' }, '2026-07-05T00:00', '2026-07-12T00:00')).toEqual([])
  })
})

describe('dueReminders', () => {
  it('발사창 안(offset 10분 전)이면 발사, 같은 발생 재발사 금지', () => {
    const it1 = base({ startAt: '2026-07-05T14:05', remindOffsetMin: 10 })
    expect(dueReminders([it1], NOW, 10)).toHaveLength(1)
    const sent = base({ startAt: '2026-07-05T14:05', remindOffsetMin: 10, remindSentAt: '2026-07-05T14:05' })
    expect(dueReminders([sent], NOW, 10)).toHaveLength(0)
  })
  it('완료·보관·snooze 중이면 억제', () => {
    expect(dueReminders([base({ startAt: '2026-07-05T14:05', done: true })], NOW, 10)).toHaveLength(0)
    expect(dueReminders([base({ startAt: '2026-07-05T14:05', archived: true })], NOW, 10)).toHaveLength(0)
    expect(dueReminders([base({ startAt: '2026-07-05T14:05', snoozeUntil: '2026-07-05T14:30' })], NOW, 10)).toHaveLength(0)
  })
  it('발생 60분 지나면 창 닫힘', () => {
    expect(dueReminders([base({ startAt: '2026-07-05T12:30' })], NOW, 10)).toHaveLength(0)
  })
  it('offset 미지정은 defaultMin 사용', () => {
    expect(dueReminders([base({ startAt: '2026-07-05T14:08' })], NOW, 10)).toHaveLength(1)
    expect(dueReminders([base({ startAt: '2026-07-05T15:00' })], NOW, 10)).toHaveLength(0)
  })
  it('allDay는 오프셋 무시 — 전날 밤(23:50)엔 발사 안 됨', () => {
    const nightBefore = parseLocal('2026-07-04T23:50')
    const it1 = base({ startAt: '2026-07-05T00:00', allDay: true, remindOffsetMin: 10 })
    expect(dueReminders([it1], nightBefore, 10)).toHaveLength(0)
  })
  it('allDay는 당일 09:00 발사창에서 발사', () => {
    const at9 = parseLocal('2026-07-05T09:00')
    const it1 = base({ startAt: '2026-07-05T00:00', allDay: true, remindOffsetMin: 10 })
    expect(dueReminders([it1], at9, 10)).toHaveLength(1)
  })
})

describe('staleTodos', () => {
  it('기준일 초과 미완료 todo만 — 핀·완료·event 제외', () => {
    const old = { updatedAt: '2026-06-20T00:00' }
    expect(staleTodos([base({ kind: 'todo', ...old })], NOW, 7)).toHaveLength(1)
    expect(staleTodos([base({ kind: 'todo', ...old, pinned: true })], NOW, 7)).toHaveLength(0)
    expect(staleTodos([base({ kind: 'todo', ...old, done: true })], NOW, 7)).toHaveLength(0)
    expect(staleTodos([base({ kind: 'event', startAt: '2026-06-01T00:00', ...old })], NOW, 7)).toHaveLength(0)
    expect(staleTodos([base({ kind: 'todo', updatedAt: '2026-07-03T00:00' })], NOW, 7)).toHaveLength(0)
  })
  it('sqlite 포맷(공백 구분자) 자동 정규화 — 2026-06-20 00:00:00 → stale', () => {
    // updatedAt이 'YYYY-MM-DD HH:MM:SS' sqlite 포맷일 때도 처리
    expect(staleTodos([base({ kind: 'todo', updatedAt: '2026-06-20 00:00:00' })], NOW, 7)).toHaveLength(1)
  })
})
