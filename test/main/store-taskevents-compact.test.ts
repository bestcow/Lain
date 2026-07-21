// 클론 관점 감사(요청 2번) — task_events는 무한 append-only라 오래 운영할수록 무한 성장한다(정리/상한 부재).
// deleteProject를 거치지 않는 한(프로젝트 자체를 지우지 않는 한) 완료된 작업의 이벤트가 영원히 남는다.
// compactTaskEvents가 '완료 후 오래된' 작업만, '최근 N개'만 남기고 정리하는지 검증한다 — 진행 중 작업·
// 최근 완료 작업은 절대 건드리지 않는다(진실원천이 아닌 UI 트랜스크립트 캐시이므로 손실 허용 가능한 정리).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-taskevents-')) }
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
  closeStore,
  insertTask,
  upsertProject,
  addTaskEvent,
  listTaskEvents,
  compactTaskEvents,
} from '../../src/main/store'

const dbPath = path.join(DATA_DIR, 'lain.sqlite')

afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* 파일 잠금 — 무시 */
  }
})

beforeAll(() => {
  initStore()
  upsertProject({ id: 'p1', path: 'C:/x', name: 'x', stack: null, verifyCmd: null, isGit: false } as any)

  // 1) 오래전에 완료된 작업 — 이벤트가 30개, 정리 대상이어야 한다.
  insertTask({ id: 'old-done', projectId: 'p1', title: 'old', state: 'done', content: 'c' })
  for (let i = 0; i < 30; i++) addTaskEvent('old-done', 'log', `event-${i}`)

  // 2) 방금 완료된 작업 — retention 기간 안이라 정리 대상이 아니어야 한다.
  insertTask({ id: 'recent-done', projectId: 'p1', title: 'recent', state: 'done', content: 'c' })
  for (let i = 0; i < 30; i++) addTaskEvent('recent-done', 'log', `event-${i}`)

  // 3) 여전히 진행 중인 작업(오래됐어도 활성이면 손대지 않아야 한다).
  insertTask({ id: 'old-active', projectId: 'p1', title: 'active', state: 'working', content: 'c' })
  for (let i = 0; i < 30; i++) addTaskEvent('old-active', 'log', `event-${i}`)

  closeStore()
  // old-done/old-active의 updated_at을 40일 전으로 되돌린다 — API로는 과거 시각을 못 만든다(항상 now()).
  const raw = new DatabaseSync(dbPath)
  try {
    raw
      .prepare("UPDATE tasks SET updated_at = datetime('now', '-40 days') WHERE id IN ('old-done', 'old-active')")
      .run()
  } finally {
    raw.close()
  }
  initStore()
})

describe('compactTaskEvents — 완료 후 오래된 작업의 task_events만 최근 N개로 정리', () => {
  it('완료 후 retention 기간이 지난 작업만 정리 대상 — keepPerTask개만 남긴다', () => {
    const deleted = compactTaskEvents(30, 10) // retentionDays=30, keepPerTask=10
    expect(deleted).toBeGreaterThan(0)
    const remaining = listTaskEvents('old-done', 100)
    expect(remaining).toHaveLength(10)
    // 남는 건 최신 10개(오래된 순 정렬이므로 event-20..29)
    expect(remaining.map((e) => e.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `event-${20 + i}`),
    )
  })

  it('retention 기간 안의 완료 작업(recent-done)은 그대로 보존된다', () => {
    expect(listTaskEvents('recent-done', 100)).toHaveLength(30)
  })

  it('아직 진행 중인 작업(old-active)은 오래됐어도 정리하지 않는다', () => {
    expect(listTaskEvents('old-active', 100)).toHaveLength(30)
  })

  it('멱등 — 이미 정리된 상태에서 재호출하면 더 지울 게 없다', () => {
    const deleted = compactTaskEvents(30, 10)
    expect(deleted).toBe(0)
  })
})
