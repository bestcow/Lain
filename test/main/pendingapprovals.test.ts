import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 격리(store.hide 패턴).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-pendingapprovals-')) }
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
  closeStore,
  insertTask,
  insertApproval,
  resolveApprovalRow,
  listProjects,
  upsertProject,
  saveStatus,
} from '../../src/main/store'

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
  id: 'demo',
  path: 'C:/tmp/demo',
  name: 'demo',
  stack: '',
  isGit: false,
  verifyCmd: null,
}

describe('pendingApprovals 카운트 — 프로젝트 카드 관제 확장', () => {
  it('대기 승인 수가 프로젝트 상태에 실린다 (스캔된 프로젝트)', () => {
    upsertProject(proj as any)
    saveStatus({ projectId: 'demo' })
    insertTask({ id: 'pa-t1', projectId: 'demo', title: 't', state: 'working', content: 't' })
    insertApproval('pa-t1', 'push', '테스트 승인')

    const p = listProjects().find((x) => x.id === 'demo')!
    expect(p.status).not.toBeNull()
    expect(p.status!.pendingApprovals).toBe(1)
  })

  it('승인이 처리(resolve)되면 카운트에서 빠진다', () => {
    upsertProject({ ...proj, id: 'demo2' } as any)
    saveStatus({ projectId: 'demo2' })
    insertTask({ id: 'pa-t2', projectId: 'demo2', title: 't', state: 'working', content: 't' })
    const id = insertApproval('pa-t2', 'question', '테스트 승인2')
    expect(listProjects().find((x) => x.id === 'demo2')!.status!.pendingApprovals).toBe(1)

    resolveApprovalRow(id, 'approved')
    const p = listProjects().find((x) => x.id === 'demo2')!
    expect(p.status?.pendingApprovals ?? 0).toBe(0)
  })

  it('대기 승인이 없는 프로젝트는 0 또는 미표시', () => {
    upsertProject({ ...proj, id: 'demo3' } as any)
    saveStatus({ projectId: 'demo3' })
    const p = listProjects().find((x) => x.id === 'demo3')!
    expect(p.status?.pendingApprovals ?? 0).toBe(0)
  })

  it('status가 없는(미스캔) 프로젝트는 승인이 있어도 status가 null로 유지된다', () => {
    upsertProject({ ...proj, id: 'demo4' } as any)
    insertTask({ id: 'pa-t4', projectId: 'demo4', title: 't', state: 'working', content: 't' })
    insertApproval('pa-t4', 'push', '테스트 승인4')

    const p = listProjects().find((x) => x.id === 'demo4')!
    expect(p.status).toBeNull()
  })
})
