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
  insertAutoApproval,
  resolveApprovalRow,
  listApprovals,
  listAutoApprovals,
  ackAutoApproval,
  listProjects,
  upsertProject,
  saveStatus,
  clearOrphanApprovals,
  rejectPendingApprovalsForTask,
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

// B1 — 자율 통과(autonomous/bypass) 사후 검토 기록: state='auto' 행은 '대기'가 아니다.
// pending 조회·배지 카운트·스윕이 auto 행을 대기로 세면 유령 승인함·거절 오염이 생긴다(핵심 함정).
describe('insertAutoApproval — auto 행이 pending 집계에 안 섞인다 (B1)', () => {
  it('auto 행은 listApprovals(pending 조회)에 나오지 않는다', () => {
    upsertProject({ ...proj, id: 'demo5' } as any)
    saveStatus({ projectId: 'demo5' })
    insertTask({ id: 'pa-t5', projectId: 'demo5', title: 't', state: 'working', content: 't' })
    const id = insertAutoApproval('pa-t5', 'dep_change', 'npm install react')
    expect(id).toBeGreaterThan(0) // 행 자체는 삽입됨(사후 검토용 기록)
    expect(listApprovals().some((a) => a.id === id)).toBe(false)
  })

  it('auto 행은 프로젝트 pendingApprovals 배지 카운트에 안 잡힌다', () => {
    expect(listProjects().find((x) => x.id === 'demo5')!.status!.pendingApprovals).toBe(0)
  })

  it('pending과 auto가 섞여 있으면 pending만 센다', () => {
    insertApproval('pa-t5', 'push', 'git push')
    expect(listProjects().find((x) => x.id === 'demo5')!.status!.pendingApprovals).toBe(1)
    const l = listApprovals().filter((a) => a.taskId === 'pa-t5')
    expect(l).toHaveLength(1)
    expect(l[0].kind).toBe('push')
  })

  it('부팅 스윕·작업 정리는 auto 행을 건드리지 않는다(pending 한정)', () => {
    clearOrphanApprovals() // 앞선 테스트들이 남긴 pending 전부 정리(전역 스윕)
    const id = insertAutoApproval('pa-t5', 'network', 'WebFetch https://example.com')
    expect(id).toBeGreaterThan(0)
    // auto만 남은 상태 — 스윕도 작업 한정 정리도 닫을 pending이 없다(0).
    expect(clearOrphanApprovals()).toBe(0)
    expect(rejectPendingApprovalsForTask('pa-t5')).toBe(0)
  })
})

// 사후 검토 탭(B1 소비) — 자율 통과(state='auto') 기록의 조회와 '확인'(ack) 처리.
// 절대 조건: pending 승인함·배지와 완전 분리(auto/auto_acked가 pending 집계에 안 섞이고, 역으로도 안 섞임).
describe('사후 검토 — listAutoApprovals·ackAutoApproval', () => {
  it('auto 행만 최신순으로 나온다(pending은 미포함)', () => {
    upsertProject({ ...proj, id: 'demo6' } as any)
    saveStatus({ projectId: 'demo6' })
    insertTask({ id: 'pa-t6', projectId: 'demo6', title: 't', state: 'working', content: 't' })
    const a1 = insertAutoApproval('pa-t6', 'dep_change', 'npm install react')
    const a2 = insertAutoApproval('pa-t6', 'network', 'curl https://example.com')
    insertApproval('pa-t6', 'push', 'git push') // pending — 사후 검토 목록에 섞이면 안 됨
    const mine = listAutoApprovals().filter((r) => r.taskId === 'pa-t6')
    expect(mine.map((r) => r.id)).toEqual([a2, a1]) // 최신순(id DESC)
    expect(mine.every((r) => r.state === 'auto')).toBe(true)
    expect(mine[0].kind).toBe('network')
    expect(mine[0].payload).toBe('curl https://example.com')
    expect(mine[0].createdAt).toBeTruthy() // 시각 — UI가 '언제 자율 통과됐나'를 그린다
  })

  it("확인(ack)하면 auto_acked로 닫혀 목록에서 빠진다 — pending 집계엔 여전히 무영향", () => {
    const before = listProjects().find((x) => x.id === 'demo6')!.status!.pendingApprovals
    const rows = listAutoApprovals().filter((r) => r.taskId === 'pa-t6')
    expect(ackAutoApproval(rows[0].id)).toBe(true)
    const after = listAutoApprovals().filter((r) => r.taskId === 'pa-t6')
    expect(after.map((r) => r.id)).toEqual([rows[1].id]) // 확인된 행만 빠짐
    // 확인 처리가 pending 뷰·배지에 아무 변화도 안 만든다(절대 조건).
    expect(listProjects().find((x) => x.id === 'demo6')!.status!.pendingApprovals).toBe(before)
    expect(listApprovals().some((a) => a.id === rows[0].id)).toBe(false)
  })

  it('ack은 auto 행만 닫는다 — pending 행 id를 줘도 불변(오발동 방어)', () => {
    const pid = insertApproval('pa-t6', 'destructive', 'rm -rf x')
    expect(ackAutoApproval(pid)).toBe(false)
    expect(listApprovals().some((a) => a.id === pid)).toBe(true) // pending 그대로 대기
    rejectPendingApprovalsForTask('pa-t6') // 뒷정리
  })
})
