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
  rejectPendingApprovalsForTask,
  resolveApprovalRow,
  searchHistory,
  updateTask,
} from './store'
import { notifyUser } from './notify'
import { runCodexNavi } from './codex'
import { classifySystemDestructive } from './sysrisk'
import { isTestFile } from './safety'
import { shouldCompact, contextOccupancyTokens } from './compactgate'
import { summarizeNaviHandoff, handoffBlock, taskEventsToDialogue } from './handoff'
import type { ExitReason, Task, TaskEngine, TaskEvent } from '../shared/types'
import { isTransientApiError, transientBackoffMs, MAX_TRANSIENT_RETRIES } from './retry'
import { skillOptions } from './skills'
import { capTaskImages, toImageBlocks } from './taskimages'
import { NAVI_SENDER_LEGEND } from './navisender'
import { conventionsBlock } from './conventions'
import { naviSkillsBlock, isValidSkillName, readSkillBody } from './agentskills'
import { thinkingOption, tierQueryOptions, preToolUseGuard, secretDeny } from './agentopts'
import type { PreToolDeny } from './agentopts'
import { recordUsage } from './usage'
import { parseTodoWriteInput, encodeTodoLine } from '../shared/todoline'
import { shouldCheckpoint, formatCheckpoint } from './checkpoint'
import { diffStat, commitCount } from './worktree'
import { workspaceRoot } from './registry'


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

// I4 — 라이프타임 토큰 누적(순수). SDK result.usage는 세션 cumulative라, 동일 세션 resume은 이전 값을
// '교체'하고 새 세션은 '가산'해야 다중 세션(핸드오프·verify재시도) 작업의 예산이 정확히 발동한다.
/** resume 여부로 이 세션의 baseline(=현재 세션 이전 세션들 누계)을 고른다.
 *  resume 있음(동일 세션 이어가기) → 저장된 sessionBaseTokens 유지. resume 없음(신규/핸드오프 스왑 → 새 세션)
 *  → 이전 tokensTotal을 baseline으로 승격(이전 세션 최종 누계가 이 세션 위로 가산되게). */
export function sessionBaselineFor(
  resuming: boolean,
  sessionBaseTokens: number,
  tokensTotal: number,
): number {
  return resuming ? (sessionBaseTokens || 0) : (tokensTotal || 0)
}

/** baseline + 이 세션 cumulative = 라이프타임 누적. 동일세션 재갱신은 baseline이 고정이라 '교체', 새 세션은 가산. */
export function lifetimeTokensFor(sessionBaseline: number, sessionCumulative: number): number {
  return sessionBaseline + sessionCumulative
}

/** #4 크래시 복원 갭 — 핸드오프 스왑은 (handoffMd 저장 · naviSessionId='') 를 원자적으로 쓰지만, 그 새 세션의
 *  session_id가 init 메시지로 기록되기 전에 크래시하면 naviSessionId가 빈 채 handoffMd만 남는다. 복원(recoverTasks)은
 *  resumePrompt로 재개하는데, naviSessionId가 비어 resume이 끊기고 스왑 블록(신규 handoff 생성)도 재개 경계가 아니라
 *  안 타므로, 애써 써 둔 handoffMd가 프롬프트에 주입되지 않고 맥락이 유실된다. 이 경우 저장된 handoffMd를 다시
 *  주입해야 새 세션이 진행 상황을 이어받는다.
 *  조건: resume 못 함(naviSessionId 없음) · 재개 지시(resumePrompt) 있음 · 이번에 새 handoff를 만들지 않음(freshHandoff 아님)
 *       · 저장된 handoffMd 존재. 브랜뉴 작업(resumePrompt·handoffMd 둘 다 없음)이나 정상 스왑(freshHandoff)은 제외. */
export function shouldInjectStoredHandoff(
  resuming: boolean,
  hasResumePrompt: boolean,
  hasFreshHandoff: boolean,
  hasStoredHandoff: boolean,
): boolean {
  return !resuming && hasResumePrompt && !hasFreshHandoff && hasStoredHandoff
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
  taskId?: string // A4 — 이 승인이 속한 작업(waitApproval opts.taskId). abort 시 함께 닫기 위한 역참조.
}

const pending = new Map<number, PendingApproval>()
const abortControllers = new Map<string, AbortController>()

// A4 — 실행 중인 Navi의 emit(task:event 채널). abortNavi가 승인 정리 후 기존 브로드캐스트 경로를
// 한 번 태우는 데만 쓴다(ipc의 task:event 핸들러가 approvals:updated·트레이·폰 갱신을 묶어 처리).
// abortControllers와 같은 지점에서 set/delete — 러너가 없으면 undefined라 emit은 생략된다.
const naviEmitters = new Map<string, (ev: TaskEvent) => void>()

// C1 — 무인 작업의 "승인/질문 대기 중"(D4 hold) task id 추적. 영속 상태·스키마 없음(인메모리 Set) —
// 재부팅 시 비고, recoverTasks가 'working' 작업을 재개→도구 재시도→canUseTool이 다시 hold 진입하며
// 재등록되므로 자연 복구된다. held 작업은 사람을 기다리는 중이라 compute 슬롯을 안 쓰므로 concurrencyCap
// 카운트·유휴 게이트(hasActiveWork)에서 제외한다. set/clear는 waitApproval 진입/해제 단일 지점 + abort로,
// 모든 대기 종료 경로(정상 응답/거절/abort)에서 확실히 clear된다(누수 시 영구 유휴정지 재발 — 안전 최우선).
const awaitingApprovalIds = new Set<string>()

/** 이 task가 지금 D4 hold(무인 승인/질문 대기)로 멈춰 있는가 — orchestrator/게이트가 읽는다. */
export function isAwaitingApproval(taskId: string): boolean {
  return awaitingApprovalIds.has(taskId)
}

export function resolveApproval(id: number, approved: boolean, answer?: string): void {
  resolveApprovalRow(id, approved ? 'approved' : 'rejected', answer)
  pending.get(id)?.resolve({ approved, answer })
  pending.delete(id)
}

export function abortNavi(taskId: string): void {
  abortControllers.get(taskId)?.abort()
  abortControllers.delete(taskId)
  // C1 — abort로 대기가 끝나는 경로. waitApproval의 hold Promise는 abort 시 스스로 resolve하지 않으므로
  // (canUseTool이 중단돼 wrapped resolve가 안 불림) 여기서 확실히 clear한다(누수 방지).
  awaitingApprovalIds.delete(taskId)
  // A4 — 이 작업의 pending 승인도 함께 닫는다. 그냥 두면 스트림은 죽었는데 승인함 카드·트레이 배지·
  // 텔레그램 목록에 유령으로 남고, 눌러도 소비자 없는 promise만 깨운다.
  // (a) 인메모리 대기자 — deny로 깨워 정리. 이미 abort된 스트림이라 반환 deny는 소비되지 않는다(동작 변화 없음).
  for (const [id, p] of pending) {
    if (p.taskId !== taskId) continue
    pending.delete(id)
    p.resolve({ approved: false })
  }
  // (b) DB 행 — 한 번에 rejected로 닫는다(부팅 스윕 clearOrphanApprovals의 작업 한정판).
  // 실제로 닫은 행이 있을 때만 기존 브로드캐스트 경로를 한 번 태운다(ipc의 task:event 핸들러가
  // 승인함·트레이·폰 갱신을 묶어 처리) — 그래야 유령 카드가 화면에서도 사라진다. 러너가 없으면 생략.
  try {
    const closed = rejectPendingApprovalsForTask(taskId)
    if (closed > 0)
      naviEmitters.get(taskId)?.({ taskId, kind: 'status', text: '중단 — 대기 중이던 승인을 닫았다' })
  } catch {
    /* 승인함 정리 실패는 무시 — 중단(abort) 자체는 이미 끝났고 되돌릴 수 없다 */
  }
}

/** §5.7 인터럽트 가능 여부 — 현재 Navi가 실행 중(abort 등록됨)인지 */
export function isNaviRunning(taskId: string): boolean {
  return abortControllers.has(taskId)
}

// D4 — navichat(채팅 세션)·manager(레인 자신 승인)의 기본 무응답 데드라인. 사용자가 채팅에 실재하는
// 포그라운드라 '무인 대기' 문제 대상이 아니므로 기존대로 만료 시 rejected 처리(30분 고정).
const APPROVAL_TIMEOUT_MS = 30 * 60_000
const TOOL_LOOP_BLOCK = 8 // 동일 도구 호출 반복 차단 임계 (§24 — 무한루프 방어, 정상 반복엔 안 걸릴 만큼 높게)

// D4 — 분 단위 승인 대기 임계를 ms로. 0이면 0(재알림/데드라인 없음 = 무한 대기).
export function approvalTimeoutMs(min: number): number {
  return Math.max(0, Math.floor(min)) * 60_000
}

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
 *  content가 문자열/블록배열 어느 쪽이든, tool_result 블록만 골라 평탄화한다.
 *  isError: 블록의 is_error 플래그(A7 — 관리자 스트림 도구 실패 표시가 이 필드로 성공/실패를 가른다). */
export function extractToolResults(
  userMsg: unknown,
): Array<{ toolUseId: string; result: string; isError: boolean }> {
  const content = (userMsg as { message?: { content?: unknown } })?.message?.content
  if (!Array.isArray(content)) return []
  const out: Array<{ toolUseId: string; result: string; isError: boolean }> = []
  for (const block of content) {
    const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
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
    out.push({ toolUseId: b.tool_use_id, result: text, isError: !!b.is_error })
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

// D4 — 승인 대기 옵션. 기본(옵션 없음)은 기존 동작: APPROVAL_TIMEOUT_MS 후 자동 거절(navichat/manager).
// 무인 백그라운드 작업(orchestrator task)만 hold=true로 넘겨 "만료 시 거절하지 않고 재알림 1회 후 무한 대기"로
// 바꾼다. 세션·worktree는 대기 중에도 그대로 살아있어(Promise만 미해결) 사용자가 응답하면 그 지점부터 이어진다.
export interface WaitApprovalOpts {
  hold?: boolean // true=만료해도 거절하지 않고 무한 대기(무인 작업). 재알림은 onRemind로 1회.
  timeoutMs?: number // hold일 때 재알림까지의 대기(ms). 0이면 재알림 없이 곧장 무한 대기.
  onRemind?: () => void // 만료 시각에 1회 호출(재알림 — PC 토스트/텔레그램). hold 전용.
  taskId?: string // C1 — hold 대기 진입/해제 시 awaitingApprovalIds set/clear(무인 작업 슬롯 점유 제외용).
}

export function waitApproval(id: number, opts: WaitApprovalOpts = {}): Promise<ApprovalResult> {
  // C1 — hold(무인 대기) 진입 시 이 task를 'awaiting-approval'로 표시. 슬롯·유휴 게이트에서 제외된다.
  // clear는 아래 wrapped resolve(정상 응답/거절)와 abortNavi(abort)에서 — 모든 종료 경로 커버(누수 방지).
  if (opts.hold && opts.taskId) awaitingApprovalIds.add(opts.taskId)
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.hold) {
      // 무인 작업 — 만료해도 거절 금지. timeoutMs가 양수면 그 시점에 재알림 1회만 보내고, 이후 추가 타이머
      // 없이 무한 대기(반복 알림 금지 — 스팸/복잡도 회피). 사용자가 응답할 때만 아래 resolve로 깨어난다.
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            opts.onRemind?.()
          } catch {
            /* 재알림 실패는 무시 — 대기 자체엔 영향 없음 */
          }
        }, opts.timeoutMs)
      }
    } else {
      // 기존 동작(포그라운드) — 데드라인 만료 시 자동 거절.
      timer = setTimeout(() => {
        resolveApprovalRow(id, 'rejected')
        pending.delete(id)
        resolve({ approved: false })
      }, APPROVAL_TIMEOUT_MS)
    }
    pending.set(id, {
      taskId: opts.taskId, // A4 — abortNavi가 이 작업의 대기자를 찾아 함께 닫기 위한 역참조
      resolve: (v) => {
        if (timer) clearTimeout(timer)
        if (opts.taskId) awaitingApprovalIds.delete(opts.taskId) // C1 — 정상 응답/거절로 대기 종료
        resolve(v)
      },
    })
  })
}

// §22 retrieval — 이 프로젝트에서 누적된 학습을 프롬프트에 주입(fresh start만).
// 주입된 학습은 reuse_count++ (성장 추이). 임베딩 검색은 후속 — 지금은
// 프로젝트 매칭 + 재사용·최신순 top-K로 시작.
function lessonsBlock(task: Task, countInject = true): string {
  // §24 — 작업 내용(TASK.md)을 질의로 줘 관련도 높은 학습을 우선 주입(콘텐츠-인지 랭킹).
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

## 과거 작업에서 학습한 학습 (§22 — 참고하되 맹신 말 것. 틀리거나 해로운 학습은 mcp__lain__flag_lesson 으로 신고)
${items}`
}

// L3(P6) — 완료 조건 체크리스트(DoD). elicit(§21.3)가 확정한 criteria를 Navi 프롬프트에 그대로 박아
// 자기검증을 강제한다(순수 — worker.test.ts처럼 직접 import되는 함수라 SDK 의존 없이 테스트 가능).
export function criteriaBlock(criteria: string[] | undefined): string {
  if (!criteria?.length) return ''
  return [
    '## 완료 조건 체크리스트',
    ...criteria.map((c) => `- [ ] ${c}`),
    '완료 보고 전에 항목별로 스스로 검증하고, 모두 충족했을 때만 done으로 보고하라. 미충족 항목은 blocked 사유에 명시하라.',
  ].join('\n')
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
  // L3(P6) — 구조화 criteria(elicit 영속분)가 있으면 별도 블록으로 주입. 없으면 content의 '## 합격 기준'
  // 텍스트(orchestrator append)만 남아 하위호환 유지.
  const critBlock = criteriaBlock(task.criteria)
  return `${NAVI_SENDER_LEGEND}${conventions}너는 lain의 Navi다. 이 디렉터리는 전용 git worktree이고 현재 브랜치(${task.branch})가 네 작업 브랜치다.

## 작업 지시 (TASK.md)
${task.content}

## 규칙
- 이 worktree 안에서만 작업한다. 절대 다른 경로를 수정하지 않는다.
- 브랜치 변경 금지, push 금지(승인제). 의미 있는 단위로 커밋해라(커밋은 자유).
- 검증 명령이 명시돼 있으면 실행해 통과시켜라. 통과 못 하면 솔직히 보고해라.
- **작업 중 판단이 필요한 모호함이 생기면 mcp__lain__ask_manager 도구로 질문해라** — 답을 받아 그 자리에서 이어갈 수 있다. 사소한 재량은 묻지 말고 보수적 기본값으로 진행. 비슷한 작업을 전에 어떻게 처리했는지 궁금하면 mcp__lain__search_history로 과거 기록을 먼저 검색해라.${autonomousNote}${workspaceSnapshot(task)}${lessonsBlock(task, countInject)}${naviSkillsBlock(task.content)}${critBlock ? `\n\n${critBlock}` : ''}
- 작업을 끝내면(또는 ask_manager로도 해소가 안 되면) 마지막 메시지를 반드시 아래 JSON 한 블록으로 끝내라:

\`\`\`json
{"status": "done" | "blocked", "summary": "<무엇을 했고 결과가 어떤지 3-5문장>", "questions": ["<막혔을 때만, 사람에게 물을 질문>"]}
\`\`\``
}

export function parseReport(text: string): NaviReport | null {
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

/** 외부 러너를 쓰는 엔진의 실행 함수 시그니처 — runNavi와 같은 NaviReport 계약(abort는 signal로). */
type ExternalNaviRunner = (
  task: Task,
  emit: (ev: TaskEvent) => void,
  opts: RunNaviOpts,
  signal: AbortSignal,
) => Promise<NaviReport>

// D12 — 엔진별 외부 러너 레지스트리. claude는 runNavi 인라인 본체(등록 안 함=fall-through), codex만 위임.
// 제3 엔진(예: gemini)을 붙이려면 여기 엔트리 1개 + engines.ts capability 1개 + types 유니언·start_task enum만.
const ENGINE_RUNNERS: Partial<Record<TaskEngine, ExternalNaviRunner>> = {
  codex: runCodexNavi,
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

  // D12 — 엔진 dispatch. claude 본체는 이 함수 인라인(아래 그대로)이고, 외부 러너를 쓰는 엔진만
  // ENGINE_RUNNERS에 등록한다(현재 codex). 하드코딩 `=== 'codex'` 대신 레지스트리 조회로 위임 —
  // 제3 엔진은 여기 엔트리 1개만 추가하면 된다. abort는 엔진 무관하게 여기서 등록(abortNavi/인터럽트 공용).
  const externalRunner = ENGINE_RUNNERS[task.engine ?? 'claude']
  if (externalRunner) {
    const cac = new AbortController()
    abortControllers.set(task.id, cac)
    naviEmitters.set(task.id, emit) // A4 — abort 시 승인 정리 브로드캐스트용
    try {
      return await externalRunner(task, emit, opts, cac.signal)
    } finally {
      abortControllers.delete(task.id)
      naviEmitters.delete(task.id)
    }
  }

  const ac = new AbortController()
  abortControllers.set(task.id, ac)
  naviEmitters.set(task.id, emit) // A4 — abort 시 승인 정리 브로드캐스트용
  let lastText = ''
  let aborted = false
  // D6 체크포인트 상태(이 run 동안만) — SDK는 turns/tokens를 result(세션 종료)에만 준다. 세션 중엔
  // assistant 메시지를 세어 turnsSoFar를 근사하고, 마지막 체크포인트 시점의 턴·벽시계를 보관해 트리거를 판정한다.
  const cpProject = getProject(task.projectId)
  let turnsSoFar = 0
  let lastCheckpointTurn = 0
  let lastCheckpointMs = Date.now()
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

  // 결정론 차단(기계적 거부) — PreToolUse 훅과 canUseTool이 공유하는 순수 판정.
  // canUseTool은 auto-allow된 도구 호출에서 아예 불리지 않으므로(실측) 실발동은 훅이 담당한다.
  // 범위는 종전 canUseTool 가드와 동일: ① autonomous 테스트 파일 수정(§21.6 spec-gaming 방어)
  // ② 시크릿 파일/명령/경로(§24 Phase1 + §3 i15s). 그 이상은 넓히지 않는다(과차단 금지).
  const denyCheck = (toolName: string, input: unknown): PreToolDeny | null => {
    if (task.mode === 'autonomous') {
      const fp = String((input as any)?.file_path ?? (input as any)?.path ?? '')
      const isTestEdit =
        (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') && isTestFile(fp)
      if (isTestEdit) {
        return {
          kind: 'spec_gaming',
          detail: `테스트 파일 수정 거부 (${fp})`,
          message:
            '테스트 파일은 수정할 수 없다(§21.6). 테스트가 틀렸다고 판단되면 고치지 말고 blocked로 보고해라.',
        }
      }
    }
    return secretDeny(toolName, input)
  }
  // 차단 1건을 glass-box에 남긴다(종전 canUseTool 경로와 동일한 exitReason/denyDetail 계약).
  const recordDeny = (_toolName: string, d: PreToolDeny): void => {
    exitReason = 'blocked'
    denyDetail = `${d.kind}: ${d.detail}`
    log('status', `${d.kind === 'spec_gaming' ? 'spec-gaming' : 'secret'} 차단: ${d.detail}`)
  }

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
      // §24 Phase3 patch-on-use — 주입된 학습이 틀렸으면 Navi가 신고 → 즉시 soft-archive(품질 폐루프).
      tool(
        'flag_lesson',
        '주입된 과거 학습([L<번호>])이 이 작업에서 틀렸거나 해로웠으면 신고한다. 즉시 보관되어 다음 작업에 더는 주입되지 않는다.',
        {
          lesson_id: z.number().describe('학습 번호([L 뒤의 숫자])'),
          reason: z.string().optional().describe('왜 틀렸는지 한 줄'),
        },
        async ({ lesson_id, reason }) => {
          const archived = flagLesson(lesson_id)
          log(
            'status',
            `학습 신고 L${lesson_id}: ${archived ? '보관됨' : '대상아님(핀/이미보관/없음)'}${reason ? ` — ${reason.slice(0, 80)}` : ''}`,
          )
          return {
            content: [
              {
                type: 'text',
                text: archived
                  ? `학습 L${lesson_id}을 보관했다 — 다음 작업엔 주입되지 않는다.`
                  : `학습 L${lesson_id}은 신고 대상이 아니다(핀 고정/이미 보관/없는 번호).`,
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

  // #4 크래시 복원 갭 — 스왑 도중(handoffMd 저장 · naviSessionId='') 크래시 후 복원되면 resume은 끊겼는데
  // 위 스왑 블록도 안 타(재개 경계 미도달) handoffInject가 비어, 저장된 핸드오프가 프롬프트에 안 실린다.
  // 이 경우 저장된 handoffMd를 다시 주입해 새 세션이 진행 상황을 이어받게 한다(맥락 유실 방지).
  if (shouldInjectStoredHandoff(!!resume, !!opts.resumePrompt, !!handoffInject, !!task.handoffMd)) {
    handoffInject = handoffBlock(task.handoffMd)
    log('status', '🔄 복원 — 저장된 핸드오프 md로 맥락 이어감(스왑 중 크래시 복구)')
  }

  // I4 — 라이프타임 토큰 누적 baseline 확정(resume 여부가 이제 최종이라 여기서 정한다).
  //  - resume 있음(동일 세션 이어가기): 저장된 baseline(session_base_tokens)을 그대로 쓴다. 이 세션의 result는
  //    세션 cumulative를 보고하므로 tokens_total = baseline + cumulative가 되어 동일세션 재갱신은 '교체'다(중복 없음).
  //  - resume 없음(신규 작업 또는 핸드오프 스왑 → 새 세션): 이전 세션들 누계(현재 tokens_total)를 새 baseline으로
  //    승격해 이 세션 몫이 그 위에 '가산'되게 한다. 신규 작업이면 tokens_total=0이라 baseline=0.
  //    (핸드오프 스왑은 위 블록이 naviSessionId를 비웠지만 task 스냅샷의 tokens_total은 call 시점 값=이전 세션 최종 누계.)
  const sessionBaseline = sessionBaselineFor(!!resume, task.sessionBaseTokens ?? 0, task.tokensTotal ?? 0)
  if (!resume && sessionBaseline !== (task.sessionBaseTokens ?? 0)) {
    updateTask(task.id, { sessionBaseTokens: sessionBaseline })
  }

  // 프롬프트 3분기: ①진짜 resume(세션에 규칙·히스토리 있음) ②핸드오프 스왑(새 세션 — 규칙 재공급 + 핸드오프)
  // ③신규 작업. 스왑은 resume이 끊겼지만 opts.resumePrompt는 살아있어 '이어가기'로 이어붙인다.
  // naviPrompt(task, false) — 스왑은 같은 작업의 연속이라 학습 inject_count를 다시 올리지 않는다(적합도 신호 보존).
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
        // 결정론 차단(시크릿·spec-gaming)의 실발동 지점 — auto-allow된 호출도 PreToolUse는 반드시 거친다.
        ...preToolUseGuard(denyCheck, recordDeny),

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

          // A4 — TodoWrite는 구조화된 kind='todo' 이벤트로만 표시하고 일반 'tool' 회색 라인은 스킵한다.
          // (그러지 않으면 raw JSON이 로그에 노출되고 'todo' 위젯과 이중 표시됨 — manager.ts와 동일 정책.)
          // task.todos 스냅샷은 누적이 아니라 최신이 진실이라 매번 통째 교체.
          if (toolName === 'TodoWrite') {
            const todos = parseTodoWriteInput(input)
            if (todos) {
              log('todo', encodeTodoLine(todos))
              updateTask(task.id, { todos })
            }
          } else {
            log('tool', `${toolName}: ${desc || cmd.slice(0, 120) || JSON.stringify(input).slice(0, 120)}`)
          }

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

          // 결정론 차단(spec-gaming §21.6 · 시크릿 §24 Phase1/§3 i15s)은 PreToolUse 훅이 모든 호출에서
          // 이미 판정했다. 여기 한 번 더 보는 것은 훅이 등록되지 않았을 때를 위한 이중 방어 — 순수 판정.
          const mechanical = denyCheck(toolName, input)
          if (mechanical) {
            recordDeny(toolName, mechanical)
            return { behavior: 'deny', message: mechanical.message }
          }

          // 경로 가둠 (§9-2): 워크스페이스 루트 밖 절대경로가 명령에 보이면 승인 대상. 루트는 E6 설정
          // (UI/env)을 반영하는 유효값 — 사용자가 지정한 워크스페이스가 신뢰 구역이 되게(env만이던 시절 확장).
          const root = workspaceRoot()
          const outside = /[A-Za-z]:\\/.test(cmd) && !cmd.toUpperCase().includes(root.toUpperCase())
          const risky = RISKY.find((r) => r.re.test(cmd))

          if (toolName === 'Bash' || toolName === 'PowerShell') {
            // 시스템/PC 파괴(sysrisk.ts) — bypass·autonomous 자율 진행 예외 없이 항상 사람 승인.
            const sys = classifySystemDestructive(cmd)
            if (sys) {
              const approvalId = insertApproval(task.id, 'system', cmd)
              log('status', `승인 대기 [system:${sys}]: ${cmd.slice(0, 160)}`)
              emit({ taskId: task.id, kind: 'status', text: `approval:${approvalId}` })
              notifyUser('lain — 시스템 명령 승인 필요', `[${sys}] ${cmd.slice(0, 120)}`)
              // D4 — 무인 작업 승인은 만료해도 거절하지 않는다(세션·worktree 보존). 임계 도달 시 재알림 1회.
              const sysRes = await waitApproval(approvalId, {
                hold: true,
                taskId: task.id, // C1 — hold 동안 슬롯·유휴 게이트에서 제외
                timeoutMs: approvalTimeoutMs(getSettings().approvalTimeoutMin),
                onRemind: () => {
                  log('status', `승인 재알림 [system:${sys}] — 아직 무응답(거절 아님, 계속 대기)`)
                  notifyUser('lain — 승인 대기 중', `[${sys}] ${task.projectId}: 아직 응답이 없다 (${cmd.slice(0, 80)})`)
                },
              })
              log('status', sysRes.approved ? `승인됨: ${cmd.slice(0, 80)}` : `거절됨: ${cmd.slice(0, 80)}`)
              if (!sysRes.approved) {
                return {
                  behavior: 'deny',
                  message: '사용자가 이 시스템 명령을 거절했다. 다른 방법으로 진행하거나 blocked로 보고해라.',
                }
              }
              return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
            }
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
              // D4 — 무인 작업 승인은 만료해도 거절하지 않는다(세션·worktree 보존). 임계 도달 시 재알림 1회.
              const res = await waitApproval(approvalId, {
                hold: true,
                taskId: task.id, // C1 — hold 동안 슬롯·유휴 게이트에서 제외
                timeoutMs: approvalTimeoutMs(getSettings().approvalTimeoutMin),
                onRemind: () => {
                  log('status', `승인 재알림 [${kind}] — 아직 무응답(거절 아님, 계속 대기)`)
                  notifyUser('lain — 승인 대기 중', `[${kind}] ${task.projectId}: 아직 응답이 없다 (${cmd.slice(0, 80)})`)
                },
              })
              log('status', res.approved ? `승인됨: ${cmd.slice(0, 80)}` : `거절됨: ${cmd.slice(0, 80)}`)
              if (!res.approved) {
                return {
                  behavior: 'deny',
                  message: '사용자가 이 명령을 거절했다. 다른 방법으로 진행하거나 blocked로 보고해라.',
                }
              }
            }
          }

          // D9 — plan 모드 배선: permissionMode==='plan'일 때만 ExitPlanMode를 승인 게이트로 건다.
          // 계획 전문을 승인 카드로 띄우고(기존 승인 큐 재사용 — PC 카드·텔레그램 버튼 자동), 사람이
          // 승인해야 실행이 이어진다. hold:true라 무인 백그라운드 작업답게 무한 대기(D4 타임아웃 보류 상속).
          // 그 외 모드에선 ExitPlanMode가 올 일이 거의 없으나, 와도 흐름을 막지 않게 그대로 allow 통과.
          if (toolName === 'ExitPlanMode' && task.permissionMode === 'plan') {
            const plan = String((input as { plan?: unknown })?.plan ?? '(계획 본문 없음)')
            const approvalId = insertApproval(task.id, 'plan', plan)
            log('status', `계획 승인 대기 [plan]: ${plan.slice(0, 160)}`)
            emit({ taskId: task.id, kind: 'status', text: `approval:${approvalId}` })
            notifyUser('lain — 계획 승인 필요', plan.slice(0, 120))
            // D4 — 무인 작업 승인은 만료해도 거절하지 않는다(세션·worktree 보존). 임계 도달 시 재알림 1회.
            const res = await waitApproval(approvalId, {
              hold: true,
              taskId: task.id, // C1 — hold 동안 슬롯·유휴 게이트에서 제외
              timeoutMs: approvalTimeoutMs(getSettings().approvalTimeoutMin),
              onRemind: () => {
                log('status', `승인 재알림 [plan] — 아직 무응답(거절 아님, 계속 대기)`)
                notifyUser('lain — 계획 승인 대기 중', `${task.projectId}: 아직 응답이 없다`)
              },
            })
            log('status', res.approved ? `계획 승인됨` : `계획 거절됨`)
            if (!res.approved) {
              return {
                behavior: 'deny',
                message: '사용자가 계획을 거부했다. 계획을 수정하거나 다른 접근을 제안해라.',
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
        // D6 — assistant 메시지 1건 ≈ 턴 1(SDK가 세션 중엔 num_turns를 안 줘서 이걸로 근사).
        // N턴 또는 M분 경과 시 결정론 체크포인트 1회(git diffStat·커밋 수). LLM 호출 없음.
        turnsSoFar++
        if (
          cpProject &&
          shouldCheckpoint({
            turnsSoFar,
            lastCheckpointTurn,
            elapsedMs: Date.now() - lastCheckpointMs,
          })
        ) {
          try {
            const stat = diffStat(cpProject, task.id)
            const line = formatCheckpoint(turnsSoFar, commitCount(cpProject, task.id), stat)
            log('checkpoint', line)
            // 다이제스트가 세션 종료 전에도 최신 진행을 반영하도록 기존 필드만 갱신(스키마 무변경).
            updateTask(task.id, { turns: turnsSoFar, diffStat: stat })
          } catch {
            /* git 실패는 무해 — 체크포인트만 건너뛰고 작업은 계속 */
          }
          lastCheckpointTurn = turnsSoFar
          lastCheckpointMs = Date.now()
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
        // I4 — 라이프타임 누적: tokens(세션 cumulative)는 표시용으로 유지하고, tokens_total은
        // baseline(이전 세션들 누계) + 이 세션 cumulative로 갱신한다. 동일 세션 result가 반복돼도
        // 세션 cumulative가 baseline 위에 얹히므로 '교체'라 중복 계수되지 않고, 새 세션은 baseline이 이미
        // 이전 세션 누계로 승격돼 있어 '가산'된다. 예산 판정(finishWork)은 tokens_total을 기준으로 본다.
        const tokensTotal = lifetimeTokensFor(sessionBaseline, tokens)
        // 점유(input+캐시, output 제외)는 다음 재개 경계의 핸드오프 감지용 — 누적합 tokens와 별개.
        updateTask(task.id, { costUsd: cost, tokens, tokensTotal, turns, contextTokens: contextOccupancyTokens(msg) })
        // D7 — 전역 사용량 롤링 카운터에 이번 세션 소비 토큰을 적재(인메모리·결정론, LLM 없음).
        // 근접 시 신규 스폰 억제·judge 티어 강등의 단일 출처(usage.ts). off여도 적재는 무해(합만 함).
        recordUsage(tokens)
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
    naviEmitters.delete(task.id)
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
