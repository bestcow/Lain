// §23 평가 하네스 — 자기개선이 지표를 실제로 올리는지 A/B로 측정.
// 같은 벤치 task 묶음을 학습 off/on 두 조건으로 돌려 성공률·1회통과율·턴·비용 비교.
// Hermes(curator)도 "사용량"만 보고 "효과"는 측정 안 함 → lain의 차별점.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BENCH_DIR, DATA_DIR } from './paths'
import { addProject } from './registry'
import { startTask } from './orchestrator'
import { removeWorktree } from './worktree'
import { notifyUser } from './notify'
import {
  deleteAllLessons,
  deleteProject,
  getProject,
  getTask,
  insertBenchResult,
  insertLesson,
  snapshotLessonsForBench,
  restoreLessonsFromBenchSnapshot,
  listTaskEvents,
} from './store'
import type { BenchSummary, BenchTaskResult } from '../shared/types'

const BENCH_TMP = path.join(DATA_DIR, 'bench-tmp')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true })
}

interface BenchTaskDef {
  id: string
  dir: string
  seedLessons: { trigger: string; lesson: string; scope?: 'project' | 'global' }[]
}

function loadBenchTasks(benchRoot: string): BenchTaskDef[] {
  if (!fs.existsSync(benchRoot)) return []
  const tasks: BenchTaskDef[] = []
  for (const entry of fs.readdirSync(benchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(benchRoot, entry.name)
    if (!fs.existsSync(path.join(dir, 'TASK.md'))) continue
    let seedLessons: BenchTaskDef['seedLessons'] = []
    const lp = path.join(dir, 'lessons.json')
    if (fs.existsSync(lp)) {
      try {
        seedLessons = JSON.parse(fs.readFileSync(lp, 'utf8'))
      } catch {
        /* 무시 */
      }
    }
    tasks.push({ id: entry.name, dir, seedLessons })
  }
  return tasks
}

// fixture(파일들)를 임시 git repo로 만들어 등록. lessons.json은 fixture 밖이라 복사 안 됨.
// Windows에서 .git objects는 read-only라 rmSync가 EPERM 날 수 있음 — retry로 흡수.
function rmTree(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* best-effort — 잔재는 다음 실행 시작 시 정리 */
  }
}

function materialize(
  def: BenchTaskDef,
  runId: string,
  condition: string,
): { projectId: string; repo: string } {
  const repo = path.join(BENCH_TMP, `${runId}-${condition}-${def.id}`)
  rmTree(repo)
  fs.mkdirSync(repo, { recursive: true })
  for (const f of fs.readdirSync(def.dir)) {
    if (f === 'lessons.json') continue
    fs.cpSync(path.join(def.dir, f), path.join(repo, f), { recursive: true })
  }
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'bench@lain.local')
  git(repo, 'config', 'user.name', 'lain-bench')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'bench fixture', '--no-gpg-sign')
  const project = addProject(repo)
  return { projectId: project.id, repo }
}

const POLL_MS = 3000
const TASK_TIMEOUT_MS = 8 * 60_000

async function waitTerminal(taskId: string): Promise<void> {
  const deadline = Date.now() + TASK_TIMEOUT_MS
  for (;;) {
    const t = getTask(taskId)
    if (!t || ['review', 'done', 'error', 'cancelled', 'blocked'].includes(t.state)) return
    if (Date.now() > deadline) return
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

async function runOne(
  def: BenchTaskDef,
  condition: 'no-lessons' | 'with-lessons',
  runId: string,
): Promise<BenchTaskResult> {
  const { projectId, repo } = materialize(def, runId, condition)
  let benchTaskId: string | undefined
  try {
    if (condition === 'with-lessons') {
      for (const l of def.seedLessons) {
        insertLesson({
          projectId,
          taskId: 'bench-seed',
          scope: l.scope ?? 'project',
          trigger: l.trigger,
          lesson: l.lesson,
        })
      }
    }
    const { taskId } = await startTask(projectId, { skipClarify: true })
    if (!taskId) {
      return mkResult(def.id, condition, false, false, 0, 0, 0)
    }
    benchTaskId = taskId
    await waitTerminal(taskId)
    const t = getTask(taskId)
    const success = !!t && t.state === 'review' && t.verifyResult === 'pass'
    // verify 1회차 통과 = "verify 실행 (N회차)" 이벤트가 1개뿐
    const verifyRuns = listTaskEvents(taskId).filter((e) =>
      e.text.includes('verify 실행'),
    ).length
    const verifyFirstPass = success && verifyRuns <= 1
    return mkResult(
      def.id,
      condition,
      success,
      verifyFirstPass,
      t?.turns ?? 0,
      t?.costUsd ?? 0,
      t?.tokens ?? 0,
    )
  } finally {
    // 정리: worktree(data/wt/<taskId>) → 레지스트리 → 임시 repo
    const proj = getProject(projectId)
    if (proj && benchTaskId) {
      try {
        removeWorktree(proj, benchTaskId, true)
      } catch {
        /* 무시 */
      }
    }
    deleteProject(projectId)
    rmTree(repo)
  }
}

function mkResult(
  benchTask: string,
  condition: 'no-lessons' | 'with-lessons',
  success: boolean,
  verifyFirstPass: boolean,
  turns: number,
  costUsd: number,
  tokens: number,
): BenchTaskResult {
  return { benchTask, condition, success, verifyFirstPass, turns, costUsd, tokens }
}

export function aggregate(runId: string, results: BenchTaskResult[], startedAt: string): BenchSummary {
  const byCondition: BenchSummary['byCondition'] = {}
  for (const cond of ['no-lessons', 'with-lessons']) {
    const rs = results.filter((r) => r.condition === cond)
    if (rs.length === 0) continue
    const n = rs.length
    byCondition[cond] = {
      n,
      successRate: rs.filter((r) => r.success).length / n,
      firstPassRate: rs.filter((r) => r.verifyFirstPass).length / n,
      avgTurns: rs.reduce((s, r) => s + r.turns, 0) / n,
      avgCost: rs.reduce((s, r) => s + r.costUsd, 0) / n,
      avgTokens: rs.reduce((s, r) => s + r.tokens, 0) / n,
    }
  }
  return { runId, startedAt, byCondition, results, regression: detectRegression(byCondition) }
}

/** §24 회귀 감지 — 학습 ON이 OFF보다 지표를 악화시키면 경보. 자기개선이 '틀린 학습 누적'으로
 *  역효과를 내는 경우(§22.2)를 평가 하네스가 CI처럼 잡아내게 한다. 둘 다 있을 때만 비교. */
function detectRegression(bc: BenchSummary['byCondition']): string | null {
  const off = bc['no-lessons']
  const on = bc['with-lessons']
  if (!off || !on) return null
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const issues: string[] = []
  if (on.successRate < off.successRate - 1e-9)
    issues.push(`성공률 하락 ${pct(off.successRate)}→${pct(on.successRate)}`)
  if (on.firstPassRate < off.firstPassRate - 1e-9)
    issues.push(`1회통과율 하락 ${pct(off.firstPassRate)}→${pct(on.firstPassRate)}`)
  // 효율 회귀는 성공률이 떨어지지 않은 전제에서만 의미(학습은 효율을 올려야 함 §23.2). >10% 악화면 경보.
  if (on.successRate >= off.successRate - 1e-9) {
    if (off.avgTurns > 0 && on.avgTurns > off.avgTurns * 1.1)
      issues.push(`평균 턴 증가 ${off.avgTurns.toFixed(1)}→${on.avgTurns.toFixed(1)}`)
    if (on.avgCost > off.avgCost * 1.1 && on.avgCost - off.avgCost > 0.01)
      issues.push(`평균 비용 증가 $${off.avgCost.toFixed(3)}→$${on.avgCost.toFixed(3)}`)
  }
  return issues.length
    ? `⚠️ 학습 회귀 의심: ${issues.join('; ')} — 틀린 학습 누적 가능(§22.2). 학습 정제(curator) 필요.`
    : null
}

/** 벤치 1회 실행: 모든 bench task를 두 조건으로 순차 실행하고 집계.
 *  conditions를 좁혀 한 조건만 돌릴 수도 있다(빠른 확인용). */
export async function runBench(
  startedAt: string,
  opts: {
    benchRoot?: string
    conditions?: ('no-lessons' | 'with-lessons')[]
    onProgress?: (msg: string) => void
  } = {},
): Promise<BenchSummary> {
  const runId = `bench-${crypto.randomBytes(3).toString('hex')}`
  const benchRoot = opts.benchRoot ?? BENCH_DIR
  const conditions = opts.conditions ?? (['no-lessons', 'with-lessons'] as const)
  const progress = opts.onProgress ?? (() => {})
  const tasks = loadBenchTasks(benchRoot)
  fs.mkdirSync(BENCH_TMP, { recursive: true })
  const results: BenchTaskResult[] = []
  // 사용자 학습 보호 — 조건 격리는 스냅샷 안에서만. 중간에 throw/크래시해도 finally·부팅 복원으로 원본 보존.
  snapshotLessonsForBench()
  try {
    for (const cond of conditions) {
      // 조건 간 학습 격리 — no-lessons는 빈 상태에서 출발
      deleteAllLessons()
      for (const def of tasks) {
        progress(`[${cond}] ${def.id} 실행 중...`)
        const r = await runOne(def, cond, runId)
        insertBenchResult(runId, r)
        results.push(r)
        progress(
          `[${cond}] ${def.id}: ${r.success ? 'OK' : 'FAIL'} (1회통과 ${r.verifyFirstPass ? 'Y' : 'N'}, ${r.turns}턴)`,
        )
      }
    }
  } finally {
    restoreLessonsFromBenchSnapshot()
  }
  const summary = aggregate(runId, results, startedAt)
  if (summary.regression) {
    progress(summary.regression)
    notifyUser('lain — 벤치 회귀 경보', summary.regression.slice(0, 120))
  }
  return summary
}
