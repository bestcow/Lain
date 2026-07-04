// 오케스트레이터 (PLAN.md §8) — task 상태머신과 실행 흐름.
// TASK.md 로드 → 관리자 명확화 → worktree 격리 Navi → verify → review → 사람 결정.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, AGENT_CWD, CLAUDE_BIN } from './paths'
import {
  activeTaskForProject,
  getProject,
  getTask,
  insertTask,
  listTasks,
  updateTask,
  addTaskEvent,
  insertApproval,
  getSettings,
  insertLesson,
  lessonsForProject,
  bumpLessonReuse,
} from './store'
import { createWorktree, removeWorktree, diffStat, changedFiles, tryMerge } from './worktree'
import { isTestFile } from './safety'
import { runNavi, abortNavi, waitApproval, isNaviRunning } from './worker'
import { saveStatus } from './store'
import { tierQueryOptions } from './agentopts'
import { notifyUser } from './notify'
import { frameMessage, type NaviSender } from './navisender'
import type {
  Project,
  Task,
  TaskEvent,
  NaviMode,
  TaskPermissionMode,
  ThinkingLevel,
} from '../shared/types'

const execP = promisify(exec)

// §5.7 인터럽트 — 실행 중 Navi에 끼어든 사용자 메시지. abort 후 이 메시지를
// resume 프롬프트로 전달해 컨텍스트 유지로 이어간다(§18 실측: streaming-input
// interrupt는 컨텍스트 유실 → abort+resume이 안전).
const interruptMsgs = new Map<string, string>()

type Emit = (ev: TaskEvent) => void
let emitGlobal: Emit = () => {}
let tasksChanged: () => void = () => {}
let projectsChanged: () => void = () => {}

export function bindOrchestrator(
  emit: Emit,
  onTasksChanged: () => void,
  onProjectsChanged: () => void = () => {},
): void {
  emitGlobal = emit
  tasksChanged = onTasksChanged
  projectsChanged = onProjectsChanged
}

function log(taskId: string, kind: TaskEvent['kind'], text: string, speaker?: TaskEvent['speaker']): void {
  addTaskEvent(taskId, kind, text, speaker)
  emitGlobal({ taskId, kind, text, speaker } as TaskEvent)
}

function setState(taskId: string, state: Task['state'], extra?: Partial<Task>): void {
  updateTask(taskId, { state, ...extra })
  tasksChanged()
}

// ── elicitation 게이트 (§21.3) — "테스트로 적을 수 있나"가 멈춤 게이트 ──
// 실행 전에 요구사항을 합격/불합격 기준(테스트·체크)으로 적어본다. 적히면 잠금,
// "테스트로 못 적겠다"가 곧 기계적 모호함 탐지 → 그 지점만 콕 집어 질문.
// 산출 = 합격 기준 묶음(= 실행의 판사, spec=test=judge). autoGradable로 §21.2 모드 판정.
interface Elicited {
  criteria: string[]
  questions: string[]
  autoGradable: boolean
}
async function elicit(content: string): Promise<Elicited> {
  try {
    let last = ''
    const stream = query({
      prompt: `너는 lain의 elicitation 게이트다(§21.3). 아래 작업 지시서를 *실행하지 말고*, 요구사항을 하나씩 "합격/불합격을 확인할 수 있는 구체적 기준(테스트·체크)"으로 적어본다.

규칙:
- 확인 가능한 기준으로 적히면 criteria에 넣는다. (예: "npm test 통과", "buttonX 클릭 시 모달 열림", "sum(2,3)===5", "/health가 200")
- "테스트로 적을 수 없다"가 곧 모호함 신호다 — 값·범위·대상·판정 방법이 불명확하면 criteria로 만들지 말고 그 지점을 콕 집어 questions에 넣는다(최대 3개). 사소한 재량(변수명 등)은 묻지 않는다.
- autoGradable: criteria가 전부 사람 개입 없이 자동 명령/테스트로 채점 가능하면 true. 시각 확인·주관 판단이 하나라도 필요하면 false.

<task>
${content}
</task>

JSON 한 블록만 출력:
\`\`\`json
{"criteria": ["확인 가능한 합격 기준"], "questions": ["테스트로 못 적는 모호한 지점만"], "autoGradable": true|false}
\`\`\``,
      options: {
        cwd: AGENT_CWD,
        allowedTools: [],
        maxTurns: 2,
        ...tierQueryOptions(getSettings().judgeModel, getSettings()), // §9b — 짧은 판정류(local 라우팅 포함)
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) last = t
      }
    }
    const m = last.match(/```json\s*([\s\S]*?)```/)
    if (m) {
      const obj = JSON.parse(m[1])
      return {
        criteria: Array.isArray(obj.criteria) ? obj.criteria.map(String) : [],
        questions: Array.isArray(obj.questions) ? obj.questions.map(String) : [],
        autoGradable: !!obj.autoGradable,
      }
    }
  } catch {
    /* 판정 실패 → 기준 없이 진행 (게이트가 진행을 막지 않게) */
  }
  return { criteria: [], questions: [], autoGradable: false }
}

const ELICIT_MAX_ROUNDS = 3 // 답변-재elicit 루프 상한 (판사가 끝없이 캐묻는 것 방지)

// §21.2 모드 판정 (순수) — 마커가 최우선, 다음 사용자 기본값(defaultTaskMode), 없으면 자동판정.
// 안전: autonomous는 verify_cmd가 있어야만(테스트=판사). 사용자가 autonomous 기본이어도 verify_cmd 없으면 interactive 폴백.
export function pickTaskMode(
  content: string,
  pref: 'auto' | 'autonomous' | 'interactive',
  autoGradable: boolean,
  hasVerifyCmd: boolean,
): NaviMode {
  if (/lain:interactive|(^|\n)\s*mode:\s*interactive\b/i.test(content)) return 'interactive'
  if (/lain:autonomous|(^|\n)\s*mode:\s*autonomous\b/i.test(content)) return 'autonomous'
  if (pref === 'interactive') return 'interactive'
  if (pref === 'autonomous') return hasVerifyCmd ? 'autonomous' : 'interactive'
  return autoGradable && hasVerifyCmd ? 'autonomous' : 'interactive'
}

function decideMode(taskId: string, autoGradable: boolean): void {
  const task = getTask(taskId)!
  const project = getProject(task.projectId)
  const pref = getSettings().defaultTaskMode
  const mode = pickTaskMode(task.content, pref, autoGradable, !!project?.verifyCmd)
  if (mode !== task.mode) updateTask(taskId, { mode })
  log(taskId, 'status', `mode: ${mode} (기본값 ${pref}${pref === 'auto' ? ', 자동판정' : ''})`)
}

// ── 시작 (§8-1~4) ──
export async function startTask(
  projectId: string,
  opts: {
    skipClarify?: boolean
    content?: string
    mode?: NaviMode
    permissionMode?: TaskPermissionMode
    thinkingLevel?: ThinkingLevel
    disallowedTools?: string[]
    skills?: string[]
    fastMode?: boolean
  } = {},
): Promise<{ taskId?: string; mode?: NaviMode; error?: string }> {
  const project = getProject(projectId)
  if (!project) return { error: '프로젝트 없음' }
  if (!project.isGit) return { error: '비-git 프로젝트는 Phase 1에서 미지원 (§15b)' }
  if (activeTaskForProject(projectId)) return { error: '이미 진행 중인 작업이 있다' }

  // 동시성 cap (§9-7, 기본 2 — settings.concurrency_cap)
  const cap = getSettings().concurrencyCap
  const working = listTasks().filter((t) => t.state === 'working')
  if (working.length >= cap) {
    return { error: `동시 실행 ${cap}개 제한 — ${working.map((t) => t.projectId).join(', ')} 진행 중` }
  }

  // 작업 내용: 채팅으로 받은 ad-hoc 지시(opts.content, Lain 위임 등)가 있으면 그걸, 없으면 TASK.md.
  let content: string
  if (opts.content && opts.content.trim()) {
    content = opts.content
  } else {
    const mdPath = path.join(project.path, 'TASK.md')
    if (!fs.existsSync(mdPath))
      return { error: 'TASK.md 없음 — 루트에 작성하거나 작업 내용을 직접 줘라' }
    content = fs.readFileSync(mdPath, 'utf8')
  }

  const lines = content.split('\n').map((l) => l.trim())
  const body = lines.find((l) => l && !l.startsWith('#')) // 첫 본문 줄(보통 목표)
  const title = (body ?? 'untitled').slice(0, 60)

  // §21.2 모드: 호출자 명시(opts.mode — Lain 위임 등)는 content에 마커로 새겨, 이후 clarify의
  // decideMode(§21.2)도 같은 결정을 따르게 한다(명시 모드가 자동판정에 덮어써지지 않도록).
  if (opts.mode === 'autonomous' && !/lain:autonomous|(^|\n)\s*mode:\s*autonomous\b/i.test(content)) {
    content += '\n\n<!-- lain:autonomous -->\n'
  } else if (
    opts.mode === 'interactive' &&
    !/lain:interactive|(^|\n)\s*mode:\s*interactive\b/i.test(content)
  ) {
    content += '\n\n<!-- lain:interactive -->\n'
  }
  const mode: NaviMode = /(^|\n)\s*mode:\s*autonomous\b|lain:autonomous/i.test(content)
    ? 'autonomous'
    : 'interactive'
  // 무개입(autonomous)은 테스트=판사가 전제(§21.1) — verify_cmd 없으면 자동 채점 불가라 거부.
  if (mode === 'autonomous' && !project.verifyCmd) {
    return {
      error:
        'autonomous(무개입)는 verify_cmd가 필요하다(테스트=판사). interactive로 진행하거나 검증 명령을 먼저 설정해라.',
    }
  }

  const taskId = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`
  insertTask({
    id: taskId,
    projectId,
    title,
    state: 'clarifying',
    content,
    mode,
    permissionMode: opts.permissionMode,
    thinkingLevel: opts.thinkingLevel,
    disallowedTools: opts.disallowedTools,
    skills: opts.skills,
    fastMode: opts.fastMode,
  })
  tasksChanged()
  log(taskId, 'status', `작업 생성[${mode}]: ${title}`)

  // §23 벤치는 clarify를 건너뛴다(측정 일관성 — 명세 명확한 fixture 전제)
  if (opts.skipClarify) void launch(taskId)
  else void clarifyAndLaunch(taskId)

  return { taskId, mode }
}

// elicitation 게이트 → launch. startTask와 크래시 복원(§15b)이 공유.
// "테스트로 못 적는 지점"이 있으면 blocked로 질문(최대 ELICIT_MAX_ROUNDS회 반복).
// 전부 기준으로 적히면 합격 기준을 Navi DoD로 주입하고 §21.2 모드 판정 후 실행.
async function clarifyAndLaunch(taskId: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  const rounds = (task.content.match(/## 추가 답변/g) ?? []).length
  const v = await elicit(task.content)

  if (v.questions.length > 0 && rounds < ELICIT_MAX_ROUNDS) {
    setState(taskId, 'blocked', { questions: v.questions })
    log(taskId, 'status', `elicitation — 테스트로 못 적는 지점 ${v.questions.length}건, 답변 대기 (${rounds + 1}/${ELICIT_MAX_ROUNDS})`)
    notifyUser('lain — 질문', `${task.projectId}: 명세 모호 ${v.questions.length}건`)
    return
  }
  if (v.questions.length > 0) {
    log(taskId, 'status', `elicitation 라운드 상한 도달 — 남은 모호함 감수하고 진행`)
  }

  // 합격 기준 = 실행의 판사. Navi가 보도록 지시서에 주입(잠금).
  if (v.criteria.length > 0) {
    const block = `\n\n## 합격 기준 (lain elicitation §21.3 — 이걸 충족하면 완료)\n${v.criteria
      .map((c) => `- ${c}`)
      .join('\n')}\n`
    updateTask(taskId, { content: getTask(taskId)!.content + block })
    log(taskId, 'status', `합격 기준 ${v.criteria.length}건 확정 (spec=test=judge)`)
  }

  decideMode(taskId, v.autoGradable) // §21.2
  await launch(taskId)
}

// ── 크래시 복원 (§15b) — 앱 시작 시 미완 task를 이어간다 ──
// blocked/review는 사용자 입력 대기라 그대로 둔다. 진행형 상태만 재개:
//   clarifying → clarify부터 다시 / working·ready → Navi 세션 resume(없으면 새 세션,
//   worktree는 보존돼 있음). 크래시로 고아가 된 pending 승인은 호출부에서 정리.
export function recoverTasks(): number {
  const stuck = listTasks().filter((t) =>
    ['clarifying', 'working', 'ready'].includes(t.state),
  )
  for (const t of stuck) {
    log(t.id, 'status', `크래시 복원(§15b): ${t.state} 상태에서 재개`)
    if (t.state === 'clarifying' || !t.worktreePath) {
      setState(t.id, 'clarifying')
      void clarifyAndLaunch(t.id)
    } else {
      setState(t.id, 'working')
      void launch2(
        t.id,
        '앱이 재시작되어 세션을 재개한다. 작업트리의 현재 상태(git status/log)를 점검하고, 하던 작업을 이어가라.',
      )
    }
  }
  return stuck.length
}

// ── ask_manager 흐름 (§5.2): 관리자 헤드리스 판정 → 답 못 하면 사용자 에스컬레이션 ──
function makeAskManager(taskId: string): (question: string) => Promise<string> {
  return async (question: string) => {
    const task = getTask(taskId)
    // 1) 관리자가 답할 수 있으면 즉답
    try {
      let last = ''
      const stream = query({
        prompt: `Navi가 작업 중 질문을 보냈다. 네가 작업 지시서만으로 확실히 답할 수 있으면 답하고, 사용자의 의도·취향·결정이 필요하면 escalate해라.

<task>
${task?.content ?? ''}
</task>

<question>
${question}
</question>

JSON 한 블록만 출력:
\`\`\`json
{"escalate": true|false, "answer": "<escalate=false일 때 Navi에게 줄 답>"}
\`\`\``,
        options: {
          cwd: AGENT_CWD,
          allowedTools: [],
          maxTurns: 2,
          ...tierQueryOptions(getSettings().judgeModel, getSettings()), // §9b — 짧은 판정류(local 라우팅 포함)
          executable: 'node',
          pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
        },
      })
      for await (const msg of stream) {
        if (msg.type === 'assistant') {
          const t = (msg.message?.content ?? [])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('')
          if (t) last = t
        }
      }
      const m = last.match(/```json\s*([\s\S]*?)```/)
      if (m) {
        const obj = JSON.parse(m[1])
        if (!obj.escalate && obj.answer) {
          log(taskId, 'status', `관리자 즉답: ${String(obj.answer).slice(0, 120)}`)
          return `[lain] ${obj.answer}`
        }
      }
    } catch {
      /* 관리자 판정 실패 → 사용자로 */
    }
    // 2) 사용자 에스컬레이션 — question 카드
    const approvalId = insertApproval(taskId, 'question', question)
    log(taskId, 'status', `사용자 질문 대기: ${question.slice(0, 120)}`)
    emitGlobal({ taskId, kind: 'status', text: `approval:${approvalId}` })
    notifyUser('lain — Navi 질문', question.slice(0, 120))
    const res = await waitApproval(approvalId)
    if (res.approved && res.answer) return `[user] ${res.answer}`
    return '답변을 받지 못했다. 보수적 기본값으로 진행하거나, 불가능하면 blocked로 보고해라.'
  }
}

// ── 실행 (§8-4~7) ──
async function launch(taskId: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  const project = getProject(task.projectId)
  if (!project) return

  try {
    const wt = createWorktree(project, taskId)
    setState(taskId, 'working', { branch: wt.branch, worktreePath: wt.path, questions: [] })
    log(taskId, 'status', `worktree 생성: ${wt.branch}`)
    if (wt.depsWarning) {
      // §15b deps 헬스체크 — 일찍 알려서 사용자가 승인/사전 설치로 빨리 풀 수 있게
      log(taskId, 'status', `⚠ ${wt.depsWarning}`)
      notifyUser('lain — 의존성 경고', `${project.id}: node_modules 비어 있음`)
      updateTask(taskId, {
        content: getTask(taskId)!.content + `\n\n## 환경 주의 (lain)\n${wt.depsWarning}\n`,
      })
    }

    const report = await runWithInterrupts(taskId, {})
    await finishWork(taskId, report)
  } catch (e) {
    setState(taskId, 'error', { error: String(e) })
    log(taskId, 'error', String(e))
    notifyUser('lain — 에러', `${task.projectId}: ${String(e).slice(0, 100)}`)
  }
}

// Navi를 실행하되, 도중 §5.7 인터럽트가 들어오면 abort→resume으로 이어간다.
// 인터럽트가 없으면 Navi 보고를 그대로 반환(기존 동작과 동일).
async function runWithInterrupts(
  taskId: string,
  firstOpts: { resumePrompt?: string },
): Promise<FinishReport> {
  let opts: { resumePrompt?: string; fromInterrupt?: boolean } = firstOpts
  for (;;) {
    const report = await runNavi(getTask(taskId)!, emitGlobal, {
      ...opts,
      askManager: makeAskManager(taskId),
    })
    const injected = interruptMsgs.get(taskId)
    if (!injected) return report
    // 인터럽트로 끊긴 것 — 사용자 메시지를 resume으로 전달해 같은 세션 이어감.
    // fromInterrupt=true로 핸드오프 스왑을 막는다(인터럽트는 같은 세션 즉시 주입이 핵심 — 매번 스왑하면 연속성 파괴).
    interruptMsgs.delete(taskId)
    log(taskId, 'status', '인터럽트 처리 — Navi 세션 resume으로 재개')
    setState(taskId, 'working')
    opts = {
      resumePrompt: `사용자가 작업 중 끼어들었다(최우선 처리). 메시지:\n${injected}\n\n이 지시를 먼저 반영한 뒤 원래 작업을 이어가라.`,
      fromInterrupt: true,
    }
  }
}

/** §5.7 작업 중 인터럽트 — 실행 중 Navi를 안전 중단하고 사용자 메시지를 최우선 주입.
 *  반환: 실제로 인터럽트가 걸렸는지(Navi가 실행 중이었는지). */
export function interruptTask(taskId: string, message: string): boolean {
  const task = getTask(taskId)
  if (!task || task.state !== 'working' || !isNaviRunning(taskId)) return false
  interruptMsgs.set(taskId, message)
  log(taskId, 'status', `인터럽트: ${message.slice(0, 120)}`, 'user')
  abortNavi(taskId) // runWithInterrupts 루프가 injected를 보고 resume
  return true
}

const VERIFY_RETRIES = 2 // §15b 검증 실패 루프 — 최대 재시도 횟수

interface FinishReport {
  status: 'done' | 'blocked'
  summary: string
  questions: string[]
}

// Navi 보고 이후 공통 마무리: verify(실패 시 피드백 재시도) → review + 판단 요약(§10.2)
// §24 Phase1 — verify 실패가 '코드 문제(재시도로 고쳐질 수 있음)'인지 '환경 블로커(재시도 무의미)'인지
// 분류. 환경 블로커면 같은 Navi를 2회 더 돌리고 상위 티어로 에스컬레이션하는 토큰 낭비를 막고 즉시
// blocked로 사람에게 넘긴다. 불확실하면 보수적으로 retryable=true(기존 동작 유지). Windows/PowerShell
// 메시지 우선. hermes error_classifier의 HTTP status 분류를 베끼지 않고 verify(셸 exit+stdout) 도메인으로 새로 작성.
const NON_RETRYABLE_VERIFY: Array<{ re: RegExp; reason: string }> = [
  {
    re: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket hang up|network is unreachable/i,
    reason: '네트워크 도달 불가',
  },
  {
    re: /is not recognized as (an|the name of)|command not found|: not found|cannot find the path/i,
    reason: '필요한 명령/도구 없음',
  },
  {
    re: /(missing|require[ds]?|no)[^\n]{0,24}(api[_ -]?key|credential|secret|token)|environment variable[^\n]*(not set|is not defined|missing|undefined)|\bENOENT\b[^\n]*\.env/i,
    reason: '환경값/시크릿 누락',
  },
  { re: /EACCES|permission denied|operation not permitted/i, reason: '권한 거부' },
]

// §i11 flake — 코드 결함이 아니라 환경 경합/타이밍으로 산발 실패하는 패턴. 1회 재시도로 풀릴 수 있어
// tier-up 없이 동일 모델로 한 번만 다시 돌린다. ETIMEDOUT은 NON_RETRYABLE의 네트워크로 이미 잡히니 제외.
const FLAKY_VERIFY = /EADDRINUSE|address already in use|port .{0,16}(?:in use|already in use)|Async callback was not invoked|timeout .{0,24}exceeded|exceeded timeout/i

/** verify 실패 출력(tail)을 보고 재시도가 의미 있는지 판정. 환경 블로커는 retryable=false.
 *  retryable한 실패 중 일시 경합(flake)으로 보이면 kind='flake'(tier-up 없이 1회 재시도 신호). */
export function classifyVerifyFailure(
  tail: string,
): { retryable: boolean; reason: string; kind?: 'flake' } {
  for (const p of NON_RETRYABLE_VERIFY) if (p.re.test(tail)) return { retryable: false, reason: p.reason }
  if (FLAKY_VERIFY.test(tail)) return { retryable: true, reason: '', kind: 'flake' }
  return { retryable: true, reason: '' }
}

async function finishWork(taskId: string, firstReport: FinishReport): Promise<void> {
  const task = getTask(taskId)!
  // 취소된(또는 이미 종결된) task는 abort로 Navi가 빠져나왔을 뿐 — 마무리 진행 금지.
  if (['cancelled', 'done', 'error'].includes(task.state)) return
  const project = getProject(task.projectId)!
  let report = firstReport
  let verifyResult = 'skipped(verify_cmd 없음)'
  let flakeRetried = false // §i11 — flake는 작업당 1회만 무료(동일 모델) 재시도

  for (let attempt = 0; ; attempt++) {
    updateTask(taskId, { diffStat: diffStat(project, taskId), summary: report.summary })

    if (report.status === 'blocked') {
      setState(taskId, 'blocked', { questions: report.questions })
      log(taskId, 'status', 'Navi blocked — 질문 답변 대기')
      notifyUser('lain — 질문', `${task.projectId}: Navi가 막힘`)
      return
    }

    if (!project.verifyCmd) break

    log(taskId, 'status', `verify 실행 (${attempt + 1}회차): ${project.verifyCmd}`)
    try {
      await execP(project.verifyCmd, {
        cwd: getTask(taskId)!.worktreePath!,
        windowsHide: true,
        timeout: 5 * 60_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      verifyResult = 'pass'
      break
    } catch (e: any) {
      const tail = (String(e?.stdout ?? '') + String(e?.stderr ?? '')).slice(-800)
      verifyResult = `fail: ${tail}`
      // §24 — 환경 블로커(네트워크·도구·시크릿·권한)는 재시도/에스컬레이션이 무의미 → 즉시 blocked로 사람에게.
      const cls = classifyVerifyFailure(tail)
      if (!cls.retryable) {
        log(taskId, 'status', `verify 실패 — 재시도 무의미(${cls.reason}) → 즉시 blocked (§24)`)
        setState(taskId, 'blocked', {
          verifyResult,
          questions: [
            `검증이 환경 문제로 실패했다(${cls.reason}). 코드 수정으로는 안 풀린다 — 사람 개입 필요.\n출력 끝:\n${tail.slice(-300)}`,
          ],
        })
        saveStatus({ projectId: task.projectId, summary: `환경 블로커로 중단: ${cls.reason}` })
        projectsChanged()
        notifyUser('lain — 환경 블로커', `${task.projectId}: ${cls.reason}`)
        return
      }
      // §i11 — 일시 경합(flake)이면 tier-up·피드백 없이 동일 모델로 딱 1회만 같은 명령 재실행.
      // attempt--로 for 헤더의 ++을 상쇄해 VERIFY_RETRIES 예산을 소모하지 않는다(코드 수정 재시도와 별개).
      if (cls.kind === 'flake' && !flakeRetried) {
        flakeRetried = true
        attempt--
        log(taskId, 'status', `verify flake 감지 — tier-up 없이 동일 모델로 1회 재실행 (§i11)`)
        continue
      }
      if (attempt >= VERIFY_RETRIES) {
        log(taskId, 'status', `verify ${attempt + 1}회 실패 — 재시도 중단(§15b)`)
        break
      }
      // 실패 출력을 Navi에 피드백하고 같은 세션 resume으로 수정 시도.
      // §9b: 마지막 재시도는 상위 티어 모델로 에스컬레이션.
      const tierUp: Record<string, string> = { haiku: 'sonnet', sonnet: 'opus' }
      const escalated =
        attempt === VERIFY_RETRIES - 1 ? tierUp[getSettings().naviModel] : undefined
      if (escalated)
        log(taskId, 'status', `모델 에스컬레이션(§9b): ${escalated}로 마지막 재시도`)
      log(taskId, 'status', `verify 실패 — Navi에 피드백 후 재시도 (${attempt + 1}/${VERIFY_RETRIES})`)
      report = await runNavi(getTask(taskId)!, emitGlobal, {
        resumePrompt: `검증 명령(${project.verifyCmd})이 실패했다. 출력 끝부분:\n\`\`\`\n${tail}\n\`\`\`\n원인을 고치고 커밋해라.`,
        askManager: makeAskManager(taskId),
        modelOverride: escalated,
      })
    }
  }

  // verify 루프 이후 상태 재확인(Lain 기여) — verify 실행 중 cancelTask가 경쟁적으로 호출되면
  // worktree가 삭제되고 state가 'cancelled'로 바뀐 뒤 여기에 도달할 수 있다. 그 상태에서
  // changedFiles·setState('review')를 계속 실행하면 취소 상태를 덮어쓰거나 삭제된 worktree 접근으로
  // throw한다 — 재확인 후 종료로 차단.
  if (['cancelled', 'done', 'error'].includes(getTask(taskId)?.state ?? '')) return

  // §24 — autonomous spec-gaming 사후검증: verify가 판사인데 Navi가 테스트 파일을 바꿔 통과를 위조했는지.
  // (테스트 파일 Edit/Write는 canUseTool에서 이미 차단하나 Bash sed 등 우회 가능 → 커밋·미커밋 diff로 확인.)
  if (verifyResult === 'pass' && task.mode === 'autonomous') {
    const touchedTests = changedFiles(project, taskId).filter(isTestFile)
    if (touchedTests.length) {
      log(taskId, 'status', `spec-gaming 의심(§24): autonomous인데 테스트 파일 변경 → blocked (${touchedTests.slice(0, 3).join(', ')})`)
      setState(taskId, 'blocked', {
        verifyResult: `의심: 테스트 파일 변경(${touchedTests.join(', ')})`,
        questions: [
          `autonomous 작업이 verify를 통과했지만 테스트 파일(${touchedTests.join(', ')})을 수정했다. 테스트=판사를 위조했을 수 있다 — 사람 검토가 필요하다(이 작업의 교훈은 신뢰할 수 없어 학습하지 않는다).`,
        ],
      })
      notifyUser('lain — spec-gaming 의심', `${task.projectId}: 테스트 파일 변경됨`)
      return
    }
  }

  setState(taskId, 'review', { verifyResult })
  log(taskId, 'status', `검토 대기 — verify: ${verifyResult.slice(0, 120)}`)
  // 판단 요약 (§10.2) — 관리자 다이제스트에 반영
  saveStatus({ projectId: task.projectId, summary: report.summary.slice(0, 500) })
  projectsChanged()
  notifyUser('lain — 결재 대기', `${task.projectId}: ${task.title.slice(0, 60)}`)

  // §22 자기개선 — verify pass한 작업에서만 교훈 추출(틀린 교훈 누적 방지).
  // verify_cmd가 없으면 자동 채점 불가라 신뢰 못 함 → 건너뜀.
  if (verifyResult === 'pass') {
    void reflect(taskId).catch((e) => log(taskId, 'status', `자기개선 회고 실패: ${e}`))
  }
}

// §22 회고 — 검증된 작업의 diff·보고에서 재사용 가능한 교훈을 judge 모델로 추출·저장.
async function reflect(taskId: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  let last = ''
  // 회고가 본 주입 교훈(§8) — judge가 'cited_lesson_ids'로 인용해 계보를 추적하게 한다.
  const injected = lessonsForProject(task.projectId, 8, task.content)
  const injectedBlock = injected.length
    ? `<injected-lessons>\n${injected
        .map((l) => `[L${l.id}] (${l.scope}) ${l.trigger ? l.trigger + ' → ' : ''}${l.lesson}`)
        .join('\n')}\n</injected-lessons>`
    : ''
  const stream = query({
    prompt: `너는 lain의 회고 담당이다. 방금 검증(테스트)을 통과한 작업에서, **이 프로젝트의 이후 작업에 재사용할 수 있는 교훈**을 0~2건 뽑아라.
좋은 교훈 예: 프로젝트 컨벤션(파일명·디렉터리 구조·도구·명령), 검증을 통과시키는 데 필요했던 비자명한 단계, 이 repo 특유의 제약.

이 교훈들은 다음 Navi의 프롬프트에 그대로 주입된다 — 잘못 적으면 미래의 Navi가 시도도 안 하고 거부(self-refusal)하게 굳는다. 다음은 **교훈이 아니다. 절대 만들지 마라**:
1. 환경/설치 실패 — 누락 바이너리·command-not-found·미설치·시크릿/env 누락·경로 불일치. 이건 그 머신의 일시 상태지 프로젝트 사실이 아니다.
2. 도구/기능 부정단정 금지 — "X 안 됨", "Y 깨짐", "Z 못 씀" 류. Navi 프롬프트에 박히면 self-refusal로 굳는다.
3. 재시도로 풀린 일시 오류 — 교훈은 "X가 안 된다"가 아니라 "X 실패하면 retry/재실행" 패턴만 저장.
4. 일회성 작업 서사 — 이번 작업에서만 쓰는 사실·진행 경위·일반 상식은 버린다.
5. 선언적·재사용 사실만 남긴다 — 셋업이 막혔으면 "X 안 됨"이 아니라 FIX(설치 명령·필요 env 키)만 적는다.
재사용할 게 정말 없으면 빈 배열을 내라.

<task>
${task.content.slice(0, 1500)}
</task>
<worker-summary>
${task.summary ?? ''}
</worker-summary>
<diff-stat>
${task.diffStat ?? ''}
</diff-stat>
${injectedBlock}

JSON 한 블록만:
\`\`\`json
{"lessons": [{"scope": "project|global", "trigger": "<언제 적용되나, 키워드>", "lesson": "<재사용 교훈 한두 문장>", "cited_lesson_ids": [<이 교훈을 도출하는 데 실제 도움된 주입 교훈 L번호들, 없으면 빈배열>]}]}
\`\`\`
- scope: 이 repo 한정이면 project, 어떤 프로젝트에도 통하는 일반 원칙이면 global.
- cited_lesson_ids: 위 injected-lessons 중 이번 작업에 실제로 도움이 된 것의 L번호만. 추측 금지, 없으면 [].`,
    options: {
      cwd: AGENT_CWD,
      allowedTools: [],
      maxTurns: 2,
      ...tierQueryOptions(getSettings().judgeModel, getSettings()),
      executable: 'node',
      pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
    },
  })
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      const t = (msg.message?.content ?? [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
      if (t) last = t
    }
  }
  const m = last.match(/```json\s*([\s\S]*?)```/)
  if (!m) {
    log(taskId, 'status', `자기개선 회고: JSON 블록 없음 (응답 ${last.length}자)`)
    return
  }
  let obj: any
  try {
    obj = JSON.parse(m[1])
  } catch {
    log(taskId, 'status', '자기개선 회고: JSON 파싱 실패')
    return
  }
  const lessons = Array.isArray(obj.lessons) ? obj.lessons : []
  if (lessons.length === 0) log(taskId, 'status', '자기개선 회고: 재사용 교훈 없음(0건)')
  // 주입된 교훈 id 집합 — judge가 지어낸 id는 무시(보수적).
  const injectedIds = new Set(injected.map((l) => l.id))
  const citedIds = new Set<number>()
  let saved = 0
  for (const l of lessons) {
    if (!l?.lesson) continue
    insertLesson({
      projectId: task.projectId,
      taskId,
      scope: l.scope === 'global' ? 'global' : 'project',
      trigger: String(l.trigger ?? ''),
      lesson: String(l.lesson),
    })
    saved++
    // §8/i10 — 이번 작업에 실제 도움된 주입 교훈만 진짜 재사용으로 bump(계보 추적).
    if (Array.isArray(l.cited_lesson_ids)) {
      for (const raw of l.cited_lesson_ids) {
        const id = Number(raw)
        if (Number.isInteger(id) && injectedIds.has(id)) citedIds.add(id)
      }
    }
  }
  if (citedIds.size > 0) {
    bumpLessonReuse([...citedIds])
    log(taskId, 'status', `자기개선(§22): 근거 교훈 ${citedIds.size}건 재사용 bump`)
  }
  if (saved > 0) {
    log(taskId, 'status', `자기개선(§22): 교훈 ${saved}건 학습`)
    projectsChanged()
  }
}

// ── 명확화/blocked 답변 (§8-3, §5.2 턴 끝 질문) ──
// sender: 발신자(user|lain). 지정 시 working 분기 resume 프롬프트(=모델에 닿는 메시지)에만 태그를 붙인다.
// 영속되는 task.content(아래 qa 블록)에는 태그를 박지 않는다 — 명세 본문 오염·재투입 방지(elicit 재진입/TASK.md).
// 발신자 출처는 모델이 읽는 resume 프롬프트의 한 줄 태그로 전달되며, 헤더는 발신자 중립으로 둔다.
export async function answerClarify(
  taskId: string,
  answers: string,
  sender?: NaviSender,
): Promise<void> {
  const task = getTask(taskId)
  if (!task || task.state !== 'blocked') return
  const qa = `\n\n## 추가 답변\n질문: ${task.questions.join(' / ')}\n답변: ${answers}\n`
  updateTask(taskId, { content: task.content + qa, questions: [] })
  log(taskId, 'status', '답변 수신 — 재개')

  if (task.worktreePath && task.naviSessionId) {
    // 작업 중 막힘 → 같은 Navi 세션 resume (§5.1 턴 기반 이어가기)
    // 발신자 태깅은 여기(메시지)서만 — answers는 영속 명세라 깨끗이 두고, 태그는 모델에 닿는 프롬프트에 붙인다.
    setState(taskId, 'working')
    const tagged = sender ? frameMessage(sender, answers) : answers
    void launch2(taskId, `막힌 질문에 답변이 도착했다.\n질문: ${task.questions.join(' / ')}\n답변: ${tagged}`)
  } else {
    // 명확화(elicitation) 단계 답변 → 다시 게이트로(§21.3 반복). 답이 모호함을 풀면 통과.
    setState(taskId, 'clarifying')
    void clarifyAndLaunch(taskId)
  }
}

// 이미 worktree가 있는 task의 재개 — 기존 Navi 세션을 resume해 컨텍스트 유지
// B3 resume-continue — error 상태 작업을 worktree·세션 그대로 수동 재개(기존 launch2 재개 경로 재사용).
// cancelled/done/review는 removeWorktree로 작업트리가 삭제돼 재개 불가 → error만 허용(안전·고빈도).
export async function resumeTask(taskId: string): Promise<void> {
  const task = getTask(taskId)
  if (!task || task.state !== 'error' || !task.worktreePath || !task.naviSessionId) return
  setState(taskId, 'working')
  tasksChanged()
  void launch2(
    taskId,
    '사용자가 작업을 수동으로 재개했다. 작업트리 현재 상태(git status/log/diff)를 먼저 점검하고, 마지막 중단 지점부터 남은 것만 이어가라. 끝나면 동일한 JSON 보고 형식으로 마무리.',
  )
}

async function launch2(taskId: string, resumePrompt: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  try {
    const report = await runWithInterrupts(taskId, { resumePrompt })
    await finishWork(taskId, report)
  } catch (e) {
    setState(taskId, 'error', { error: String(e) })
    log(taskId, 'error', String(e))
  }
}

// ── 검토 결정 (§8-9) ──
export async function resolveReview(
  taskId: string,
  action: 'merge' | 'keep-branch' | 'discard',
): Promise<string> {
  const task = getTask(taskId)
  if (!task || task.state !== 'review') return '검토 상태가 아니다'
  const project = getProject(task.projectId)
  if (!project) return '프로젝트 없음'

  let result = ''
  if (action === 'merge') {
    const m = tryMerge(project, taskId)
    result = m.reason
    removeWorktree(project, taskId, m.merged) // 병합됐으면 브랜치도 정리
    archiveTaskMd(project, task, `merge: ${m.reason}`)
    setState(taskId, 'done', { summary: `${task.summary ?? ''}\n[병합] ${m.reason}` })
  } else if (action === 'keep-branch') {
    removeWorktree(project, taskId, false)
    archiveTaskMd(project, task, 'keep-branch')
    result = `브랜치 ${task.branch} 보존 — 직접 머지해라`
    setState(taskId, 'done')
  } else {
    removeWorktree(project, taskId, true)
    result = '폐기 완료 (브랜치 삭제)'
    setState(taskId, 'cancelled')
  }
  log(taskId, 'status', result)
  return result
}

export function cancelTask(taskId: string): void {
  const task = getTask(taskId)
  if (!task) return
  abortNavi(taskId)
  const project = getProject(task.projectId)
  if (project && task.worktreePath) removeWorktree(project, taskId, true)
  setState(taskId, 'cancelled')
  log(taskId, 'status', '사용자 취소')
}

// ── TASK.md 아카이브 (§7.1) — repo 오염 없이 lain 데이터 폴더로 ──
function archiveTaskMd(project: Project, task: Task, outcome: string): void {
  try {
    const dir = path.join(DATA_DIR, 'done', project.id.replaceAll('/', '_'))
    fs.mkdirSync(dir, { recursive: true })
    const meta = `---\ntask: ${task.id}\nproject: ${project.id}\noutcome: ${outcome}\ncost_usd: ${task.costUsd}\nturns: ${task.turns}\narchived: ${new Date().toISOString()}\n---\n\n`
    fs.writeFileSync(path.join(dir, `${task.id}.md`), meta + task.content)
    const mdPath = path.join(project.path, 'TASK.md')
    if (fs.existsSync(mdPath)) fs.rmSync(mdPath)
  } catch {
    /* 아카이브 실패는 치명적이지 않음 */
  }
}
