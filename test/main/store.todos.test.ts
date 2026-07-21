import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-todos-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, insertTask, getTask, updateTask, upsertProject } from '../../src/main/store'

beforeAll(() => {
  initStore()
  upsertProject({
    id: 'p-todos',
    path: 'C:/tmp/p-todos',
    name: 'p-todos',
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

// A4 — task.todos(최신 TodoWrite 스냅샷) 왕복. 누적이 아니라 "최신 상태"이므로 updateTask가
// 매번 통째로 교체해야 한다(병합·누적 금지).
describe('tasks.todos 왕복 — A4 TodoWrite 스냅샷', () => {
  it('기본 null(TodoWrite 미사용)', () => {
    insertTask({ id: 'tt1', projectId: 'p-todos', title: 't', state: 'clarifying', content: 'c' })
    expect(getTask('tt1')!.todos).toBeNull()
  })

  it('updateTask로 저장하면 JSON 왕복된다', () => {
    insertTask({ id: 'tt2', projectId: 'p-todos', title: 't', state: 'clarifying', content: 'c' })
    const todos = [
      { content: '파일 읽기', status: 'completed' as const, activeForm: '읽는 중' },
      { content: '수정하기', status: 'in_progress' as const, activeForm: '수정 중' },
    ]
    updateTask('tt2', { todos })
    expect(getTask('tt2')!.todos).toEqual(todos)
  })

  it('두 번째 TodoWrite가 첫 번째를 완전히 대체한다(누적 아님)', () => {
    insertTask({ id: 'tt3', projectId: 'p-todos', title: 't', state: 'clarifying', content: 'c' })
    updateTask('tt3', {
      todos: [{ content: 'A', status: 'pending' as const, activeForm: 'A중' }],
    })
    const next = [
      { content: 'A', status: 'completed' as const, activeForm: 'A중' },
      { content: 'B', status: 'in_progress' as const, activeForm: 'B중' },
    ]
    updateTask('tt3', { todos: next })
    expect(getTask('tt3')!.todos).toEqual(next) // A 하나가 아니라 next 전체로 교체됨
  })

  it('빈 배열로 갱신하면 null로 저장된다(빈 배열=상태 없음과 동일 취급)', () => {
    insertTask({ id: 'tt4', projectId: 'p-todos', title: 't', state: 'clarifying', content: 'c' })
    updateTask('tt4', { todos: [{ content: 'A', status: 'pending' as const, activeForm: 'A중' }] })
    updateTask('tt4', { todos: [] })
    expect(getTask('tt4')!.todos).toBeNull()
  })
})
