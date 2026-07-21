import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// finishWork verify 경로 — execP 직호출이 아니라 collectors.verifyInDir(타임아웃 시 killTree로
// 프로세스 트리 전체 종료)를 경유하는지 단언한다. execP는 Windows 타임아웃 시 cmd.exe만 죽여
// 고아 vitest/dev서버가 포트·파일락을 점유하는 문제가 있었다(collectors.ts 주석 참조).
// 격리는 orchestrator-race.test.ts와 동형(paths·worktree·collectors·worker·notify·audit 모킹).
const { DATA_DIR: TEST_DATA_DIR, WT_PATH } = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const ph = require('node:path') as typeof import('node:path')
  const osh = require('node:os') as typeof import('node:os')
  return {
    DATA_DIR: fsh.mkdtempSync(ph.join(osh.tmpdir(), 'lain-overify-')),
    WT_PATH: fsh.mkdtempSync(ph.join(osh.tmpdir(), 'lain-overify-wt-')),
  }
})

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

// worktree — 실제 git 없이 빈 응답. createWorktree가 돌려주는 경로(WT_PATH)가 verifyInDir cwd 인자로
// 그대로 전달되는지가 이 파일의 핵심 단언.
vi.mock('../../src/main/worktree', () => ({
  createWorktree: vi.fn(() => ({ branch: 'verify-branch', path: WT_PATH, depsWarning: null })),
  removeWorktree: vi.fn(),
  diffStat: vi.fn(() => ''),
  changedFiles: vi.fn(() => []),
  tryMerge: vi.fn(() => ({ merged: false, reason: 'mocked' })),
  rebaseWorktreeOntoMain: vi.fn(() => ({ ok: true, reason: 'rebased' })),
  revertMergeRange: vi.fn(() => ({ ok: true, reason: 'reverted' })),
}))

vi.mock('../../src/main/collectors', () => ({
  verifyInDir: vi.fn(async () => ({ pass: true, tail: '' })),
}))

vi.mock('../../src/main/worker', () => ({
  runNavi: vi.fn(async () => ({ status: 'done', summary: '', questions: [] })),
  abortNavi: vi.fn(),
  waitApproval: vi.fn(),
  isNaviRunning: vi.fn(() => false),
  isAwaitingApproval: vi.fn(() => false),
  approvalTimeoutMs: vi.fn(() => 0),
}))

vi.mock('../../src/main/notify', () => ({ notifyUser: vi.fn() }))

// T14 심사 — verify 통과 후 게이트가 SDK를 부르지 않게 목으로(null = 심사 생략과 동일 합류).
vi.mock('../../src/main/audit', () => ({ runAudit: vi.fn(async () => null) }))

import { initStore, closeStore, upsertProject, getTask, saveSettings } from '../../src/main/store'
import { startTask } from '../../src/main/orchestrator'
import { verifyInDir } from '../../src/main/collectors'
import { runNavi } from '../../src/main/worker'
import type { Task } from '../../src/shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const waitForState = async (id: string, want: Task['state'], timeoutMs = 8000): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (getTask(id)?.state === want) return
    await sleep(15)
  }
}

beforeAll(() => {
  initStore()
  saveSettings({ concurrencyCap: 20, projectParallelCap: 1 })
  // review 상태도 활성으로 계수돼 같은 프로젝트 재사용이 큐로 빠진다 — 테스트별 전용 프로젝트.
  upsertProject({
    id: 'verify-pass', path: os.tmpdir(), name: 'verify-pass', stack: '',
    verifyCmd: 'npm test', isGit: true,
  })
  upsertProject({
    id: 'verify-retry', path: os.tmpdir(), name: 'verify-retry', stack: '',
    verifyCmd: 'npm test', isGit: true,
  })
})

afterAll(() => {
  closeStore()
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  try { fs.rmSync(WT_PATH, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('finishWork verify — verifyInDir 경유(고아 프로세스 차단)', () => {
  it('verifyInDir(verifyCmd, worktreePath)를 호출하고, 통과 시 review·verifyResult pass', async () => {
    vi.mocked(verifyInDir).mockClear()

    const r = await startTask('verify-pass', { content: '검증 경유 작업', skipClarify: true })
    expect(r.taskId).toBeTruthy()
    const id = r.taskId!
    await waitForState(id, 'review')

    const t = getTask(id)!
    expect(t.state).toBe('review')
    expect(t.verifyResult).toBe('pass')
    // ★ 핵심 — verify는 execP 직호출이 아니라 verifyInDir 경유(명령·worktree 경로 그대로 전달).
    expect(vi.mocked(verifyInDir)).toHaveBeenCalledWith('npm test', WT_PATH)
  })

  it('실패 시 verifyInDir tail이 Navi 재시도 resumePrompt에 실리고, 재검증 통과로 review', async () => {
    vi.mocked(verifyInDir).mockClear()
    // 1회차 실패(재시도 가능한 테스트 실패) → 2회차부터 기본 구현(pass)으로 복귀.
    vi.mocked(verifyInDir).mockResolvedValueOnce({ pass: false, tail: 'AssertionError: expected 1 to be 2' })

    const r = await startTask('verify-retry', { content: '재시도 작업', skipClarify: true })
    const id = r.taskId!
    await waitForState(id, 'review')

    expect(getTask(id)!.state).toBe('review')
    expect(getTask(id)!.verifyResult).toBe('pass')
    // 실패 출력(tail)이 execP의 e.stdout/e.stderr 대신 verifyInDir 반환값에서 조립돼 피드백에 실린다.
    const fed = vi
      .mocked(runNavi)
      .mock.calls.some((c) => String((c[2] as any)?.resumePrompt ?? '').includes('AssertionError: expected 1 to be 2'))
    expect(fed).toBe(true)
    expect(vi.mocked(verifyInDir).mock.calls.length).toBeGreaterThanOrEqual(2) // 실패 1회 + 재검증
  })
})
