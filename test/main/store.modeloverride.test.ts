import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-modeloverride-')) }
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
    id: 'p-model',
    path: 'C:/tmp/p-model',
    name: 'p-model',
    stack: '',
    verifyCmd: null,
    isGit: false,
    enabled: true,
  } as any)
})
afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

// D10 — task.modelOverride 왕복(빈 문자열='' = 전역 naviModel 따름).
describe('tasks.model_override 왕복', () => {
  it('기본 빈 문자열(전역 따름)', () => {
    insertTask({ id: 'tm1', projectId: 'p-model', title: 't', state: 'clarifying', content: 'c' })
    expect(getTask('tm1')!.modelOverride).toBe('')
  })
  it('생성 시 modelOverride 지정', () => {
    insertTask({
      id: 'tm2',
      projectId: 'p-model',
      title: 't',
      state: 'clarifying',
      content: 'c',
      modelOverride: 'opus',
    })
    expect(getTask('tm2')!.modelOverride).toBe('opus')
  })
  it('updateTask로 변경 — 이후 빈 문자열로 되돌리면 전역 따름', () => {
    insertTask({ id: 'tm3', projectId: 'p-model', title: 't', state: 'clarifying', content: 'c' })
    updateTask('tm3', { modelOverride: 'haiku' })
    expect(getTask('tm3')!.modelOverride).toBe('haiku')
    updateTask('tm3', { modelOverride: '' })
    expect(getTask('tm3')!.modelOverride).toBe('')
  })
})
