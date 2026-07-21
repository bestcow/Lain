import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'

// worktree.ts의 git 헬퍼(execFileSync 동기 호출)에 timeout이 걸려 있는지 — git index lock 경합이나
// credential prompt로 git이 매달리면 Electron 메인 프로세스 전체가 동기 블로킹되는 것을 막는다.
// 실제 git은 절대 스폰하지 않고 child_process를 목으로 세워 옵션만 검사한다(verifyindir.test.ts와 동형).
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn(() => '') }))
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: require('node:os').tmpdir(),
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { mergeTargetRef, diffStat, commitCount } from '../../src/main/worktree'
import type { Project } from '../../src/shared/types'

const project: Project = {
  id: 'wt-timeout', path: 'C:/tmp/wt-timeout-proj', name: 'wt-timeout', stack: '',
  verifyCmd: null, isGit: true,
} as Project

describe('worktree git 호출 — 동기 블로킹 방지 timeout', () => {
  it('모든 execFileSync git 호출에 timeout(30초)이 걸려 있다', () => {
    execFileSyncMock.mockClear()
    // git() 헬퍼를 지나는 대표 경로들 — 전 호출이 공용 헬퍼라 옵션은 전부 동일해야 한다.
    mergeTargetRef(project)
    diffStat(project, 'tid')
    commitCount(project, 'tid')

    expect(execFileSyncMock.mock.calls.length).toBeGreaterThan(0)
    for (const call of execFileSyncMock.mock.calls) {
      const opts = call[2] as Record<string, unknown>
      expect(opts?.timeout).toBe(30_000)
    }
  })
})
