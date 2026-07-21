import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 격리(store.hide 패턴).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-cclastactivity-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, closeStore, addCcEvent, listProjects, upsertProject, saveStatus } from '../../src/main/store'

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
    /* DB 파일 잠금 — 무시 */
  }
})

const proj = {
  id: 'demo2',
  path: 'C:/tmp/demo2',
  name: 'demo2',
  stack: '',
  isGit: false,
  verifyCmd: null,
}

describe('lastCcAt — 프로젝트 카드 마지막 CC 활동', () => {
  it('최근 CC 이벤트 시각이 프로젝트 상태에 실린다 (스캔된 프로젝트)', () => {
    upsertProject(proj as any)
    saveStatus({ projectId: 'demo2' })
    addCcEvent('demo2', 'aaaa1111-2222-3333-4444-555566667777', 'SessionStart')

    const p = listProjects().find((x) => x.id === 'demo2')!
    expect(p.status).not.toBeNull()
    expect(p.status!.lastCcAt).toBeTruthy()
  })

  it('status가 없는(미스캔) 프로젝트는 CC 이벤트가 있어도 status가 null로 유지된다', () => {
    upsertProject({ ...proj, id: 'demo3' } as any)
    addCcEvent('demo3', 'bbbb1111-2222-3333-4444-555566667777', 'SessionStart')

    const p = listProjects().find((x) => x.id === 'demo3')!
    expect(p.status).toBeNull()
  })
})
