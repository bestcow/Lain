// 오케스트레이터 (PLAN.md §8) — task 상태머신과 실행 흐름.
// TASK.md 로드 → 관리자 명확화 → worktree 격리 Navi → verify → review → 사람 결정.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import {
  activeTaskCountForProject,
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
  queuedTasks,
  insertTaskGroup,
  getTaskGroup,
  tasksForGroup,
  setGroupResolveState,
  listResolvingGroups,
  loopStats,
  promotionStats,
} from './store'
import {
  createWorktree,
  removeWorktree,
  diffStat,
  changedFiles,
  tryMerge,
  rebaseWorktreeOntoMain,
  revertMergeRange,
} from './worktree'
import { verifyInDir } from './collectors'
import { isTestFile } from './safety'
import { runNavi, abortNavi, waitApproval, isNaviRunning, approvalTimeoutMs, isAwaitingApproval } from './worker'
import { codexStatus } from './codex'
import { engineCapabilities } from './engines'
import { saveStatus } from './store'
import { runJudge, parseJsonBlock, isJsonObject } from './judge'
import { buildPostmortemPrompt, parsePostmortem } from './postmortem'
import { runAudit, type AuditVerdict } from './audit'
import { REWORK_MAX, canRework, buildReworkPrompt } from './rework'
import { budgetExceeded, recentUsageTokens, usageGuardTripped } from './usage'
import { emitQuip } from './quips'
import { notifyUser } from './notify'
import { frameMessage, type NaviSender } from './navisender'
import type {
  Project,
  Task,
  TaskEvent,
  TaskState,
  NaviMode,
  TaskEngine,
  TaskPermissionMode,
  ThinkingLevel,
  ModelTier,
  ReviewDepth,
} from '../shared/types'

// §5.7 인터럽트 — 실행 중 Navi에 끼어든 사용자 메시지. abort 후 이 메시지를
// resume 프롬프트로 전달해 컨텍스트 유지로 이어간다(§18 실측: streaming-input
// interrupt는 컨텍스트 유실 → abort+resume이 안전).
const interruptMsgs = new Map<string, string>()

// quips(tasks_streak) — 최근 1시간 내 review 도달 시각들(인메모리, 재시작 리셋 수용 — 플레이버)
let reviewStreakAt: number[] = []

// I6 — resolveReview in-flight 가드. 3진입점(IPC·manager resolve_review·텔레그램)이 verifyInDir await(최대 5분)
// 동안 같은 review 가드를 통과해 이중 merge/removeWorktree/상태 오염(revert_merge 경로까지)을 일으키는 것을 막는다.
// review 가드 직후 동기 체크-앤-셋(await 전)이라 재진입을 확실히 차단한다.
const resolvingReviews = new Set<string>()

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
  // judge 1콜(#8 공용 러너 — 60초 abort 내장). 무응답이면 task가 clarifying에 영구 고착되고 그 상태가
  // 동시성 슬롯을 세므로 몇 개 쌓이면 큐 전체가 기아가 된다(scheduler judge와 동일 패턴).
  // 실패·타임아웃·파싱 불능 = 기준 없이 진행(게이트가 진행을 막지 않게 — 무해 폴백).
  const last = await runJudge(`너는 lain의 elicitation 게이트다(§21.3). 아래 작업 지시서를 *실행하지 말고*, 요구사항을 하나씩 "합격/불합격을 확인할 수 있는 구체적 기준(테스트·체크)"으로 적어본다.

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
\`\`\``)
  const obj = parseJsonBlock(last, isJsonObject)
  if (obj) {
    return {
      criteria: Array.isArray(obj.criteria) ? obj.criteria.map(String) : [],
      questions: Array.isArray(obj.questions) ? obj.questions.map(String) : [],
      autoGradable: !!obj.autoGradable,
    }
  }
  return { criteria: [], questions: [], autoGradable: false }
}

const ELICIT_MAX_ROUNDS = 3 // 답변-재elicit 루프 상한 (판사가 끝없이 캐묻는 것 방지)

// autonomous 마커(§21.2) — pickTaskMode·startTask와 동일 패턴. D5 자동착수 판정이 재사용(중복 정규식 방지).
const AUTONOMOUS_MARKER = /lain:autonomous|(^|\n)\s*mode:\s*autonomous\b/i
const INTERACTIVE_MARKER = /lain:interactive|(^|\n)\s*mode:\s*interactive\b/i

// A3(확신도 축) — 자동판정(auto)이 autonomous를 주려면 요구하는 프로젝트 완료 실적(창 내 done 수) 최소치.
// 첫 작업/신규 프로젝트가 실적 없이 곧장 hands-off로 가는 것을 막는다(§21.5 확신도 = 실적으로 획득).
export const AUTONOMOUS_MIN_DONE = 3
// 실적 집계 창(일) — 7일 창은 휴지기 한 번에 실적이 소멸해 과도(게이트는 확신도이지 리듬 벌칙이 아님).
const AUTONOMOUS_DONE_WINDOW_DAYS = 30

// §21.2 모드 판정 (순수) — 마커가 최우선, 다음 사용자 기본값(defaultTaskMode), 없으면 자동판정.
// 안전: autonomous는 verify_cmd가 있어야만(테스트=판사). 사용자가 autonomous 기본이어도 verify_cmd 없으면 interactive 폴백.
// A3 — 자동판정 경로(pref='auto')만 완료 실적(projectDone ≥ AUTONOMOUS_MIN_DONE)을 추가로 요구한다.
// 마커·명시 pref는 사용자 의사라 게이트를 안 탄다. 생략 시 0(보수적 — 실적 모름 = 실적 없음).
export function pickTaskMode(
  content: string,
  pref: 'auto' | 'autonomous' | 'interactive',
  autoGradable: boolean,
  hasVerifyCmd: boolean,
  projectDone = 0,
): NaviMode {
  if (INTERACTIVE_MARKER.test(content)) return 'interactive'
  if (AUTONOMOUS_MARKER.test(content)) return 'autonomous'
  if (pref === 'interactive') return 'interactive'
  if (pref === 'autonomous') return hasVerifyCmd ? 'autonomous' : 'interactive'
  return autoGradable && hasVerifyCmd && projectDone >= AUTONOMOUS_MIN_DONE
    ? 'autonomous'
    : 'interactive'
}

// A3(확신도 소비, 순수) — 독립 심사 강도 결정. 작업별 명시(taskDepth)가 있으면 그대로(사용자 존중).
// 없으면 설정 기본값을 쓰되, 최근 실적에 사고 신호(rework·심사 미통과)가 있으면 standard→adversarial 상향.
// 상향만 한다 — light(명시적 완화 선택)는 건드리지 않고, 하향 자동화는 금지(강등은 promotionAdvice '제안' 경유).
export function decideReviewDepth(
  taskDepth: ReviewDepth | undefined,
  defaultDepth: ReviewDepth,
  recentTrouble: boolean,
): ReviewDepth {
  if (taskDepth) return taskDepth
  return defaultDepth === 'standard' && recentTrouble ? 'adversarial' : defaultDepth
}

// D5 — 새 TASK.md 발견 시 자동 착수 여부(순수, 결정론). 3중 게이트:
//   1) 설정 opt-in(기본 off) 2) 파일에 autonomous 마커 명시 3) 프로젝트에 verify_cmd 존재(테스트=판사).
// 마커 없는 TASK.md(자동판정 대상)는 절대 자동착수하지 않는다 — 자동판정은 애매하면 interactive로
// 빠질 수 있어, 사람이 안 보는데 조용히 interactive로 걸려(승인 대기) 방치되는 상황을 막기 위함.
// 통과해도 clarifyAndLaunch의 elicitation 게이트·승인 큐·spec-gaming 방어(§21)는 그대로 탄다 — 이건
// '착수 여부'만 결정하고 안전장치를 우회하지 않는다.
export function shouldAutoStartTask(
  content: string,
  autoStartEnabled: boolean,
  hasVerifyCmd: boolean,
): boolean {
  return autoStartEnabled && hasVerifyCmd && AUTONOMOUS_MARKER.test(content)
}

function decideMode(taskId: string, autoGradable: boolean): void {
  const task = getTask(taskId)!
  const project = getProject(task.projectId)
  const pref = getSettings().defaultTaskMode
  // A3 — 자동판정의 autonomous에는 프로젝트 완료 실적(loopStats)을 요구(첫 작업 프로젝트 hands-off 방지).
  const done = loopStats(AUTONOMOUS_DONE_WINDOW_DAYS, task.projectId).done
  const mode = pickTaskMode(task.content, pref, autoGradable, !!project?.verifyCmd, done)
  if (mode !== task.mode) updateTask(taskId, { mode })
  // glass-box — 실적 게이트가 결정적이었으면(실적만 찼다면 autonomous였을 판정) 사유를 로그에 남긴다.
  const gated =
    mode === 'interactive' &&
    pickTaskMode(task.content, pref, autoGradable, !!project?.verifyCmd, AUTONOMOUS_MIN_DONE) ===
      'autonomous'
  log(
    taskId,
    'status',
    `mode: ${mode} (기본값 ${pref}${pref === 'auto' ? ', 자동판정' : ''}${gated ? ` — 실적 부족: 최근 ${AUTONOMOUS_DONE_WINDOW_DAYS}일 done ${done}<${AUTONOMOUS_MIN_DONE} (A3)` : ''})`,
  )
}

// ── C1: 활성 작업 판정 (D4 hold × D5/유휴 서브시스템 교착 방어) ──
// held(무인 승인/질문 대기) 작업은 task.state가 'working'에 고정되지만 실제 compute 슬롯을 쓰지 않고
// 사람을 기다리는 중이다. 순수 함수로 "held 아닌 working"만 활성으로 세어 (1) concurrencyCap 카운트에서
// held를 제외하고 (2) 유휴 게이트 4곳(scheduler×3·selfimprove×1)이 held만 있을 땐 서브시스템을 돌게 한다.
// isHeld는 worker.isAwaitingApproval 주입(테스트에선 스텁) — store·worker에 의존하지 않아 단위 테스트가 쉽다.

/** 순수 — held 아닌 working이 하나라도 있으면 true(= 유휴 아님). 모든 working이 held면 false(유휴 허용). */
export function hasActiveWorkAmong(tasks: Task[], isHeld: (taskId: string) => boolean): boolean {
  return tasks.some((t) => t.state === 'working' && !isHeld(t.id))
}

/** store 상태 기반 — held 아닌 working이 있는가. 유휴 서브시스템 게이트(scheduler·selfimprove)의 단일 출처. */
export function hasActiveWork(): boolean {
  return hasActiveWorkAmong(listTasks(), isAwaitingApproval)
}

// ── D1: 대기 큐 (task waiting-queue) ──
// cap 초과·프로젝트 중복으로 즉시 거절하던 작업을 'queued'로 적재하고, 슬롯이 열리면 드레인이 자동 착수한다.
// 착수 경로(clarifyAndLaunch)는 정상 경로와 드레인이 공유한다(중복 금지). 순수 판정은 아래 selectQueuedToLaunch.

/** 순수 — cap 슬롯 점유 = 실행 중(working, held 제외) + 착수 진행 중(clarifying).
 *  C3 — working-only 계수(hasActiveWorkAmong)와 분리한다: drainQueue가 착수 시 동기로 setState('clarifying')로 올린
 *  작업이 이 계수에 즉시 잡혀야, 후속 드레인(scheduler 주기틱·다음 finishWork)이나 startTask가 그 슬롯을
 *  빈 자리로 오인해 cap을 초과 착수하는 것을 막는다. idle 게이트(hasActiveWork*)는 working-only(held 제외)
 *  기준 그대로이므로 여기와 분리한다 — clarifying을 idle 판정에 더하면 유휴 서브시스템 게이트가 바뀐다. */
export function slotOccupyingCount(tasks: Task[], isHeld: (taskId: string) => boolean): number {
  return tasks.filter((t) => (t.state === 'working' && !isHeld(t.id)) || t.state === 'clarifying').length
}

/** 순수 — cap 슬롯(slotOccupyingCount = working !held + clarifying) 기준의 남은 슬롯 수. 음수면 0으로 클램프. */
export function capRoom(tasks: Task[], cap: number, isHeld: (taskId: string) => boolean): number {
  return Math.max(0, cap - slotOccupyingCount(tasks, isHeld))
}

// ── D2: 작업 간 의존성 ──

/** 순수 — 의존 전부 충족(=선행 done: 병합·keep-branch 모두 종결로 본다 — 사용자 확정 2026-07-08)인가.
 *  없는 id(하드삭제 없음 전제의 방어)는 충족으로 봐 영구 잠금을 막는다 — 오타는 등록 시점 검증이 잡는다. */
export function depsMet(
  dependsOn: string[],
  stateOf: (id: string) => TaskState | null | undefined,
): boolean {
  return dependsOn.every((id) => {
    const s = stateOf(id)
    return s == null || s === 'done'
  })
}

/** 순수 — taskId의 의존을 newDeps로 바꿨을 때 사이클이 생기는가(새 의존들에서 기존 그래프를 따라
 *  taskId로 되돌아오면 사이클). start_task 신규 등록은 새 id라 사이클이 불가능 — set_task_deps 전용. */
export function wouldCreateDepCycle(
  taskId: string,
  newDeps: string[],
  depsOf: (id: string) => string[],
): boolean {
  const seen = new Set<string>()
  const stack = [...newDeps]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === taskId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    stack.push(...depsOf(cur))
  }
  return false
}

// 선행 실패(cancelled·error 확정) 통지 — 프로세스 내 1회(플래그 인메모리, 재시작 시 재통지 수용).
// 자동 연쇄취소는 하지 않는다: 후행이 선행 없이도 독립 실행 가능할 수 있어 결정은 사람/레인에게.
const depFailNotified = new Set<string>()
function noteDepFailures(queued: Task[], stateOf: (id: string) => TaskState | undefined): void {
  for (const t of queued) {
    if (t.dependsOn.length === 0 || depFailNotified.has(t.id)) continue
    const bad = t.dependsOn.filter((id) => {
      const s = stateOf(id)
      return s === 'cancelled' || s === 'error'
    })
    if (bad.length === 0) continue
    depFailNotified.add(t.id)
    log(
      t.id,
      'status',
      `선행 작업 실패/폐기(${bad.join(', ')}) — 대기 유지. 진행하려면 set_task_deps로 의존 해제하거나 이 작업을 폐기해라`,
    )
    notifyUser(
      'lain — 선행 작업 실패',
      `${t.projectId}: '${t.title.slice(0, 40)}' 대기 중 — 선행 ${bad.length}건 실패/폐기`,
    )
  }
}

/** D2 — queued 작업의 의존을 set_task_deps 도구로 교체(빈 배열=해제). 검증: queued만·자기참조·존재·사이클. */
export function setTaskDeps(taskId: string, dependsOn: string[]): { error?: string } {
  const task = getTask(taskId)
  if (!task) return { error: '작업 없음' }
  if (task.state !== 'queued') return { error: 'queued(대기) 상태 작업만 의존을 바꿀 수 있다' }
  const deps = [...new Set(dependsOn)]
  if (deps.includes(taskId)) return { error: '자기 자신에 의존할 수 없다' }
  for (const id of deps) if (!getTask(id)) return { error: `선행 작업 없음: ${id} (list_tasks로 확인)` }
  if (wouldCreateDepCycle(taskId, deps, (id) => getTask(id)?.dependsOn ?? []))
    return { error: '의존 사이클이 생긴다 — 체인을 확인해라' }
  updateTask(taskId, { dependsOn: deps })
  log(taskId, 'status', `의존 갱신: [${deps.join(', ') || '없음'}]`)
  tasksChanged()
  drainQueue() // 해제로 즉시 착수 가능해졌을 수 있다
  return {}
}

/** 순수·결정론 — 대기 큐에서 이번 드레인에 착수할 task id를 우선순위대로 고른다.
 *  게이트: (a) 그 프로젝트의 활성 작업 수가 perProjectCap 미만이어야 하고(D14 — 기본 1=종전 동작),
 *  (b) 전역 cap에 여유가 있어야 한다.
 *  레이스 방어: 후보를 하나 고를 때마다 남은 슬롯(room)을 로컬로 1 깎고, 그 프로젝트 계수를 +1 해
 *  뒤 후보 계수에 즉시 반영한다(연속 착수 시 cap 초과·프로젝트 상한 초과 착수 방지). setState가 실제로
 *  반영되기 전(비동기 launch)에도 이 로컬 계수가 상한을 지킨다.
 *  @param queued priority ASC·created_at ASC로 정렬된 대기 작업(queuedTasks() 결과)
 *  @param activeCountByProject 프로젝트별 현재 활성(queued 제외) 작업 수
 *  @param perProjectCap 프로젝트당 동시 활성 상한(설정 projectParallelCap, 기본 1) */
export function selectQueuedToLaunch(
  queued: Pick<Task, 'id' | 'projectId'>[],
  room: number,
  activeCountByProject: ReadonlyMap<string, number>,
  perProjectCap = 1,
): string[] {
  const launch: string[] = []
  const counts = new Map(activeCountByProject) // 원본 불변 — 로컬 복제에 착수분을 누적
  let left = room
  for (const t of queued) {
    if (left <= 0) break // cap 소진 — 중단
    const cur = counts.get(t.projectId) ?? 0
    if (cur >= perProjectCap) continue // 이 프로젝트는 상한 도달(또는 이번 착수 포함) — 건너뜀
    launch.push(t.id)
    counts.set(t.projectId, cur + 1)
    left--
  }
  return launch
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
    modelOverride?: ModelTier | '' // D10 — 이 작업만 고정할 모델('' 또는 생략=전역 naviModel)
    engine?: TaskEngine // codex = OpenAI Codex CLI로 실행(설치·로그인 필요). 기본 claude
    dependsOn?: string[] // D2 — 선행 task id. 전부 done 될 때까지 queued 대기 후 자동 착수
    groupId?: string // D13 — 크로스레포 그룹 소속(startTaskGroup 내부 전용)
    reviewDepth?: ReviewDepth // L4(P6) — 이 작업의 독립 심사 강도(생략 시 설정 reviewDepthDefault)
  } = {},
): Promise<{ taskId?: string; mode?: NaviMode; error?: string; queued?: boolean; queuePos?: number }> {
  const project = getProject(projectId)
  if (!project) return { error: '프로젝트 없음' }
  if (!project.isGit) return { error: '비-git 프로젝트는 Phase 1에서 미지원 (§15b)' }

  // D1 — 즉시 착수 가능 여부. 프로젝트 상한·전역 cap 초과면 거절이 아니라 큐에 적재한다.
  // D14 — 프로젝트당 동시 활성은 projectParallelCap(기본 1=종전 '진행 중이면 대기')까지 허용. 병합 충돌은
  // 새 예측 없이 D8(rebase→verify 재실행)이 사후 판사다.
  // C1 — held(무인 승인/질문 대기) 작업은 compute 슬롯을 안 쓰고 사람을 기다리는 중이므로 카운트에서 제외.
  // D7 — 전역 사용량 가드: 최근 창 누적 토큰이 한도 근접이면 신규 스폰을 큐로 우회(거절 아님). 큐에 쌓아
  // 두고 사용량이 창 밖으로 빠져 여유가 생기면 drainQueue가 착수한다(병렬 작업이 한도를 다 태워 급한 작업을
  // 막는 것 방지). off(limit=0)면 항상 false → 기존 동작 불변.
  const cap = getSettings().concurrencyCap
  const projectBusy =
    activeTaskCountForProject(projectId) >= Math.max(1, getSettings().projectParallelCap)
  const capFull = capRoom(listTasks(), cap, isAwaitingApproval) <= 0
  const usageTripped = usageGuardTripped(recentUsageTokens(), getSettings().usageWindowTokenLimit)
  // D2 — 선행 의존 검증(존재하는 id만 — depsMet는 미지 id를 충족으로 보므로 오타를 여기서 끊는다).
  // 신규 task id는 아직 없으니 사이클은 불가능(사후 조정 set_task_deps 쪽에서 검사).
  const dependsOn = [...new Set(opts.dependsOn ?? [])]
  for (const dep of dependsOn) {
    if (!getTask(dep)) return { error: `선행 작업 없음: ${dep} — list_tasks로 정확한 task_id를 확인해라` }
  }
  const depsWaiting = !depsMet(dependsOn, (id) => getTask(id)?.state)
  const shouldQueue = projectBusy || capFull || usageTripped || depsWaiting

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
  if (opts.mode === 'autonomous' && !AUTONOMOUS_MARKER.test(content)) {
    content += '\n\n<!-- lain:autonomous -->\n'
  } else if (opts.mode === 'interactive' && !INTERACTIVE_MARKER.test(content)) {
    content += '\n\n<!-- lain:interactive -->\n'
  }
  const mode: NaviMode = AUTONOMOUS_MARKER.test(content) ? 'autonomous' : 'interactive'
  // 무개입(autonomous)은 테스트=판사가 전제(§21.1) — verify_cmd 없으면 자동 채점 불가라 거부.
  if (mode === 'autonomous' && !project.verifyCmd) {
    return {
      error:
        'autonomous(무개입)는 verify_cmd가 필요하다(테스트=판사). interactive로 진행하거나 검증 명령을 먼저 설정해라.',
    }
  }
  // D12 — autonomous 미지원 엔진 거절을 capability 기반으로 일반화(하드코딩 엔진 문자열 대신).
  // autonomous는 spec-gaming 방어(테스트 파일 수정 차단)가 canUseTool 기반이라 그 게이트가 없는 엔진(codex 등)에선 불가.
  if (mode === 'autonomous' && !engineCapabilities(opts.engine).autonomous) {
    return {
      error: `${opts.engine ?? 'claude'} 엔진은 autonomous(무개입) 모드를 지원하지 않는다(테스트 보호 게이트 미지원) — interactive로 시작해라.`,
    }
  }
  // Codex 고유 — 시작 전 설치·로그인 검사(런타임 blocked보다 명확한 즉시 에러). capability와 별개:
  // 이건 '엔진 능력'이 아니라 외부 CLI의 설치/로그인 가용성이라 codex 전용 게이트로 유지한다.
  if (opts.engine === 'codex') {
    const st = codexStatus()
    if (!st.ok) return { error: `codex 엔진 사용 불가 — ${st.reason}` }
  }

  // §23 벤치(skipClarify)는 즉시·결정론 실행이 전제라 큐에 넣지 않는다(전용 fixture 프로젝트라 경합도 없음).
  const queue = shouldQueue && !opts.skipClarify

  const taskId = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`
  insertTask({
    id: taskId,
    projectId,
    title,
    state: queue ? 'queued' : 'clarifying',
    content,
    mode,
    permissionMode: opts.permissionMode,
    thinkingLevel: opts.thinkingLevel,
    disallowedTools: opts.disallowedTools,
    skills: opts.skills,
    fastMode: opts.fastMode,
    modelOverride: opts.modelOverride,
    engine: opts.engine,
    dependsOn,
    groupId: opts.groupId,
    reviewDepth: opts.reviewDepth,
  })
  tasksChanged()

  if (queue) {
    // 큐 적재 — 착수는 슬롯이 열릴 때 drainQueue가 clarifyAndLaunch로 태운다(옵션은 task 레코드에 전부 보존).
    const pos = queuedTasks().findIndex((t) => t.id === taskId) + 1
    const why = depsWaiting
      ? `선행 작업 대기(${dependsOn.join(', ')})`
      : projectBusy
        ? '프로젝트 진행 중'
        : capFull
          ? `동시 실행 ${cap}개 제한`
          : '사용량 한도 근접(D7)'
    log(taskId, 'status', `작업 큐 적재[${mode}] ${pos}번째 대기 (${why}): ${title}`)
    return { taskId, mode, queued: true, queuePos: pos }
  }

  log(taskId, 'status', `작업 생성[${mode}${opts.engine === 'codex' ? '·codex' : ''}]: ${title}`)
  // §23 벤치는 clarify를 건너뛴다(측정 일관성 — 명세 명확한 fixture 전제)
  beginTask(taskId, !!opts.skipClarify)

  return { taskId, mode }
}

// D1 — 착수 디스패치(정상 경로·드레인 공유). skipClarify면 clarify 게이트를 건너뛰고 바로 launch.
// startTask/drainQueue 양쪽이 이 함수만 부르게 해 착수 경로 중복을 없앤다.
function beginTask(taskId: string, skipClarify: boolean): void {
  if (skipClarify) void launch(taskId)
  else void clarifyAndLaunch(taskId)
}

// D1 — 슬롯이 열렸을 때 대기 큐를 우선순위대로 착수한다. 슬롯 해제 지점(finishWork→review·cancelTask·
// resolveReview 3결말)과 부팅 recoverTasks 끝에서 호출. 전부 결정론(LLM 호출 없음 — clarify가 LLM을
// 부르는 건 기존 착수 경로라 무방). 순수 판정은 selectQueuedToLaunch에 위임(단위 테스트 대상).
export function drainQueue(): void {
  const queued = queuedTasks() // priority ASC·created_at ASC
  if (queued.length === 0) return
  // D7 — 전역 사용량 가드 발동 중이면 드레인 보류(신규 착수가 한도를 더 태우지 않게). 대기 작업은 큐에
  // 그대로 남고, 사용량이 창 밖으로 빠져 여유가 생기면 이후 드레인 트리거(슬롯 해제·부팅)에서 착수한다.
  // off(limit=0)면 항상 false → 기존 동작 불변.
  if (usageGuardTripped(recentUsageTokens(), getSettings().usageWindowTokenLimit)) {
    log(queued[0].id, 'status', '사용량 한도 근접(D7) — 대기 큐 드레인 보류')
    return
  }
  // D2 — 의존 게이트: 선행이 전부 done인 작업만 이번 드레인 후보. 실패로 안 풀릴 대기는 1회 통지.
  const stateOf = (id: string): TaskState | undefined => getTask(id)?.state
  noteDepFailures(queued, stateOf)
  const eligible = queued.filter((t) => depsMet(t.dependsOn, stateOf))
  if (eligible.length === 0) return
  const tasks = listTasks()
  const cap = getSettings().concurrencyCap
  const room = capRoom(tasks, cap, isAwaitingApproval)
  // D14 — 프로젝트별 활성(queued 제외) 작업 수. projectParallelCap(기본 1=종전 '중복 착수 차단')까지 허용.
  const activeCountByProject = new Map<string, number>()
  for (const t of tasks) {
    if (['done', 'error', 'cancelled', 'queued'].includes(t.state)) continue
    activeCountByProject.set(t.projectId, (activeCountByProject.get(t.projectId) ?? 0) + 1)
  }
  const perProjectCap = Math.max(1, getSettings().projectParallelCap)
  const toLaunch = selectQueuedToLaunch(eligible, room, activeCountByProject, perProjectCap)
  for (const taskId of toLaunch) {
    // 레이스 방어: 비동기 launch 전에 상태를 동기적으로 'clarifying'으로 올려, 재진입 드레인이나
    // 다음 후보 계수(activeTaskForProject/queuedTasks)가 이 착수를 즉시 반영하게 한다.
    setState(taskId, 'clarifying')
    const t = getTask(taskId)
    log(taskId, 'status', `대기 큐에서 착수(드레인): ${t?.title ?? taskId}`)
    beginTask(taskId, false) // 큐 항목은 항상 clarify 게이트를 탄다(skipClarify는 큐에 안 들어옴)
  }
}

// elicitation 게이트 → launch. startTask와 크래시 복원(§15b)이 공유.
// "테스트로 못 적는 지점"이 있으면 blocked로 질문(최대 ELICIT_MAX_ROUNDS회 반복).
// 전부 기준으로 적히면 합격 기준을 Navi DoD로 주입하고 §21.2 모드 판정 후 실행.
async function clarifyAndLaunch(taskId: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  const rounds = (task.content.match(/## 추가 답변/g) ?? []).length
  const v = await elicit(task.content)

  // 취소 레이스(#1) — elicit await(최대 60초) 동안 cancelTask가 들어오면 상태가 'cancelled'로 바뀐다.
  // clarifying은 worktree 전이라 cancelTask는 state만 바꾸는데, 여기서 재확인하지 않으면 아래 blocked
  // setState나 launch가 취소된 작업을 되살려(부활) worktree까지 만든다. 종결 상태면 조용히 종료.
  const cur = getTask(taskId)
  if (!cur || ['cancelled', 'done', 'error'].includes(cur.state)) return

  if (v.questions.length > 0 && rounds < ELICIT_MAX_ROUNDS) {
    setState(taskId, 'blocked', { questions: v.questions })
    log(taskId, 'status', `elicitation — 테스트로 못 적는 지점 ${v.questions.length}건, 답변 대기 (${rounds + 1}/${ELICIT_MAX_ROUNDS})`)
    notifyUser('lain — 질문', `${task.projectId}: 명세 모호 ${v.questions.length}건`)
    drainQueue() // C2 — clarifying→blocked는 cap 슬롯(slotOccupyingCount)을 비운다: 대기 큐에 열린 자리를 착수
    return
  }
  if (v.questions.length > 0) {
    log(taskId, 'status', `elicitation 라운드 상한 도달 — 남은 모호함 감수하고 진행`)
  }

  // 합격 기준 = 실행의 판사. Navi가 보도록 지시서에 주입(잠금) + L3(P6) 구조화 영속(criteria 컬럼).
  // content append는 프롬프트 하위호환을 위해 유지 — criteria 컬럼은 audit 우선순위·Navi 자기검증 체크리스트·
  // TaskDrawer 결재 패널이 읽는 단일 출처(이중 기록 의도적).
  if (v.criteria.length > 0) {
    const block = `\n\n## 합격 기준 (lain elicitation §21.3 — 이걸 충족하면 완료)\n${v.criteria
      .map((c) => `- ${c}`)
      .join('\n')}\n`
    updateTask(taskId, { content: getTask(taskId)!.content + block, criteria: v.criteria })
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
  // D1 — queued 작업은 재개(launch)하지 않고 큐에 그대로 둔 뒤, 부팅 후 슬롯 여유가 있으면 드레인이 착수한다.
  drainQueue()
  return stuck.length
}

// ── ask_manager 흐름 (§5.2): 관리자 헤드리스 판정 → 답 못 하면 사용자 에스컬레이션 ──
function makeAskManager(taskId: string): (question: string) => Promise<string> {
  return async (question: string) => {
    const task = getTask(taskId)
    // 1) 관리자가 답할 수 있으면 즉답 — judge 1콜(#8 공용 러너 — 60초 abort 내장, 없으면 ask_manager를
    // 기다리는 Navi가 영구 대기). 실패·타임아웃·파싱 불능 = 즉답 포기하고 사용자 에스컬레이션(무해 폴백).
    const last = await runJudge(`Navi가 작업 중 질문을 보냈다. 네가 작업 지시서만으로 확실히 답할 수 있으면 답하고, 사용자의 의도·취향·결정이 필요하면 escalate해라.

<task>
${task?.content ?? ''}
</task>

<question>
${question}
</question>

JSON 한 블록만 출력:
\`\`\`json
{"escalate": true|false, "answer": "<escalate=false일 때 Navi에게 줄 답>"}
\`\`\``)
    const obj = parseJsonBlock(last, isJsonObject)
    if (obj && !obj.escalate && obj.answer) {
      log(taskId, 'status', `관리자 즉답: ${String(obj.answer).slice(0, 120)}`)
      return `[lain] ${String(obj.answer)}`
    }
    // 2) 사용자 에스컬레이션 — question 카드
    const approvalId = insertApproval(taskId, 'question', question)
    log(taskId, 'status', `사용자 질문 대기: ${question.slice(0, 120)}`)
    emitGlobal({ taskId, kind: 'status', text: `approval:${approvalId}` })
    notifyUser('lain — Navi 질문', question.slice(0, 120))
    // D4 — 무인 작업 중 질문도 만료해도 거절/포기하지 않는다(세션 보존, 무한 대기). 임계 도달 시 재알림 1회.
    // (30분 무응답 자동거절이 없어져, 야간 무인 작업이 '답 못 받음'으로 차선 우회하는 것을 막는다.)
    const res = await waitApproval(approvalId, {
      hold: true,
      taskId, // C1 — hold 동안 슬롯·유휴 게이트에서 제외
      timeoutMs: approvalTimeoutMs(getSettings().approvalTimeoutMin),
      onRemind: () => {
        log(taskId, 'status', '질문 재알림 — 아직 무응답(계속 대기)')
        notifyUser('lain — 질문 대기 중', `${getTask(taskId)?.projectId ?? taskId}: 아직 답이 없다`)
      },
    })
    if (res.approved && res.answer) return `[user] ${res.answer}`
    return '답변을 받지 못했다. 보수적 기본값으로 진행하거나, 불가능하면 blocked로 보고해라.'
  }
}

// ── 실행 (§8-4~7) ──
async function launch(taskId: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  // 취소 레이스(#1) — 착수 직전에 종결(취소 등)됐으면 worktree를 만들지 않고 종료한다.
  // clarifyAndLaunch(elicit await 뒤)·drainQueue·recoverTasks 어느 경로로 들어오든, 이 사이에 cancelTask가
  // 끼면 취소된 작업을 'working'으로 되살리고 좀비 worktree를 만드는 것을 여기서 최종 차단한다.
  if (['cancelled', 'done', 'error'].includes(task.state)) return
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
    await handleRunError(taskId, e)
  }
}

// D3 — runNavi가 throw해 작업이 error로 죽으려 할 때의 공통 처리(launch·launch2 catch 공유).
// error를 즉시 방치하지 않고, worktree·세션이 살아있으면 error 확정 직전 자동으로 1~2회 재개(백오프)해
// 밤새 일시 장애로 죽은 작업이 아침까지 노는 상황을 없앤다. 재시도 카운트는 task에 영속(무한루프 방지).
// 자동 재개도 모두 실패하면 error 확정 + 원인 요약을 Lain 채팅에 에스컬레이션(기존 notify 경로, LLM 호출 없음).
async function handleRunError(taskId: string, e: unknown): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  // 이미 종결·대기 상태로 정착한 작업은 손대지 않는다(경쟁적 cancel/merge, 또는 finishWork가 이미
  // review/blocked로 처리한 뒤 이후 코드가 throw한 경우) — error로 덮어쓰지 않는다.
  if (['cancelled', 'done', 'review', 'blocked'].includes(task.state)) return
  const msg = String(e)
  const decision = nextAutoRetry(task.autoRetryCount)
  // worktree·세션이 있어야 resume 재개가 의미 있다(없으면 처음부터인데, 초기 셋업 실패는 재시도 무의미).
  const canResume = !!task.worktreePath && !!task.naviSessionId
  if (decision.retry && canResume) {
    // L6 — everAutoRetried는 review 도달 시에도 리셋되지 않는 영속 플래그(loopStats firstPass 판정용).
    updateTask(taskId, { autoRetryCount: decision.nextCount, everAutoRetried: true })
    setState(taskId, 'working')
    log(
      taskId,
      'status',
      `실행 에러 — 자동 재개 예약 ${decision.nextCount}/${AUTO_RETRY_MAX} (${decision.backoffMs / 1000}s 후): ${msg.slice(0, 120)}`,
    )
    setTimeout(() => {
      // 대기 중 취소/종결됐으면 재개 취소.
      const cur = getTask(taskId)
      if (!cur || ['cancelled', 'done', 'review', 'blocked'].includes(cur.state)) return
      void launch2(
        taskId,
        '이전 실행이 예기치 못한 오류로 중단됐다(자동 재개). 작업트리 현재 상태(git status/log/diff)를 먼저 점검하고, 마지막 중단 지점부터 남은 것만 이어가라. 끝나면 동일한 JSON 보고 형식으로 마무리.',
      )
    }, decision.backoffMs)
    return
  }
  // 자동 재개 소진(또는 재개 불가) — error 확정 + 에스컬레이션.
  setState(taskId, 'error', { error: msg })
  emitQuip('task_error') // quips — 자동 재시도로 working 복귀하는 분기(위 return)가 아니라 최종 error 확정만
  void reflectFailure(taskId, 'error', msg).catch(() => {}) // L2 — 최종 error 확정만(자동 재개 소진 후)
  log(taskId, 'error', msg)
  const retried = task.autoRetryCount > 0 ? ` (자동 재개 ${task.autoRetryCount}회 실패)` : ''
  log(taskId, 'status', `자동 복구 실패 — 사람 개입 필요${retried}. resumeTask로 수동 재개 가능.`)
  notifyUser('lain — 작업 실패', `${task.projectId}: ${task.title.slice(0, 40)} — 자동 복구 실패${retried}`)
  drainQueue() // C2 — working→error는 cap 슬롯을 비운다: 대기 큐에 열린 자리를 착수(자동 재개 소진 경로만)
}

// Navi를 실행하되, 도중 §5.7 인터럽트가 들어오면 abort→resume으로 이어간다.
// 인터럽트가 없으면 Navi 보고를 그대로 반환(기존 동작과 동일).
async function runWithInterrupts(
  taskId: string,
  firstOpts: { resumePrompt?: string },
): Promise<FinishReport> {
  const cur = getTask(taskId)!
  const report = await runNavi(cur, emitGlobal, {
    ...firstOpts,
    askManager: makeAskManager(taskId),
    // D10 — 작업별 모델 고정('' = 전역 naviModel, runNavi가 ?? 폴백). §9b 자동 에스컬레이션(finishWork의
    // escalated)과는 경로가 달라 충돌하지 않는다 — 그건 verify 재시도에서 별도로 modelOverride를 넘긴다.
    modelOverride: cur.modelOverride || undefined,
  })
  return drainInterrupts(taskId, report)
}

// §5.7 인터럽트 드레인 — runNavi가 abort→반환한 뒤, 실행 중 주입된 인터럽트 메시지를 회수해 같은 세션
// resume으로 이어간다(없으면 report 그대로). runWithInterrupts(정상 실행 경로)와 finishWork의 verify-재시도
// runNavi가 공유한다. 후자는 runWithInterrupts 밖이라, 이 드레인이 없으면 verify 재시도 중 들어온 사용자
// 인터럽트가 interruptMsgs 맵에 남아 영영 소비되지 않고 유실된다(#2 — interruptTask는 true를 돌려주지만
// 메시지는 반영되지 않는다). 여기서 회수해 다음 verify 이전에 같은 세션에 즉시 반영한다.
async function drainInterrupts(taskId: string, report: FinishReport): Promise<FinishReport> {
  for (;;) {
    const injected = interruptMsgs.get(taskId)
    if (!injected) return report
    interruptMsgs.delete(taskId)
    // 재리뷰 #3 — 취소 레이스 가드: 인터럽트 in-flight(메시지 세팅 후 runNavi 언와인드 전)에 cancelTask 등으로
    // 종결된 작업을 되살리지 않는다. 없으면 아래 setState('working')이 cancelled를 뒤집고 이미 삭제된
    // worktree에서 세션을 재개해 좀비가 병렬 슬롯을 점유한다.
    const latest = getTask(taskId)
    if (!latest || ['cancelled', 'done', 'error'].includes(latest.state)) return report
    // 인터럽트로 끊긴 것 — 사용자 메시지를 resume으로 전달해 같은 세션 이어감.
    // fromInterrupt=true로 핸드오프 스왑을 막는다(인터럽트는 같은 세션 즉시 주입이 핵심 — 매번 스왑하면 연속성 파괴).
    log(taskId, 'status', '인터럽트 처리 — Navi 세션 resume으로 재개')
    setState(taskId, 'working')
    report = await runNavi(getTask(taskId)!, emitGlobal, {
      resumePrompt: `사용자가 작업 중 끼어들었다(최우선 처리). 메시지:\n${injected}\n\n이 지시를 먼저 반영한 뒤 원래 작업을 이어가라.`,
      askManager: makeAskManager(taskId),
      fromInterrupt: true,
      modelOverride: latest.modelOverride || undefined,
    })
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

// D3 — runNavi 자체가 throw(스트림 소진 후에도 복구 못 함)해 error로 죽으려 할 때, error 확정 직전
// 인프로세스로 자동 재개할 최대 횟수. 보수적으로 낮게(무인 실행 신뢰성용 — 밤새 일시 장애로 죽은 작업이
// 아침까지 노는 것 방지). 카운트는 task.autoRetryCount에 영속돼 같은 작업이 반복 error나도 상한에서 멈춘다.
// (재부팅 복원은 error를 자동 재개하지 않으므로 이 카운트가 무한 재시도로 새지 않는다.)
const AUTO_RETRY_MAX = 2

/** 순수·결정론 — error 직전 자동 재개를 한 번 더 할지 판정. count=지금까지 자동재개한 횟수.
 *  retry=true면 다음 재개를 하고 카운트를 nextCount로 올린다. backoffMs=재개 전 대기(지수, 지터 없음).
 *  count가 max 이상이면 소진(retry=false) → 호출부가 error 확정 + 에스컬레이션. */
export function nextAutoRetry(
  count: number,
  max: number = AUTO_RETRY_MAX,
): { retry: boolean; nextCount: number; backoffMs: number } {
  if (count >= max) return { retry: false, nextCount: count, backoffMs: 0 }
  // 1회차 5s, 2회차 15s (일시 장애가 가라앉을 시간을 주되 무인 신뢰성 위해 과하지 않게).
  const backoffMs = count === 0 ? 5_000 : 15_000
  return { retry: true, nextCount: count + 1, backoffMs }
}

interface FinishReport {
  status: 'done' | 'blocked'
  summary: string
  questions: string[]
}

// C1+I5 — 예산 게이트 판정(순수). done 리포트는 예산 초과여도 막지 않는다(verify/review 정상 진행 —
// pause→blocked로 강제하면 결재큐에 못 가고 resume 시 재실행→재초과 무한 루프). done이 아닌 리포트가
// 라이프타임 누적 토큰(lifetimeTokens)으로 예산을 넘겼을 때만 일시정지한다.
export function shouldPauseForBudget(
  status: FinishReport['status'],
  lifetimeTokens: number,
  budget: number,
): boolean {
  return status !== 'done' && budgetExceeded(lifetimeTokens, budget)
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

// D7 — 작업별 토큰 예산 초과 시 일시정지. blocked+questions 재사용(D3/D4 패턴), 결정론(LLM 없음).
// 핸드오프 기록: worktree·git 상태·직전 요약이 컨텍스트를 보존하므로 여기선 사람이 볼 '왜 멈췄나' md를
// 미러 파일에 결정론으로 남긴다(Navi 재요약 LLM 호출 없음 — 예산을 아끼려 멈추는데 또 태우면 자기모순).
function pauseForBudget(
  taskId: string,
  tokens: number,
  budget: number,
  extraQuestions: string[] = [],
): void {
  const task = getTask(taskId)
  if (!task) return
  const summary = (task.summary ?? '').slice(0, 800)
  const md = `# 토큰 예산 초과로 일시정지 (D7)\n\n- 작업: ${task.title}\n- 프로젝트: ${task.projectId}\n- 누적 토큰: ${tokens.toLocaleString()} / 예산 ${budget.toLocaleString()}\n- 브랜치: ${task.branch ?? '(없음)'}\n- 시각: ${new Date().toISOString()}\n\n## 직전 진행 요약\n${summary || '(요약 없음)'}\n\n작업트리와 Navi 세션은 보존돼 있다. 재개하면 마지막 지점부터 이어간다(git status/log 점검 후 남은 것만).`
  try {
    const mirror = path.join(DATA_DIR, 'handoffs', `task-${taskId}-budget.md`)
    fs.mkdirSync(path.dirname(mirror), { recursive: true })
    fs.writeFileSync(mirror, md, 'utf8')
  } catch {
    /* 미러 기록 실패는 무해 — 일시정지·에스컬레이션은 계속 */
  }
  setState(taskId, 'blocked', {
    questions: [
      `토큰 예산(${budget.toLocaleString()})을 초과했다 — 누적 ${tokens.toLocaleString()} 토큰. 여기서 멈췄다. 계속 진행하려면 재개하고, 아니면 이 작업을 취소/검토해라. (작업트리·세션은 보존됨)`,
      ...extraQuestions, // blocked 리포트를 예산으로 멈출 때 Navi 원래 질문을 잃지 않도록 뒤에 보존
    ],
  })
  log(taskId, 'status', `토큰 예산 초과(${tokens.toLocaleString()}/${budget.toLocaleString()}) — 일시정지(blocked), 사람 결정 대기`)
  notifyUser('lain — 토큰 예산 초과', `${task.projectId}: ${task.title.slice(0, 40)} — ${tokens.toLocaleString()}/${budget.toLocaleString()} 토큰`)
  drainQueue() // working 슬롯 해제 — 대기 큐가 열린 자리를 착수(단, 가드 발동 중이면 아래 drainQueue가 보류)
}

async function finishWork(taskId: string, firstReport: FinishReport): Promise<void> {
  const task = getTask(taskId)!
  // 취소된(또는 이미 종결된) task는 abort로 Navi가 빠져나왔을 뿐 — 마무리 진행 금지.
  if (['cancelled', 'done', 'error'].includes(task.state)) return
  const project = getProject(task.projectId)!
  let report = firstReport

  // D7 — 작업별 토큰 예산: 이 세션이 끝난 시점(worker가 task.tokens를 방금 갱신)의 누적 토큰이 예산을 넘으면,
  // verify/review/reflect로 더 태우지 않고 일시정지한다. 새 state를 만들지 않고 기존 blocked+questions 경로를
  // 재사용(D3/D4와 동형 — 스키마·복원 무변경). 사용자가 resume하면 worktree·세션이 보존돼 이어간다.
  // 결정론(LLM 호출 없음): 판정은 순수 budgetExceeded, 핸드오프 md도 결정론으로 기록.
  // C1+I5 — done 리포트(작업 완료)는 예산 초과여도 막지 않는다: pause→blocked로 강제하면 결재큐에 못 가고
  // resume 시 Navi 재실행→예산 재초과로 무한 루프에 빠진다. done은 verify/review로 정상 진행(verify 재시도는
  // VERIFY_RETRIES 상한이라 유한). blocked 리포트를 예산으로 멈출 땐 Navi 원래 질문(firstReport.questions)을
  // pauseForBudget에 넘겨 예산 메시지 + Navi 질문을 둘 다 보존한다(pauseForBudget은 extraQuestions 4번째 인자 수용).
  // I4 — 예산 판정은 라이프타임 누적(tokensTotal)을 기준으로 한다: 다중 세션(핸드오프·resume·verify재시도)
  // 작업이 세션마다 tokens가 리셋돼도 예산이 걸리도록. tokensTotal이 0인 legacy 행/미갱신 시엔 tokens로 폴백.
  const lifetimeTokens = task.tokensTotal || task.tokens
  if (shouldPauseForBudget(firstReport.status, lifetimeTokens, getSettings().taskTokenBudget)) {
    pauseForBudget(taskId, lifetimeTokens, getSettings().taskTokenBudget, firstReport.questions)
    return
  }
  let verifyResult = 'skipped(verify_cmd 없음)'
  let flakeRetried = false // §i11 — flake는 작업당 1회만 무료(동일 모델) 재시도

  for (let attempt = 0; ; attempt++) {
    updateTask(taskId, { diffStat: diffStat(project, taskId), summary: report.summary })

    if (report.status === 'blocked') {
      setState(taskId, 'blocked', { questions: report.questions })
      log(taskId, 'status', 'Navi blocked — 질문 답변 대기')
      notifyUser('lain — 질문', `${task.projectId}: Navi가 막힘`)
      drainQueue() // C2 — working→blocked는 cap 슬롯을 비운다: 대기 큐에 열린 자리를 착수
      return
    }

    if (!project.verifyCmd) break

    log(taskId, 'status', `verify 실행 (${attempt + 1}회차): ${project.verifyCmd}`)
    // 고아 방지 — execP 직호출은 Windows 타임아웃 시 직속 자식(cmd.exe)만 죽어 손자(vitest/dev서버)가
    // 포트·파일락을 쥔 채 고아로 남고, 다음 verify의 EADDRINUSE flake를 스스로 유발한다. verifyInDir는
    // 같은 판정 계약(pass/tail)에 타임아웃 시 killTree(트리 전체 종료)를 내장한다(collectors.ts 주석).
    const v = await verifyInDir(project.verifyCmd, getTask(taskId)!.worktreePath!)
    if (v.pass) {
      verifyResult = 'pass'
      break
    }
    const tail = v.tail.slice(-800) // 기존 execP 판정과 동일한 꼬리 상한(800자) 유지
    verifyResult = `fail: ${tail}`
    // §24 — 환경 블로커(네트워크·도구·시크릿·권한)는 재시도/에스컬레이션이 무의미 → 즉시 blocked로 사람에게.
    const cls = classifyVerifyFailure(tail)
    if (!cls.retryable) {
      log(taskId, 'status', `verify 실패 — 재시도 무의미(${cls.reason}) → 즉시 blocked (§24)`)
      void reflectFailure(taskId, 'blocked', cls.reason).catch(() => {}) // L2 — 환경 블로커 사유
      setState(taskId, 'blocked', {
        verifyResult,
        questions: [
          `검증이 환경 문제로 실패했다(${cls.reason}). 코드 수정으로는 안 풀린다 — 사람 개입 필요.\n출력 끝:\n${tail.slice(-300)}`,
        ],
      })
      saveStatus({ projectId: task.projectId, summary: `환경 블로커로 중단: ${cls.reason}` })
      projectsChanged()
      notifyUser('lain — 환경 블로커', `${task.projectId}: ${cls.reason}`)
      drainQueue() // C2 — working→blocked(환경 블로커)는 cap 슬롯을 비운다: 대기 큐에 열린 자리를 착수
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
      emitQuip('verify_fail') // quips — verify 재시도 소진(환경 블로커·spec-gaming과 다른 분기)
      void reflectFailure(taskId, 'verify', tail).catch(() => {}) // L2 — verify 재시도 소진(이후 review로 흐름, blocked 아님)
      break
    }
    // 실패 출력을 Navi에 피드백하고 같은 세션 resume으로 수정 시도.
    // §9b: 마지막 재시도는 상위 티어 모델로 에스컬레이션. 기준선은 이 작업의 modelOverride(D10)가
    // 있으면 그걸, 없으면 전역 naviModel을 쓴다 — 작업별 고정 모델을 에스컬레이션이 조용히 무시하지 않게.
    const tierUp: Record<string, string> = { haiku: 'sonnet', sonnet: 'opus' }
    const baseModel = task.modelOverride || getSettings().naviModel
    const escalated = attempt === VERIFY_RETRIES - 1 ? tierUp[baseModel] : undefined
    if (escalated)
      log(taskId, 'status', `모델 에스컬레이션(§9b): ${escalated}로 마지막 재시도`)
    log(taskId, 'status', `verify 실패 — Navi에 피드백 후 재시도 (${attempt + 1}/${VERIFY_RETRIES})`)
    report = await runNavi(getTask(taskId)!, emitGlobal, {
      resumePrompt: `검증 명령(${project.verifyCmd})이 실패했다. 출력 끝부분:\n\`\`\`\n${tail}\n\`\`\`\n원인을 고치고 커밋해라.`,
      askManager: makeAskManager(taskId),
      modelOverride: escalated ?? (task.modelOverride || undefined),
    })
    // #2 — 이 runNavi는 runWithInterrupts 밖이라, 실행 중 들어온 §5.7 인터럽트가 유실된다. 드레인으로
    // 회수해 같은 세션에 즉시 주입한 뒤(없으면 no-op) 다음 verify 재실행으로 이어간다.
    report = await drainInterrupts(taskId, report)
  }

  // verify 루프 이후 상태 재확인(Lain 기여) — verify 실행 중 cancelTask가 경쟁적으로 호출되면
  // worktree가 삭제되고 state가 'cancelled'로 바뀐 뒤 여기에 도달할 수 있다. 그 상태에서
  // changedFiles·setState('review')를 계속 실행하면 취소 상태를 덮어쓰거나 삭제된 worktree 접근으로
  // throw한다 — 재확인 후 종료로 차단.
  if (['cancelled', 'done', 'error'].includes(getTask(taskId)?.state ?? '')) return

  // §24 — autonomous spec-gaming 사후검증: verify가 판사인데 Navi가 테스트 파일을 바꿔 통과를 위조했는지.
  // (테스트 파일 Edit/Write는 canUseTool에서 이미 차단하나 Bash sed 등 우회 가능 → 커밋·미커밋 diff로 확인.)
  if (verifyResult === 'pass' && task.mode === 'autonomous') {
    // git 조회 실패(null)는 '변경 파일 없음'과 다르다 — 검사를 못 한 것이므로 조용히 통과시키지 않고
    // 로그로 남긴다(자동 blocked는 과잉: 병합은 어차피 사람 결재 전용이고 직후 L1 심사가 같은 diff를 본다).
    const changed = changedFiles(project, taskId)
    if (changed === null)
      log(taskId, 'status', '⚠ spec-gaming 사후검증 불능(git 조회 실패) — 결재 전 수동 확인 필요')
    const touchedTests = (changed ?? []).filter(isTestFile)
    if (touchedTests.length) {
      log(taskId, 'status', `spec-gaming 의심(§24): autonomous인데 테스트 파일 변경 → blocked (${touchedTests.slice(0, 3).join(', ')})`)
      setState(taskId, 'blocked', {
        verifyResult: `의심: 테스트 파일 변경(${touchedTests.join(', ')})`,
        questions: [
          `autonomous 작업이 verify를 통과했지만 테스트 파일(${touchedTests.join(', ')})을 수정했다. 테스트=판사를 위조했을 수 있다 — 사람 검토가 필요하다(이 작업의 학습은 신뢰할 수 없어 학습하지 않는다).`,
        ],
      })
      notifyUser('lain — spec-gaming 의심', `${task.projectId}: 테스트 파일 변경됨`)
      drainQueue() // C2 — working→blocked(spec-gaming 의심)는 cap 슬롯을 비운다: 대기 큐에 열린 자리를 착수
      return
    }
  }

  // T14(P6) — L1 독립 완료 심사: verify 통과 후·결재 전, Navi 자기 보고를 신뢰하지 않고 실제 git diff·
  // 완료 조건과 대조한다. verify가 실제 통과한 경우에만 돌린다(verify 소진으로 review에 온 작업은 이미
  // 실패가 표시돼 심사 불요 — 비용 절약). 미통과면 1회에 한해 자동 재작업(launch2 재개 경로 재사용 —
  // runWithInterrupts 인터럽트 가드 + finishWork 자연 재진입, cancelTask 레이스 #3 재도입 방지). 심사
  // 불능(null)이나 통과면 그대로 review로. 재작업 후 재진입 시엔 auditRetried=true라 결과만 달고 review.
  // L4(P6) — 심사 강도는 작업별 reviewDepth(생략 시 설정 reviewDepthDefault) 다이얼로 runAudit이 분기
  // (light=심사 생략 → null이라 아래 '통과면 그대로 review' 경로와 자연 합류, standard=기존 1콜, adversarial=3렌즈 합의).
  let auditResult: string | undefined
  // verify_cmd 없는 작업은 verifyResult가 'skipped(...)'로 고정돼 절대 'pass'가 안 된다 — 그 경우
  // 심사가 유일한 판사이므로 게이트에 포함한다(원래는 verify 자체가 실패한 fail만 걸러내면 충분).
  if (verifyResult === 'pass' || verifyResult.startsWith('skipped')) {
    const fresh = getTask(taskId)! // diffStat·summary·auditRetried 최신값(finishWork 루프 top에서 갱신됨)
    if (fresh.worktreePath) {
      // A3(확신도 소비) — 최근 7일 실적에 사고 신호(rework·심사 미통과)가 있는 프로젝트는 기본 심사를
      // standard→adversarial로 상향(decideReviewDepth — 상향만, 작업별 명시 reviewDepth는 그대로 존중).
      const base = fresh.reviewDepth ?? getSettings().reviewDepthDefault
      const ps = promotionStats(task.projectId, 7)
      const depth = decideReviewDepth(
        fresh.reviewDepth,
        getSettings().reviewDepthDefault,
        ps.recentReworked > 0 || ps.recentAuditRetried > 0,
      )
      if (depth !== base)
        log(
          taskId,
          'status',
          `심사 상향(A3): 최근 ${ps.days}일 rework ${ps.recentReworked}건·심사 미통과 ${ps.recentAuditRetried}건 — ${base}→${depth}`,
        )
      const verdict = await runAudit(fresh, fresh.worktreePath, depth).catch(() => null)
      // 심사(LLM)는 수초 걸린다 — 그 사이 cancelTask 경쟁 시 종결 상태를 setState로 되살리지 않는다(#3 가드).
      if (['cancelled', 'done', 'error'].includes(getTask(taskId)?.state ?? '')) return
      if (verdict && !verdict.pass && !fresh.auditRetried) {
        setState(taskId, 'working', { auditRetried: true }) // 1회 한정 재시도 플래그(영속 → 재진입 시 재시도 금지)
        log(taskId, 'status', `독립 심사 미통과(${verdict.issues.length}건) — 1회 자동 재작업 후 재심사`)
        const fb = `독립 심사에서 미완료 판정이 나왔다. 미충족 사유:\n${verdict.issues
          .map((i) => `- ${i}`)
          .join('\n')}\n각 사유를 해소하고 커밋한 뒤 다시 완료 보고하라.`
        void launch2(taskId, fb) // finishWork verify-재시도와 동일한 가드된 재개 경로(runWithInterrupts→finishWork)
        return
      }
      if (verdict) auditResult = JSON.stringify(verdict)
      else if (depth !== 'light') {
        // light는 심사를 아예 생략해 null이 정상이지만, 그 외 강도의 null은 심사가 실패한 것이다.
        // 결재 화면(TaskDrawer)은 둘 다 '—(미심사)'로 그려 구분이 안 되니 로그에 불능임을 남긴다.
        log(taskId, 'status', '⚠ 독립 심사 불능 — 심사 없이 결재로 넘어감')
      }
    }
  }

  // D3 — 여기까지 완주(review 도달)했으면 자동 재개 예산을 리셋한다(작업이 정상 진전했다는 신호).
  // 이후 blocked→재개 등에서 새로 error가 나면 다시 온전한 재시도 예산을 갖도록.
  setState(taskId, 'review', { verifyResult, autoRetryCount: 0, ...(auditResult ? { auditResult } : {}) })
  // quips — 1시간 내 3건째 완주(review 도달)면 한마디(인메모리 플레이버, 트리거 쿨다운 1h이 반복 억제)
  reviewStreakAt = [...reviewStreakAt.filter((t) => Date.now() - t < 3_600_000), Date.now()]
  if (reviewStreakAt.length >= 3) emitQuip('tasks_streak')
  log(taskId, 'status', `검토 대기 — verify: ${verifyResult.slice(0, 120)}`)
  drainQueue() // D1 — working 슬롯 해제(→review): 대기 큐에 열린 자리를 착수한다.
  // 판단 요약 (§10.2) — 관리자 다이제스트에 반영
  saveStatus({ projectId: task.projectId, summary: report.summary.slice(0, 500) })
  projectsChanged()
  // T14 — 결재 알림에 독립 심사 요약: 통과면 안심, 미통과(재작업 후에도)면 결재 시 참고하라고 경고.
  let auditNote = ''
  if (auditResult) {
    try {
      const v = JSON.parse(auditResult) as AuditVerdict
      auditNote = v.pass ? ' — 심사 통과' : ` — ⚠ 심사 미통과 사유 ${v.issues.length}건(결재 시 참고)`
    } catch {
      /* 손상 JSON — 알림엔 심사 표시 생략 */
    }
  }
  notifyUser('lain — 결재 대기', `${task.projectId}: ${task.title.slice(0, 60)}${auditNote}`)

  // §22 자기개선 — verify pass한 작업에서만 학습 추출(틀린 학습 누적 방지).
  // verify_cmd가 없으면 자동 채점 불가라 신뢰 못 함 → 건너뜀.
  if (verifyResult === 'pass') {
    void reflect(taskId).catch((e) => log(taskId, 'status', `자기개선 회고 실패: ${e}`))
  }
}

// §22 회고 — 검증된 작업의 diff·보고에서 재사용 가능한 학습을 judge 모델로 추출·저장.
async function reflect(taskId: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  // 회고가 본 주입 학습(§8) — judge가 'cited_lesson_ids'로 인용해 계보를 추적하게 한다.
  const injected = lessonsForProject(task.projectId, 8, task.content)
  const injectedBlock = injected.length
    ? `<injected-lessons>\n${injected
        .map((l) => `[L${l.id}] (${l.scope}) ${l.trigger ? l.trigger + ' → ' : ''}${l.lesson}`)
        .join('\n')}\n</injected-lessons>`
    : ''
  // judge 1콜(#8 공용 러너 — 60초 abort 내장). 실패(null)면 학습 없이 종료 — 무해 폴백.
  const last = await runJudge(`너는 lain의 회고 담당이다. 방금 검증(테스트)을 통과한 작업에서, **이 프로젝트의 이후 작업에 재사용할 수 있는 학습**을 0~2건 뽑아라.
좋은 학습 예: 프로젝트 컨벤션(파일명·디렉터리 구조·도구·명령), 검증을 통과시키는 데 필요했던 비자명한 단계, 이 repo 특유의 제약.

이 학습들은 다음 Navi의 프롬프트에 그대로 주입된다 — 잘못 적으면 미래의 Navi가 시도도 안 하고 거부(self-refusal)하게 굳는다. 다음은 **학습이 아니다. 절대 만들지 마라**:
1. 환경/설치 실패 — 누락 바이너리·command-not-found·미설치·시크릿/env 누락·경로 불일치. 이건 그 머신의 일시 상태지 프로젝트 사실이 아니다.
2. 도구/기능 부정단정 금지 — "X 안 됨", "Y 깨짐", "Z 못 씀" 류. Navi 프롬프트에 박히면 self-refusal로 굳는다.
3. 재시도로 풀린 일시 오류 — 학습은 "X가 안 된다"가 아니라 "X 실패하면 retry/재실행" 패턴만 저장.
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
{"lessons": [{"scope": "project|global", "trigger": "<언제 적용되나, 키워드>", "lesson": "<재사용 학습 한두 문장>", "cited_lesson_ids": [<이 학습을 도출하는 데 실제 도움된 주입 학습 L번호들, 없으면 빈배열>]}]}
\`\`\`
- scope: 이 repo 한정이면 project, 어떤 프로젝트에도 통하는 일반 원칙이면 global.
- cited_lesson_ids: 위 injected-lessons 중 이번 작업에 실제로 도움이 된 것의 L번호만. 추측 금지, 없으면 [].`)
  if (last === null) {
    log(taskId, 'status', '자기개선 회고 실패: judge 무응답/타임아웃')
    return
  }
  const obj = parseJsonBlock(last, isJsonObject)
  if (!obj) {
    log(taskId, 'status', `자기개선 회고: JSON 블록 없음/파싱 실패 (응답 ${last.length}자)`)
    return
  }
  const lessons = Array.isArray(obj.lessons) ? obj.lessons : []
  if (lessons.length === 0) log(taskId, 'status', '자기개선 회고: 재사용 학습 없음(0건)')
  // 주입된 학습 id 집합 — judge가 지어낸 id는 무시(보수적).
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
    // §8/i10 — 이번 작업에 실제 도움된 주입 학습만 진짜 재사용으로 bump(계보 추적).
    if (Array.isArray(l.cited_lesson_ids)) {
      for (const raw of l.cited_lesson_ids) {
        const id = Number(raw)
        if (Number.isInteger(id) && injectedIds.has(id)) citedIds.add(id)
      }
    }
  }
  if (citedIds.size > 0) {
    bumpLessonReuse([...citedIds])
    log(taskId, 'status', `자기개선(§22): 근거 학습 ${citedIds.size}건 재사용 bump`)
  }
  if (saved > 0) {
    log(taskId, 'status', `자기개선(§22): 학습 ${saved}건 학습`)
    projectsChanged()
  }
}

// L2 회고 — 실패(verify 소진/환경 블로커/error 확정)한 작업에서 재사용 가능한 원인·대처를 judge 1콜로
// 한 줄 추출해 프로젝트 학습으로 저장한다(reflect의 judge 골격을 축소 복사). fire-and-forget 호출 전제라
// 실패해도 조용히 무시된다 — 다음 시도의 진행을 막지 않는다. 주입은 다음 runNavi의 lessonsBlock이 자동 수행.
async function reflectFailure(taskId: string, kind: 'verify' | 'error' | 'blocked', detail: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  // judge 1콜(#8 공용 러너 — 60초 abort 내장). 실패(null)는 조용히 무시 — fire-and-forget 전제 유지.
  const last = await runJudge(buildPostmortemPrompt(task.title, kind, detail))
  const lesson = parsePostmortem(last ?? '')
  if (!lesson) return
  insertLesson({ projectId: task.projectId, taskId, scope: 'project', trigger: `실패(${kind})`, lesson, origin: 'agent' })
  log(taskId, 'status', `실패 회고(L2): ${lesson}`)
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
  // 사용자가 직접 재개하는 건 새 시도 — D3 자동 재개 예산을 리셋해 다시 온전한 재시도 여력을 준다.
  setState(taskId, 'working', { autoRetryCount: 0 })
  tasksChanged()
  void launch2(
    taskId,
    '사용자가 작업을 수동으로 재개했다. 작업트리 현재 상태(git status/log/diff)를 먼저 점검하고, 마지막 중단 지점부터 남은 것만 이어가라. 끝나면 동일한 JSON 보고 형식으로 마무리.',
  )
}

// D11 — done/cancelled(종결) 작업을 같은 명세로 재실행. 원본 task는 손대지 않고 startTask로 새 task를
// 만든다(원본 보존 — 이력·비용·outcome이 그대로 남는다). content를 통째로 복제하므로 elicitation으로
// 확정된 '## 합격 기준' 블록과 과거 '## 추가 답변' 이력도 함께 넘어간다(§21.3 산출물 재사용).
// mode는 opts로 강제하지 않는다 — content에 이미 §21.2 마커가 박혀 있으면 startTask가 그대로 재판정해
// 원본과 같은 모드로 떨어진다(마커 없이 자동판정됐던 원본은 새 clarify에서 다시 자동판정).
export async function rerunTask(
  taskId: string,
): Promise<{ taskId?: string; mode?: NaviMode; error?: string }> {
  const task = getTask(taskId)
  if (!task) return { error: '작업 없음' }
  if (task.state !== 'done' && task.state !== 'cancelled') {
    return { error: 'done 또는 cancelled 상태만 재실행할 수 있다' }
  }
  return startTask(task.projectId, {
    content: task.content,
    permissionMode: task.permissionMode,
    thinkingLevel: task.thinkingLevel,
    disallowedTools: task.disallowedTools,
    skills: task.skills ?? undefined,
    fastMode: task.fastMode,
    modelOverride: task.modelOverride,
    engine: task.engine,
  })
}

async function launch2(taskId: string, resumePrompt: string): Promise<void> {
  const task = getTask(taskId)
  if (!task) return
  try {
    const report = await runWithInterrupts(taskId, { resumePrompt })
    await finishWork(taskId, report)
  } catch (e) {
    await handleRunError(taskId, e)
  }
}

// D8 병합(ff) + rebase 폴백(verify 재실행 포함) — resolveReview 개별 결재와 resolveGroup 일괄 병합이 공유.
// 부수효과는 진행 로그·rebase 후 verifyResult 갱신뿐 — worktree 정리·상태 전이·되돌릴 범위 저장은 호출부가 한다.
async function mergeWithRebaseFallback(
  project: Project,
  task: Task,
): Promise<{ merged: boolean; reason: string; baseSha?: string; mergedSha?: string }> {
  const taskId = task.id
  let m = tryMerge(project, taskId)
  // D8 rebase 폴백 — ff 불가(분기 후 메인 전진)이고 메인이 dirty가 아니면 자동 rebase 시도.
  // dirty면 rebase해도 어차피 ff 병합이 막히므로 건너뛴다(reason에 dirty 명시). 비파괴: worktree
  // 브랜치만 rebase, 충돌·verify실패면 브랜치만 남기고 사람에게(메인은 손대지 않음).
  if (!m.merged && getSettings().autoRebaseOnMerge && project.isGit && !m.reason.includes('dirty')) {
    log(taskId, 'status', 'ff 불가 — main에 rebase 폴백 시도…')
    const rb = rebaseWorktreeOntoMain(project, taskId)
    if (rb.ok) {
      // rebase 성공 → verify 재실행(시간 소요, 진행 표시). verify_cmd 없으면 재검증 없이 진행.
      let verifyOk = true
      let verifyNote = 'verify_cmd 없음 — 재검증 생략'
      if (project.verifyCmd && task.worktreePath) {
        log(taskId, 'status', 'rebase 후 verify 재실행…')
        const v = await verifyInDir(project.verifyCmd, task.worktreePath)
        verifyOk = v.pass
        verifyNote = v.pass ? 'rebase 후 verify 통과' : 'rebase 후 verify 실패'
        // 재검증 결과를 task.verifyResult에 반영(리뷰 화면·후속 판단에 최신값)
        setState(taskId, 'review', { verifyResult: v.pass ? 'pass' : v.tail })
      }
      if (verifyOk) {
        // 이제 ff 가능 — 재시도.
        m = tryMerge(project, taskId)
        if (m.merged) m.reason = `rebase 후 fast-forward 병합 완료 (${verifyNote})`
      } else {
        // verify 실패 — 브랜치만 남긴다(사람 개입). rebase는 worktree 브랜치에만 적용됐고
        // 메인은 전진하지 않았으므로 안전. 브랜치를 보존해 수동 검토·머지를 맡긴다.
        m = { merged: false, reason: 'rebase 후 verify 실패 — 브랜치만 남김. 직접 확인/머지해라.' }
      }
    } else {
      // rebase 충돌 등 — 이미 abort로 worktree 원복됨. 브랜치만 남긴다.
      m = { merged: false, reason: rb.reason }
    }
  }
  return m
}

// ── 검토 결정 (§8-9) ──
export async function resolveReview(
  taskId: string,
  action: 'merge' | 'keep-branch' | 'discard' | 'rework',
  comment?: string,
): Promise<string> {
  const task = getTask(taskId)
  if (!task || task.state !== 'review') return '검토 상태가 아니다'
  // D13 — 그룹 소속 작업의 개별 '병합'은 봉쇄(반쪽 상태 방지) — resolve_group으로 일괄 결재. keep-branch/discard/rework는 개별 허용.
  if (task.groupId && action === 'merge') {
    return '이 작업은 크로스레포 그룹 소속이라 개별 병합할 수 없다 — resolve_group으로 그룹 전체를 일괄 병합(all-or-nothing)해라. (개별 keep-branch/discard/rework는 가능)'
  }
  // I6 — 동기 체크-앤-셋(review 가드 직후, verifyInDir await 전): 두 번째 동시 호출은 여기서 거절돼
  // 이중 merge/removeWorktree를 막는다. 아래 전체를 try/finally로 감싸 어떤 종료 경로에서도 해제한다.
  if (resolvingReviews.has(taskId)) return '이미 결재 처리 중이다'
  resolvingReviews.add(taskId)
  try {
  const project = getProject(task.projectId)
  if (!project) return '프로젝트 없음'

  // T15(P6) — rework: 반려 대신 지적사항으로 같은 worktree 재작업. worktree는 review 상태에서 보존돼
  // 있으므로(discard만 삭제) 추가 조치 없이 launch2로 재개한다 — resumeTask(error 수동재개)와 동일하게
  // review→working으로 슬롯을 재점유하고 drainQueue는 부르지 않는다. 재작업 완료 시 finishWork→verify→
  // audit(T14)→review로 자연 재진입한다(audit은 auditRetried 영속 플래그로 최대 1회만 재시도 → 발산 없음).
  if (action === 'rework') {
    if (!canRework(task.reworkCount ?? 0)) {
      return `재작업 상한(${REWORK_MAX}회) 도달 — 병합/보류/폐기로 결정하세요`
    }
    const round = (task.reworkCount ?? 0) + 1
    // #9 — 사람 지적 코멘트를 프롬프트 소비로 끝내지 않고 학습으로 영속(LLM 0콜). origin='user'라
    // curator 폐기 대상에서 제외되고, 기존 lessons 주입 경로(lessonsBlock)가 다음 작업에 자동 태운다.
    if (comment?.trim()) {
      insertLesson({
        projectId: task.projectId,
        taskId,
        scope: 'project',
        trigger: `재작업 지적(${task.title})`,
        lesson: comment.trim(),
        origin: 'user',
      })
    }
    // 이전 라운드 심사 판정을 비워둔다 — 재작업 후 verify가 실패해 audit을 건너뛰면(위 T14 게이트) 갱신 기회가
    // 없어 결재 화면(TaskDrawer 체크리스트)에 지난 라운드 ✗가 그대로 남는다(falsy 클리어 관례, rowToTask 참고).
    setState(taskId, 'working', { reworkCount: round, auditResult: '' })
    void launch2(taskId, buildReworkPrompt(comment ?? '', round)) // verify 실패 재개와 동일 재개 경로(runWithInterrupts→finishWork)
    const msg = `수정 요청 접수 — 재작업 ${round}/${REWORK_MAX}회차`
    log(taskId, 'status', msg)
    return msg
  }

  let result = ''
  if (action === 'merge') {
    const m = await mergeWithRebaseFallback(project, task)
    result = m.reason
    removeWorktree(project, taskId, m.merged) // 병합됐으면 브랜치도 정리
    archiveTaskMd(project, task, `merge: ${m.reason}`)
    // D8 — ff 병합 성공 시 되돌릴 범위(base..head)를 task에 저장(revert_merge에 사용).
    const mergeExtra: Partial<Task> =
      m.merged && m.baseSha && m.mergedSha
        ? { mergeBaseSha: m.baseSha, mergeHeadSha: m.mergedSha }
        : {}
    setState(taskId, 'done', { summary: `${task.summary ?? ''}\n[병합] ${m.reason}`, ...mergeExtra })
    if (m.merged) {
      emitQuip('task_done') // quips — merge 성공한 완료만(병합 실패로 done 못 간 케이스는 대사 없음)
    } else {
      // 병합 실패는 인박스에서 행이 사라지고 패널 한 줄만 남아 창을 안 보고 있으면 놓친다 —
      // 그룹 일괄 병합 실패(resolveGroup)와 대칭으로 알림을 띄운다.
      notifyUser('lain — 병합 실패', `${task.projectId}: ${m.reason.slice(0, 120)}`)
    }
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
  drainQueue() // D1 — review 결말(done/keep-branch/discard) 모두 슬롯을 해제하니 대기 큐를 착수한다.
  return result
  } finally {
    resolvingReviews.delete(taskId) // I6 — 성공·실패·throw 어느 경로에서도 in-flight 해제
  }
}

// ── D8 병합 되돌리기 ──
// done 상태 + ff 병합으로 포착된 범위(base..head)가 있는 작업만 대상. 비파괴 — main에 새 revert
// 커밋을 쌓아 되돌린다(reset/force 금지). 충돌·dirty면 abort 후 실패 메시지. task state는 done 유지
// (되돌림 이력만 summary에 append). resolve_review의 review-state 결재와 별개 경로다.
export async function revertMerge(taskId: string): Promise<string> {
  const task = getTask(taskId)
  if (!task) return '작업 없음'
  if (task.state !== 'done') return '완료(done) 상태 작업만 병합을 되돌릴 수 있다'
  if (!task.mergeBaseSha || !task.mergeHeadSha) {
    return '되돌릴 병합 기록이 없다(ff 병합으로 완료된 작업만 가능 — keep-branch/discard는 제외)'
  }
  const project = getProject(task.projectId)
  if (!project) return '프로젝트 없음'

  const r = revertMergeRange(project, task.mergeBaseSha, task.mergeHeadSha)
  if (r.ok) {
    // 되돌림 이력을 summary에 남긴다(비파괴 표시). 되돌린 뒤엔 재-revert를 막기 위해 범위를 지운다.
    setState(taskId, 'done', {
      summary: `${task.summary ?? ''}\n[병합 되돌림] ${r.reason} (범위 ${task.mergeBaseSha.slice(0, 7)}..${task.mergeHeadSha.slice(0, 7)})`,
      mergeBaseSha: null,
      mergeHeadSha: null,
    })
  }
  log(taskId, 'status', `병합 되돌리기: ${r.reason}`)
  return r.reason
}

// ── D13 크로스레포 작업 그룹 ──
// 공유 명세 + repo별 child task를 한 그룹으로 묶어, 모든 child가 review일 때만 일괄 병합(all-or-nothing).
// 중간 병합 실패 시 이미 병합된 child를 revertMergeRange로 자동 롤백해 '한쪽만 병합된 반쪽 상태'를 원천 차단.

/** 그룹 생성 — child는 서로 다른 프로젝트 전제(§5). 각 child = 공유 spec + repo별 몫. child는
 *  일반 startTask 경로를 타므로 clarify·큐·병렬 정책이 그대로 적용된다(그룹은 결재 게이트만 얹는다). */
export async function startTaskGroup(
  title: string,
  spec: string,
  children: { projectId: string; content: string }[],
): Promise<{ groupId?: string; started?: { taskId: string; projectId: string; queued?: boolean }[]; error?: string }> {
  if (children.length < 2) return { error: '그룹은 child 작업이 2개 이상이어야 한다(단일 레포는 start_task를 써라)' }
  // 사전 검증 — 하나라도 부적격이면 아무것도 만들지 않는다(부분 생성 방지).
  const seen = new Set<string>()
  for (const c of children) {
    const p = getProject(c.projectId)
    if (!p) return { error: `프로젝트 없음: ${c.projectId}` }
    if (!p.isGit) return { error: `비-git 프로젝트는 그룹 작업 불가: ${c.projectId}` }
    if (!c.content?.trim()) return { error: `child 작업 내용(content)이 비었다: ${c.projectId}` }
    if (seen.has(c.projectId)) return { error: `같은 프로젝트를 그룹에 중복 지정: ${c.projectId} (크로스레포 전제)` }
    seen.add(c.projectId)
  }
  const groupId = `g-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`
  insertTaskGroup({ id: groupId, title: title.slice(0, 120), spec })
  const started: { taskId: string; projectId: string; queued?: boolean }[] = []
  for (const c of children) {
    const content = `${spec}\n\n## 이 레포(${c.projectId})의 몫\n${c.content}`
    const r = await startTask(c.projectId, { content, groupId })
    if (r.taskId) started.push({ taskId: r.taskId, projectId: c.projectId, queued: r.queued })
    else log(groupId, 'status', `그룹 child 생성 실패(${c.projectId}): ${r.error ?? '?'}`)
  }
  log(groupId, 'status', `크로스레포 그룹 '${title}' 생성 — child ${started.length}/${children.length}`)
  return { groupId, started }
}

// 이미 병합된 child들을 역순으로 되돌린다(반쪽 상태 차단). 되돌린 child는 done 유지 + [그룹 롤백] 표기
// (worktree·브랜치는 이미 제거됨 — 재실행은 rerun_task). revert 실패(dirty main 등)는 로그로 표면화.
// 재리뷰 #1 — SHA 범위 제거는 revert '성공' 시에만(revertMerge와 대칭). 실패면 병합이 main에 남아
// 있으므로 기록을 보존해야 revert_merge로 수동 재시도가 가능하다(지우면 되돌릴 방법이 영영 소실).
async function rollbackGroupMerges(
  merged: { task: Task; project: Project; baseSha: string; headSha: string }[],
): Promise<number> {
  let reverted = 0
  for (const m of [...merged].reverse()) {
    const r = revertMergeRange(m.project, m.baseSha, m.headSha)
    if (r.ok) {
      setState(m.task.id, 'done', {
        summary: `${m.task.summary ?? ''}\n[그룹 롤백] ${r.reason}`,
        mergeBaseSha: null,
        mergeHeadSha: null,
      })
      reverted++
    } else {
      setState(m.task.id, 'done', {
        summary: `${m.task.summary ?? ''}\n[그룹 롤백 실패] ${r.reason} — 병합 기록 보존(revert_merge로 재시도 가능)`,
      })
      log(m.task.id, 'status', `⚠ 그룹 롤백 실패 — 수동 되돌리기 필요: ${r.reason}`)
    }
  }
  return reverted
}

/** 그룹 일괄 결재. merge=모든 child review일 때만 순차 병합, 중간 실패 시 병합분 자동 롤백.
 *  keep-branch/discard=child별 resolveReview 일괄(review 아닌 child는 건너뜀). */
export async function resolveGroup(
  groupId: string,
  action: 'merge' | 'keep-branch' | 'discard',
): Promise<string> {
  const group = getTaskGroup(groupId)
  if (!group) return '그룹 없음'
  const children = tasksForGroup(groupId)
  if (children.length === 0) return '그룹에 작업이 없다'

  if (action !== 'merge') {
    // keep-branch/discard — child별 개별 결재 재사용(그룹 게이트는 merge만 봉쇄).
    const results: string[] = []
    for (const child of children) {
      if (child.state !== 'review') {
        results.push(`${child.projectId}: ${child.state}(건너뜀)`)
        continue
      }
      results.push(`${child.projectId}: ${await resolveReview(child.id, action)}`)
    }
    return `그룹 '${group.title}' ${action}:\n${results.join('\n')}`
  }

  // merge — all-or-nothing. 게이트: 모든 child가 review여야 한다(하나라도 아니면 어디가 덜 됐는지 보고).
  // 재리뷰 #2 — 단, 이전 실행이 크래시로 중단돼 이미 병합된 child(done + merge SHA)는 '병합 완료분'으로
  // 간주하고 재진입을 허용한다: 재개 호출이 남은 child만 이어서 병합한다(recoverGroups 통지의 복구 경로).
  const isMergedChild = (c: Task): boolean => c.state === 'done' && !!c.mergeBaseSha && !!c.mergeHeadSha
  const notReady = children.filter((c) => c.state !== 'review' && !isMergedChild(c))
  if (notReady.length) {
    return `아직 일괄 병합 불가 — review 대기가 아닌 child ${notReady.length}건: ${notReady
      .map((c) => `${c.projectId}(${c.state})`)
      .join(', ')}. 전부 결재 대기(review)가 되면 다시 시도해라.`
  }
  // I6 — 그룹 내 모든 child의 결재 락을 선점(개별 resolveReview와 공유). 하나라도 처리 중이면 거절.
  if (children.some((c) => resolvingReviews.has(c.id))) return '그룹 내 작업이 이미 결재 처리 중이다'
  for (const c of children) resolvingReviews.add(c.id)
  try {
    // 재리뷰 #2 — 병합 루프 진입을 영속 표시. 도중 크래시하면 이 플래그가 남아 부팅 recoverGroups가
    // 반쪽 병합을 감지·통지한다(finally에서 회수 — 정상 완료·롤백 경로는 흔적 없음).
    setGroupResolveState(groupId, 'merging')
    const merged: { task: Task; project: Project; baseSha: string; headSha: string }[] = []
    // 재리뷰 #2 재개 — 크래시 전 이미 병합된 child를 merged에 선적재: 이번 재개분이 실패하면 이들까지
    // 함께 롤백해 all-or-nothing 보장이 크래시 경계를 건너도 유지된다.
    for (const child of children) {
      if (!isMergedChild(child)) continue
      const project = getProject(child.projectId)
      if (project) merged.push({ task: child, project, baseSha: child.mergeBaseSha!, headSha: child.mergeHeadSha! })
    }
    for (const child of children) {
      if (isMergedChild(child)) continue // #2 재개 — 이미 병합된 child는 재병합하지 않는다
      const project = getProject(child.projectId)
      if (!project) {
        const rb = await rollbackGroupMerges(merged)
        return `그룹 병합 중단 — 프로젝트 소실(${child.projectId}). 이미 병합된 ${rb}건 되돌림`
      }
      const m = await mergeWithRebaseFallback(project, child)
      if (m.merged && m.baseSha && m.mergedSha) {
        removeWorktree(project, child.id, true)
        archiveTaskMd(project, child, `group-merge: ${m.reason}`)
        setState(child.id, 'done', {
          summary: `${child.summary ?? ''}\n[그룹 병합] ${m.reason}`,
          mergeBaseSha: m.baseSha,
          mergeHeadSha: m.mergedSha,
        })
        merged.push({ task: child, project, baseSha: m.baseSha, headSha: m.mergedSha })
      } else {
        // 이 child가 막힘 — 이미 병합된 것 전부 롤백(반쪽 상태 차단). 실패 child·미착수 child는 review 유지.
        const rb = await rollbackGroupMerges(merged)
        log(child.id, 'status', `그룹 병합 실패: ${m.reason}`)
        notifyUser('lain — 그룹 병합 실패', `${group.title}: ${child.projectId}에서 막힘 — 병합분 ${rb}건 되돌림`)
        return `그룹 병합 실패 — ${child.projectId}에서 막힘(${m.reason}). 이미 병합된 ${rb}건을 되돌렸다(반쪽 상태 없음). 문제를 해결하고 다시 시도하거나 개별 폐기해라.`
      }
    }
    log(children[0].id, 'status', `크로스레포 그룹 '${group.title}' 일괄 병합 완료 ${merged.length}건`)
    drainQueue()
    return `그룹 '${group.title}' 일괄 병합 완료 — ${merged.length}개 레포에 병합했다.`
  } finally {
    setGroupResolveState(groupId, '')
    for (const c of children) resolvingReviews.delete(c.id)
  }
}

// 재리뷰 #2 — 그룹 병합 도중 크래시 복구(부팅 시). resolve_state='merging'으로 남은 그룹은 병합 루프가
// 중간에 죽어 일부 레포만 병합된 상태일 수 있다. git 병합은 비가역 온디스크 부수효과라 부팅에서 자동
// 재개·자동 롤백 모두 위험(무인 파괴 금지 — §9-4 정신) → 감지·통지만 하고 사람이 결정한다:
//   이어서 병합 = resolve_group(merge) 재호출(이미 병합된 child는 건너뛰고 재개, 실패 시 전체 롤백)
//   되돌리기   = 병합된 child를 revert_merge로 개별 revert(#1 수정으로 SHA가 보존돼 항상 가능)
export function recoverGroups(): number {
  const groups = listResolvingGroups()
  for (const g of groups) {
    const children = tasksForGroup(g.id)
    const mergedCount = children.filter(
      (c) => c.state === 'done' && c.mergeBaseSha && c.mergeHeadSha,
    ).length
    setGroupResolveState(g.id, '') // 플래그 회수 — 감지는 1회면 충분(재부팅마다 중복 통지 방지)
    const detail = `병합 ${mergedCount}/${children.length} 상태로 중단됨`
    if (children[0]) {
      log(
        children[0].id,
        'status',
        `⚠ 그룹 '${g.title}' 일괄 병합이 재시작으로 중단 — ${detail}. resolve_group(merge)로 이어서 병합하거나, 병합된 작업을 revert_merge로 되돌려라.`,
      )
    }
    notifyUser('lain — 그룹 병합 중단(재시작)', `${g.title}: ${detail} — 이어서 병합하거나 되돌려야 한다`)
  }
  return groups.length
}

export function cancelTask(taskId: string): void {
  const task = getTask(taskId)
  if (!task) return
  // 재리뷰 #3 — in-flight 인터럽트 메시지 폐기: 남겨두면 runWithInterrupts 루프가 취소된 작업을
  // 'working'으로 되살려 삭제된 worktree에서 재개한다(취소가 인터럽트를 이긴다).
  interruptMsgs.delete(taskId)
  abortNavi(taskId)
  const project = getProject(task.projectId)
  if (project && task.worktreePath) removeWorktree(project, taskId, true)
  setState(taskId, 'cancelled')
  log(taskId, 'status', '사용자 취소')
  drainQueue() // D1 — 슬롯 해제(취소): 대기 큐를 착수한다.
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
