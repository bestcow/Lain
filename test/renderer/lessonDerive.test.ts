import { describe, it, expect } from 'vitest'
import { isCleanupCandidate, absorbedOriginals } from '../../src/renderer/lib/lessonDerive'
import type { Lesson } from '../../src/shared/types'

function mkLesson(over: Partial<Lesson>): Lesson {
  return {
    id: 1,
    projectId: 'p',
    taskId: 't',
    scope: 'project',
    trigger: '',
    lesson: 'x',
    reuseCount: 0,
    createdAt: '2026-07-07T10:00:00',
    status: 'active',
    lastUsedAt: null,
    pinned: false,
    origin: 'agent',
    absorbedInto: null,
    consolidationBatch: null,
    injectCount: 0,
    ...over,
  }
}

describe('isCleanupCandidate — 주입>0·인용0 죽은 교훈', () => {
  it('주입됐지만 한 번도 인용 안 됨 → 후보', () => {
    expect(isCleanupCandidate(mkLesson({ injectCount: 5, reuseCount: 0 }))).toBe(true)
  })
  it('인용된 적 있으면 후보 아님', () => {
    expect(isCleanupCandidate(mkLesson({ injectCount: 5, reuseCount: 2 }))).toBe(false)
  })
  it('아직 주입 안 된 새 교훈은 후보 아님', () => {
    expect(isCleanupCandidate(mkLesson({ injectCount: 0, reuseCount: 0 }))).toBe(false)
  })
  it('pinned(불가침)는 후보에서 제외', () => {
    expect(isCleanupCandidate(mkLesson({ injectCount: 5, reuseCount: 0, pinned: true }))).toBe(false)
  })
  it('archived(이미 정리됨)는 후보에서 제외', () => {
    expect(isCleanupCandidate(mkLesson({ injectCount: 5, reuseCount: 0, status: 'archived' }))).toBe(
      false,
    )
  })
})

describe('absorbedOriginals — absorbed_into 역참조 그룹핑', () => {
  const all = [
    mkLesson({ id: 10, absorbedInto: null, taskId: 'curator', lesson: 'umbrella' }),
    mkLesson({ id: 1, absorbedInto: 10, createdAt: '2026-07-05T10:00:00', lesson: 'orig-A' }),
    mkLesson({ id: 2, absorbedInto: 10, createdAt: '2026-07-03T10:00:00', lesson: 'orig-B' }),
    mkLesson({ id: 3, absorbedInto: 99, createdAt: '2026-07-01T10:00:00', lesson: 'other' }),
    mkLesson({ id: 4, absorbedInto: null, lesson: 'unrelated' }),
  ]

  it('해당 umbrella에 흡수된 원본만, createdAt 오름차순(오래된 먼저)', () => {
    const got = absorbedOriginals(all, 10)
    expect(got.map((l) => l.id)).toEqual([2, 1]) // 7/3 먼저, 7/5 다음
  })
  it('다른 umbrella·무관 교훈은 제외', () => {
    const got = absorbedOriginals(all, 10)
    expect(got.some((l) => l.id === 3 || l.id === 4)).toBe(false)
  })
  it('흡수된 원본이 없으면 빈 배열', () => {
    expect(absorbedOriginals(all, 12345)).toEqual([])
  })
})
