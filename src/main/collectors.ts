// 현황 수집 (PLAN.md §10.1) — 읽기 전용, LLM 토큰 0. git/grep/verify를 셸로 직접.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { Project, ProjectStatus } from '../shared/types'
import { saveStatus } from './store'
import { killTree } from './prockill'

const execFileP = promisify(execFile)

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
  // 예외 격리(#12) — 호출부 4곳(index/ipc/scheduler/telegram)이 전부 Promise.all 일괄 수집이라
  // 한 프로젝트의 예외(saveStatus DB 오류 등)가 새면 스캔 사이클 전체(자동착수·알림 포함)가 죽는다.
  // 호출부 수정 대신 함수 안 한 곳에서 흡수한다(최소 침습 — git()은 이미 개별 catch로 null 폴백).
  try {
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
  } catch (e) {
    // 이 프로젝트만 이번 사이클 갱신 실패 — 다음 스캔이 자연 재시도한다.
    console.error(`collectStatus(${p.id}) 실패:`, e)
  }
}

const TAIL_CHARS = 2000
const VERIFY_TIMEOUT = 5 * 60_000
// 보관 버퍼 상한(구 maxBuffer 대체) — 프로세스는 죽이지 않고 꼬리만 유지해 메모리를 묶는다.
const OUTPUT_CAP = 10 * 1024 * 1024

/** 임의 디렉터리에서 verify 명령 실행 → pass/fail + 출력 꼬리. DB에 저장하지 않음(순수 실행).
 * D8 rebase 폴백이 worktree(project status와 별개)에서 검증을 다시 돌리는 데 재사용한다.
 *
 * spawn(shell) 기반 — 타임아웃 시 Windows는 직속 자식(cmd.exe)만 죽이면 손자(node/vitest 등)가
 * 고아로 남으므로 killTree로 프로세스 트리 전체를 종료한다(비 win32는 표준 kill). 반환 계약은
 * 기존 execP 판정을 그대로 보존한다: pass = 종료코드 0(타임아웃/스폰오류 아님), tail = (stdout+stderr)
 * 꼬리(TAIL_CHARS), 실패 시 출력이 비면 사유 문자열로 폴백. */
export function verifyInDir(cmd: string, cwd: string): Promise<{ pass: boolean; tail: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const done = (pass: boolean, fallback: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const combined = (stdout + stderr).slice(-TAIL_CHARS)
      // 성공은 출력 그대로(빈 문자열도 원계약 유지), 실패는 출력이 비면 사유로 폴백.
      resolve({ pass, tail: pass ? combined : combined || fallback.slice(-TAIL_CHARS) })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, { cwd, shell: true, windowsHide: true })
    } catch (e) {
      done(false, String(e))
      return
    }

    timer = setTimeout(() => {
      killTree(child.pid) // 트리 전체 종료 — 손자 고아 방지
      done(false, `verify 타임아웃(${VERIFY_TIMEOUT / 1000}s 초과): ${cmd}`)
    }, VERIFY_TIMEOUT)

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > OUTPUT_CAP) stdout = stdout.slice(-OUTPUT_CAP)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > OUTPUT_CAP) stderr = stderr.slice(-OUTPUT_CAP)
    })
    child.on('error', (e) => done(false, String(e)))
    child.on('close', (code) => done(code === 0, `exit ${code}`))
  })
}

/** verify_cmd 실행 → pass/fail + 출력 꼬리 저장. 수동 트리거 전용(Phase 0). */
export async function runVerify(p: Project): Promise<void> {
  if (!p.verifyCmd) return
  saveStatus({ projectId: p.id, testState: 'running' })
  const { pass, tail } = await verifyInDir(p.verifyCmd, p.path)
  saveStatus({ projectId: p.id, testState: pass ? 'pass' : 'fail', testOutputTail: tail })
}
