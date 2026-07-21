import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { FileAttachment } from '../../src/shared/types'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-images-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, insertTask, getTask, updateTask, upsertProject } from '../../src/main/store'

const png: FileAttachment = { name: 's.png', mimeType: 'image/png', data: 'QUJD', isImage: true }

beforeAll(() => {
  initStore()
  upsertProject({
    id: 'p-images',
    path: 'C:/tmp/p-images',
    name: 'p-images',
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

describe('tasks.images 왕복', () => {
  it('신규 작업은 빈 배열', () => {
    insertTask({ id: 'ti1', projectId: 'p-images', title: 't', state: 'clarifying', content: 'c' })
    expect(getTask('ti1')!.images).toEqual([])
  })
  it('updateTask로 첨부·파싱', () => {
    insertTask({ id: 'ti2', projectId: 'p-images', title: 't', state: 'clarifying', content: 'c' })
    updateTask('ti2', { images: [png] })
    expect(getTask('ti2')!.images).toEqual([png])
  })
  it('빈 배열로 비우면 [] 로 복원(NULL 영속)', () => {
    insertTask({ id: 'ti3', projectId: 'p-images', title: 't', state: 'clarifying', content: 'c' })
    updateTask('ti3', { images: [png] })
    updateTask('ti3', { images: [] })
    expect(getTask('ti3')!.images).toEqual([])
  })
})
