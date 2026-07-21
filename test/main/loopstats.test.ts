import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-loopstats-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, insertTask, updateTask, addTaskEvent, upsertProject, loopStats } from '../../src/main/store'
import { formatLoopStatsLine, isoWeekOf } from '../../src/shared/loopstats'

beforeAll(() => {
  initStore()
  upsertProject({
    id: 'demo',
    path: 'C:/tmp/demo',
    name: 'demo',
    stack: '',
    verifyCmd: null,
    isGit: false,
  } as any)
})
afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

// L6(P6) — 루프 성적표: store 집계(done·1회통과·재작업·실패 사유) + shared 포맷 순수함수.
describe('loopStats', () => {
  it('done·1회통과·재작업·실패사유를 집계한다', () => {
    insertTask({ id: 'ls-a', projectId: 'demo', title: 'a', state: 'done', content: 'a' }) // 1회 통과
    insertTask({ id: 'ls-b', projectId: 'demo', title: 'b', state: 'done', content: 'b' }) // 재작업 후 완료
    updateTask('ls-b', { reworkCount: 1 })
    insertTask({ id: 'ls-c', projectId: 'demo', title: 'c', state: 'error', content: 'c' })
    addTaskEvent('ls-c', 'exit', 'error', 'worker')

    const s = loopStats(7)
    expect(s.total).toBeGreaterThanOrEqual(3)
    expect(s.done).toBeGreaterThanOrEqual(2)
    expect(s.firstPass).toBeGreaterThanOrEqual(1)
    expect(s.reworked).toBeGreaterThanOrEqual(1)
    expect(s.error).toBeGreaterThanOrEqual(1)
    expect(s.topFailReasons.some(([k]) => k === 'error')).toBe(true)
  })

  it('콜론 뒤 detail이 달라도 콜론 앞 reason으로 합산 그룹핑한다', () => {
    insertTask({ id: 'ls-d', projectId: 'demo', title: 'd', state: 'error', content: 'd' })
    addTaskEvent('ls-d', 'exit', 'error: ENOENT xyz', 'worker')
    insertTask({ id: 'ls-e', projectId: 'demo', title: 'e', state: 'error', content: 'e' })
    addTaskEvent('ls-e', 'exit', 'error: 다른 상세', 'worker')

    const s = loopStats(7)
    const found = s.topFailReasons.find(([k]) => k === 'error')
    expect(found).toBeDefined()
    expect((found as [string, number])[1]).toBeGreaterThanOrEqual(2)
  })

  it('everAutoRetried=true면 auto_retry_count가 0이어도 firstPass에서 제외된다', () => {
    const base = loopStats(7)

    // 크래시 후 자동재개를 겪었지만 review 도달 시 autoRetryCount는 0으로 리셋된 done 작업
    // (기존 상태머신 리셋 동작 보존 — everAutoRetried만 영속돼 firstPass 오집계를 막아야 한다).
    insertTask({ id: 'ls-f', projectId: 'demo', title: 'f', state: 'done', content: 'f' })
    updateTask('ls-f', { autoRetryCount: 0, everAutoRetried: true })
    const afterF = loopStats(7)
    expect(afterF.done).toBe(base.done + 1)
    expect(afterF.firstPass).toBe(base.firstPass) // ls-f는 firstPass로 늘면 안 됨(오집계 검증)

    // 자동재개 없이 done된 작업은 정상적으로 firstPass에 잡혀야 한다(대조군).
    insertTask({ id: 'ls-g', projectId: 'demo', title: 'g', state: 'done', content: 'g' })
    const afterG = loopStats(7)
    expect(afterG.firstPass).toBe(afterF.firstPass + 1)
  })

  it('auditRetried=true면 독립 심사 미통과로 자동 재작업했으므로 firstPass에서 제외된다', () => {
    const base = loopStats(7)

    // 독립 심사(T14) 미통과로 1회 자동 재작업을 거쳐 done된 작업 — everAutoRetried·reworkCount는
    // 0이라 기존 조건만으로는 "1회 통과"로 오집계됐다(이번 수정 대상).
    insertTask({ id: 'ls-h', projectId: 'demo', title: 'h', state: 'done', content: 'h' })
    updateTask('ls-h', { auditRetried: true })
    const afterH = loopStats(7)
    expect(afterH.done).toBe(base.done + 1)
    expect(afterH.firstPass).toBe(base.firstPass) // ls-h는 firstPass로 늘면 안 됨(오집계 검증)
  })

  it('한 줄 포맷', () => {
    const line = formatLoopStatsLine({
      days: 7,
      total: 12,
      done: 9,
      error: 2,
      cancelled: 1,
      firstPass: 7,
      reworked: 2,
      topFailReasons: [['verify', 2]],
    })
    expect(line).toContain('12')
    expect(line).toMatch(/통과|완료/)
  })

  it('total 0이면 빈 문자열', () => {
    expect(
      formatLoopStatsLine({
        days: 7,
        total: 0,
        done: 0,
        error: 0,
        cancelled: 0,
        firstPass: 0,
        reworked: 0,
        topFailReasons: [],
      }),
    ).toBe('')
  })
})

describe('isoWeekOf', () => {
  it('연초 경계 — 2023-01-01(일요일)은 전년도 마지막 주(2022-W52)로 귀속', () => {
    expect(isoWeekOf(new Date(Date.UTC(2023, 0, 1)))).toBe('2022-W52')
  })
})
