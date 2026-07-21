// 클론 관점 감사(요청 1번) — rowToTask가 JSON 컬럼(questions/skills/images/todos/depends_on)을
// 가드 없이 JSON.parse해서, DB에 손상된 JSON 문자열이 하나라도 있으면 getTask/listTasks 전체가
// throw했다(부팅·조회 전체 장애). 손상 행을 실제로 주입해 재현하고, 개별 필드는 안전 기본값으로
// 복구하되 나머지 정상 행·정상 필드는 그대로 살아남는지 검증한다.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-corrupttask-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, closeStore, insertTask, getTask, listTasks, upsertProject } from '../../src/main/store'

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
  insertTask({ id: 'good-1', projectId: 'p1', title: '정상 작업', state: 'ready', content: 'c' })
  insertTask({ id: 'bad-1', projectId: 'p1', title: '손상 작업', state: 'ready', content: 'c' })
  insertTask({ id: 'good-2', projectId: 'p1', title: '정상 작업2', state: 'done', content: 'c' })
  closeStore() // 체크포인트 후 닫아야 아래 raw 연결이 최신 상태를 보고, 재오픈도 깨끗하게 된다.

  // API를 거치지 않고 DB에 직접 손상된 JSON 문자열을 주입 — insertTask/updateTask는 항상
  // JSON.stringify를 거치므로 API로는 재현 불가능한, 실제 디스크 손상·수동 편집 시나리오를 흉내낸다.
  const raw = new DatabaseSync(dbPath)
  try {
    raw
      .prepare('UPDATE tasks SET questions = ?, skills = ?, images = ?, todos = ?, depends_on = ? WHERE id = ?')
      .run('{not json', '[[[', 'null,', '{"x":', '["a"', 'bad-1')
  } finally {
    raw.close()
  }

  initStore() // 재오픈 — 손상 행이 있는 상태로 부팅/조회를 실측한다.
})

describe('rowToTask — 손상 JSON 컬럼 방어(개별 필드 안전 기본값, 전체 실패 금지)', () => {
  it('listTasks()가 throw하지 않고 손상 행을 포함한 전체 행을 반환한다', () => {
    const tasks = listTasks()
    expect(tasks.map((t) => t.id).sort()).toEqual(['bad-1', 'good-1', 'good-2'])
  })

  it('정상 행(good-1, good-2)의 JSON 필드는 그대로 파싱된다(회귀 방지)', () => {
    const t = getTask('good-1')
    expect(t?.questions).toEqual([])
    expect(t?.images).toEqual([])
    expect(t?.dependsOn).toEqual([])
    expect(t?.todos).toBeNull()
    expect(t?.skills).toBeNull()
  })

  it('손상 행(bad-1)은 throw 없이 안전 기본값으로 복구되고, 손상되지 않은 다른 필드(title 등)는 보존된다', () => {
    expect(() => getTask('bad-1')).not.toThrow()
    const t = getTask('bad-1')!
    expect(t.title).toBe('손상 작업') // JSON이 아닌 필드는 영향받지 않는다
    expect(t.questions).toEqual([])
    expect(t.skills).toBeNull()
    expect(t.images).toEqual([])
    expect(t.todos).toBeNull()
    expect(t.dependsOn).toEqual([])
  })

  it('손상 복구 내역이 recovery.log에 기록된다(재발 추적 가능)', () => {
    const log = fs.readFileSync(path.join(DATA_DIR, 'recovery.log'), 'utf8')
    expect(log).toMatch(/손상.*JSON|JSON.*손상/)
  })
})
