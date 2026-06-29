// §5.6 Navi 직접 채팅 — 특정 프로젝트의 Claude에게 직접 입력 (관리자 우회).
// "그 프로젝트의 Claude Code에 직접 타이핑하는 것과 동일":
// - working/clarifying 작업이 있으면 거절 (§5.7 인터럽트는 §18 실측 후 별도 증분)
// - blocked 작업이 있으면 그 Navi 세션의 답변 경로(answerClarify)로 위임 — 상태머신 보존
// - 그 외(idle)는 프로젝트 루트에 독립 세션을 띄운다(세션은 settings에 영속, resume 유지)
// 위험 명령은 Navi와 동일하게 승인 큐(§9-4)로 — task_id는 `chat:<projectId>` 합성 키.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mcpServersFor } from './mcp'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, CLAUDE_BIN } from './paths'
import { appendCapped } from './logfile'
import {
  activeTaskForProject,
  addNaviMessage,
  conversationSdkSession,
  ensureActiveConversation,
  getConversationContextTokens,
  getConversationHandoff,
  getProject,
  getSettings,
  insertApproval,
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
import { modelId } from '../shared/models'
import { summarizeConversationTitle } from './title'
import { DEV_ROOT, RISKY, sumUsageTokens, waitApproval } from './worker'
import { answerClarify, interruptTask } from './orchestrator'
import { notifyUser } from './notify'
import { blocksSecretFile, toolFilePath, SECRET_DENY_MESSAGE } from './safety'
import { shouldCompact, contextOccupancyTokens } from './compactgate'
import { summarizeNaviHandoff, handoffBlock } from './handoff'
import { skillOptions } from './skills'
import { frameMessage, NAVI_SENDER_LEGEND, type NaviSender } from './navisender'
import { conventionsBlock } from './conventions'
import type { NaviChatEvent, FileAttachment } from '../shared/types'

const busyProjects = new Set<string>()
const chatAborts = new Map<string, AbortController>()

export function chatTaskId(projectId: string): string {
  return `chat:${projectId}`
}

// 정지 — 진행 중인 Navi 직접 채팅 응답을 중단(abort). UI/IPC workerchat:stop이 호출.
// manager.ts stopManager 미러: 컨트롤러 abort만 하고, busy 해제·result emit은 스트림 마감 경로가 처리.
export function stopNaviChat(projectId: string): void {
  chatAborts.get(projectId)?.abort()
}

// assistant content의 tool_use 블록 → 짧은 회색 활동 라인.
function toolActivityLine(b: any): string {
  const name = String(b?.name ?? '')
  const input = (b?.input ?? {}) as Record<string, unknown>
  const base = (p: unknown) => path.basename(String(p ?? '')) || String(p ?? '')
  switch (name) {
    case 'Read':
      return `· Read ${base(input.file_path)}`
    case 'Edit':
    case 'Write':
      return `· ${name} ${base(input.file_path)}`
    case 'Bash':
    case 'PowerShell':
      return `· $ ${String(input.command ?? '').slice(0, 60)}`
    case 'Glob':
    case 'Grep':
      return `· Grep ${String(input.pattern ?? '')}`
    default:
      return `· ${name}`
  }
}

// §5.6 전체(broadcast) — 모든 enabled 프로젝트에 같은 메시지를 fan-out.
// 동시 실행은 concurrencyCap으로 제한(§9-7). 작업 중(working) Navi는
// 건너뛰고 그 사실을 이벤트로 알린다 (§5.7 인터럽트가 붙기 전까지의 정책).
export async function sendToAllNavis(
  text: string,
  emit: (ev: NaviChatEvent) => void,
  from: NaviSender = 'user', // 'lain' = 관리자 broadcast_navis (Navi 대화창에서 'lain>'으로 귀속)
): Promise<{ error?: string }> {
  const targets = listProjects().filter((p) => p.enabled)
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
  const preamble = !resume ? NAVI_SENDER_LEGEND + conventionsBlock(project.path) : ''
  const body = `${preamble}${handoffInject}${frameMessage(from, text)}${textSuffix}`
  const imageAttachments = attachments.filter((a) => a.isImage)
  type ImgMedia = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  type ImageBlock = {
    type: 'image'
    source: { type: 'base64'; media_type: ImgMedia; data: string }
  }
  type TextBlock = { type: 'text'; text: string }
  const promptContent: (TextBlock | ImageBlock)[] = [{ type: 'text', text: body }]
  for (const img of imageAttachments) {
    promptContent.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType as ImgMedia, data: img.data },
    })
  }
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

  try {
    const stream = query({
      prompt: promptParam,
      options: {
        cwd: project.path,
        resume,
        permissionMode: 'acceptEdits',
        maxTurns: 30,
        model: modelId(getSettings().naviModel), // §9b — Navi와 같은 티어
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
            const outside =
              /[A-Za-z]:\\/.test(cmd) && !cmd.toUpperCase().includes(DEV_ROOT.toUpperCase())
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
      if (msg.type === 'system' && msg.subtype === 'init') {
        setConversationSdkSession(conversationId, msg.session_id)
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
          const line = toolActivityLine(b)
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
    chatAborts.delete(projectId)
    busyProjects.delete(projectId)
    // 안전망 — 스트림이 result 없이 끝났는데도 종료 이벤트가 안 갔으면 result를 1회 보내 naviBusy 해제.
    if (!resultSeen) emit({ projectId, kind: 'result', costUsd: null, tokens: null, sessionId: null })
  }
}
