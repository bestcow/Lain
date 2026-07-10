import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { DATA_DIR: TEST_DATA_DIR } = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const ph = require('node:path') as typeof import('node:path')
  const osh = require('node:os') as typeof import('node:os')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(osh.tmpdir(), 'lain-groups-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

// worktree — git 없이 제어 가능한 목. tryMerge/revertMergeRange를 테스트에서 mockReturnValueOnce로 조종.
vi.mock('../../src/main/worktree', () => ({
  createWorktree: vi.fn(() => ({ branch: 'b', path: os.tmpdir(), depsWarning: null })),
  removeWorktree: vi.fn(),
  diffStat: vi.fn(() => ''),
  changedFiles: vi.fn(() => []),
  tryMerge: vi.fn(() => ({ merged: true, reason: 'ff', baseSha: 'base0', mergedSha: 'head0' })),
  rebaseWorktreeOntoMain: vi.fn(() => ({ ok: true, reason: 'rebased' })),
  revertMergeRange: vi.fn(() => ({ ok: true, reason: 'reverted' })),
}))
vi.mock('../../src/main/collectors', () => ({ verifyInDir: vi.fn(async () => ({ pass: true, tail: '' })) }))
vi.mock('../../src/main/worker', () => ({
  runNavi: vi.fn(async () => ({ status: 'done', summary: '', questions: [] })),
  abortNavi: vi.fn(),
  waitApproval: vi.fn(),
  isNaviRunning: vi.fn(() => false),
  isAwaitingApproval: vi.fn(() => false),
  approvalTimeoutMs: vi.fn(() => 0),
}))
vi.mock('../../src/main/notify', () => ({ notifyUser: vi.fn() }))

import {
  initStore,
  closeStore,
  upsertProject,
  insertTask,
  getTask,
  updateTask,
  insertTaskGroup,
  getTaskGroup,
  tasksForGroup,
  setGroupResolveState,
  saveSettings,
} from '../../src/main/store'
import { resolveReview, resolveGroup, startTaskGroup, recoverGroups } from '../../src/main/orchestrator'
import { tryMerge, revertMergeRange, removeWorktree } from '../../src/main/worktree'
import { notifyUser } from '../../src/main/notify'

const tryMergeMock = tryMerge as unknown as ReturnType<typeof vi.fn>
const revertMock = revertMergeRange as unknown as ReturnType<typeof vi.fn>

beforeAll(() => {
  initStore()
  for (const id of ['pA', 'pB', 'pC']) {
    upsertProject({ id, path: os.tmpdir(), name: id, stack: '', verifyCmd: null, isGit: true, enabled: true })
  }
  // 비-git 프로젝트(검증 실패 케이스용)
  upsertProject({ id: 'pNoGit', path: os.tmpdir(), name: 'pNoGit', stack: '', verifyCmd: null, isGit: false, enabled: true })
  // rebase 폴백 경로를 끄면 tryMerge 반환이 곧 최종 결과 → 목 제어가 단순해진다.
  saveSettings({ autoRebaseOnMerge: false })
})
afterAll(() => {
  closeStore()
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})
beforeEach(() => {
  tryMergeMock.mockClear()
  revertMock.mockClear()
  tryMergeMock.mockReturnValue({ merged: true, reason: 'ff', baseSha: 'base0', mergedSha: 'head0' })
})

let seq = 0
function mkChild(groupId: string, projectId: string, state: string): string {
  const id = `gt${++seq}`
  insertTask({ id, projectId, title: `t-${id}`, state: state as any, content: 'x', groupId })
  return id
}

describe('store — task_groups 왕복 + group_id 영속', () => {
  it('insertTaskGroup/getTaskGroup/tasksForGroup', () => {
    insertTaskGroup({ id: 'grp1', title: '크로스레포 X', spec: '공유 명세' })
    const g = getTaskGroup('grp1')
    expect(g?.title).toBe('크로스레포 X')
    expect(g?.spec).toBe('공유 명세')
    const c1 = mkChild('grp1', 'pA', 'review')
    const c2 = mkChild('grp1', 'pB', 'working')
    const rows = tasksForGroup('grp1')
    expect(rows.map((r) => r.id)).toEqual([c1, c2])
    expect(getTask(c1)!.groupId).toBe('grp1')
    expect(getTask(c2)!.groupId).toBe('grp1')
  })
})

describe('startTaskGroup — 검증(부분 생성 방지)', () => {
  it('child 2개 미만이면 거절', async () => {
    const r = await startTaskGroup('t', 's', [{ projectId: 'pA', content: 'x' }])
    expect(r.error).toContain('2개 이상')
  })
  it('없는 프로젝트면 거절', async () => {
    const r = await startTaskGroup('t', 's', [
      { projectId: 'pA', content: 'x' },
      { projectId: 'ghost', content: 'y' },
    ])
    expect(r.error).toContain('프로젝트 없음')
  })
  it('비-git 프로젝트면 거절', async () => {
    const r = await startTaskGroup('t', 's', [
      { projectId: 'pA', content: 'x' },
      { projectId: 'pNoGit', content: 'y' },
    ])
    expect(r.error).toContain('비-git')
  })
  it('같은 프로젝트 중복이면 거절(크로스레포 전제)', async () => {
    const r = await startTaskGroup('t', 's', [
      { projectId: 'pA', content: 'x' },
      { projectId: 'pA', content: 'y' },
    ])
    expect(r.error).toContain('중복')
  })
  it('빈 content면 거절', async () => {
    const r = await startTaskGroup('t', 's', [
      { projectId: 'pA', content: 'x' },
      { projectId: 'pB', content: '   ' },
    ])
    expect(r.error).toContain('내용')
  })
})

describe('resolveReview — D13 그룹 게이트', () => {
  it('그룹 소속 작업의 개별 merge는 봉쇄', async () => {
    insertTaskGroup({ id: 'grpGate', title: 'G', spec: '' })
    const c = mkChild('grpGate', 'pA', 'review')
    const res = await resolveReview(c, 'merge')
    expect(res).toContain('resolve_group')
    expect(getTask(c)!.state).toBe('review') // 병합 안 됨
  })
  it('그룹 소속이어도 개별 discard는 허용', async () => {
    insertTaskGroup({ id: 'grpDisc', title: 'G', spec: '' })
    const c = mkChild('grpDisc', 'pA', 'review')
    await resolveReview(c, 'discard')
    expect(getTask(c)!.state).toBe('cancelled')
  })
})

describe('resolveGroup — all-or-nothing 병합', () => {
  it('모든 child가 review가 아니면 병합 불가(어디가 덜 됐는지 보고)', async () => {
    insertTaskGroup({ id: 'grpNR', title: 'G', spec: '' })
    mkChild('grpNR', 'pA', 'review')
    mkChild('grpNR', 'pB', 'working')
    const res = await resolveGroup('grpNR', 'merge')
    expect(res).toContain('병합 불가')
    expect(res).toContain('pB(working)')
  })

  it('전부 review면 순차 병합 → 전 child done, revert 없음', async () => {
    insertTaskGroup({ id: 'grpOK', title: 'G', spec: '' })
    const c1 = mkChild('grpOK', 'pA', 'review')
    const c2 = mkChild('grpOK', 'pB', 'review')
    const res = await resolveGroup('grpOK', 'merge')
    expect(res).toContain('일괄 병합 완료')
    expect(getTask(c1)!.state).toBe('done')
    expect(getTask(c2)!.state).toBe('done')
    expect(getTask(c1)!.mergeBaseSha).toBe('base0') // 되돌릴 범위 저장됨
    expect(revertMock).not.toHaveBeenCalled()
  })

  it('중간 실패 시 이미 병합된 child를 자동 롤백(반쪽 상태 차단)', async () => {
    insertTaskGroup({ id: 'grpFail', title: 'G', spec: '' })
    const c1 = mkChild('grpFail', 'pA', 'review')
    const c2 = mkChild('grpFail', 'pB', 'review')
    // 첫 child는 병합 성공, 둘째는 ff 불가(rebase 폴백 off라 곧 실패)
    tryMergeMock
      .mockReturnValueOnce({ merged: true, reason: 'ff', baseSha: 'b1', mergedSha: 'h1' })
      .mockReturnValueOnce({ merged: false, reason: 'ff 불가' })
    const res = await resolveGroup('grpFail', 'merge')
    expect(res).toContain('그룹 병합 실패')
    expect(res).toContain('되돌렸다')
    // 이미 병합된 c1은 revert 호출됨(범위 b1..h1)
    expect(revertMock).toHaveBeenCalledWith(expect.anything(), 'b1', 'h1')
    // c1은 done(롤백 표기), c2는 review 유지(막힌 지점)
    expect(getTask(c1)!.state).toBe('done')
    expect(getTask(c1)!.summary).toContain('그룹 롤백')
    expect(getTask(c1)!.mergeBaseSha).toBeNull() // 롤백 후 범위 제거(재-revert 방지)
    expect(getTask(c2)!.state).toBe('review')
  })

  // 재리뷰 #1 — 롤백의 revert 자체가 실패(dirty main·충돌)하면 병합은 main에 남아 있다.
  // 이때 SHA를 지우면 되돌릴 기록이 소실돼 revert_merge 수동 재시도가 영영 불가능해진다 — 보존해야 한다.
  it('롤백 revert 실패 시 merge SHA를 보존한다(#1 — revert_merge 수동 재시도 가능)', async () => {
    insertTaskGroup({ id: 'grpRbFail', title: 'G', spec: '' })
    const c1 = mkChild('grpRbFail', 'pA', 'review')
    const c2 = mkChild('grpRbFail', 'pB', 'review')
    tryMergeMock
      .mockReturnValueOnce({ merged: true, reason: 'ff', baseSha: 'b1', mergedSha: 'h1' })
      .mockReturnValueOnce({ merged: false, reason: 'ff 불가' })
    revertMock.mockReturnValueOnce({ ok: false, reason: 'main dirty — abort' }) // 롤백 자체 실패
    const res = await resolveGroup('grpRbFail', 'merge')
    expect(res).toContain('그룹 병합 실패')
    const t1 = getTask(c1)!
    expect(t1.state).toBe('done')
    expect(t1.mergeBaseSha).toBe('b1') // ★ 보존 — 병합이 main에 남아 있으므로
    expect(t1.mergeHeadSha).toBe('h1')
    expect(t1.summary).toContain('롤백 실패')
    expect(getTask(c2)!.state).toBe('review')
  })

  it('keep-branch/discard는 child별 일괄(review 아닌 것은 건너뜀)', async () => {
    insertTaskGroup({ id: 'grpKeep', title: 'G', spec: '' })
    const c1 = mkChild('grpKeep', 'pA', 'review')
    const c2 = mkChild('grpKeep', 'pB', 'working')
    const res = await resolveGroup('grpKeep', 'keep-branch')
    expect(getTask(c1)!.state).toBe('done') // keep-branch → done
    expect(getTask(c2)!.state).toBe('working') // 건너뜀
    expect(res).toContain('건너뜀')
    expect(removeWorktree).toHaveBeenCalled()
  })
})

// 재리뷰 #2 — 그룹 병합 루프 도중 크래시(전원 차단·강제 종료)하면 일부 레포만 병합된 채 남는다.
// git 병합은 비가역 부수효과라 자동 재개·자동 롤백 모두 위험 → 부팅 시 감지·통지하고 사람이 결정한다.
// resolveGroup은 재진입 가능해야 한다: 이미 병합된 child(done+SHA)는 건너뛰되, 이후 실패 시
// 그들까지 롤백해 all-or-nothing 보장이 크래시를 건너도 유지된다.
describe('그룹 병합 크래시 복구(#2) — recoverGroups + resolveGroup 재개', () => {
  it('recoverGroups — merging 잔류 그룹을 감지해 통지하고 플래그를 걷는다', () => {
    insertTaskGroup({ id: 'grpCrash', title: '크래시그룹', spec: '' })
    const c1 = mkChild('grpCrash', 'pA', 'done')
    updateTask(c1, { mergeBaseSha: 'b1', mergeHeadSha: 'h1' }) // 크래시 전 병합됨
    mkChild('grpCrash', 'pB', 'review') // 아직 미병합
    setGroupResolveState('grpCrash', 'merging') // 크래시로 남은 플래그를 흉내
    vi.mocked(notifyUser).mockClear()
    const n = recoverGroups()
    expect(n).toBe(1)
    expect(vi.mocked(notifyUser)).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(notifyUser).mock.calls[0][1])).toContain('1/2')
    expect(getTaskGroup('grpCrash')!.resolveState).toBe('') // 플래그 회수(중복 통지 방지)
    // 다시 부르면 감지 대상 없음
    expect(recoverGroups()).toBe(0)
  })

  it('resolveGroup 재개 — 이미 병합된 child는 건너뛰고 나머지만 병합한다', async () => {
    insertTaskGroup({ id: 'grpResume', title: 'G', spec: '' })
    const c1 = mkChild('grpResume', 'pA', 'done')
    updateTask(c1, { mergeBaseSha: 'b1', mergeHeadSha: 'h1' }) // 크래시 전 병합분
    const c2 = mkChild('grpResume', 'pB', 'review')
    const res = await resolveGroup('grpResume', 'merge')
    expect(res).toContain('일괄 병합 완료')
    expect(tryMergeMock).toHaveBeenCalledTimes(1) // c2만 병합 시도(c1 재병합 없음)
    expect(getTask(c2)!.state).toBe('done')
    expect(getTask(c1)!.mergeBaseSha).toBe('b1') // 기존 병합분 무손상
  })

  it('재개 중 실패 시 크래시 전 병합분까지 롤백한다(all-or-nothing 복원)', async () => {
    insertTaskGroup({ id: 'grpResumeFail', title: 'G', spec: '' })
    const c1 = mkChild('grpResumeFail', 'pA', 'done')
    updateTask(c1, { mergeBaseSha: 'b1', mergeHeadSha: 'h1' }) // 크래시 전 병합분
    const c2 = mkChild('grpResumeFail', 'pB', 'review')
    tryMergeMock.mockReturnValueOnce({ merged: false, reason: 'ff 불가' }) // 재개분 실패
    const res = await resolveGroup('grpResumeFail', 'merge')
    expect(res).toContain('그룹 병합 실패')
    expect(revertMock).toHaveBeenCalledWith(expect.anything(), 'b1', 'h1') // 크래시 생존분 롤백
    expect(getTask(c1)!.mergeBaseSha).toBeNull() // 롤백 성공 → 범위 제거
    expect(getTask(c2)!.state).toBe('review')
  })

  it('정상 완료된 그룹 병합은 resolve_state를 남기지 않는다(recoverGroups 오탐 없음)', async () => {
    insertTaskGroup({ id: 'grpClean', title: 'G', spec: '' })
    mkChild('grpClean', 'pA', 'review')
    mkChild('grpClean', 'pB', 'review')
    await resolveGroup('grpClean', 'merge')
    expect(getTaskGroup('grpClean')!.resolveState).toBe('')
    expect(recoverGroups()).toBe(0)
  })
})
