// C10 — bench_runs 그룹 집계(aggregate) 순수 함수 테스트. DB 없이 BenchTaskResult 배열만으로 검증.
import { describe, it, expect } from 'vitest'
import { aggregate } from '../../src/main/bench'
import type { BenchTaskResult } from '../../src/shared/types'

function r(partial: Partial<BenchTaskResult>): BenchTaskResult {
  return {
    benchTask: 't1',
    condition: 'no-lessons',
    success: true,
    verifyFirstPass: true,
    turns: 1,
    costUsd: 0,
    tokens: 0,
    ...partial,
  }
}

describe('aggregate — bench_runs 그룹 요약 집계(C10)', () => {
  it('조건별 n·성공률·1회통과율·평균 턴/비용/토큰을 계산한다', () => {
    const results: BenchTaskResult[] = [
      r({ condition: 'no-lessons', success: true, verifyFirstPass: true, turns: 2, costUsd: 0.1, tokens: 100 }),
      r({ condition: 'no-lessons', success: false, verifyFirstPass: false, turns: 4, costUsd: 0.3, tokens: 300 }),
    ]
    const summary = aggregate('run-1', results, '2026-07-01T00:00:00Z')
    expect(summary.runId).toBe('run-1')
    expect(summary.byCondition['no-lessons']).toEqual({
      n: 2,
      successRate: 0.5,
      firstPassRate: 0.5,
      avgTurns: 3,
      avgCost: 0.2,
      avgTokens: 200,
    })
  })

  it('결과가 없는 조건은 byCondition에서 빠진다', () => {
    const summary = aggregate('run-2', [r({ condition: 'with-lessons' })], '2026-07-01T00:00:00Z')
    expect(summary.byCondition['no-lessons']).toBeUndefined()
    expect(summary.byCondition['with-lessons']).toBeDefined()
  })

  it('빈 결과면 byCondition이 비고 regression은 null', () => {
    const summary = aggregate('run-3', [], '2026-07-01T00:00:00Z')
    expect(summary.byCondition).toEqual({})
    expect(summary.regression).toBeNull()
  })

  it('교훈 ON이 성공률을 악화시키면 회귀 경보를 만든다', () => {
    const results: BenchTaskResult[] = [
      r({ condition: 'no-lessons', success: true, verifyFirstPass: true, turns: 2, costUsd: 0.1 }),
      r({ condition: 'with-lessons', success: false, verifyFirstPass: false, turns: 2, costUsd: 0.1 }),
    ]
    const summary = aggregate('run-4', results, '2026-07-01T00:00:00Z')
    expect(summary.regression).toMatch(/성공률 하락/)
  })

  it('둘 다 있고 회귀 없으면 regression은 null', () => {
    const results: BenchTaskResult[] = [
      r({ condition: 'no-lessons', success: true, verifyFirstPass: true, turns: 2, costUsd: 0.1 }),
      r({ condition: 'with-lessons', success: true, verifyFirstPass: true, turns: 2, costUsd: 0.1 }),
    ]
    const summary = aggregate('run-5', results, '2026-07-01T00:00:00Z')
    expect(summary.regression).toBeNull()
  })
})
