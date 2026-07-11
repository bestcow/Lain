import { describe, it, expect } from 'vitest'
import { depsMet, wouldCreateDepCycle, selectQueuedToLaunch } from '../../src/main/orchestrator'
import type { TaskState } from '../../src/shared/types'

const stateOf =
  (m: Record<string, TaskState>) =>
  (id: string): TaskState | undefined =>
    m[id]

describe('depsMet — D2 의존 충족 판정 (순수)', () => {
  it('의존 없음 = 충족', () => {
    expect(depsMet([], stateOf({}))).toBe(true)
  })
  it('전부 done이어야 충족 — working·review·queued는 미충족', () => {
    expect(depsMet(['a'], stateOf({ a: 'done' }))).toBe(true)
    expect(depsMet(['a', 'b'], stateOf({ a: 'done', b: 'done' }))).toBe(true)
    for (const s of ['working', 'review', 'queued', 'blocked', 'clarifying', 'error', 'cancelled'] as TaskState[]) {
      expect(depsMet(['a'], stateOf({ a: s }))).toBe(false)
    }
  })
  it('없는 id(하드삭제 없음 전제의 방어)는 충족으로 본다 — 영구 잠금 방지', () => {
    expect(depsMet(['ghost'], stateOf({}))).toBe(true)
  })
})

describe('wouldCreateDepCycle — set_task_deps 사이클 검증 (순수)', () => {
  const depsOf =
    (g: Record<string, string[]>) =>
    (id: string): string[] =>
      g[id] ?? []
  it('직접 사이클 — B가 A에 의존하는데 A의 의존을 B로', () => {
    expect(wouldCreateDepCycle('A', ['B'], depsOf({ B: ['A'] }))).toBe(true)
  })
  it('간접 사이클 — C→B→A 체인에서 A의 의존을 C로', () => {
    expect(wouldCreateDepCycle('A', ['C'], depsOf({ C: ['B'], B: ['A'] }))).toBe(true)
  })
  it('사이클 아님 — 독립 체인', () => {
    expect(wouldCreateDepCycle('A', ['B'], depsOf({ B: ['C'], C: [] }))).toBe(false)
  })
  it('다이아몬드(공유 선행)는 사이클 아님', () => {
    expect(wouldCreateDepCycle('A', ['B', 'C'], depsOf({ B: ['D'], C: ['D'], D: [] }))).toBe(false)
  })
})

describe('의존 게이트 × 큐 선별 통합(드레인 동형 — eligible 필터 후 selectQueuedToLaunch)', () => {
  it('선행 미완 작업은 후보에서 빠지고, 그 뒤 순번이 슬롯을 가져간다', () => {
    const queued = [
      { id: 'q1', projectId: 'p1', dependsOn: ['dep1'] }, // dep1 working — 미충족
      { id: 'q2', projectId: 'p2', dependsOn: [] },
      { id: 'q3', projectId: 'p3', dependsOn: ['dep2'] }, // dep2 done — 충족
    ]
    const st = stateOf({ dep1: 'working', dep2: 'done' })
    const eligible = queued.filter((t) => depsMet(t.dependsOn, st))
    expect(eligible.map((t) => t.id)).toEqual(['q2', 'q3'])
    expect(selectQueuedToLaunch(eligible, 2, new Map())).toEqual(['q2', 'q3'])
  })
})
