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

import {
  initStore,
  insertTask,
  updateTask,
  addTaskEvent,
  upsertProject,
  loopStats,
  promotionStats,
} from '../../src/main/store'
import {
  formatLoopStatsLine,
  isoWeekOf,
  promotionAdvice,
  PROMOTE_STREAK,
  DEMOTE_REWORK,
  DEMOTE_AUDIT,
  type PromotionStats,
} from '../../src/shared/loopstats'

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

// A3(확신도 축) — 프로젝트 단위 실적 조회: loopStats projectId 스코프(WHERE project_id).
describe('loopStats projectId 스코프', () => {
  const mkProject = (id: string): void =>
    upsertProject({ id, path: `C:/tmp/${id}`, name: id, stack: '', verifyCmd: null, isGit: false } as any)

  it('projectId를 주면 해당 프로젝트 작업만 집계한다(실패 사유 포함)', () => {
    mkProject('px')
    mkProject('py')
    insertTask({ id: 'px-1', projectId: 'px', title: 'a', state: 'done', content: 'a' }) // 1회 통과
    insertTask({ id: 'px-2', projectId: 'px', title: 'b', state: 'done', content: 'b' }) // 재작업 후 완료
    updateTask('px-2', { reworkCount: 1 })
    insertTask({ id: 'px-3', projectId: 'px', title: 'c', state: 'error', content: 'c' })
    addTaskEvent('px-3', 'exit', 'pxfail: 상세', 'worker')
    insertTask({ id: 'py-1', projectId: 'py', title: 'd', state: 'done', content: 'd' }) // 1회 통과
    insertTask({ id: 'py-2', projectId: 'py', title: 'e', state: 'error', content: 'e' })
    addTaskEvent('py-2', 'exit', 'pyfail: 상세', 'worker')

    const sx = loopStats(7, 'px')
    expect(sx.total).toBe(3)
    expect(sx.done).toBe(2)
    expect(sx.firstPass).toBe(1)
    expect(sx.reworked).toBe(1)
    expect(sx.error).toBe(1)
    expect(sx.topFailReasons.some(([k]) => k === 'pxfail')).toBe(true)
    expect(sx.topFailReasons.some(([k]) => k === 'pyfail')).toBe(false) // 타 프로젝트 사유 미혼입

    const sy = loopStats(7, 'py')
    expect(sy.total).toBe(2)
    expect(sy.firstPass).toBe(1)
  })

  it('projectId 생략(전역)은 기존 동작 그대로 — 모든 프로젝트를 합산한다', () => {
    const g = loopStats(7)
    const sx = loopStats(7, 'px')
    const sy = loopStats(7, 'py')
    expect(g.total).toBeGreaterThanOrEqual(sx.total + sy.total)
    expect(g.topFailReasons.length).toBeGreaterThanOrEqual(1)
  })
})

// A3 — promotionStats: 승격/강등 제안의 입력 집계(스트릭·최근 rework/심사 미통과·spec-gaming 유무).
describe('promotionStats', () => {
  const mkProject = (id: string): void =>
    upsertProject({ id, path: `C:/tmp/${id}`, name: id, stack: '', verifyCmd: null, isGit: false } as any)

  it('연속 무수정 통과 스트릭 — 최신부터 세고 재작업 done에서 끊긴다', () => {
    mkProject('ps1')
    insertTask({ id: 'ps1-1', projectId: 'ps1', title: 'a', state: 'done', content: 'a' }) // (오래됨) 통과
    insertTask({ id: 'ps1-2', projectId: 'ps1', title: 'b', state: 'done', content: 'b' }) // 재작업 — 여기서 끊김
    updateTask('ps1-2', { reworkCount: 1 })
    insertTask({ id: 'ps1-3', projectId: 'ps1', title: 'c', state: 'done', content: 'c' })
    insertTask({ id: 'ps1-4', projectId: 'ps1', title: 'd', state: 'done', content: 'd' })
    insertTask({ id: 'ps1-5', projectId: 'ps1', title: 'e', state: 'done', content: 'e' })

    const s = promotionStats('ps1')
    expect(s.projectId).toBe('ps1')
    expect(s.consecutiveFirstPass).toBe(3)
    expect(s.recentReworked).toBe(1)
    expect(s.specGamingBlocked).toBe(false)
  })

  it('cancelled는 중립 — 스트릭을 끊지도 늘리지도 않는다', () => {
    mkProject('ps2')
    insertTask({ id: 'ps2-1', projectId: 'ps2', title: 'a', state: 'done', content: 'a' })
    insertTask({ id: 'ps2-2', projectId: 'ps2', title: 'b', state: 'cancelled', content: 'b' })
    insertTask({ id: 'ps2-3', projectId: 'ps2', title: 'c', state: 'done', content: 'c' })
    expect(promotionStats('ps2').consecutiveFirstPass).toBe(2)
  })

  it('error가 최신이면 스트릭 0', () => {
    mkProject('ps3')
    insertTask({ id: 'ps3-1', projectId: 'ps3', title: 'a', state: 'done', content: 'a' })
    insertTask({ id: 'ps3-2', projectId: 'ps3', title: 'b', state: 'error', content: 'b' })
    expect(promotionStats('ps3').consecutiveFirstPass).toBe(0)
  })

  it('심사 미통과 자동 재작업(auditRetried)·spec-gaming status 이벤트를 집계한다', () => {
    mkProject('ps4')
    insertTask({ id: 'ps4-1', projectId: 'ps4', title: 'a', state: 'done', content: 'a' })
    updateTask('ps4-1', { auditRetried: true })
    insertTask({ id: 'ps4-2', projectId: 'ps4', title: 'b', state: 'blocked', content: 'b' })
    addTaskEvent('ps4-2', 'status', 'spec-gaming 차단: 테스트 파일 수정 거부 (t.test.ts)')

    const s = promotionStats('ps4')
    expect(s.recentAuditRetried).toBe(1)
    expect(s.specGamingBlocked).toBe(true)
    expect(s.consecutiveFirstPass).toBe(0) // auditRetried done은 무수정 통과가 아님
  })
})

// A3 — promotionAdvice 순수함수 경계: 승격 스트릭·강등 트리거·null 케이스. 자동 적용 없음(텍스트 제안만).
describe('promotionAdvice', () => {
  const ps = (over: Partial<PromotionStats>): PromotionStats => ({
    projectId: 'p1',
    days: 7,
    consecutiveFirstPass: 0,
    recentReworked: 0,
    recentAuditRetried: 0,
    specGamingBlocked: false,
    ...over,
  })

  it(`연속 무수정 통과 ${PROMOTE_STREAK}건 이상 → 승격 제안`, () => {
    const a = promotionAdvice(ps({ consecutiveFirstPass: PROMOTE_STREAK }))
    expect(a).toContain('승격')
    expect(a).toContain('p1')
  })

  it(`연속 ${PROMOTE_STREAK - 1}건(임계 미만)·사고 없음 → null`, () => {
    expect(promotionAdvice(ps({ consecutiveFirstPass: PROMOTE_STREAK - 1 }))).toBeNull()
  })

  it('spec-gaming 차단 발생 → 강등 제안(승격 스트릭이 있어도 강등이 우선)', () => {
    const a = promotionAdvice(ps({ consecutiveFirstPass: PROMOTE_STREAK, specGamingBlocked: true }))
    expect(a).toContain('강등')
    expect(a).not.toContain('승격')
  })

  it(`재작업 ${DEMOTE_REWORK}건 이상 → 강등 제안, ${DEMOTE_REWORK - 1}건이면 null`, () => {
    expect(promotionAdvice(ps({ recentReworked: DEMOTE_REWORK }))).toContain('강등')
    expect(promotionAdvice(ps({ recentReworked: DEMOTE_REWORK - 1 }))).toBeNull()
  })

  it(`심사 미통과 ${DEMOTE_AUDIT}건 이상 → 강등 제안`, () => {
    expect(promotionAdvice(ps({ recentAuditRetried: DEMOTE_AUDIT }))).toContain('강등')
  })
})
