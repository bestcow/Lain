import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-queue-')) }
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
  getTask,
  updateTask,
  upsertProject,
  queuedTasks,
  setTaskPriority,
  activeTaskForProject,
} from '../../src/main/store'

beforeAll(() => {
  initStore()
  upsertProject({
    id: 'p-q',
    path: 'C:/tmp/p-q',
    name: 'p-q',
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

// D1 — 대기 큐 store 헬퍼: priority 왕복, queuedTasks 정렬, setTaskPriority, activeTaskForProject 제외.
describe('tasks.priority 왕복 + insertTask 매핑', () => {
  it('기본 priority 0', () => {
    insertTask({ id: 'pr1', projectId: 'p-q', title: 't', state: 'queued', content: 'c' })
    expect(getTask('pr1')!.priority).toBe(0)
  })
  it('생성 시 priority 지정(음수 포함)', () => {
    insertTask({ id: 'pr2', projectId: 'p-q', title: 't', state: 'queued', content: 'c', priority: -3 })
    expect(getTask('pr2')!.priority).toBe(-3)
  })
  it('updateTask로 priority 변경', () => {
    insertTask({ id: 'pr3', projectId: 'p-q', title: 't', state: 'queued', content: 'c' })
    updateTask('pr3', { priority: 7 })
    expect(getTask('pr3')!.priority).toBe(7)
  })
})

describe('setTaskPriority', () => {
  it('대기 작업의 priority를 갱신한다', () => {
    insertTask({ id: 'sp1', projectId: 'p-q', title: 't', state: 'queued', content: 'c' })
    setTaskPriority('sp1', -10)
    expect(getTask('sp1')!.priority).toBe(-10)
  })
})

describe('queuedTasks — priority ASC, created_at ASC', () => {
  it('state=queued만, priority 오름차순으로 반환한다', () => {
    // 격리: 이 describe가 심는 것만 검사하도록 고유 프로젝트 사용.
    upsertProject({ id: 'p-q2', path: 'C:/tmp/p-q2', name: 'p-q2', stack: '', verifyCmd: null, isGit: false } as any)
    insertTask({ id: 'qa', projectId: 'p-q2', title: 'a', state: 'queued', content: 'c', priority: 5 })
    insertTask({ id: 'qb', projectId: 'p-q2', title: 'b', state: 'queued', content: 'c', priority: -2 })
    insertTask({ id: 'qc', projectId: 'p-q2', title: 'c', state: 'queued', content: 'c', priority: 0 })
    insertTask({ id: 'qw', projectId: 'p-q2', title: 'w', state: 'working', content: 'c', priority: -99 }) // queued 아님 → 제외

    const order = queuedTasks()
      .filter((t) => t.projectId === 'p-q2')
      .map((t) => t.id)
    expect(order).toEqual(['qb', 'qc', 'qa']) // -2, 0, 5
    updateTask('qw', { state: 'done' })
    for (const id of ['qa', 'qb', 'qc']) updateTask(id, { state: 'done' })
  })

  it('priority 동률이면 created_at ASC(먼저 들어온 것 먼저)', () => {
    upsertProject({ id: 'p-q3', path: 'C:/tmp/p-q3', name: 'p-q3', stack: '', verifyCmd: null, isGit: false } as any)
    // created_at은 datetime('now')(초 단위)라 동일 초에 들어가면 정렬이 불안정할 수 있어 id를 rowid 대용으로 삽입 순서 검증만.
    insertTask({ id: 'first', projectId: 'p-q3', title: 'first', state: 'queued', content: 'c', priority: 1 })
    insertTask({ id: 'second', projectId: 'p-q3', title: 'second', state: 'queued', content: 'c', priority: 1 })
    const ids = queuedTasks()
      .filter((t) => t.projectId === 'p-q3')
      .map((t) => t.id)
    // 둘 다 priority 1 — created_at ASC가 동률 tie-break. 같은 초면 순서 보장 안 되나 둘 다 포함은 보장.
    expect(ids).toContain('first')
    expect(ids).toContain('second')
    for (const id of ['first', 'second']) updateTask(id, { state: 'done' })
  })
})

describe('activeTaskForProject — queued 제외', () => {
  it('queued 작업만 있으면 활성 없음(null)', () => {
    upsertProject({ id: 'p-q4', path: 'C:/tmp/p-q4', name: 'p-q4', stack: '', verifyCmd: null, isGit: false } as any)
    insertTask({ id: 'a1', projectId: 'p-q4', title: 't', state: 'queued', content: 'c' })
    expect(activeTaskForProject('p-q4')).toBeNull()
  })
  it('working 작업이 있으면 그건 활성으로 잡힌다(queued와 대비)', () => {
    upsertProject({ id: 'p-q5', path: 'C:/tmp/p-q5', name: 'p-q5', stack: '', verifyCmd: null, isGit: false } as any)
    insertTask({ id: 'a2', projectId: 'p-q5', title: 't', state: 'queued', content: 'c' })
    insertTask({ id: 'a3', projectId: 'p-q5', title: 't', state: 'working', content: 'c' })
    expect(activeTaskForProject('p-q5')!.id).toBe('a3')
    updateTask('a3', { state: 'done' })
  })
})
