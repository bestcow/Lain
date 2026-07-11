import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-skills-')) }
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
  getSettings,
  saveSettings,
  upsertProject,
} from '../../src/main/store'

beforeAll(() => {
  initStore()
  // tasks.project_id FK — 프로젝트가 먼저 있어야 insertTask 가능.
  upsertProject({
    id: 'p-skills',
    path: 'C:/tmp/p-skills',
    name: 'p-skills',
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

describe('tasks.skills 왕복', () => {
  it('할당 배열 저장·파싱', () => {
    insertTask({ id: 't1', projectId: 'p-skills', title: 't', state: 'clarifying', content: 'c', skills: ['systematic-debugging'] })
    expect(getTask('t1')!.skills).toEqual(['systematic-debugging'])
  })
  it('미할당이면 null', () => {
    insertTask({ id: 't2', projectId: 'p-skills', title: 't', state: 'clarifying', content: 'c' })
    expect(getTask('t2')!.skills).toBeNull()
  })
})

describe('skillsEnabled 설정', () => {
  it('기본 false', () => { expect(getSettings().skillsEnabled).toBe(false) })
  it('저장 후 true', () => { saveSettings({ skillsEnabled: true }); expect(getSettings().skillsEnabled).toBe(true) })
})
