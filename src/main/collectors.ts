// 현황 수집 (PLAN.md §10.1) — 읽기 전용, LLM 토큰 0. git/grep/verify를 셸로 직접.
import { execFile, exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { Project, ProjectStatus } from '../shared/types'
import { saveStatus } from './store'

const execFileP = promisify(execFile)
const execP = promisify(exec)

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, timeout: 15_000 })
    return stdout.trim()
  } catch {
    return null
  }
}

/** git/TODO 현황 수집 → 저장. test_state는 건드리지 않음(verify 전용). */
export async function collectStatus(p: Project): Promise<void> {
  const patch: Partial<ProjectStatus> & { projectId: string } = { projectId: p.id }
  patch.hasTaskMd = fs.existsSync(path.join(p.path, 'TASK.md'))

  if (p.isGit) {
    patch.gitBranch = await git(p.path, 'rev-parse', '--abbrev-ref', 'HEAD')

    const porcelain = await git(p.path, 'status', '--porcelain')
    patch.dirtyFiles = porcelain ? porcelain.split('\n').filter(Boolean).length : 0

    const last = await git(p.path, 'log', '-1', '--format=%s%x00%cI')
    if (last) {
      const [subject, date] = last.split('\0')
      patch.lastCommit = subject ?? null
      patch.lastCommitAt = date ?? null
    }

    // upstream 없으면 실패 → 0/0 유지
    const counts = await git(p.path, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}')
    if (counts) {
      const [ahead, behind] = counts.split(/\s+/).map((n) => parseInt(n, 10))
      patch.ahead = Number.isFinite(ahead) ? ahead : 0
      patch.behind = Number.isFinite(behind) ? behind : 0
    } else {
      patch.ahead = 0
      patch.behind = 0
    }

    // git grep -c → "file:count" 줄들. 매치 없으면 exit 1 → null → 0
    const grep = await git(p.path, 'grep', '-c', '-e', 'TODO', '-e', 'FIXME')
    patch.todoCount = grep
      ? grep.split('\n').reduce((sum, line) => {
          const n = parseInt(line.slice(line.lastIndexOf(':') + 1), 10)
          return sum + (Number.isFinite(n) ? n : 0)
        }, 0)
      : 0
  } else {
    patch.gitBranch = null
    patch.dirtyFiles = 0
    patch.ahead = 0
    patch.behind = 0
    patch.todoCount = 0
  }

  saveStatus(patch)
}

const TAIL_CHARS = 2000

/** verify_cmd 실행 → pass/fail + 출력 꼬리 저장. 수동 트리거 전용(Phase 0). */
export async function runVerify(p: Project): Promise<void> {
  if (!p.verifyCmd) return
  saveStatus({ projectId: p.id, testState: 'running' })
  try {
    const { stdout, stderr } = await execP(p.verifyCmd, {
      cwd: p.path,
      windowsHide: true,
      timeout: 5 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    saveStatus({
      projectId: p.id,
      testState: 'pass',
      testOutputTail: (stdout + stderr).slice(-TAIL_CHARS),
    })
  } catch (e: any) {
    const tail = (String(e?.stdout ?? '') + String(e?.stderr ?? '') || String(e)).slice(-TAIL_CHARS)
    saveStatus({ projectId: p.id, testState: 'fail', testOutputTail: tail })
  }
}
