import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// D8 — 실제 git 레포 픽스처로 worktree 병합/rebase/revert 경로를 검증한다.
// WT_ROOT = DATA_DIR/wt 이므로 paths.DATA_DIR을 tmp로 모킹해 사용자 데이터와 격리한다.
const { DATA_DIR } = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const ph = require('node:path') as typeof import('node:path')
  const osh = require('node:os') as typeof import('node:os')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(osh.tmpdir(), 'lain-wtmerge-data-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import {
  createWorktree,
  removeWorktree,
  branchName,
  tryMerge,
  rebaseWorktreeOntoMain,
  revertMergeRange,
  mergeTargetRef,
} from '../../src/main/worktree'
import type { Project } from '../../src/shared/types'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

let repoRoot: string
let project: Project
const TASK = 'wtmerge1'

function writeCommit(cwd: string, file: string, content: string, msg: string): void {
  fs.writeFileSync(path.join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-m', msg)
}

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-wtmerge-repo-'))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@lain.local')
  git(root, 'config', 'user.name', 'Lain Test')
  // 커밋 서명 비활성(CI/로컬 서명 설정이 있어도 테스트가 깨지지 않게)
  git(root, 'config', 'commit.gpgsign', 'false')
  writeCommit(root, 'base.txt', 'base\n', 'init')
  return root
}

beforeEach(() => {
  repoRoot = initRepo()
  project = {
    id: 'p-wtmerge',
    path: repoRoot,
    name: 'p-wtmerge',
    stack: '',
    verifyCmd: null,
    isGit: true,
  } as Project
})

afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* 잠금 무시 */
  }
})

describe('D8 tryMerge — ff 병합 + merge SHA 포착', () => {
  it('ff 가능하면 병합하고 base/merged SHA를 반환한다', () => {
    const before = git(repoRoot, 'rev-parse', 'HEAD')
    createWorktree(project, TASK)
    const wt = path.join(DATA_DIR, 'wt', TASK)
    writeCommit(wt, 'feat.txt', 'feature\n', 'feat: add')
    const branchTip = git(wt, 'rev-parse', 'HEAD')

    const m = tryMerge(project, TASK)
    expect(m.merged).toBe(true)
    expect(m.baseSha).toBe(before) // 병합 직전 main tip = 하한(exclusive)
    expect(m.mergedSha).toBe(branchTip) // 병합 후 main tip = 브랜치 tip = 상한(inclusive)
    // main이 실제로 전진했다
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(branchTip)
    removeWorktree(project, TASK, true)
  })

  it('메인이 dirty면 병합하지 않는다(비파괴)', () => {
    createWorktree(project, TASK)
    const wt = path.join(DATA_DIR, 'wt', TASK)
    writeCommit(wt, 'feat.txt', 'feature\n', 'feat: add')
    // 메인 작업트리를 dirty로 만든다(추적 파일 수정)
    fs.writeFileSync(path.join(repoRoot, 'base.txt'), 'base dirty\n')
    const m = tryMerge(project, TASK)
    expect(m.merged).toBe(false)
    expect(m.reason).toContain('dirty')
    // 정리
    git(repoRoot, 'checkout', '--', 'base.txt')
    removeWorktree(project, TASK, true)
  })
})

describe('D8 rebase 폴백 — ff 불가 → rebase → ff 성공', () => {
  it('분기 후 main이 전진하면 rebase 후 ff 병합 가능', () => {
    createWorktree(project, TASK)
    const wt = path.join(DATA_DIR, 'wt', TASK)
    writeCommit(wt, 'feat.txt', 'feature\n', 'feat: add')
    // 분기 이후 main에 새 커밋(다른 파일) → ff 불가 유발
    writeCommit(repoRoot, 'other.txt', 'other\n', 'main: diverge')

    const m1 = tryMerge(project, TASK)
    expect(m1.merged).toBe(false)
    expect(m1.reason).toContain('fast-forward 불가')

    // rebase 폴백
    const rb = rebaseWorktreeOntoMain(project, TASK)
    expect(rb.ok).toBe(true)
    // rebase 후 ff 재시도 → 성공
    const m2 = tryMerge(project, TASK)
    expect(m2.merged).toBe(true)
    expect(m2.baseSha).toBeDefined()
    expect(m2.mergedSha).toBeDefined()
    // main에 feat와 other가 모두 있어야 한다
    expect(fs.existsSync(path.join(repoRoot, 'feat.txt'))).toBe(true)
    expect(fs.existsSync(path.join(repoRoot, 'other.txt'))).toBe(true)
    removeWorktree(project, TASK, true)
  })
})

describe('D8 rebase 충돌 → abort → keep-branch(비파괴)', () => {
  it('같은 파일을 양쪽에서 바꾸면 rebase 충돌, abort로 worktree 원복, 브랜치 보존', () => {
    createWorktree(project, TASK)
    const wt = path.join(DATA_DIR, 'wt', TASK)
    // worktree에서 base.txt 수정
    writeCommit(wt, 'base.txt', 'branch change\n', 'feat: edit base')
    const branchTip = git(wt, 'rev-parse', 'HEAD')
    // main에서 같은 파일 다르게 수정 → rebase 충돌 확정
    writeCommit(repoRoot, 'base.txt', 'main change\n', 'main: edit base')
    const mainTip = git(repoRoot, 'rev-parse', 'HEAD')

    const m1 = tryMerge(project, TASK)
    expect(m1.merged).toBe(false)

    const rb = rebaseWorktreeOntoMain(project, TASK)
    expect(rb.ok).toBe(false)
    expect(rb.reason).toContain('충돌')

    // 비파괴 검증: worktree 브랜치 tip이 원래대로(abort로 원복), rebase 진행 중 아님
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(branchTip)
    // main도 손대지 않았다
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(mainTip)
    // 브랜치는 여전히 존재(keep-branch 가능)
    const branches = git(repoRoot, 'branch', '--list', branchName(TASK))
    expect(branches).toContain(branchName(TASK))
    removeWorktree(project, TASK, true)
  })
})

describe('D8 revertMergeRange — 범위 revert로 새 revert 커밋 생성(비파괴)', () => {
  it('ff 병합된 범위를 되돌리면 새 커밋이 쌓이고 파일이 사라진다', () => {
    const before = git(repoRoot, 'rev-parse', 'HEAD')
    createWorktree(project, TASK)
    const wt = path.join(DATA_DIR, 'wt', TASK)
    writeCommit(wt, 'feat.txt', 'feature\n', 'feat: add')
    const m = tryMerge(project, TASK)
    expect(m.merged).toBe(true)
    const afterMerge = git(repoRoot, 'rev-parse', 'HEAD')
    expect(fs.existsSync(path.join(repoRoot, 'feat.txt'))).toBe(true)

    const countBefore = Number(git(repoRoot, 'rev-list', '--count', 'HEAD'))
    const rv = revertMergeRange(project, m.baseSha!, m.mergedSha!)
    expect(rv.ok).toBe(true)
    // 새 revert 커밋이 생겼다(HEAD 전진, before/afterMerge와 다름 — 히스토리 보존)
    const head = git(repoRoot, 'rev-parse', 'HEAD')
    expect(head).not.toBe(afterMerge)
    expect(Number(git(repoRoot, 'rev-list', '--count', 'HEAD'))).toBeGreaterThan(countBefore)
    // 원 병합 커밋은 여전히 히스토리에 있다(비파괴 — reset 아님)
    expect(git(repoRoot, 'cat-file', '-t', afterMerge)).toBe('commit')
    // 되돌린 파일은 작업트리에서 사라졌다
    expect(fs.existsSync(path.join(repoRoot, 'feat.txt'))).toBe(false)
    removeWorktree(project, TASK, true)
  })

  it('메인이 dirty면 되돌리지 않는다', () => {
    createWorktree(project, TASK)
    const wt = path.join(DATA_DIR, 'wt', TASK)
    writeCommit(wt, 'feat.txt', 'feature\n', 'feat: add')
    const m = tryMerge(project, TASK)
    expect(m.merged).toBe(true)
    // 메인 dirty
    fs.writeFileSync(path.join(repoRoot, 'base.txt'), 'dirty\n')
    const rv = revertMergeRange(project, m.baseSha!, m.mergedSha!)
    expect(rv.ok).toBe(false)
    expect(rv.reason).toContain('dirty')
    git(repoRoot, 'checkout', '--', 'base.txt')
    removeWorktree(project, TASK, true)
  })

  it('revert 충돌이면 abort하고 main HEAD를 원복한다(비파괴)', () => {
    const before = git(repoRoot, 'rev-parse', 'HEAD')
    createWorktree(project, TASK)
    const wt = path.join(DATA_DIR, 'wt', TASK)
    // worktree가 base.txt를 바꿔 병합
    writeCommit(wt, 'base.txt', 'v2\n', 'feat: edit base')
    const m = tryMerge(project, TASK)
    expect(m.merged).toBe(true)
    // 병합 후 main에서 같은 줄을 또 바꿔 revert가 충돌하게 만든다
    writeCommit(repoRoot, 'base.txt', 'v3\n', 'main: edit again')
    const mainTip = git(repoRoot, 'rev-parse', 'HEAD')

    const rv = revertMergeRange(project, m.baseSha!, m.mergedSha!)
    expect(rv.ok).toBe(false)
    expect(rv.reason).toContain('충돌')
    // abort로 원복: main HEAD 그대로, revert 진행 중 아님
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(mainTip)
    // 작업트리 clean(revert 진행 잔재 없음)
    expect(git(repoRoot, 'status', '--porcelain')).toBe('')
    expect(before).not.toBe(mainTip)
    removeWorktree(project, TASK, true)
  })
})

describe('D8 mergeTargetRef', () => {
  it('main 체크아웃의 현재 HEAD를 반환한다', () => {
    const head = git(repoRoot, 'rev-parse', 'HEAD')
    expect(mergeTargetRef(project)).toBe(head)
  })
})
