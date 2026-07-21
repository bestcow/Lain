import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp로 격리(store.hide.test 패턴).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-regdedup-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, closeStore, listProjects, saveSettings, insertLesson, lessonsForProject } from '../../src/main/store'
import { addProject } from '../../src/main/registry'

let ws: string

beforeAll(() => initStore())
afterAll(() => {
  try {
    closeStore()
  } catch {
    /* 잠금 무시 */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* 무시 */
  }
})

beforeEach(() => {
  // 테스트마다 고유 워크스페이스 루트 — 프로젝트는 고유 물리 경로로 격리(하드삭제 미노출).
  ws = fs.mkdtempSync(path.join(DATA_DIR, 'ws-'))
  saveSettings({ workspaceRoot: ws })
})

describe('registry addProject — 물리 경로 기반 dedup (E6 최종리뷰 Important#2)', () => {
  it('같은 폴더를 두 번 등록해도 프로젝트 행은 1개(멱등)', () => {
    const dir = path.join(ws, 'apps', 'foo')
    fs.mkdirSync(dir, { recursive: true })
    const before = listProjects().length
    addProject(dir)
    addProject(dir)
    const rows = listProjects().filter((p) => p.path === dir)
    expect(rows.length).toBe(1)
    expect(listProjects().length).toBe(before + 1)
  })

  it('루트 변경 후 같은 물리 폴더를 재등록해도 중복 INSERT 없이 기존 id·이력 유지', () => {
    const dir = path.join(ws, 'apps', 'bar')
    fs.mkdirSync(dir, { recursive: true })
    const p1 = addProject(dir)
    // 이 프로젝트에 학습(이력) 하나 심어 둔다
    insertLesson({
      projectId: p1.id,
      taskId: 'task-x',
      scope: 'project',
      trigger: '테스트',
      lesson: '길들인 학습',
    })
    const lessonsBefore = lessonsForProject(p1.id).length
    expect(lessonsBefore).toBeGreaterThan(0)

    // 루트를 이 폴더를 포함하지 않는 다른 경로로 변경 → projectId(상대경로)가 절대경로로 바뀜
    const other = fs.mkdtempSync(path.join(DATA_DIR, 'other-'))
    saveSettings({ workspaceRoot: other })

    // 같은 물리 폴더를 폴더피커로 재등록하는 상황
    const p2 = addProject(dir)

    // path 기반 dedup → 같은 id 재사용, 행 1개, 학습 보존
    expect(p2.id).toBe(p1.id)
    const rows = listProjects().filter((p) => p.path === dir)
    expect(rows.length).toBe(1)
    expect(lessonsForProject(p1.id).length).toBe(lessonsBefore)
  })
})
