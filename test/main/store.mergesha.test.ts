import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// D8 — tasks.merge_base_sha / merge_head_sha 가산 컬럼 왕복.
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-mergesha-')) }
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
  getSettings,
  saveSettings,
} from '../../src/main/store'

beforeAll(() => {
  initStore()
  upsertProject({
    id: 'p-mergesha',
    path: 'C:/tmp/p-mergesha',
    name: 'p-mergesha',
    stack: '',
    verifyCmd: null,
    isGit: true,
    enabled: true,
  } as any)
})
afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* 잠금 무시 */
  }
})

describe('tasks merge SHA 왕복', () => {
  it('기본은 null(되돌릴 병합 없음)', () => {
    insertTask({ id: 'ms1', projectId: 'p-mergesha', title: 't', state: 'done', content: 'c' })
    const t = getTask('ms1')!
    expect(t.mergeBaseSha).toBeNull()
    expect(t.mergeHeadSha).toBeNull()
  })

  it('updateTask로 base/head SHA 저장 후 읽힌다', () => {
    insertTask({ id: 'ms2', projectId: 'p-mergesha', title: 't', state: 'done', content: 'c' })
    updateTask('ms2', { mergeBaseSha: 'aaaa111', mergeHeadSha: 'bbbb222' })
    const t = getTask('ms2')!
    expect(t.mergeBaseSha).toBe('aaaa111')
    expect(t.mergeHeadSha).toBe('bbbb222')
  })

  it('되돌린 뒤 null로 되돌리면 되돌릴 병합 없음으로 표시된다', () => {
    insertTask({ id: 'ms3', projectId: 'p-mergesha', title: 't', state: 'done', content: 'c' })
    updateTask('ms3', { mergeBaseSha: 'aaaa111', mergeHeadSha: 'bbbb222' })
    expect(getTask('ms3')!.mergeBaseSha).toBe('aaaa111')
    updateTask('ms3', { mergeBaseSha: null, mergeHeadSha: null })
    const t = getTask('ms3')!
    expect(t.mergeBaseSha).toBeNull()
    expect(t.mergeHeadSha).toBeNull()
  })
})

describe('D8 autoRebaseOnMerge 설정 왕복', () => {
  it('기본 on', () => {
    expect(getSettings().autoRebaseOnMerge).toBe(true)
  })
  it('off로 저장 후 로드', () => {
    saveSettings({ autoRebaseOnMerge: false })
    expect(getSettings().autoRebaseOnMerge).toBe(false)
    saveSettings({ autoRebaseOnMerge: true })
    expect(getSettings().autoRebaseOnMerge).toBe(true)
  })
})
