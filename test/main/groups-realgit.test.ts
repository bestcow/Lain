import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// D13 e2e — 크로스레포 그룹 병합·롤백을 **실제 git 레포 2개**로 검증한다.
// groups.test.ts는 worktree를 통째로 목으로 대체해 '다중 레포'와 rebase 폴백(기본 on)이 한 번도
// 실제로 돌지 않는다. 여기서는 worktree만 목에서 빼고(store/paths는 tmp, worker/notify/collectors는 목)
// tmpdir의 실 레포 A·B에 브랜치·커밋을 만들어 resolveGroup을 그대로 태운다.
const { DATA_DIR: TEST_DATA_DIR } = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const ph = require('node:path') as typeof import('node:path')
  const osh = require('node:os') as typeof import('node:os')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(osh.tmpdir(), 'lain-groups-rg-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
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
  getProject,
  insertTask,
  getTask,
  updateTask,
  insertTaskGroup,
  saveSettings,
} from '../../src/main/store'
import { resolveGroup } from '../../src/main/orchestrator'
import { createWorktree, removeWorktree } from '../../src/main/worktree'
import { verifyInDir } from '../../src/main/collectors'

// 실 git은 느리다 — 레포 초기화는 파일 전체에서 2회(A·B)뿐이고, 각 시나리오는 taskId만 새로 딴다.
const T = 30_000

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function writeCommit(cwd: string, file: string, content: string, msg: string): void {
  fs.writeFileSync(path.join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-m', msg)
}

// worktree-merge.test.ts와 동일한 초기화(서명 비활성 포함) — 로컬/CI 설정에 흔들리지 않게.
function initRepo(tag: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lain-groups-rg-${tag}-`))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@lain.local')
  git(root, 'config', 'user.name', 'Lain Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeCommit(root, 'base.txt', 'base\n', 'init')
  return root
}

let repoA: string
let repoB: string
let seq = 0

/** 그룹 child 하나 = 실제 worktree + 브랜치 커밋 1개(=병합 대상). review 상태로 결재 대기시킨다. */
function mkChild(groupId: string, projectId: string, file: string): { id: string; wt: string } {
  const id = `rg${++seq}`
  insertTask({ id, projectId, title: `t-${id}`, state: 'review', content: 'x', groupId })
  const project = getProject(projectId)!
  const wt = createWorktree(project, id)
  updateTask(id, { worktreePath: wt.path, branch: wt.branch })
  writeCommit(wt.path, file, `${file}\n`, `feat: ${file}`)
  return { id, wt: wt.path }
}

beforeAll(() => {
  initStore()
  repoA = initRepo('a')
  repoB = initRepo('b')
  upsertProject({ id: 'rgA', path: repoA, name: 'rgA', stack: '', verifyCmd: null, isGit: true })
  // B만 verify_cmd를 둔다 — rebase 폴백의 verify 재실행 경로를 실제로 태우기 위해(verifyInDir는 목).
  upsertProject({ id: 'rgB', path: repoB, name: 'rgB', stack: '', verifyCmd: 'echo ok', isGit: true })
  saveSettings({ autoRebaseOnMerge: true }) // 프로덕션 기본값 그대로 검증
})

afterAll(() => {
  closeStore()
  for (const dir of [TEST_DATA_DIR, repoA, repoB]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 잠금 무시 */
    }
  }
})

beforeEach(() => {
  vi.mocked(verifyInDir).mockReset()
  vi.mocked(verifyInDir).mockResolvedValue({ pass: true, tail: '' } as any)
})

describe('D13 e2e(실 git) — 크로스레포 그룹 일괄 병합', () => {
  it(
    '정상: 두 레포 브랜치가 각자의 main에 실제로 병합된다',
    async () => {
      insertTaskGroup({ id: 'rgOK', title: '실git 정상', spec: '' })
      const a = mkChild('rgOK', 'rgA', 'featA.txt')
      const b = mkChild('rgOK', 'rgB', 'featB.txt')
      const tipA = git(a.wt, 'rev-parse', 'HEAD')
      const tipB = git(b.wt, 'rev-parse', 'HEAD')
      const beforeA = git(repoA, 'rev-parse', 'HEAD')

      const res = await resolveGroup('rgOK', 'merge')
      expect(res).toContain('일괄 병합 완료')
      // 양쪽 main이 각 브랜치 tip으로 전진 + 파일 실재
      expect(git(repoB, 'rev-parse', 'HEAD')).toBe(tipB)
      expect(fs.existsSync(path.join(repoA, 'featA.txt'))).toBe(true)
      expect(fs.existsSync(path.join(repoB, 'featB.txt'))).toBe(true)
      // 되돌릴 범위가 실제 SHA로 저장됐다
      const ta = getTask(a.id)!
      expect(ta.state).toBe('done')
      expect(ta.mergeBaseSha).toBe(beforeA)
      expect(ta.mergeHeadSha).toBe(tipA)
      expect(getTask(b.id)!.state).toBe('done')
    },
    T,
  )

  it(
    '중간 실패: B가 병합 불가면 A는 실제 revert로 롤백돼 반쪽 상태가 남지 않는다',
    async () => {
      insertTaskGroup({ id: 'rgFail', title: '실git 중간실패', spec: '' })
      const a = mkChild('rgFail', 'rgA', 'halfA.txt')
      const b = mkChild('rgFail', 'rgB', 'halfB.txt')
      // B의 main을 dirty로 → tryMerge가 거절하고 rebase 폴백도 건너뛴다(비파괴)
      fs.writeFileSync(path.join(repoB, 'base.txt'), 'dirty\n')

      const res = await resolveGroup('rgFail', 'merge')
      expect(res).toContain('그룹 병합 실패')
      expect(res).toContain('되돌렸다')
      // A: 병합됐다가 revert 커밋으로 되돌아왔다(히스토리 보존 — reset 아님)
      expect(fs.existsSync(path.join(repoA, 'halfA.txt'))).toBe(false)
      expect(git(repoA, 'log', '--oneline', '-1')).toMatch(/Revert/i)
      const ta = getTask(a.id)!
      expect(ta.state).toBe('done')
      expect(ta.summary).toContain('그룹 롤백')
      expect(ta.mergeBaseSha).toBeNull() // 롤백 성공 → 범위 제거(재-revert 방지)
      // B: 손대지 않음 — 병합물 없음, 작업은 review 유지(브랜치 보존)
      expect(fs.existsSync(path.join(repoB, 'halfB.txt'))).toBe(false)
      expect(getTask(b.id)!.state).toBe('review')

      git(repoB, 'checkout', '--', 'base.txt')
      removeWorktree(getProject('rgB')!, b.id, true)
    },
    T,
  )

  it(
    'rebase 폴백: main이 앞서가 ff 불가여도 rebase→verify→ff 재시도로 병합된다',
    async () => {
      insertTaskGroup({ id: 'rgRebase', title: '실git rebase', spec: '' })
      const a = mkChild('rgRebase', 'rgA', 'rbA.txt')
      const b = mkChild('rgRebase', 'rgB', 'rbB.txt')
      // 분기 이후 B의 main만 전진 → ff 불가(다른 파일이라 rebase는 성공)
      writeCommit(repoB, 'ahead.txt', 'ahead\n', 'main: diverge')

      const res = await resolveGroup('rgRebase', 'merge')
      expect(res).toContain('일괄 병합 완료')
      // rebase 후 verify가 실제로 재실행됐다(B의 verify_cmd + worktree 경로로)
      expect(vi.mocked(verifyInDir)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(verifyInDir).mock.calls[0][0]).toBe('echo ok')
      // B main에 선행 커밋과 브랜치 작업이 모두 있다(rebase 후 ff)
      expect(fs.existsSync(path.join(repoB, 'ahead.txt'))).toBe(true)
      expect(fs.existsSync(path.join(repoB, 'rbB.txt'))).toBe(true)
      expect(getTask(b.id)!.summary).toContain('rebase 후')
      expect(getTask(a.id)!.state).toBe('done')
      expect(fs.existsSync(path.join(repoA, 'rbA.txt'))).toBe(true)
    },
    T,
  )

  it(
    '롤백 실패: revert가 막히면 병합 SHA를 보존한다(revert_merge 수동 재시도 가능)',
    async () => {
      insertTaskGroup({ id: 'rgRbFail', title: '실git 롤백실패', spec: '' })
      const a = mkChild('rgRbFail', 'rgA', 'keepA.txt')
      const b = mkChild('rgRbFail', 'rgB', 'keepB.txt')
      writeCommit(repoB, 'ahead2.txt', 'ahead2\n', 'main: diverge again') // B는 ff 불가 → rebase→verify 경로
      // A 병합 이후·롤백 이전에 A의 main이 dirty해지는 상황을 verify 타이밍으로 재현한다.
      // (verify는 A 병합 뒤에 도는 유일한 await 지점) → B는 verify 실패로 막히고, A 롤백은 dirty로 실패.
      vi.mocked(verifyInDir).mockImplementationOnce(async () => {
        fs.writeFileSync(path.join(repoA, 'base.txt'), 'dirty during group merge\n')
        return { pass: false, tail: 'verify 실패' } as any
      })

      const res = await resolveGroup('rgRbFail', 'merge')
      expect(res).toContain('그룹 병합 실패')
      // A의 병합은 main에 그대로 남아 있다 → 기록(SHA)을 지우면 되돌릴 방법이 소실된다
      expect(fs.existsSync(path.join(repoA, 'keepA.txt'))).toBe(true)
      const ta = getTask(a.id)!
      expect(ta.mergeBaseSha).toBeTruthy()
      expect(ta.mergeHeadSha).toBeTruthy()
      expect(ta.summary).toContain('롤백 실패')
      // 보존된 범위가 실제 git 히스토리와 맞는다(수동 revert가 가능한 값)
      expect(git(repoA, 'rev-list', '--count', `${ta.mergeBaseSha}..${ta.mergeHeadSha}`)).toBe('1')
      expect(getTask(b.id)!.state).toBe('review') // 막힌 쪽은 review 유지(브랜치 보존)

      git(repoA, 'checkout', '--', 'base.txt')
      removeWorktree(getProject('rgB')!, b.id, true)
    },
    T,
  )
})
