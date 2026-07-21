import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 경합(race) 버그 재현 — orchestrator.test.ts와 동형 격리(paths·worktree·collectors·worker·notify 모킹)에
// 더해, elicit이 쓰는 SDK query()를 게이트 가능한 목으로 덮어 clarify await 중 cancelTask를 끼워 넣는다.
const { DATA_DIR: TEST_DATA_DIR } = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const ph = require('node:path') as typeof import('node:path')
  const osh = require('node:os') as typeof import('node:os')
  const tmpDir = fsh.mkdtempSync(ph.join(osh.tmpdir(), 'lain-orace-'))
  return { DATA_DIR: tmpDir }
})

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

// worktree — 실제 git 없이 빈 응답. createWorktree 호출 여부가 #1 부활 판정의 핵심(좀비 worktree 방지).
vi.mock('../../src/main/worktree', () => ({
  createWorktree: vi.fn(() => ({ branch: 'race-branch', path: require('node:os').tmpdir(), depsWarning: null })),
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

// worker — runNavi/isNaviRunning를 목으로. #2에서 verify-재시도 runNavi 중 인터럽트를 주입한다.
vi.mock('../../src/main/worker', () => ({
  runNavi: vi.fn(async () => ({ status: 'done', summary: '', questions: [] })),
  abortNavi: vi.fn(),
  waitApproval: vi.fn(),
  isNaviRunning: vi.fn(() => false),
  isAwaitingApproval: vi.fn(() => false),
  approvalTimeoutMs: vi.fn(() => 0),
}))

vi.mock('../../src/main/notify', () => ({ notifyUser: vi.fn() }))

// SDK query() — elicit(§21.3)가 쓴다. 게이트 프라미스로 clarify await를 붙잡아 그 사이 cancelTask를 끼운다.
// 빈 스트림(yield 없음) → elicit이 criteria/questions 없이 반환 → clarifyAndLaunch가 launch로 진행(부활 유도).
const { elicitGate } = vi.hoisted(() => ({ elicitGate: { release: () => {} } }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() =>
    (async function* () {
      await new Promise<void>((r) => {
        elicitGate.release = r
      })
    })(),
  ),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
}))

import {
  initStore,
  closeStore,
  upsertProject,
  getTask,
  saveSettings,
} from '../../src/main/store'
import { startTask, cancelTask, interruptTask } from '../../src/main/orchestrator'
import { createWorktree } from '../../src/main/worktree'
import { runNavi, isNaviRunning } from '../../src/main/worker'
import type { Task } from '../../src/shared/types'

const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
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
  upsertProject({
    id: 'race-clarify', path: os.tmpdir(), name: 'race-clarify', stack: '',
    verifyCmd: null, isGit: true,
  })
  upsertProject({
    id: 'race-verify', path: os.tmpdir(), name: 'race-verify', stack: '',
    verifyCmd: 'exit 1', // finishWork verify를 항상 실패시켜 재시도 경로(runNavi at 982)를 태운다
    isGit: true,
  })
})

afterAll(() => {
  closeStore()
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

// 버그 #1 — cancelTask 상태 가드 없음: clarifying 단계(elicit await 중) 취소가 clarifyAndLaunch/launch에
// 의해 되살아나 worktree까지 만들어지는 경합. 취소가 이겨야 한다(부활·좀비 worktree 없음).
describe('cancelTask — clarify 단계 취소 부활 레이스(#1)', () => {
  it('elicit await 중 취소하면 launch가 되살리지 않는다 — cancelled 유지, worktree 미생성', async () => {
    vi.mocked(createWorktree).mockClear()
    vi.mocked(runNavi).mockClear()

    const r = await startTask('race-clarify', { content: '취소될 작업(모호함 없음)' })
    expect(r.taskId).toBeTruthy()
    const id = r.taskId!

    // clarifyAndLaunch → elicit → query() → for await 가 게이트에서 멈출 때까지 진행시킨다.
    await flush(12)
    expect(getTask(id)!.state).toBe('clarifying')

    // elicit await 중 사용자 취소. clarifying은 worktree 전이라 state만 'cancelled'로 바뀐다.
    cancelTask(id)
    expect(getTask(id)!.state).toBe('cancelled')

    // 게이트 해제 → elicit 완료 → clarifyAndLaunch가 이어서 launch를 시도한다.
    elicitGate.release()
    await flush(20)
    await sleep(30)

    // ★ 부활 금지: cancelled 유지, worktree 생성·runNavi 실행 없음.
    expect(getTask(id)!.state).toBe('cancelled')
    expect(vi.mocked(createWorktree)).not.toHaveBeenCalled()
    expect(vi.mocked(runNavi)).not.toHaveBeenCalled()
  })
})

// 버그 #2 — interruptTask가 finishWork의 verify-재시도 runNavi(runWithInterrupts 밖) 중에 걸리면
// 인터럽트 메시지가 interruptMsgs에 남아 소비되지 않고 유실된다. drainInterrupts로 회수돼 후속 resume에
// 반드시 실려야 한다.
describe('interruptTask — verify 재시도 경로 인터럽트 유실(#2)', () => {
  it('verify 재시도 runNavi 중 인터럽트가 후속 세션 resume에 반영된다(유실 금지)', async () => {
    const MARK = 'INTERRUPT_MARKER_XYZ'
    vi.mocked(isNaviRunning).mockReturnValue(true) // interruptTask 게이트 통과
    vi.mocked(runNavi).mockReset()
    let injectedOnce = false
    vi.mocked(runNavi).mockImplementation(async (t: Task, _emit, opts: any) => {
      // verify 실패 피드백 재개(= runWithInterrupts 밖)일 때 딱 1회 사용자 인터럽트를 끼운다.
      if (opts?.resumePrompt?.includes('검증 명령') && !injectedOnce) {
        injectedOnce = true
        const ok = interruptTask(t.id, MARK)
        expect(ok).toBe(true) // 인터럽트는 수락된다(→ 반드시 반영돼야 유실 아님)
      }
      return { status: 'done', summary: '', questions: [] }
    })

    const r = await startTask('race-verify', { content: 'verify 실패 재시도 작업', skipClarify: true })
    const id = r.taskId!
    await waitForState(id, 'review')
    expect(getTask(id)!.state).toBe('review')

    // ★ 인터럽트 메시지가 어느 runNavi 재개 프롬프트엔가 반드시 실렸다(유실 아님).
    const carried = vi
      .mocked(runNavi)
      .mock.calls.some((c) => String((c[2] as any)?.resumePrompt ?? '').includes(MARK))
    expect(carried).toBe(true)

    // 정리
    vi.mocked(isNaviRunning).mockReturnValue(false)
    vi.mocked(runNavi).mockImplementation(async () => ({ status: 'done', summary: '', questions: [] }))
  })
})
