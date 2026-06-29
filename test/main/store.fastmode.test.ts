import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-fast-')) }
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
    id: 'p-fast',
    path: 'C:/tmp/p-fast',
    name: 'p-fast',
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

describe('tasks.fast_mode 왕복', () => {
  it('기본 false', () => {
    insertTask({ id: 'tf1', projectId: 'p-fast', title: 't', state: 'clarifying', content: 'c' })
    expect(getTask('tf1')!.fastMode).toBe(false)
  })
  it('생성 시 fastMode=true', () => {
    insertTask({ id: 'tf2', projectId: 'p-fast', title: 't', state: 'clarifying', content: 'c', fastMode: true })
    expect(getTask('tf2')!.fastMode).toBe(true)
  })
  it('updateTask로 토글', () => {
    insertTask({ id: 'tf3', projectId: 'p-fast', title: 't', state: 'clarifying', content: 'c' })
    updateTask('tf3', { fastMode: true })
    expect(getTask('tf3')!.fastMode).toBe(true)
    updateTask('tf3', { fastMode: false })
    expect(getTask('tf3')!.fastMode).toBe(false)
  })
})
