import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'에서 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 고정(격리).
// vi.mock 팩토리는 파일 최상단으로 호이스트되므로, tmp dir 생성도 vi.hoisted로 함께 끌어올린다.
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-selfimprove-')) }
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
  computeNextRun,
  insertRoutine,
  listRoutines,
  listDueRoutines,
  setRoutineEnabled,
  deleteRoutine,
  markRoutineRan,
  insertLesson,
  lessonsForProject,
  bumpLessonInject,
  bumpLessonReuse,
  applyConsolidation,
  revertConsolidationBatch,
  listLessons,
  lastChatActivityAt,
  addMessage,
} from '../../src/main/store'

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

describe('computeNextRun (순수 결정론 스케줄)', () => {
  it('interval:<분> — from + N분', () => {
    const r = computeNextRun('interval:30', '2026-06-20T10:00:00.000Z')
    expect(r).toBe('2026-06-20T10:30:00.000Z')
  })

  it('interval — 0/음수/비수치는 null(비스케줄, 안전)', () => {
    expect(computeNextRun('interval:0', '2026-06-20T10:00:00.000Z')).toBeNull()
    expect(computeNextRun('interval:-5', '2026-06-20T10:00:00.000Z')).toBeNull()
    expect(computeNextRun('interval:abc', '2026-06-20T10:00:00.000Z')).toBeNull()
  })

  it('daily:HH:MM — 같은 날 그 시각이 미래면 오늘, 과거면 내일', () => {
    // 09:00 UTC 기준, 목표 12:00 → 같은 날
    expect(computeNextRun('daily:12:00', '2026-06-20T09:00:00.000Z')).toBe(
      '2026-06-20T12:00:00.000Z',
    )
    // 14:00 UTC 기준, 목표 12:00(과거) → 다음 날
    expect(computeNextRun('daily:12:00', '2026-06-20T14:00:00.000Z')).toBe(
      '2026-06-21T12:00:00.000Z',
    )
  })

  it('daily — 정확히 같은 시각이면 다음 날(<=면 미룬다)', () => {
    expect(computeNextRun('daily:12:00', '2026-06-20T12:00:00.000Z')).toBe(
      '2026-06-21T12:00:00.000Z',
    )
  })

  it('hourly:MM — 이번 시각 분이 미래면 이번 시간, 과거면 다음 시간', () => {
    expect(computeNextRun('hourly:30', '2026-06-20T10:00:00.000Z')).toBe(
      '2026-06-20T10:30:00.000Z',
    )
    expect(computeNextRun('hourly:15', '2026-06-20T10:30:00.000Z')).toBe(
      '2026-06-20T11:15:00.000Z',
    )
  })

  it('weekly:<0-6>:HH:MM — 해당 요일 그 시각, 지났으면 다음 주', () => {
    // 2026-06-20는 토요일(getUTCDay=6). 목표 일요일(0) 09:00 → 다음 날(6/21)
    expect(computeNextRun('weekly:0:09:00', '2026-06-20T10:00:00.000Z')).toBe(
      '2026-06-21T09:00:00.000Z',
    )
    // 같은 요일(6) 미래 시각(12:00) → 오늘
    expect(computeNextRun('weekly:6:12:00', '2026-06-20T10:00:00.000Z')).toBe(
      '2026-06-20T12:00:00.000Z',
    )
    // 같은 요일(6) 과거 시각(08:00) → 다음 주
    expect(computeNextRun('weekly:6:08:00', '2026-06-20T10:00:00.000Z')).toBe(
      '2026-06-27T08:00:00.000Z',
    )
  })

  it('미지원/형식 오류 cron은 null (throw 금지)', () => {
    expect(computeNextRun('cron 0 9 * * *', '2026-06-20T10:00:00.000Z')).toBeNull()
    expect(computeNextRun('daily:99:99', '2026-06-20T10:00:00.000Z')).toBeNull()
    expect(computeNextRun('weekly:9:09:00', '2026-06-20T10:00:00.000Z')).toBeNull()
    expect(computeNextRun('hourly:99', '2026-06-20T10:00:00.000Z')).toBeNull()
    expect(computeNextRun('', '2026-06-20T10:00:00.000Z')).toBeNull()
    expect(computeNextRun('interval:5', 'not-a-date')).toBeNull()
  })
})

describe('routines CRUD + 스케줄', () => {
  it('insertRoutine — next_run_at을 computeNextRun으로 채우고 enabled 기본 1', () => {
    const id = insertRoutine({ title: 'r1', prompt: '점검해', cron: 'interval:60' })
    const r = listRoutines().find((x) => x.id === id)!
    expect(r).toBeTruthy()
    expect(r.enabled).toBe(true)
    expect(r.nextRunAt).not.toBeNull()
    expect(r.projectId).toBeNull()
  })

  it('listDueRoutines — next_run_at <= now 인 enabled 루틴만', () => {
    const id = insertRoutine({ title: 'due', prompt: 'go', cron: 'interval:60' })
    // 충분히 미래의 now → due
    const future = new Date(Date.now() + 3600_000 * 2).toISOString()
    expect(listDueRoutines(future).some((r) => r.id === id)).toBe(true)
    // 과거의 now → not due
    const past = new Date(Date.now() - 3600_000).toISOString()
    expect(listDueRoutines(past).some((r) => r.id === id)).toBe(false)
  })

  it('disabled 루틴은 due에서 제외', () => {
    const id = insertRoutine({ title: 'off', prompt: 'go', cron: 'interval:1' })
    setRoutineEnabled(id, false)
    const future = new Date(Date.now() + 3600_000).toISOString()
    expect(listDueRoutines(future).some((r) => r.id === id)).toBe(false)
    expect(listRoutines().find((r) => r.id === id)!.enabled).toBe(false)
  })

  it('setRoutineEnabled(true) — next_run_at이 과거면 재계산해 즉시 폭주 방지', () => {
    const id = insertRoutine({ title: 'requeue', prompt: 'go', cron: 'interval:60' })
    setRoutineEnabled(id, false)
    setRoutineEnabled(id, true)
    const r = listRoutines().find((x) => x.id === id)!
    expect(r.enabled).toBe(true)
    // 재계산된 next_run_at은 미래여야 한다(과거 즉시 실행 방지)
    expect(new Date(r.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
  })

  it('markRoutineRan — last_run_at 기록 + next_run_at 전진(중복 실행 차단)', () => {
    const id = insertRoutine({ title: 'ran', prompt: 'go', cron: 'interval:30' })
    const before = listRoutines().find((x) => x.id === id)!.nextRunAt!
    const now = new Date(Date.now() + 60_000).toISOString()
    markRoutineRan(id, now)
    const after = listRoutines().find((x) => x.id === id)!
    expect(after.lastRunAt).toBe(now)
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('deleteRoutine — 목록에서 사라짐', () => {
    const id = insertRoutine({ title: 'del', prompt: 'go', cron: 'interval:60' })
    deleteRoutine(id)
    expect(listRoutines().some((r) => r.id === id)).toBe(false)
  })
})

describe('학습 inject vs reuse 적합도 랭킹 (lessonsForProject)', () => {
  it('여러 번 주입됐으나 한 번도 적용(reuse) 안 된 학습은 동률에서 강등된다', () => {
    const pid = 'proj-fitness'
    // 두 학습: 같은 키워드 매칭·같은 reuse 0. A는 주입 3회(미적용→fitness 0), B는 주입 0회(중립 1.0).
    const a = insertLesson({
      projectId: pid,
      taskId: 't1',
      scope: 'project',
      trigger: 'build',
      lesson: 'alpha build hint widget',
    })
    const b = insertLesson({
      projectId: pid,
      taskId: 't2',
      scope: 'project',
      trigger: 'build',
      lesson: 'beta build hint widget',
    })
    bumpLessonInject([a, a, a]) // A: inject_count=3, reuse_count=0 → fitness 0
    // B: inject_count=0 → fitness 1.0(중립)
    const ranked = lessonsForProject(pid, 8, 'build widget')
    const ia = ranked.findIndex((l) => l.id === a)
    const ib = ranked.findIndex((l) => l.id === b)
    expect(ia).toBeGreaterThanOrEqual(0)
    expect(ib).toBeGreaterThanOrEqual(0)
    // B(중립)가 A(강등)보다 앞
    expect(ib).toBeLessThan(ia)
  })

  it('주입은 last_used_at을 갱신한다 — 적용 중 학습은 보존(자동 만료 폐지)', () => {
    const id = insertLesson({
      projectId: 'proj-lastused',
      taskId: 't1',
      scope: 'project',
      trigger: 'x',
      lesson: 'lastused probe',
    })
    expect(listLessons().find((l) => l.id === id)!.lastUsedAt).toBeNull() // 생성 직후 미사용
    bumpLessonInject([id])
    expect(listLessons().find((l) => l.id === id)!.lastUsedAt).not.toBeNull() // 주입=사용 → 갱신
  })

  it('reuse_count가 높으면 fitness보다 우선(reuse가 상위 정렬 신호)', () => {
    const pid = 'proj-reuse'
    const a = insertLesson({
      projectId: pid,
      taskId: 't1',
      scope: 'project',
      trigger: 'deploy',
      lesson: 'alpha deploy step',
    })
    const b = insertLesson({
      projectId: pid,
      taskId: 't2',
      scope: 'project',
      trigger: 'deploy',
      lesson: 'beta deploy step',
    })
    bumpLessonInject([a, a])
    bumpLessonReuse([a]) // A: reuse 1 > B reuse 0
    const ranked = lessonsForProject(pid, 8, 'deploy step')
    expect(ranked.findIndex((l) => l.id === a)).toBeLessThan(
      ranked.findIndex((l) => l.id === b),
    )
  })
})

describe('consolidation 계보 + revert (applyConsolidation / revertConsolidationBatch)', () => {
  it('applyConsolidation 후 revert로 원본 active 복구·umbrella archive', () => {
    const pid = 'proj-consol'
    const l1 = insertLesson({
      projectId: pid,
      taskId: 'c1',
      scope: 'project',
      trigger: 'x',
      lesson: 'consol original one',
    })
    const l2 = insertLesson({
      projectId: pid,
      taskId: 'c2',
      scope: 'project',
      trigger: 'x',
      lesson: 'consol original two',
    })
    const archived = applyConsolidation([l1, l2], {
      projectId: pid,
      scope: 'project',
      trigger: 'x',
      lesson: 'umbrella merged',
    })
    expect(archived).toBe(2)
    // 원본은 archived + absorbed_into·consolidation_batch 채워짐
    const all = listLessons({ status: 'all', limit: 500 })
    const o1 = all.find((l) => l.id === l1)!
    const o2 = all.find((l) => l.id === l2)!
    expect(o1.status).toBe('archived')
    expect(o2.status).toBe('archived')
    expect(o1.absorbedInto).not.toBeNull()
    expect(o1.consolidationBatch).not.toBeNull()
    expect(o1.consolidationBatch).toBe(o2.consolidationBatch)
    // umbrella는 같은 batch + task_id='curator' + active
    const umbrella = all.find(
      (l) => l.consolidationBatch === o1.consolidationBatch && l.taskId === 'curator',
    )!
    expect(umbrella).toBeTruthy()
    expect(umbrella.id).toBe(o1.absorbedInto)
    expect(umbrella.status).toBe('active')

    // revert — 원본 2건 복구, umbrella archive
    const restored = revertConsolidationBatch(o1.consolidationBatch!)
    expect(restored).toBe(2)
    const all2 = listLessons({ status: 'all', limit: 500 })
    expect(all2.find((l) => l.id === l1)!.status).toBe('active')
    expect(all2.find((l) => l.id === l1)!.absorbedInto).toBeNull()
    expect(all2.find((l) => l.id === l2)!.status).toBe('active')
    expect(all2.find((l) => l.id === umbrella.id)!.status).toBe('archived')
  })

  it('없는 batch revert → 0(무해)', () => {
    expect(revertConsolidationBatch('no-such-batch')).toBe(0)
  })

  it('insertLesson — rowid 반환(연속 증가)', () => {
    const a = insertLesson({
      projectId: 'p',
      taskId: 't',
      scope: 'project',
      trigger: '',
      lesson: 'rowid a',
    })
    const b = insertLesson({
      projectId: 'p',
      taskId: 't',
      scope: 'project',
      trigger: '',
      lesson: 'rowid b',
    })
    expect(typeof a).toBe('number')
    expect(b).toBeGreaterThan(a)
  })
})

describe('lastChatActivityAt (idle 가드 기준, 순수 SQL)', () => {
  it('메시지 추가 후 MAX(created_at)을 반환', () => {
    addMessage('manager', 'user', 'hello idle test')
    const t = lastChatActivityAt()
    expect(t).not.toBeNull()
    // datetime 문자열(YYYY-MM-DD HH:MM:SS) 또는 ISO 형식
    expect(String(t).length).toBeGreaterThanOrEqual(10)
  })
})
