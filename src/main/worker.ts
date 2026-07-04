// L2 Navi 세션 래퍼 (PLAN.md §4, §9-4, §5.2) — worktree 안에서 작업하는 Claude.
// 권한 모델: "전부 허용, 단 허락받음" — 위험 행위만 승인 큐로 라우팅.
// ask_manager: in-process MCP 툴 — 작업 중간에 관리자에게 질문하고 그 자리에서 이어감.
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { mcpServersFor } from './mcp'
import { z } from 'zod'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, CLAUDE_BIN } from './paths'
import { appendCapped } from './logfile'
import {
  addTaskEvent,
  bumpLessonInject,
  bumpSkillUse,
  flagLesson,
  getProject,
  getSettings,
  insertApproval,
  lessonsForProject,
  listTaskEvents,
  resolveApprovalRow,
  searchHistory,
  updateTask,
} from './store'
import { notifyUser } from './notify'
import { blocksSecretFile, blocksSecretPath, isTestFile, toolFilePath, SECRET_DENY_MESSAGE } from './safety'
import { shouldCompact, contextOccupancyTokens } from './compactgate'
import { summarizeNaviHandoff, handoffBlock, taskEventsToDialogue } from './handoff'
import type { ExitReason, Task, TaskEvent } from '../shared/types'
import { isTransientApiError, transientBackoffMs, MAX_TRANSIENT_RETRIES } from './retry'
import { skillOptions } from './skills'
import { capTaskImages, toImageBlocks } from './taskimages'
import { NAVI_SENDER_LEGEND } from './navisender'
import { conventionsBlock } from './conventions'
import { naviSkillsBlock, isValidSkillName, readSkillBody } from './agentskills'
import { thinkingOption, tierQueryOptions } from './agentopts'

// 워크스페이스 루트 — 기본 C:\workspace, 환경변수 LAIN_WORKSPACE로 변경 가능. 위험명령 경로가둠(이 루트 밖 절대경로는 승인)에 쓰임.
export const DEV_ROOT = process.env.LAIN_WORKSPACE || 'C:\\workspace'


// SDK result 메시지의 usage에서 총 토큰 합산(input+output+cache). 구독 모델용 표시(§비용대신).
export function sumUsageTokens(msg: unknown): number {
  const u = (msg as { usage?: Record<string, number> })?.usage
  if (!u) return 0
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  )
}

// 위험 분류 (§9-4) — best-effort 정규식. 진짜 방어선은 worktree 격리 + 병합 승인.
// (workerchat.ts의 직접 채팅 세션도 같은 분류를 쓴다 — §5.6 "위험 지시는 승인 그대로")
export const RISKY: Array<{ kind: string; re: RegExp }> = [
  { kind: 'push', re: /git\s+push|git\s+remote\s+add/i },
  // 주의: bare '--force'는 넣지 않는다 — npm install --force·npm test -- --forceExit·--force-with-lease
  // 같은 무해/일상 명령까지 destructive로 오분류돼 autonomous가 불필요하게 escalate한다.
  // 진짜 force push는 위 'push'(git push)가 먼저 잡고, force push 변형은 '-f\s+origin'로 커버.
  { kind: 'destructive', re: /rm\s+-rf|rd\s+\/s|rmdir\s+\/s|reset\s+--hard|clean\s+-fd|-f\s+origin/i },
  { kind: 'dep_change', re: /npm\s+(install|i|uninstall|remove|add)\s+\S|pnpm\s+(add|remove)|yarn\s+(add|remove)|pip\s+install|uv\s+add/i },
  { kind: 'network', re: /curl\s|wget\s|Invoke-WebRequest|iwr\s/i },
]

// §21.5 divergence(escalation) 정책 — autonomous Navi가 계획대로 안 풀려 위험행위에
// 닿았을 때 "스스로 결정(+로그) vs 승인 큐로 escalate"를 사전 결정한다.
// 2축: ① 안전한 default가 있나 ② 되돌릴 수 있나/저-스테이크인가. **둘 다 yes만 자율,
// 하나라도 no면 escalate**(= interactive 승인 큐로 전환). 불확실하면 보수적으로 escalate.
export interface DivergenceVerdict {
  autonomous: boolean // true = Navi가 자율 진행(+로그), false = escalate
  reason: string // 감사/glass-box 로그 — 어느 축이 막았는지
}

/** package.json(worktree)에 선언된 의존성 이름 집합. 읽기 실패 시 빈 집합(→ 보수적 escalate). */
function declaredDeps(worktreePath: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8'))
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]
    return new Set(names)
  } catch {
    return new Set()
  }
}

/** `pkg@1.2.3` / `@scope/pkg@x` → 버전 떼고 기본 패키지명. */
function basePkgName(tok: string): string {
  const sep = tok.startsWith('@') ? tok.indexOf('@', 1) : tok.indexOf('@')
  return sep === -1 ? tok : tok.slice(0, sep)
}

/** dep_change 명령의 2축 판정. node_modules는 worktree 국소·삭제로 복구 → reversible.
 * 단 '새 의존성 추가'나 '의존성 제거'는 설계·공급망 선택(§21.5) → 안전 default 아님 → escalate.
 * 이미 package.json에 선언된 JS 패키지의 (재)설치(= 선언 복원)만 자율. pip/uv(Python)는
 * package.json으로 검증 불가 → 보수적 escalate. */
function classifyDepChange(cmd: string, worktreePath: string): DivergenceVerdict {
  if (/\b(uninstall|remove)\b/i.test(cmd))
    return { autonomous: false, reason: 'dep_change: 의존성 제거 = 설계 변경(안전 default 없음)' }
  const m = cmd.match(
    /\b(?:npm\s+(?:install|i)|pnpm\s+add|yarn\s+add)\b\s+(.+)/i,
  )
  if (!m) return { autonomous: false, reason: 'dep_change: pip/uv 등 비-JS 또는 미파싱 — 검증 불가' }
  const declared = declaredDeps(worktreePath)
  if (declared.size === 0)
    return { autonomous: false, reason: 'dep_change: package.json 읽기 실패 — 보수적 escalate' }
  const pkgs = m[1]
    .trim()
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-') && !t.includes('='))
    .map(basePkgName)
  if (pkgs.length === 0)
    return { autonomous: false, reason: 'dep_change: 패키지 인자 없음 — 보수적 escalate' }
  const novel = pkgs.filter((p) => !declared.has(p))
  if (novel.length > 0)
    return { autonomous: false, reason: `dep_change: 새 의존성 [${novel.join(', ')}] = 공급망·설계 선택` }
  return { autonomous: true, reason: '선언된 의존성 복원 — worktree 국소·삭제로 복구 가능' }
}

/** 위험행위 kind를 2축으로 판정. dep_change만 조건부 자율, 나머지(push·destructive·
 * network·outside_dev)는 외부 publish/비가역/광역 → 안전 default 없음 → 항상 escalate. */
export function classifyDivergence(kind: string, cmd: string, worktreePath: string): DivergenceVerdict {
  if (kind === 'dep_change') return classifyDepChange(cmd, worktreePath)
  return { autonomous: false, reason: `${kind}: 외부/비가역/광역 — 안전 default 없음` }
}

export interface NaviReport {
  status: 'done' | 'blocked'
  summary: string
  questions: string[]
}

export interface ApprovalResult {
  approved: boolean
  answer?: string
}

interface PendingApproval {
  resolve: (res: ApprovalResult) => void
}

const pending = new Map<number, PendingApproval>()
const abortControllers = new Map<string, AbortController>()

export function resolveApproval(id: number, approved: boolean, answer?: string): void {
  resolveApprovalRow(id, approved ? 'approved' : 'rejected', answer)
  pending.get(id)?.resolve({ approved, answer })
  pending.delete(id)
}

export function abortNavi(taskId: string): void {
  abortControllers.get(taskId)?.abort()
  abortControllers.delete(taskId)
}

/** §5.7 인터럽트 가능 여부 — 현재 Navi가 실행 중(abort 등록됨)인지 */
export function isNaviRunning(taskId: string): boolean {
  return abortControllers.has(taskId)
}

const APPROVAL_TIMEOUT_MS = 30 * 60_000 // 30분 무응답 → 거절
const TOOL_LOOP_BLOCK = 8 // 동일 도구 호출 반복 차단 임계 (§24 — 무한루프 방어, 정상 반복엔 안 걸릴 만큼 높게)

// ── no-progress 루프 가드 (i1) ─────────────────────────────────────────────
// 정확일치 축(sha256(toolName+input))과 별개로, idempotent 읽기 도구에 한해
// "같은 호출이 같은 결과를 계속 돌려주는데도 또 부른다"(= 진전 없음)를 잡는다.
// 임계는 settings에 노출하지 않는다(공유계약 §4 — 설정면 비대화 방지, 모듈 상수 유지).
const TOOL_NOPROGRESS_BLOCK = 5 // 동일 sig·동일 result 연속 반복이 이 횟수면 deny (직전 1회는 warn).

// 결과가 결정론으로 반복되기 쉬운 읽기 전용·부작용 없는 도구만 대상.
// 부작용 도구(Edit/Write/Bash 등)는 같은 인자라도 결과가 의미 있게 달라질 수 있어 제외.
const IDEMPOTENT_TOOLS = new Set(['Read', 'Grep', 'Glob'])

/** 순수 — 도구명이 무진전 판정 대상(읽기·부작용 없음 화이트리스트)인가. */
export function isIdempotentTool(toolName: string): boolean {
  return IDEMPOTENT_TOOLS.has(toolName)
}

export type LoopAction = 'allow' | 'warn' | 'deny'

/** 순수·결정론 — 같은 (sig+result)가 연속 `identicalRepeats`회 반복됐을 때의 조치.
 *  threshold 직전 1회는 'warn'(점층 — SDK canUseTool엔 allow 가이드 채널이 없어
 *  deny 메시지로 1회 부드럽게 경고), threshold 이상이면 'deny', 그 외 'allow'.
 *  identicalRepeats는 "이 결과를 본 누적 횟수"(2면 같은 결과를 두 번째로 본 것). */
export function noProgressAction(identicalRepeats: number, threshold: number): LoopAction {
  if (threshold <= 1) return identicalRepeats >= threshold ? 'deny' : 'allow'
  if (identicalRepeats >= threshold) return 'deny'
  if (identicalRepeats === threshold - 1) return 'warn'
  return 'allow'
}

/** SDK 스트림의 user(tool_result) 메시지에서 tool_use_id→결과 텍스트 쌍을 뽑는다(순수).
 *  canUseTool 결정 시점엔 결과를 모르므로, 직전 호출의 toolUseID와 상관시켜 결과 해시를 누적한다.
 *  content가 문자열/블록배열 어느 쪽이든, tool_result 블록만 골라 평탄화한다. */
export function extractToolResults(userMsg: unknown): Array<{ toolUseId: string; result: string }> {
  const content = (userMsg as { message?: { content?: unknown } })?.message?.content
  if (!Array.isArray(content)) return []
  const out: Array<{ toolUseId: string; result: string }> = []
  for (const block of content) {
    const b = block as { type?: string; tool_use_id?: string; content?: unknown }
    if (b?.type !== 'tool_result' || !b.tool_use_id) continue
    let text = ''
    if (typeof b.content === 'string') text = b.content
    else if (Array.isArray(b.content))
      text = b.content
        .map((c) => {
          const cc = c as { type?: string; text?: string }
          return cc?.type === 'text' ? (cc.text ?? '') : JSON.stringify(cc ?? null)
        })
        .join('')
    else if (b.content != null) text = JSON.stringify(b.content)
    out.push({ toolUseId: b.tool_use_id, result: text })
  }
  return out
}

/** 순수 — SDK result 메시지의 subtype을 공유계약 ExitReason으로 분류(i9).
 *  success는 done(보고 유무는 호출부가 보강), max_turns는 max_turns, 나머지 error_*는 error.
 *  canUseTool에서 latch된 사유(tool_loop·blocked)가 우선이므로, 이건 그것이 없을 때만 쓰인다. */
export function resultExitReason(subtype: string): ExitReason {
  if (subtype === 'success') return 'done'
  if (subtype === 'error_max_turns') return 'max_turns'
  return 'error'
}

/** i9 — Navi 종료 사유를 task_events에 kind='exit'로 1회 영속(스키마 ALTER 0 — kind 재사용)하고
 *  렌더러엔 exitReason 필드를 실어 emit(글래스박스). detail은 사람이 읽을 세부 사유(없으면 생략). */
function logExit(
  taskId: string,
  emit: (ev: TaskEvent) => void,
  reason: ExitReason,
  detail?: string,
): void {
  const text = detail ? `${reason}: ${detail}` : reason
  addTaskEvent(taskId, 'exit', text)
  emit({ taskId, kind: 'exit', text, exitReason: reason } as unknown as TaskEvent)
}

export function waitApproval(id: number): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolveApprovalRow(id, 'rejected')
      pending.delete(id)
      resolve({ approved: false })
    }, APPROVAL_TIMEOUT_MS)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
    })
  })
}

// §22 retrieval — 이 프로젝트에서 누적된 교훈을 프롬프트에 주입(fresh start만).
// 주입된 교훈은 reuse_count++ (성장 추이). 임베딩 검색은 후속 — 지금은
// 프로젝트 매칭 + 재사용·최신순 top-K로 시작.
function lessonsBlock(task: Task, countInject = true): string {
  // §24 — 작업 내용(TASK.md)을 질의로 줘 관련도 높은 교훈을 우선 주입(콘텐츠-인지 랭킹).
  const lessons = lessonsForProject(task.projectId, 8, task.content)
  if (lessons.length === 0) return ''
  // i10 — 프롬프트에 실제 주입 = inject_count++. 진짜 '재사용'(도움됨)은 reflect의
  // cited_lesson_ids만 bumpLessonReuse로 센다(orchestrator). 둘을 분리해 적합도 신호 확보.
  // countInject=false(핸드오프 스왑 재공급)는 같은 작업의 연속이라 카운트를 중복 집계하지 않는다.
  if (countInject) bumpLessonInject(lessons.map((l) => l.id))
  const items = lessons
    .map((l) => `- [L${l.id}] (${l.scope}${l.trigger ? `/${l.trigger}` : ''}) ${l.lesson}`)
    .join('\n')
  return `

## 과거 작업에서 학습한 교훈 (§22 — 참고하되 맹신 말 것. 틀리거나 해로운 교훈은 mcp__lain__flag_lesson 으로 신고)
${items}`
}

// §24 Phase1 — 워크스페이스 스냅샷. 이미 결정론으로 수집된 프로젝트 메타(스택·검증 명령)를
// 토큰 0으로 주입해 Navi가 '판사(verify)'를 일찍 인지하게 한다. git 상태는 worktree와 메인 체크아웃이
// 달라 오해 소지가 있어 제외 — 안정적 메타만.
function workspaceSnapshot(task: Task): string {
  const p = getProject(task.projectId)
  if (!p) return ''
  const lines: string[] = []
  if (p.stack) lines.push(`- 스택: ${p.stack}`)
  lines.push(`- git 저장소: ${p.isGit ? '예' : '아니오'}`)
  if (p.verifyCmd) lines.push(`- 검증(판사) 명령: \`${p.verifyCmd}\` — 끝내기 전 반드시 통과시켜라`)
  return `

## 워크스페이스 (${task.projectId})
${lines.join('\n')}`
}

function naviPrompt(task: Task, countInject = true): string {
  const autonomousNote =
    task.mode === 'autonomous'
      ? `

## 모드: autonomous (glass-box, §21)
- 이건 자동 채점 가능한 작업이다. **실행 중 사람 승인을 기다리지 마라** — 안전한 기본값이 있고 되돌릴 수 있는 결정은 스스로 내리고 진행한다(결정은 로그로 남는다).
- **검증 명령(테스트)이 곧 판사다.** 전체 테스트를 그린으로 만들어라.
- **테스트 파일을 수정하지 마라**(§21.6 spec-gaming 방어). 테스트가 틀려 보이면 고치지 말고 blocked로 보고해라.
- skip/xfail로 그린을 위장하지 마라. 실제로 통과시켜라.
- secret이 필요하거나, 비가역·광역 변경이 필요하거나, 테스트끼리 충돌하면 진행하지 말고 blocked로 escalate해라(§21.5).`
      : ''
  // 발신자 레전드 + 프로젝트 컨벤션 — 새 세션(naviPrompt는 신규작업·핸드오프 스왑에서만 호출)이므로 1회 선두 주입.
  // 인터럽트/blocked 재개 텍스트는 navichat·orchestrator에서 이미 태깅돼 오고, 이 선두 블록은 세션 히스토리에 있어 재주입 안 한다.
  // 컨벤션은 worktree가 아니라 '원본 프로젝트 경로'에서 읽는다 — worktree 상위는 워크스페이스가 아니라 상위 컨벤션을 놓친다.
  const conventions = conventionsBlock(getProject(task.projectId)?.path ?? '')
  return `${NAVI_SENDER_LEGEND}${conventions}너는 lain의 Navi다. 이 디렉터리는 전용 git worktree이고 현재 브랜치(${task.branch})가 네 작업 브랜치다.

## 작업 지시 (TASK.md)
${task.content}

## 규칙
- 이 worktree 안에서만 작업한다. 절대 다른 경로를 수정하지 않는다.
- 브랜치 변경 금지, push 금지(승인제). 의미 있는 단위로 커밋해라(커밋은 자유).
- 검증 명령이 명시돼 있으면 실행해 통과시켜라. 통과 못 하면 솔직히 보고해라.
- **작업 중 판단이 필요한 모호함이 생기면 mcp__lain__ask_manager 도구로 질문해라** — 답을 받아 그 자리에서 이어갈 수 있다. 사소한 재량은 묻지 말고 보수적 기본값으로 진행. 비슷한 작업을 전에 어떻게 처리했는지 궁금하면 mcp__lain__search_history로 과거 기록을 먼저 검색해라.${autonomousNote}${workspaceSnapshot(task)}${lessonsBlock(task, countInject)}${naviSkillsBlock(task.content)}
- 작업을 끝내면(또는 ask_manager로도 해소가 안 되면) 마지막 메시지를 반드시 아래 JSON 한 블록으로 끝내라:

\`\`\`json
{"status": "done" | "blocked", "summary": "<무엇을 했고 결과가 어떤지 3-5문장>", "questions": ["<막혔을 때만, 사람에게 물을 질문>"]}
\`\`\``
}

function parseReport(text: string): NaviReport | null {
  const m = text.match(/```json\s*([\s\S]*?)```/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[1])
    if (obj.status !== 'done' && obj.status !== 'blocked') return null
    return {
      status: obj.status,
      summary: String(obj.summary ?? ''),
      questions: Array.isArray(obj.questions) ? obj.questions.map(String) : [],
    }
  } catch {
    return null
  }
}

export interface RunNaviOpts {
  /** blocked 후 재개: 기존 세션을 resume하고 이 텍스트를 이어서 전달 */
  resumePrompt?: string
  /** ask_manager 질문 핸들러 (관리자→필요시 사용자 에스컬레이션) */
  askManager?: (question: string) => Promise<string>
  /** §9b 모델 에스컬레이션 — 설정값 대신 이 모델로 실행 (반복 실패 시 상위 티어) */
  modelOverride?: string
  /** §5.7 인터럽트 재개 — 이 경로는 '같은 세션 즉시 주입'이 의도라 핸드오프 스왑을 건너뛴다(연속성 보존). */
  fromInterrupt?: boolean
}

/** Navi 실행 — 완료 시 보고 반환. 이벤트는 emit + task_events에 영속. */
export async function runNavi(
  task: Task,
  emit: (ev: TaskEvent) => void,
  opts: RunNaviOpts = {},
): Promise<NaviReport> {
  const log = (kind: TaskEvent['kind'], text: string, speaker?: TaskEvent['speaker']) => {
    addTaskEvent(task.id, kind, text, speaker)
    emit({ taskId: task.id, kind, text, speaker } as TaskEvent)
  }

  const ac = new AbortController()
  abortControllers.set(task.id, ac)
  let lastText = ''
  let aborted = false
  // i9 — 흩어진 종료 신호를 한 변수로 모아 스트림 종료 후 1회 addTaskEvent('exit')로 적재(glass-box).
  // canUseTool/스트림 어디서든 기록하고, 마지막에 result subtype/abort로 보강·확정한다.
  // exitReason은 공유계약(types.ExitReason 6종)만 쓰고, 세부 사유는 denyDetail에 사람이 읽을 텍스트로 남긴다.
  let exitReason: ExitReason | null = null
  let denyDetail = ''
  // §24 Phase2 — 도구-루프 가드: 동일 (도구+인자) 호출 시그니처를 세어 무진전 무한반복을 끊는다.
  // 이 Navi 실행(run) 동안만 유효. before_call 결정론 차단(SDK PostToolUse 미검증이라 1차는 이 방식).
  const toolSig = new Map<string, number>()
  // i1 no-progress 축 상태(이 run 동안만):
  //  - pendingSig: 이번 canUseTool에서 만든 toolUseID→sig 매핑. 결과(user/tool_result)가 와야 sig를 안다.
  //  - resultSeen: sig → {hash, repeats} — 같은 sig가 같은 결과를 몇 번 연속 돌려줬는지.
  const pendingSig = new Map<string, string>()
  const resultSeen = new Map<string, { hash: string; repeats: number }>()
  //  - warnedSigs: 무진전 warn을 이미 1회 준 sig. warn이 deny로 나가면 도구가 안 돌아 repeats가
  //    안 오르므로, 같은 sig가 또 오면 이 플래그로 하드 deny로 점층한다(warn→deny 단조 진행 보장).
  const warnedSigs = new Set<string>()

  // ask_manager: in-process MCP 툴 (§5.2 작업 중간 인터럽트)
  const lainServer = createSdkMcpServer({
    name: 'lain',
    version: '0.1.0',
    tools: [
      tool(
        'ask_manager',
        '작업 중 막히거나 판단이 필요할 때 관리자에게 질문한다. 답변을 받아 작업을 이어간다.',
        { question: z.string().describe('관리자에게 물을 구체적 질문') },
        async ({ question }) => {
          log('status', `질문→Lain: ${question}`, 'worker')
          const answer = opts.askManager
            ? await opts.askManager(question)
            : '관리자 채널 미연결 — 보수적 기본값으로 진행해라.'
          log('status', answer.slice(0, 300), 'lain') // answer는 [lain]/[user] 출처 태그를 이미 달고 옴
          return { content: [{ type: 'text', text: answer }] }
        },
      ),
      // §24 Phase2 — 교차세션 회수: 이 프로젝트의 과거 작업·대화를 검색해 재활용.
      tool(
        'search_history',
        '이 프로젝트의 과거 작업과 Navi 대화 기록을 키워드로 검색한다. 비슷한 작업을 전에 어떻게 처리했는지 떠올릴 때 쓴다.',
        {
          query: z.string().describe('검색 키워드(공백으로 여러 단어)'),
          limit: z.number().optional().describe('최대 결과 수(기본 8)'),
        },
        async ({ query: q, limit }) => {
          const hits = searchHistory(task.projectId, q, limit ?? 8)
          log('status', `search_history("${q.slice(0, 40)}") → ${hits.length}건`)
          const text = hits.length
            ? hits.map((h) => `- [${h.kind} ${h.when.slice(0, 10)}] ${h.snippet}`).join('\n')
            : '과거 기록에서 일치하는 항목이 없다.'
          return { content: [{ type: 'text', text }] }
        },
      ),
      // 학습루프 T1 — 레인 스킬 본문 열람(점진 공개). 프롬프트엔 관련 스킬 인덱스만 주입되고 본문은 이걸로.
      tool(
        'skill_view',
        '프롬프트의 "레인 스킬" 인덱스에 보이는 절차 스킬의 본문을 본다. 관련 작업이면 시작 전에 먼저 확인해라.',
        { name: z.string().describe('스킬 이름(인덱스의 이름)') },
        async ({ name }) => {
          if (!isValidSkillName(name) )
            return { content: [{ type: 'text', text: `잘못된 스킬 이름 "${name}"` }] }
          const body = readSkillBody(name)
          log('status', `skill_view("${name}") → ${body ? 'OK' : '없음'}`)
          if (body == null) return { content: [{ type: 'text', text: `스킬 "${name}"이 없다.` }] }
          bumpSkillUse(name)
          return { content: [{ type: 'text', text: body }] }
        },
      ),
      // §24 Phase3 patch-on-use — 주입된 교훈이 틀렸으면 Navi가 신고 → 즉시 soft-archive(품질 폐루프).
      tool(
        'flag_lesson',
        '주입된 과거 교훈([L<번호>])이 이 작업에서 틀렸거나 해로웠으면 신고한다. 즉시 보관되어 다음 작업에 더는 주입되지 않는다.',
        {
          lesson_id: z.number().describe('교훈 번호([L 뒤의 숫자])'),
          reason: z.string().optional().describe('왜 틀렸는지 한 줄'),
        },
        async ({ lesson_id, reason }) => {
          const archived = flagLesson(lesson_id)
          log(
            'status',
            `교훈 신고 L${lesson_id}: ${archived ? '보관됨' : '대상아님(핀/이미보관/없음)'}${reason ? ` — ${reason.slice(0, 80)}` : ''}`,
          )
          return {
            content: [
              {
                type: 'text',
                text: archived
                  ? `교훈 L${lesson_id}을 보관했다 — 다음 작업엔 주입되지 않는다.`
                  : `교훈 L${lesson_id}은 신고 대상이 아니다(핀 고정/이미 보관/없는 번호).`,
              },
            ],
          }
        },
      ),
    ],
  })

  // Navi 유한세션 핸드오프(A 자율작업, ≠ Lain 무한세션) — 재개 예정인데 점유가 임계 넘으면,
  // 재개 전에 현 작업 맥락을 핸드오프 md로 남기고 세션을 갈아끼운다. navichat과 같은 메커니즘이되,
  // worker는 runNavi 한 번이 SDK 턴루프를 끝까지 도므로(런 도중 SDK가 자체 관리) 트리거는 '재개 경계'뿐.
  let resume = opts.resumePrompt && task.naviSessionId ? task.naviSessionId : undefined
  let handoffInject = ''
  const handoffThreshold = getSettings().naviHandoffThreshold
  // 인터럽트 재개(fromInterrupt)는 제외 — '같은 세션 즉시 주입'이 의도라 매번 스왑하면 연속성이 깨진다.
  if (
    resume &&
    !opts.fromInterrupt &&
    handoffThreshold > 0 &&
    shouldCompact(task.contextTokens ?? 0, handoffThreshold)
  ) {
    const prev = task.handoffMd ?? null
    const recent = taskEventsToDialogue(listTaskEvents(task.id, 60))
    const mirror = path.join(DATA_DIR, 'handoffs', `task-${task.id}.md`)
    const md = await summarizeNaviHandoff(task.worktreePath!, recent, prev, mirror, ac)
    // 스왑은 **새 md가 실제로 나왔고**(stale prev로 갈아끼워 현 세션 작업을 버리지 않음)
    // **요약 도중 인터럽트(abort)가 없었을 때만**(인터럽트면 세션 보존하고 정상 abort 흐름으로).
    if (md && !ac.signal.aborted) {
      updateTask(task.id, { handoffMd: md, naviSessionId: '', contextTokens: 0 })
      handoffInject = handoffBlock(md)
      resume = undefined // SDK 새 세션 — 아래 프롬프트는 naviPrompt(규칙)+핸드오프+이어가기 분기로 감
      log('status', '🔄 세션 교체 — 핸드오프 md로 맥락 이어감')
    } else if (!md && !ac.signal.aborted) {
      // 작성 실패 — stale prev로 교체하면 현 세션의 최신 작업을 잃는다. 세션 유지하고 다음 재개에 재시도.
      log('status', '핸드오프 작성 실패 — 이번 경계 세션 유지(다음 재개에 재시도)')
    }
  }

  // 프롬프트 3분기: ①진짜 resume(세션에 규칙·히스토리 있음) ②핸드오프 스왑(새 세션 — 규칙 재공급 + 핸드오프)
  // ③신규 작업. 스왑은 resume이 끊겼지만 opts.resumePrompt는 살아있어 '이어가기'로 이어붙인다.
  // naviPrompt(task, false) — 스왑은 같은 작업의 연속이라 교훈 inject_count를 다시 올리지 않는다(적합도 신호 보존).
  const promptText = resume
    ? `${opts.resumePrompt}\n\n(이건 이어가는 작업이다 — 이미 끝낸 단계를 처음부터 다시 하지 말고 남은 것만 진행해라. 끝나면 동일한 JSON 보고 형식으로 마무리.)`
    : handoffInject
      ? `${naviPrompt(task, false)}\n\n${handoffInject}이전 세션에서 컨텍스트 한계로 새 세션으로 교체됐다. 위 핸드오프의 '진행 상황·다음 단계'부터 이어가라(처음부터 다시 하지 마라). 이번에 처리할 지시:\n${opts.resumePrompt}\n\n끝나면 동일한 JSON 보고 형식으로 마무리.`
      : naviPrompt(task)

  // B17 이미지 입력 — '새 세션'(resume 없음: 신규작업·핸드오프 스왑)일 때만 작업 이미지를 첨부한다.
  // resume(같은 세션 이어가기)이면 이미지는 이미 세션 히스토리에 있어 재전송 불필요. 재시도 루프가
  // 제너레이터를 재소비하므로 makePrompt()로 매 시도 새 제너레이터를 만든다(소비 1회 제약 회피).
  const promptImages = resume ? [] : capTaskImages(task.images)
  const makePrompt = () =>
    promptImages.length === 0
      ? promptText
      : (async function* () {
          yield {
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: [{ type: 'text' as const, text: promptText }, ...toImageBlocks(promptImages)],
            },
            parent_tool_use_id: null,
          }
        })()

  try {
    // 일시적 상류 에러(529·5xx)면 백오프 후 자동 재시도 — 본 출력(lastText)이 없을 때만(중복 방지).
    // abort·비일시적·재시도 소진은 바깥 catch로 넘겨 기존 처리(error 상태·재던짐) 유지.
    let transientAttempt = 0
    while (true) {
     try {
    const stream = query({
      prompt: makePrompt(),
      options: {
        cwd: task.worktreePath!,
        resume,
        // P2 권한모드 — task.permissionMode 반영. bypass는 SDK엔 acceptEdits로 주고(시크릿·spec-gaming
        // 가드 보존), 승인 큐만 아래 canUseTool에서 자동통과시킨다. raw SDK bypassPermissions는 쓰지 않는다.
        permissionMode: task.permissionMode === 'bypass' ? 'acceptEdits' : task.permissionMode,
        // P2 thinking 예산 — task.thinkingLevel을 SDK thinking 옵션으로. default면 미설정(현행 유지).
        ...thinkingOption(task.thinkingLevel),
        // P2 allow/deny — 금지 도구(블랙리스트). canUseTool 가드와 별개의 SDK 레벨 필터.
        ...(task.disallowedTools.length ? { disallowedTools: task.disallowedTools } : {}),
        maxTurns: 60,
        ...tierQueryOptions(opts.modelOverride ?? getSettings().naviModel, getSettings()), // §9b 티어링(local 라우팅 포함)
        // B4 fast-mode — 작업별 Opus 빠른 출력 모드. SDK는 settings(inline Settings)로 받는다(settingSources와 별개라 정체성 오염 0).
        ...(task.fastMode ? { settings: { fastMode: true } } : {}),
        ...skillOptions(task.skills, getSettings().skillsEnabled, getSettings().curatedPlugins),

        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
        abortController: ac,
        // 내부 lain 서버 + 사용자 등록 외부 MCP(navi 타깃, enabled만) — CC-FEATURES P1
        mcpServers: { lain: lainServer, ...mcpServersFor('navi') },
        stderr: (d: string) =>
          appendCapped(path.join(DATA_DIR, `worker-${task.id}-stderr.log`), d),
        canUseTool: async (toolName, input, { toolUseID }) => {
          const cmd = String((input as any)?.command ?? '')
          const desc = String((input as any)?.description ?? '')
          log('tool', `${toolName}: ${desc || cmd.slice(0, 120) || JSON.stringify(input).slice(0, 120)}`)

          // §24 Phase2 — 도구-루프 가드(정확일치 축): 같은 (도구+인자) 호출을 임계 횟수 반복하면 차단.
          const sig = crypto.createHash('sha256').update(`${toolName} ${JSON.stringify(input ?? {})}`).digest('hex')
          const seen = (toolSig.get(sig) ?? 0) + 1
          toolSig.set(sig, seen)
          if (seen >= TOOL_LOOP_BLOCK) {
            exitReason = 'tool_loop'
            denyDetail = `tool_loop(정확일치): ${toolName} ${seen}회`
            log('status', `도구-루프 차단(§24 정확일치): 동일 ${toolName} 호출 ${seen}회 반복`)
            return {
              behavior: 'deny',
              message: `같은 도구 호출(${toolName})을 ${TOOL_LOOP_BLOCK}회 이상 반복했다 — 무한 루프로 보인다. 접근을 바꾸거나, 막혔으면 blocked로 보고해라.`,
            }
          }

          // i1 no-progress 축: idempotent 읽기 도구에 한해 '같은 sig·같은 result' 연속 반복을 차단.
          // 결과 해시는 스트림의 user(tool_result) 파싱(extractToolResults)으로 채워져 resultSeen에 누적된다.
          // 결정 시점엔 직전 결과까지만 알므로, 이번 toolUseID를 sig와 매핑해 뒀다가 다음 결과에서 상관.
          if (isIdempotentTool(toolName) && toolUseID) pendingSig.set(toolUseID, sig)
          if (isIdempotentTool(toolName)) {
            const rec = resultSeen.get(sig)
            if (rec) {
              // warn이 deny로 나가면 도구가 안 돌아 repeats가 안 오른다 → 이미 warn한 sig가 또 오면
              // threshold로 끌어올려(점층) 하드 deny로 확정한다. 순수 판정은 noProgressAction.
              const effective = warnedSigs.has(sig) ? Math.max(rec.repeats, TOOL_NOPROGRESS_BLOCK) : rec.repeats
              const action = noProgressAction(effective, TOOL_NOPROGRESS_BLOCK)
              if (action === 'deny') {
                exitReason = 'tool_loop'
                denyDetail = `tool_loop(무진전): ${toolName} 동일결과 ${rec.repeats}회`
                log('status', `도구-루프 차단(§24 무진전): ${toolName} 동일 호출이 같은 결과를 ${rec.repeats}회 반복`)
                return {
                  behavior: 'deny',
                  message: `${toolName} 같은 호출이 매번 동일한 결과를 돌려주고 있다(${rec.repeats}회) — 진전이 없다. 접근을 바꾸거나, 막혔으면 blocked로 보고해라.`,
                }
              }
              if (action === 'warn') {
                warnedSigs.add(sig)
                log('status', `도구-루프 경고(§24 무진전): ${toolName} 동일 호출·동일 결과 ${rec.repeats}회 — 다음 반복은 차단`)
                return {
                  behavior: 'deny',
                  message: `${toolName} 같은 호출이 같은 결과만 ${rec.repeats}회 돌려줬다 — 접근을 바꿔라. 정말 필요해도 같은 호출을 또 반복하면 차단되니, 막혔으면 blocked로 보고해라.`,
                }
              }
            }
          }

          // §21.6 spec-gaming 방어 (autonomous 전용) — 테스트 파일 수정 거부.
          // autonomous는 테스트가 판사이므로 Navi가 판사를 못 고치게 막는다.
          if (task.mode === 'autonomous') {
            const fp = String((input as any)?.file_path ?? (input as any)?.path ?? '')
            const isTestEdit =
              (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') &&
              isTestFile(fp)
            if (isTestEdit) {
              exitReason = 'blocked'
              denyDetail = `spec_gaming: 테스트 파일 수정 거부 (${fp})`
              log('status', `spec-gaming 차단: 테스트 파일 수정 거부 (${fp})`)
              return {
                behavior: 'deny',
                message:
                  '테스트 파일은 수정할 수 없다(§21.6). 테스트가 틀렸다고 판단되면 고치지 말고 blocked로 보고해라.',
              }
            }
          }

          // 비밀 파일 데노리스트 (§24 Phase1) — 파일 도구가 시크릿을 모델 컨텍스트로 끌어오는 것 차단.
          if (blocksSecretFile(toolName, input)) {
            exitReason = 'blocked'
            denyDetail = `secret_denied: 비밀 파일 접근 (${path.basename(toolFilePath(input))})`
            log('status', `secret 차단: 비밀 파일 접근 거부 (${path.basename(toolFilePath(input))})`)
            return { behavior: 'deny', message: SECRET_DENY_MESSAGE }
          }
          // i15s — 셸 명령/인자에 박힌 절대경로가 비밀 파일·디렉터리를 가리키면 차단.
          // blocksSecretFile은 파일도구 input 전용이라 Bash/PowerShell 명령은 못 막는다 — 그 빈틈을 blocksSecretPath로 메운다.
          if (blocksSecretPath(cmd) || blocksSecretPath(toolFilePath(input))) {
            exitReason = 'blocked'
            denyDetail = `secret_denied: 명령/경로에 비밀 파일 참조 (${toolName})`
            log('status', `secret 차단: 명령/경로에 비밀 파일 참조 (${toolName})`)
            return { behavior: 'deny', message: SECRET_DENY_MESSAGE }
          }

          // 경로 가둠 (§9-2): 워크스페이스 루트(C:\workspace) 밖 절대경로가 명령에 보이면 승인 대상
          const outside = /[A-Za-z]:\\/.test(cmd) && !cmd.toUpperCase().includes(DEV_ROOT.toUpperCase())
          const risky = RISKY.find((r) => r.re.test(cmd))

          if (toolName === 'Bash' || toolName === 'PowerShell') {
            if (risky || outside) {
              const kind = risky?.kind ?? 'outside_dev'
              // §21.5 divergence 2축 정책 (autonomous 전용): 안전 default가 있고(①)
              // 되돌릴 수 있는(②) 것만 Navi가 자율 진행(+로그). 하나라도 no면 승인 큐로
              // escalate. 막은 축의 이유는 task_events에 남겨 glass-box(§21.4)로 보인다.
              if (task.mode === 'autonomous') {
                const v = classifyDivergence(kind, cmd, task.worktreePath!)
                if (v.autonomous) {
                  log('status', `autonomous 자율 결정 [${kind}] (§21.5): ${v.reason} — ${cmd.slice(0, 100)}`)
                  return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
                }
                log('status', `autonomous escalate [${kind}] (§21.5): ${v.reason}`)
              }
              // P2 bypass — 승인 큐를 자동통과(끼어듦 없이 진행). 시크릿·spec-gaming·루프가드는 위에서 이미 통과했다.
              if (task.permissionMode === 'bypass') {
                log('status', `bypass 자동승인 [${kind}]: ${cmd.slice(0, 100)}`)
                return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
              }
              const approvalId = insertApproval(task.id, kind, cmd)
              log('status', `승인 대기 [${kind}]: ${cmd.slice(0, 160)}`)
              emit({ taskId: task.id, kind: 'status', text: `approval:${approvalId}` })
              notifyUser('lain — 승인 필요', `[${kind}] ${cmd.slice(0, 120)}`)
              const res = await waitApproval(approvalId)
              log('status', res.approved ? `승인됨: ${cmd.slice(0, 80)}` : `거절됨: ${cmd.slice(0, 80)}`)
              if (!res.approved) {
                return {
                  behavior: 'deny',
                  message: '사용자가 이 명령을 거절했다. 다른 방법으로 진행하거나 blocked로 보고해라.',
                }
              }
            }
          }
          return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
        },
      },
    })

    for await (const msg of stream) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        updateTask(task.id, { naviSessionId: msg.session_id })
      } else if (msg.type === 'assistant') {
        const text = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (text) {
          lastText = text
          log('text', text, 'worker')
        }
      } else if (msg.type === 'user') {
        // i1 no-progress 축의 결과 채널: tool_result를 직전 canUseTool(toolUseID→sig)와 상관시켜
        // 같은 sig의 결과 해시를 누적한다. 같은 결과면 repeats++, 달라지면 진전으로 보고 1로 리셋.
        for (const { toolUseId, result } of extractToolResults(msg)) {
          const sig = pendingSig.get(toolUseId)
          if (!sig) continue
          pendingSig.delete(toolUseId)
          const hash = crypto.createHash('sha256').update(result).digest('hex')
          const prev = resultSeen.get(sig)
          if (prev && prev.hash === hash) {
            resultSeen.set(sig, { hash, repeats: prev.repeats + 1 })
          } else {
            // 결과가 바뀜 = 진전 → 카운트·warn 플래그 리셋(이 sig는 다시 무해).
            resultSeen.set(sig, { hash, repeats: 1 })
            warnedSigs.delete(sig)
          }
        }
      } else if (msg.type === 'result') {
        const cost = 'total_cost_usd' in msg ? (msg.total_cost_usd ?? 0) : 0
        const turns = 'num_turns' in msg ? (msg.num_turns ?? 0) : 0
        const tokens = sumUsageTokens(msg)
        // 점유(input+캐시, output 제외)는 다음 재개 경계의 핸드오프 감지용 — 누적합 tokens와 별개.
        updateTask(task.id, { costUsd: cost, tokens, turns, contextTokens: contextOccupancyTokens(msg) })
        log('status', `세션 종료: ${msg.subtype} (${turns}턴, ${tokens.toLocaleString()} tok)`)
        // i9 — result subtype을 exitReason으로 분류. canUseTool에서 이미 막힌 사유
        // (tool_loop·secret_denied·spec_gaming_blocked)가 latch돼 있으면 그게 사인이므로 유지.
        if (!exitReason) exitReason = resultExitReason(msg.subtype)
      } else if (msg.type === 'system') {
        // B2 subagent-viz + bg-tasks — 서브에이전트/백그라운드 task_* system 메시지 가시화.
        // (SDK 0.3.173: task_started/progress/notification/updated. 기본 emit 여부는 워크로드 의존 — 와도/안와도 무해.)
        // started/notification은 영속(log), 고빈도 progress는 휘발 emit만(task_events 폭주 방지).
        const m = msg as any
        if (m.subtype === 'task_started') {
          if (!m.skip_transcript)
            log('subagent', `⑂ 시작 [${m.subagent_type ?? m.task_type ?? 'task'}] ${m.description ?? ''}`.trim(), 'worker')
        } else if (m.subtype === 'task_notification') {
          log('subagent', `⑂ ${m.status ?? '완료'} ${m.summary ?? ''}`.trim(), 'worker')
        } else if (m.subtype === 'task_progress' || m.subtype === 'task_updated') {
          emit({ taskId: task.id, kind: 'subagent', text: `⑂ ${m.description ?? m.patch?.status ?? '진행'}`.trim(), speaker: 'worker' })
        }
      }
    }
        break
     } catch (inner) {
       if (ac.signal.aborted) throw inner // abort는 바깥 catch가 처리
       const m = String((inner as Error)?.message ?? inner ?? '')
       if (isTransientApiError(m) && !lastText && transientAttempt < MAX_TRANSIENT_RETRIES) {
         log(
           'status',
           `⏳ API 과부하 — ${transientBackoffMs(transientAttempt) / 1000}s 후 재시도 (${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES})`,
         )
         await new Promise((r) => setTimeout(r, transientBackoffMs(transientAttempt)))
         transientAttempt++
         continue
       }
       throw inner // 비일시적·재시도 소진 → 바깥 catch가 error 처리·재던짐
     }
    }
  } catch (e) {
    // abort(인터럽트/취소)는 정상 흐름 — 부분 보고로 반환해 호출부가 분기.
    // 그 외 에러는 호출부(launch try/catch)가 error 상태로 처리하도록 재던짐.
    if (ac.signal.aborted) {
      aborted = true
      exitReason = 'aborted'
      log('status', '세션 중단됨(abort)')
    } else {
      // throw 전에 exit 사유를 확정·적재한다(에러도 glass-box).
      exitReason = 'error'
      denyDetail = String((e as Error)?.message ?? e ?? '').slice(0, 200)
      logExit(task.id, emit, exitReason, denyDetail)
      throw e
    }
  } finally {
    abortControllers.delete(task.id)
  }

  // i9 — 종료 사유 1회 적재. 보고 유무로 done/blocked 보강(canUseTool가 막지 않았을 때만).
  const report = parseReport(lastText)
  if (!exitReason) exitReason = report?.status === 'blocked' ? 'blocked' : 'done'
  logExit(task.id, emit, exitReason, denyDetail)

  if (report && !aborted) return report
  return {
    status: 'done',
    summary: aborted
      ? lastText.slice(0, 1500) || '(중단됨)'
      : lastText.slice(0, 1500) || '(Navi가 보고 없이 종료됨)',
    questions: [],
  }
}
