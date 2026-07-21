// §5.6 Navi 직접 채팅 — 특정 프로젝트의 Claude에게 직접 입력 (관리자 우회).
// "그 프로젝트의 Claude Code에 직접 타이핑하는 것과 동일":
// - working/clarifying 작업이 있으면 거절 (§5.7 인터럽트는 §18 실측 후 별도 증분)
// - blocked 작업이 있으면 그 Navi 세션의 답변 경로(answerClarify)로 위임 — 상태머신 보존
// - 그 외(idle)는 프로젝트 루트에 독립 세션을 띄운다(세션은 settings에 영속, resume 유지)
// 위험 명령은 Navi와 동일하게 승인 큐(§9-4)로 — task_id는 `chat:<projectId>` 합성 키.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mcpServersFor } from './mcp'
import path from 'node:path'
import { DATA_DIR, CLAUDE_BIN } from './paths'
import { appendCapped } from './logfile'
import { toImageBlocks, type ImageBlock } from './taskimages'
import {
  activeTaskForProject,
  addNaviMessage,
  bumpLessonInject,
  conversationSdkSession,
  ensureActiveConversation,
  getConversationContextTokens,
  getConversationHandoff,
  getProject,
  getSettings,
  insertApproval,
  lessonsForProject,
  listConversationDialogue,
  listProjects,
  resetConversationContextTokens,
  setConversationContextTokens,
  setConversationHandoff,
  setConversationSdkSession,
  setConversationTitleIfEmpty,
  touchConversation,
  needsAutoTitle,
} from './store'
import { tierQueryOptions } from './agentopts'
import { summarizeConversationTitle } from './title'
import { RISKY, sumUsageTokens, waitApproval } from './worker'
import { workspaceRoot } from './registry'
import { answerClarify, interruptTask } from './orchestrator'
import { notifyUser } from './notify'
import { classifySystemDestructive } from './sysrisk'
import { blocksSecretFile, toolFilePath, SECRET_DENY_MESSAGE } from './safety'
import { shouldCompact, contextOccupancyTokens } from './compactgate'
import { summarizeNaviHandoff, handoffBlock } from './handoff'
import { skillOptions } from './skills'
import { frameMessage, NAVI_SENDER_LEGEND, type NaviSender } from './navisender'
import { conventionsBlock } from './conventions'
import {
  NAVI_CHAT_LESSON_LIMIT,
  naviChatLessonsBlock,
  shouldInjectNaviChatLessons,
} from './lessoninject'
import type { NaviChatEvent, FileAttachment } from '../shared/types'
import { encodeToolLine } from '../shared/toolline'

const busyProjects = new Set<string>()
const chatAborts = new Map<string, AbortController>()
// 진행 중 Navi 채팅 턴 강제 종료기(stopNaviChat이 호출) — abort가 스트림을 못 끊을 때의 대비책(manager.forceStopTurn 미러).
const chatForceStop = new Map<string, (reason: string) => void>()

export function chatTaskId(projectId: string): string {
  return `chat:${projectId}`
}

// 정지 — 진행 중인 Navi 직접 채팅 응답을 중단. UI/IPC workerchat:stop이 호출.
export function stopNaviChat(projectId: string): void {
  chatAborts.get(projectId)?.abort()
  // ⚠️ abort가 SDK 스트림을 못 끊으면(서브프로세스 행·도구 멈춤) for-await가 안 끝나 finally(busy 해제·result)도
  // 영영 안 돈다 → busyProjects가 남아 다음 메시지가 '이전 메시지 처리 중'으로 거절되고 naviBusy도 다시 묶인다.
  // 그래서 abort와 별개로 현재 턴을 직접 강제 종료한다 — busy 해제 + 종료 result emit(manager.forceStopTurn 미러).
  chatForceStop.get(projectId)?.('정지됨')
}

// assistant content의 tool_use 블록 → 짧은 회색 활동 라인.
// A17 — display(축약)와 별개로 raw(잘리기 전 원문 — 전체 경로·전체 명령)도 반환. 호출부가
// encodeToolLine으로 합쳐 저장(스키마 변경 없이 content 하나에 원문 보존, manager.ts formatToolUse와 동일 패턴).
function toolActivityLine(b: any): { display: string; raw: string } {
  const name = String(b?.name ?? '')
  const input = (b?.input ?? {}) as Record<string, unknown>
  const fp = String(input.file_path ?? '')
  const base = (p: unknown) => path.basename(String(p ?? '')) || String(p ?? '')
  switch (name) {
    case 'Read':
      return { display: `· Read ${base(input.file_path)}`, raw: fp }
    case 'Edit':
    case 'Write':
      return { display: `· ${name} ${base(input.file_path)}`, raw: fp }
    case 'Bash':
    case 'PowerShell': {
      const cmd = String(input.command ?? '')
      return { display: `· $ ${cmd.slice(0, 60)}`, raw: cmd }
    }
    case 'Glob':
    case 'Grep':
      return { display: `· Grep ${String(input.pattern ?? '')}`, raw: '' }
    default:
      return { display: `· ${name}`, raw: '' }
  }
}

// §5.6 전체(broadcast) — 등록된 모든 프로젝트에 같은 메시지를 fan-out.
// 동시 실행은 concurrencyCap으로 제한(§9-7). 작업 중(working) Navi는
// 건너뛰고 그 사실을 이벤트로 알린다 (§5.7 인터럽트가 붙기 전까지의 정책).
export async function sendToAllNavis(
  text: string,
  emit: (ev: NaviChatEvent) => void,
  from: NaviSender = 'user', // 'lain' = 관리자 broadcast_navis (Navi 대화창에서 'lain>'으로 귀속)
): Promise<{ error?: string }> {
  const targets = listProjects()
  if (targets.length === 0) {
    emit({ projectId: '@all', kind: 'result', costUsd: null, tokens: null, sessionId: null })
    return { error: '대상 프로젝트 없음' }
  }
  const cap = Math.max(1, getSettings().concurrencyCap)
  emit({ projectId: '@all', kind: 'tool', text: `broadcast → ${targets.length}곳 (동시 ${cap})` })
  const queue = [...targets]
  const runOne = async (): Promise<void> => {
    const p = queue.shift()
    if (!p) return
    const res = await sendToNavi(p.id, text, emit, undefined, [], from)
    if (res.error) emit({ projectId: '@all', kind: 'tool', text: `[${p.id}] 건너뜀: ${res.error}` })
    return runOne()
  }
  await Promise.all(Array.from({ length: Math.min(cap, targets.length) }, () => runOne()))
  emit({ projectId: '@all', kind: 'result', costUsd: null, tokens: null, sessionId: null })
  return {}
}

export async function sendToNavi(
  projectId: string,
  text: string,
  emit: (ev: NaviChatEvent) => void,
  conversationId?: string, // 미지정 시 활성 대화로 자동(매니저 message_navi·@all·텔레그램 등)
  attachments: FileAttachment[] = [], // §5.6 첨부 — 텍스트는 프롬프트 코드블록, 이미지는 SDK 블록(idle 신규 세션만)
  from: NaviSender = 'user', // 발신자. 'lain'=관리자(message_navi/broadcast) → Navi 대화창에서 'lain>'으로 귀속
): Promise<{ error?: string }> {
  const project = getProject(projectId)
  if (!project) return { error: '프로젝트 없음' }
  conversationId = conversationId || ensureActiveConversation(projectId)
  const msgOrigin = from === 'lain' ? 'lain' : undefined // addNaviMessage origin 인자(사용자 메시지 귀속용)

  // D14 주의 — projectParallelCap>1로 같은 프로젝트 활성 작업이 여럿이면 최신 것 하나로 라우팅된다(v1).
  // 아래 tool 라인에 대상 작업 제목이 표기되므로 어디로 갔는지는 보인다. 작업 지정 라우팅은 v2(task_id 파라미터).
  const active = activeTaskForProject(projectId)
  if (active && active.state === 'working') {
    // §5.7 작업 중 인터럽트 — 안전 중단 후 메시지를 최우선 주입, 같은 세션 이어감
    // 발신자 태깅: 인터럽트 텍스트도 [user]/[lain]을 달아 모델이 출처를 읽게 한다(레전드는 새 세션에만, 세션 히스토리에 이미 있음).
    if (interruptTask(active.id, frameMessage(from, text))) {
      addNaviMessage(projectId, 'user', text, conversationId, undefined, msgOrigin)
      addNaviMessage(projectId, 'tool', `작업 "${active.title}"에 인터럽트 전달 — 진행은 작업 드로어에서 확인`, conversationId)
      emit({ projectId, kind: 'tool', text: '작업 중 Navi에 인터럽트 전달됨 (§5.7)' })
      emit({ projectId, kind: 'result', costUsd: null, tokens: null, sessionId: null })
      return {}
    }
    return { error: 'Navi 전이 중 — 잠시 후 다시 시도해라.' }
  }
  if (active && active.state === 'clarifying') {
    return { error: '명확화 판정 중 — 잠시 후 다시 시도하거나 드로어에서 취소해라.' }
  }
  if (active && active.state === 'blocked') {
    // 막힌 Navi 세션에 답변으로 주입 — finishWork 경로를 보존해 작업 상태머신이 깨지지 않게.
    addNaviMessage(projectId, 'user', text, conversationId, undefined, msgOrigin)
    addNaviMessage(projectId, 'tool', `입력을 막힌 작업 "${active.title}"의 명세 질문 답변으로 전달함 — 진행은 작업 드로어에서 확인`, conversationId)
    emit({
      projectId,
      kind: 'tool',
      text: 'blocked Navi에 답변으로 전달됨 — 응답은 비동기(지금 안 돌아옴). 진행은 작업 드로어/list_tasks로 확인',
    })
    emit({ projectId, kind: 'result', costUsd: null, tokens: null, sessionId: null })
    // 발신자 태깅: answerClarify의 answers는 task.content에 '## 추가 답변' 블록으로 영속 저장되고
    // (elicit 재진입·TASK.md·resume 프롬프트에 재투입) 되므로, 본문에 태그를 박지 않는다 — 명세 오염 방지.
    // 대신 sender만 넘겨 answerClarify가 working 분기 resume 프롬프트(모델에 닿는 메시지)에만 태그를 붙이게 한다.
    void answerClarify(active.id, text, from)
    return {}
  }
  if (active && (active.state === 'review' || active.state === 'ready')) {
    // review/ready는 idle 폴스루로 빠지면 안 된다 — 메인 체크아웃(project.path)에 acceptEdits
    // 독립 세션이 떠 worktree 브랜치와 발산한다. 명시적으로 거절(§5.6 직접채팅·Lain message_navi 공통).
    return {
      error:
        active.state === 'review'
          ? `검토 대기 중인 작업 "${active.title}"이 있다 — 메인 직접 편집은 worktree 브랜치와 발산한다. 병합/브랜치/폐기를 정한 뒤 다시 시도해라.`
          : `작업 "${active.title}" 준비/시작 중 — 잠시 후 다시 시도해라.`,
    }
  }

  if (busyProjects.has(projectId)) return { error: '이 Navi가 이전 메시지를 처리 중이다.' }
  busyProjects.add(projectId)

  // 사용자/Lain 메시지 먼저 기록 — body 합성 전에(핸드오프 🔄 노트가 이 메시지 뒤에 오도록).
  // 매니저처럼 [+N개 첨부] 접미사 + 원본 첨부 동봉(인라인 썸네일 로그).
  const userContent = text + (attachments.length ? ` [+${attachments.length}개 첨부]` : '')
  addNaviMessage(projectId, 'user', userContent, conversationId, attachments, msgOrigin)
  setConversationTitleIfEmpty(conversationId, text)
  touchConversation(conversationId)

  // Navi 유한세션 핸드오프(≠ Lain 무한세션) — 점유가 임계 넘으면 현 세션에서 Navi가 핸드오프 md를 직접 쓰고
  // 세션을 교체한다. working/blocked/review는 위에서 이미 분기 → 여기 도달 = idle 신규/resume 진입.
  let resume = conversationSdkSession(conversationId) || undefined // ''(에러로 초기화됨)도 새 세션
  const handoffThreshold = getSettings().naviHandoffThreshold
  if (
    handoffThreshold > 0 &&
    resume &&
    shouldCompact(getConversationContextTokens(conversationId), handoffThreshold)
  ) {
    const prev = getConversationHandoff(conversationId)
    const recent = listConversationDialogue(conversationId, 40) // user/assistant 원문만
    const mirror = path.join(
      DATA_DIR,
      'handoffs',
      `${projectId.replaceAll('/', '_')}-${conversationId}.md`,
    )
    const md = await summarizeNaviHandoff(project.path, recent, prev, mirror)
    // 교체 가드 — **새 md가 실제로 나왔을 때만** 끊는다. 실패(null)면 stale prev로 갈아끼우지 말고
    // 현 세션을 유지한다(현 세션이 가장 최신 맥락 — prev는 직전 스왑 시점의 오래된 요약). 다음 턴 재시도.
    if (md) {
      setConversationHandoff(conversationId, md)
      setConversationSdkSession(conversationId, '')
      resetConversationContextTokens(conversationId)
      resume = undefined
      const note = '🔄 세션 교체 — 핸드오프 md로 맥락 이어감'
      addNaviMessage(projectId, 'tool', note, conversationId)
      emit({ projectId, kind: 'tool', text: note })
    }
  }
  // 새 세션(resume 없음)이면 핸드오프 1회 주입(킬스위치: threshold 0이면 무주입). resume 있으면 세션에 이미 있음.
  const handoffInject =
    handoffThreshold > 0 && !resume ? handoffBlock(getConversationHandoff(conversationId)) : ''

  // 텍스트 첨부 코드블록 + 핸드오프 주입 = 본문(텍스트는 프롬프트, 이미지는 SDK 블록). status-digest·temporal anchor 없음.
  const textAttachments = attachments.filter((a) => !a.isImage)
  const textSuffix = textAttachments.length
    ? '\n\n' +
      textAttachments.map((a) => `[첨부: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\``).join('\n\n')
    : ''
  // 발신자 레전드 + 프로젝트 컨벤션 — 새 세션(resume 없음, handoffInject 주입 조건과 동일)일 때만 1회 선두 주입.
  // resume이 살아있으면 세션 히스토리에 이미 있으니 재주입하지 않는다. (직접 채팅은 project.path에서 돌아 상위 컨벤션도 닿음.)
  // 학습 주입 — 새 세션이면 이 프로젝트 관련 학습 top-K를 preamble에 1회 주입(manager <lessons> 포맷·cap 동형).
  // 선별은 store.lessonsForProject 기존 랭킹(메시지 내용 기준 콘텐츠-인지) 재사용, 주입=사용(inject_count·last_used_at).
  const chatLessons = shouldInjectNaviChatLessons(resume)
    ? lessonsForProject(projectId, NAVI_CHAT_LESSON_LIMIT, text)
    : []
  const lessonsInject = naviChatLessonsBlock(chatLessons)
  if (chatLessons.length) bumpLessonInject(chatLessons.map((l) => l.id))
  const preamble = !resume ? NAVI_SENDER_LEGEND + conventionsBlock(project.path) : ''
  const body = `${preamble}${lessonsInject}${handoffInject}${frameMessage(from, text)}${textSuffix}`
  const imageAttachments = attachments.filter((a) => a.isImage)
  type TextBlock = { type: 'text'; text: string }
  const promptContent: (TextBlock | ImageBlock)[] = [{ type: 'text', text: body }]
  promptContent.push(...toImageBlocks(imageAttachments))
  const promptParam =
    imageAttachments.length > 0
      ? (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: promptContent },
            parent_tool_use_id: null,
          }
        })()
      : body

  let assistantSeen = false
  const abort = new AbortController()
  chatAborts.set(projectId, abort)
  let resultSeen = false // 스트림 result가 났는지 — 마감 시 result를 한 번은 emit해 naviBusy 해제 보장.
  // 강제 종료기 — stopNaviChat이 호출. abort가 스트림을 못 끊어도 즉시 busy를 풀고 종료 result를 emit해
  // UI·후속 전송이 '처리 중'에 영구 고착하지 않게 한다. 멈춘 스트림은 orphan으로 남지만, finally의
  // abort-동일성 가드가 새 턴 상태를 지키고 abort가 결국 정리한다.
  let abandoned = false
  chatForceStop.set(projectId, (reason: string) => {
    if (abandoned) return
    abandoned = true
    resultSeen = true
    busyProjects.delete(projectId)
    try {
      addNaviMessage(projectId, 'tool', reason, conversationId)
    } catch {
      /* DB 손상 — 진단 영속 실패가 종료를 막지 않게 */
    }
    emit({ projectId, kind: 'tool', text: reason })
    emit({ projectId, kind: 'result', costUsd: null, tokens: null, sessionId: null })
  })

  try {
    const stream = query({
      prompt: promptParam,
      options: {
        cwd: project.path,
        resume,
        permissionMode: 'acceptEdits',
        maxTurns: 30,
        // A9 — 토큰 스트리밍(manager.ts와 동일 선례): 텍스트 증분(stream_event)을 렌더러에 흘려
        // 완성될 때까지 통짜로 나타나는 대신 라이브 버블로 이어붙게 한다. 확정·영속은 assistant 블록.
        includePartialMessages: true,
        ...tierQueryOptions(getSettings().naviModel, getSettings()), // §9b — Navi와 같은 티어(local 라우팅 포함)
        ...skillOptions(null, getSettings().skillsEnabled, getSettings().curatedPlugins),
        executable: 'node',
        abortController: abort,
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
        // 사용자 등록 외부 MCP(navi 타깃, enabled만) — CC-FEATURES P1. Navi 직접 채팅도 같은 도구.
        mcpServers: mcpServersFor('navi'),
        stderr: (d: string) =>
          appendCapped(
            path.join(DATA_DIR, `workerchat-${projectId.replaceAll('/', '_')}-stderr.log`),
            d,
          ),
        canUseTool: async (toolName, input) => {
          const cmd = String((input as any)?.command ?? '')
          // 비밀 파일 데노리스트 (§24 Phase1) — Navi 채팅도 파일 도구로 시크릿을 못 끌어오게.
          if (blocksSecretFile(toolName, input)) {
            const text = `secret 차단: 비밀 파일 접근 거부 (${path.basename(toolFilePath(input))})`
            addNaviMessage(projectId, 'tool', text)
            emit({ projectId, kind: 'tool', text })
            return { behavior: 'deny', message: SECRET_DENY_MESSAGE }
          }
          if (toolName === 'Bash' || toolName === 'PowerShell') {
            // 시스템/PC 파괴(sysrisk.ts) — 항상 사람 승인(예외 없음).
            const sys = classifySystemDestructive(cmd)
            if (sys) {
              const approvalId = insertApproval(chatTaskId(projectId), 'system', cmd)
              const waitNote = `승인 대기 [system:${sys}]: ${cmd.slice(0, 160)}`
              addNaviMessage(projectId, 'tool', waitNote)
              emit({ projectId, kind: 'tool', text: waitNote })
              notifyUser('lain — 시스템 명령 승인 필요', `[${sys}] ${cmd.slice(0, 120)}`)
              const sysRes = await waitApproval(approvalId)
              const sysNote = sysRes.approved ? '승인됨' : '거절됨'
              addNaviMessage(projectId, 'tool', `${sysNote}: ${cmd.slice(0, 80)}`)
              emit({ projectId, kind: 'tool', text: `${sysNote}: ${cmd.slice(0, 80)}` })
              if (!sysRes.approved) {
                return {
                  behavior: 'deny',
                  message: '사용자가 이 시스템 명령을 거절했다. 다른 방법으로 진행해라.',
                }
              }
              return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
            }
            const root = workspaceRoot() // E6 — 유효 워크스페이스 루트(UI/env) 반영
            const outside =
              /[A-Za-z]:\\/.test(cmd) && !cmd.toUpperCase().includes(root.toUpperCase())
            const risky = RISKY.find((r) => r.re.test(cmd))
            if (risky || outside) {
              const kind = risky?.kind ?? 'outside_dev'
              const approvalId = insertApproval(chatTaskId(projectId), kind, cmd)
              addNaviMessage(projectId, 'tool', `승인 대기 [${kind}]: ${cmd.slice(0, 160)}`)
              emit({ projectId, kind: 'tool', text: `승인 대기 [${kind}]: ${cmd.slice(0, 160)}` })
              notifyUser('lain — 승인 필요', `[${kind}] ${cmd.slice(0, 120)}`)
              const res = await waitApproval(approvalId)
              const note = res.approved ? '승인됨' : '거절됨'
              addNaviMessage(projectId, 'tool', `${note}: ${cmd.slice(0, 80)}`)
              emit({ projectId, kind: 'tool', text: `${note}: ${cmd.slice(0, 80)}` })
              if (!res.approved) {
                return {
                  behavior: 'deny',
                  message: '사용자가 이 명령을 거절했다. 다른 방법으로 진행해라.',
                }
              }
            }
          }
          return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
        },
      },
    })

    for await (const msg of stream) {
      if (abandoned) break // 정지로 강제 종료됨 — 늦게 도착한 스트림은 더 처리하지 않는다
      if (msg.type === 'system' && msg.subtype === 'init') {
        setConversationSdkSession(conversationId, msg.session_id)
      } else if (msg.type === 'stream_event') {
        // A9 — 최상위 텍스트 증분만 라이브로 흘린다(서브에이전트 parent_tool_use_id≠null 제외).
        // manager.ts와 동일 패턴: thinking_delta 등은 무시하고 text_delta만.
        if (msg.parent_tool_use_id == null) {
          const sev = msg.event as { type?: string; delta?: { type?: string; text?: string } }
          if (sev?.type === 'content_block_delta' && sev.delta?.type === 'text_delta' && sev.delta.text) {
            emit({ projectId, kind: 'assistant_delta', text: sev.delta.text })
          }
        }
      } else if (msg.type === 'assistant') {
        const content = msg.message?.content ?? []
        const out = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (out) {
          assistantSeen = true
          addNaviMessage(projectId, 'assistant', out, conversationId)
          emit({ projectId, kind: 'assistant', text: out })
        }
        // 도구 활동 라인 — 같은 content 배열의 tool_use 블록도 짧은 회색 라인으로 영속+emit.
        for (const b of content as any[]) {
          if (b?.type !== 'tool_use') continue
          const { display, raw } = toolActivityLine(b)
          // A17 — 원문(전체 경로·전체 명령)을 축약 뒤에 인코딩해 함께 영속(스키마 변경 없음).
          const line = encodeToolLine(display, raw)
          addNaviMessage(projectId, 'tool', line, conversationId)
          emit({ projectId, kind: 'tool', text: line })
        }
      } else if (msg.type === 'result') {
        resultSeen = true
        if ('session_id' in msg && msg.session_id)
          setConversationSdkSession(conversationId, msg.session_id)
        setConversationContextTokens(conversationId, contextOccupancyTokens(msg)) // 다음 턴 핸드오프 감지용
        emit({
          projectId,
          kind: 'result',
          costUsd: 'total_cost_usd' in msg ? (msg.total_cost_usd ?? null) : null,
          tokens: sumUsageTokens(msg),
          sessionId: 'session_id' in msg ? (msg.session_id ?? null) : null,
        })
      }
    }
    // 대화 제목 자동요약 — 이번 턴에 assistant 응답이 났고 아직 자동요약 전이면 1회 비동기 생성.
    if (assistantSeen && needsAutoTitle(conversationId))
      void summarizeConversationTitle(conversationId, text, projectId)
    return {}
  } catch (e) {
    const msg = String(e)
    // 이미 forceStop(정지)이 종료 처리했으면 늦게 도착한 abort throw는 무시 — 중복 '정지됨'·result 방지.
    if (abandoned) return {}
    if (abort.signal.aborted || /aborted by user/i.test(msg)) {
      // 정지 버튼(stopNaviChat)으로 중단 — 에러 아님. result로 busy만 깔끔히 해제.
      addNaviMessage(projectId, 'tool', '정지됨', conversationId)
      emit({ projectId, kind: 'tool', text: '정지됨' })
      resultSeen = true
      emit({ projectId, kind: 'result', costUsd: null, tokens: null, sessionId: null })
      return {}
    }
    // resume 실패 등 — 이 대화의 SDK 세션을 버려 다음 메시지는 새 세션으로 시작
    setConversationSdkSession(conversationId, '')
    emit({ projectId, kind: 'error', message: msg })
    return { error: msg }
  } finally {
    // '내 턴'일 때만 정리 — forceStop으로 busy를 일찍 푼 뒤 같은 프로젝트에 새 턴이 시작돼 chatAborts가
    // 새 컨트롤러로 교체됐다면, 늦게 끝난 이 orphan 턴이 새 턴의 abort/forceStop/busy를 지우지 않게 한다.
    if (chatAborts.get(projectId) === abort) {
      chatAborts.delete(projectId)
      chatForceStop.delete(projectId)
      busyProjects.delete(projectId)
      // 안전망 — 스트림이 result 없이 끝났는데도 종료 이벤트가 안 갔으면 result를 1회 보내 naviBusy 해제.
      if (!resultSeen) emit({ projectId, kind: 'result', costUsd: null, tokens: null, sessionId: null })
    }
  }
}
