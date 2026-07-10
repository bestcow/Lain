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

/** 임의 디렉터리에서 verify 명령 실행 → pass/fail + 출력 꼬리. DB에 저장하지 않음(순수 실행).
 * D8 rebase 폴백이 worktree(project status와 별개)에서 검증을 다시 돌리는 데 재사용한다. */
export async function verifyInDir(
  cmd: string,
  cwd: string,
): Promise<{ pass: boolean; tail: string }> {
  try {
    const { stdout, stderr } = await execP(cmd, {
      cwd,
      windowsHide: true,
      timeout: 5 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { pass: true, tail: (stdout + stderr).slice(-TAIL_CHARS) }
  } catch (e: any) {
    const tail = (String(e?.stdout ?? '') + String(e?.stderr ?? '') || String(e)).slice(-TAIL_CHARS)
    return { pass: false, tail }
  }
}

/** verify_cmd 실행 → pass/fail + 출력 꼬리 저장. 수동 트리거 전용(Phase 0). */
export async function runVerify(p: Project): Promise<void> {
  if (!p.verifyCmd) return
  saveStatus({ projectId: p.id, testState: 'running' })
  const { pass, tail } = await verifyInDir(p.verifyCmd, p.path)
  saveStatus({ projectId: p.id, testState: pass ? 'pass' : 'fail', testOutputTail: tail })
}
