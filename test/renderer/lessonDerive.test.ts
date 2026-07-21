import { describe, it, expect } from 'vitest'
import { isCleanupCandidate } from '../../src/renderer/lib/lessonDerive'
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

describe('isCleanupCandidate — 주입>0·인용0 죽은 학습', () => {
  it('주입됐지만 한 번도 인용 안 됨 → 후보', () => {
    expect(isCleanupCandidate(mkLesson({ injectCount: 5, reuseCount: 0 }))).toBe(true)
  })
  it('인용된 적 있으면 후보 아님', () => {
    expect(isCleanupCandidate(mkLesson({ injectCount: 5, reuseCount: 2 }))).toBe(false)
  })
  it('아직 주입 안 된 새 학습은 후보 아님', () => {
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
