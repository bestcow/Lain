// C10 — listBenchRuns: bench_runs를 run_id별로 묶어 시간순(오래된 런 먼저) 반환하는지.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-benchruns-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, insertBenchResult, listBenchRuns } from '../../src/main/store'

beforeAll(() => {
  initStore()
})
afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

describe('listBenchRuns — 이력 없음', () => {
  it('bench_runs가 비어 있으면 빈 배열', () => {
    expect(listBenchRuns()).toEqual([])
  })
})

describe('listBenchRuns — run_id별 그룹, 시간순', () => {
  it('여러 런의 결과를 run_id로 분리해 반환한다', () => {
    insertBenchResult('run-a', {
      benchTask: 't1',
      condition: 'no-lessons',
      success: true,
      verifyFirstPass: true,
      turns: 1,
      costUsd: 0.01,
      tokens: 10,
    })
    insertBenchResult('run-a', {
      benchTask: 't2',
      condition: 'with-lessons',
      success: true,
      verifyFirstPass: false,
      turns: 3,
      costUsd: 0.05,
      tokens: 50,
    })
    insertBenchResult('run-b', {
      benchTask: 't1',
      condition: 'no-lessons',
      success: false,
      verifyFirstPass: false,
      turns: 5,
      costUsd: 0.2,
      tokens: 200,
    })

    const runs = listBenchRuns()
    const ids = runs.map((r) => r.runId)
    expect(ids).toEqual(['run-a', 'run-b']) // 삽입 순(=시간순, 오래된 런 먼저)

    const runA = runs.find((r) => r.runId === 'run-a')!
    expect(runA.results).toHaveLength(2)
    expect(runA.results.map((r) => r.condition).sort()).toEqual(['no-lessons', 'with-lessons'])

    const runB = runs.find((r) => r.runId === 'run-b')!
    expect(runB.results).toHaveLength(1)
    expect(runB.results[0].success).toBe(false)
  })
})
