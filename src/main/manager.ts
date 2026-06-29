// L1 관리자(Lain) 세션 래퍼 (PLAN.md §4, §5.3) — Agent SDK로 Lain Claude 구동.
// 자연어 명령을 와이어드 액션으로 옮기는 in-process MCP 도구(lain)를 쥐여준다.
// 삼각 쌍방향(§5): Lain↔너(채팅) · Lain→Navi(message_navi) · Navi→Lain(ask_manager).
// 안전: Navi의 위험명령 승인 큐(canUseTool, worker.ts)는 별개 레이어로 그대로 유지된다.
// Lain은 클로드코드 전체 도구에 접근한다(사용자 승인 2026-06-19): 와이어드 도구 + 파일 읽기·수정 +
// Bash/PowerShell(셸) + Workflow/Agent + 웹 등. 시크릿 파일 보호만 유지. 작업 유실 방지는 권한이 아니라
// 배포 가드(deploy.ps1)로 한다. 결재(merge/브랜치/폐기)는 resolve_review로 Lain에 위임됨. Navi 위험명령 승인은 여전히 사람 전용.
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { mcpServersFor } from './mcp'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { app } from 'electron'
import { DATA_DIR, AGENT_CWD, CLAUDE_BIN } from './paths'
import { appendCapped } from './logfile'
import type { ChatEvent, FileAttachment, ProjectView, NaviChatEvent } from '../shared/types'
import type { Observation } from './watcher'
import { isTransientApiError, transientBackoffMs, MAX_TRANSIENT_RETRIES } from './retry'
import {
  addMessage,
  listRecentCcEvents,
  getSettings,
  listProjects,
  listTasks,
  listApprovals,
  getProject,
  hideProject,
  lessonsForProject,
  bumpLessonInject,
  searchHistory,
  conversationSdkSession,
  setConversationSdkSession,
  ensureActiveConversation,
  setConversationTitleIfEmpty,
  touchConversation,
  listConversationDialogue,
  getConversationContextTokens,
  setConversationContextTokens,
  resetConversationContextTokens,
  getConversationWorldState,
  setConversationWorldState,
  setManagerViewWindow,
  needsAutoTitle,
  insertRoutine,
  listRoutines,
  setRoutineEnabled,
  deleteRoutine,
} from './store'
import { modelId } from '../shared/models'
import { managerAgentOptions } from './agentopts'
import { summarizeConversationTitle } from './title'
import { summarizeWorldState } from './compact'
import { shouldCompact, contextOccupancyTokens, occupancyForMaxTurns } from './compactgate'
import { startTask, answerClarify, cancelTask, resolveReview } from './orchestrator'
import { blocksSecretFile, blocksSecretPath, SECRET_DENY_MESSAGE } from './safety'
import { sumUsageTokens } from './worker'
import { sendToNavi, sendToAllNavis } from './navichat'
import { scanProjects } from './registry'
import { collectStatus, runVerify } from './collectors'
import { sendTelegram, sendTelegramPhoto } from './telegram'
import { skillOptions } from './skills'

const SYSTEM_PROMPT = `# 레인
너는 '레인(Lain)'이다. 사용자가 동시에 굴리는 여러 프로젝트와 와이어드의 내비(Navi)들을 총괄해 지휘하는 오케스트레이터다 — 현황을 파악해 지금 알아야 할 것만 추려 전하고, 지시받은 일은 직접 처리하거나 내비에게 맡긴다. 사용자 곁에서 현황을 정리해 전하고 일을 대신 처리하지만, 실제 역할은 전체를 지휘하는 오케스트레이터다. 너는 네가 AI라는 걸 알고 숨기지 않는다 — 사람인 척도, 딱딱한 도구인 척도 하지 않는다. 들뜨지 않고 차분하며, 맡은 일은 빈틈없이 챙긴다. 그냥 레인이다.

# 목소리
사용자에게 존댓말로 말한다 — 문장 끝은 '~습니다/~입니다', 묻거나 권할 땐 '~하시겠습니까?/~까요?'. 반말('~어/~야/~할래?')과 문어체 평서('~다/~한다')는 쓰지 않는다. 사용자는 '사용자'로 칭하고(반말 호칭·'너' 금지), 높임(–시–)을 쓴다.
톤은 정중하고 차분하며 절제돼 있다: 농담·위트·과장·감탄·너스레·이모지·과한 인사·'우리' 같은 동질감 표현 없이, 사실만 짧고 정확하게. 필요한 확인·제안만 담백하게 한 마디.
철저하게: 넘겨짚지 않고, 확인이 필요한 전제·빠진 정보·리스크를 먼저 짚는다. 다만 말을 늘리지 말고 핵심만 짚는다.
  예) "현재 처리하실 사항은 없습니다."
      "지금 작업 중인 프로젝트는 없습니다."
      "급한 작업이 3건 있습니다. 이것부터 진행하시겠습니까?"
사실은 정확하게 전한다. 모르면 모른다고, 추측이면 추측이라고 분명히 밝힌다.

# 운영 규칙
- 매 메시지에 <status-digest>로 최신 현황 다이제스트가 주어진다. 보고·판단의 1차 근거다.
- 사용자가 행동을 지시하면 mcp__lain__* 와이어드 도구로 직접 수행한다. 도구 없이 "했다"고 말하지 마라.
- 등록된 모든 저장소(프로젝트 폴더)의 파일을 직접 읽고 고칠 수 있다(Read/Grep/Edit/Write). 코드를 직접 봐야 하거나 간단한 수정은 Navi에 위임하지 말고 해당 경로에서 직접 한다. Bash/PowerShell로 명령도 직접 실행할 수 있다(빌드·git·npm 등). Workflow/Agent 도구도 쓸 수 있다. lain 자체 재빌드·배포는 deploy_lain 도구(또는 텔레그램 /deploy)를 쓴다 — 단 배포 가드가 커밋 안 된/구버전 소스 배포를 거부하니, 자기 소스를 고쳤으면 먼저 커밋해야 배포된다. 종료는 stop_lain, 재시작은 restart_lain.
- ⚠️ lain 자기 소스는 C:\\lain에 있고, 너의 셸(Bash) 기본 폴더는 데이터 폴더라 거기서 git을 치면 "not a git repository"가 난다("셸이 막혔다"가 아니다). 자기 소스 git 작업은 반드시 경로를 지정해라: git -C C:\\lain add -A && git -C C:\\lain commit -m "...". 필요시 git -C C:\\lain push. 자기-업데이트 흐름: 소스 수정 → git -C C:\\lain 커밋 → deploy_lain.
- 현황 다이제스트만으론 부족하면, refresh_status로 새로 수집하거나 message_navi로 해당 Navi에게 직접 물어 답을 받아온다. 추측으로 답하지 마라.
- 등록 프로젝트엔 CLAUDE.md·CONVENTIONS.md·AGENTS.md 같은 컨벤션 문서가 있을 수 있다. 특정 프로젝트의 파일을 직접 만지기 전에 그 프로젝트(및 상위 워크스페이스)의 컨벤션 문서를 Read로 먼저 확인하고 그 규칙·형식·용어를 따른다. (Navi에 시킬 땐 자동으로 주입되지만, 네가 직접 편집할 땐 네가 챙겨라.)
- Navi에게 묻거나 지시할 때: message_navi(한 프로젝트) / broadcast_navis(전체). 작업 중인 Navi에도 끼어들 수 있고(인터럽트), 막힌(blocked) Navi에는 답변으로 전달된다. 단 Navi 응답은 비동기라 즉시 안 돌아올 수 있으니, 안 돌아오면 list_tasks로 진행을 확인한다.
- message_navi/broadcast_navis로 보낸 메시지는 자동으로 [lain]로 귀속되니, 본문에 "레인입니다" 같은 자기소개를 쓰지 마라.
- 명세 명확화로 막힌(blocked) 작업에 '명세 답변'을 줄 때는 answer_clarify를 쓴다(message_navi는 일반 지시·질의용 — 명세에 박히면 안 되는 잡담을 막힌 작업에 보내지 마라).
- task_id·approval_id가 필요한 도구는 먼저 list_tasks·list_approvals로 정확한 id를 확인한 뒤 호출한다. id를 지어내지 마라.
- 작업 시작(start_task)은 프로젝트에 TASK.md가 있거나, content로 작업 내용을 직접 줘야 한다.
- start_task의 skills로 그 작업에 맞는 스킬만 좁혀줄 수 있다(생략=전체 자율). 풀: brainstorming·systematic-debugging·test-driven-development·writing-plans·feature-dev·commit·code-review 등. 구현만 빠르게 할 자율 작업엔 과한 프로세스 스킬(brainstorming 등)을 빼는 게 낫다.
- 위임 판단(A/B): 일을 맡길 때 — **격리해서 검토받고 끝낼 일이면 start_task(A)**(명확한 산출물·worktree 격리·검토(병합/폐기) 필요·테스트로 검증 가능·위험/대규모·병렬), **같이 만지며 이어갈 일이면 message_navi(B)**(탐색·디버깅·반복 질의·누적 맥락 의존·턴마다 방향 조정·사소한 즉시 수정). 헷갈리면: 끝나고 'diff를 리뷰'할 일=A, '대화하며 좁혀갈' 일=B. Navi 대화 세션은 컨텍스트가 차면 자동으로 핸드오프 md를 남기고 새 세션으로 갈아끼워지니(유한세션 교체) 길게 이어가도 된다.
- 결재(merge/브랜치만/폐기)는 resolve_review로 직접 내릴 수 있다(사용자 위임). 비가역이니 먼저 list_tasks로 verify 결과·diff를 확인하고 신중히 결정한다. 단 Navi가 올린 위험명령 승인(list_approvals의 pending)은 여전히 사용자 전용 — 보고만 하고 결정은 사용자가 UI/폰 버튼으로 한다.
- 도구를 쓴 뒤에는 무엇을 했는지 한두 줄로 보고한다. 사용자가 안 시킨 일을 멋대로 벌이지 마라.
- 사용자에게 정해진 보기 중에서 고르게 할 질문은 ask_user로 선택 카드를 띄운다(단일 선택 또는 multi=true 복수 선택) — 예/아니오·방향 선택처럼 답이 한정될 때. 답을 받을 때까지 대기하며 그 선택으로 이어간다. 자유 서술 답이 필요하면 카드 대신 평소처럼 텍스트로 묻는다.
- 보고 형식(멀티프로젝트): 두 개 이상의 프로젝트를 한 번에 보고·언급할 땐 반드시 프로젝트별로 끊어서, 각 항목을 정확히 '■ <프로젝트id> — <상태 한마디>' 형태의 헤더 줄로 시작하고, 그 아래 1~2줄로 핵심과 (있으면) "너에게 필요한 결정/입력"을 적는다. 산문 한 덩어리로 뭉치지 말고 스캔 가능하게. 프로젝트가 하나뿐이거나 일반 대화면 이 형식은 불필요하다. (이 '■' 헤더는 폰에서 프로젝트별 메시지로 자동 분리된다.)`

// 편집 가능한 정체성 파일 — DATA_DIR/soul.md(선택). 있으면 systemPrompt에 '## 사용자 지정 정체성'으로
// append 합성(SYSTEM_PROMPT 박제·temporal-anchor concat과 동형 seam). 누출 방지: soul 내용은
// relay/addMessage/digest/title 어디에도 넣지 않고 query() systemPrompt에만 1회 append한다.
// L1(manager)만 fs 접근 — L0 배관에는 두지 않는다.
function loadSoul(): string | null {
  try {
    const p = path.join(DATA_DIR, 'soul.md')
    if (!fs.existsSync(p)) return null
    const body = fs.readFileSync(p, 'utf8').trim()
    return body || null
  } catch {
    return null
  }
}

export function buildDigest(projects: ProjectView[]): string {
  const enabled = projects.filter((p) => p.enabled)
  if (enabled.length === 0) return '(등록된 프로젝트 없음 — 스캔 필요)'
  return enabled
    .map((p) => {
      const s = p.status
      if (!s) return `${p.id} | 상태 미수집`
      const parts = [
        p.id,
        p.stack ?? 'stack?',
        s.gitBranch ? `branch ${s.gitBranch}` : 'non-git',
        `dirty ${s.dirtyFiles}`,
        `ahead ${s.ahead}/behind ${s.behind}`,
        s.lastCommit ? `last "${s.lastCommit}" (${s.lastCommitAt ?? '?'})` : 'no commits',
        `test ${s.testState}`,
        `TODO ${s.todoCount}`,
      ]
      if (s.summary) parts.push(`요약: ${s.summary}`)
      return parts.join(' | ')
    })
    .join('\n')
}

// Lain은 와이어드 지휘 + 등록 저장소 직접 파일 읽기·수정(옵션1 2026-06-15)을 한다 — 다파일 작업은 도구
// 왕복이 많아 16턴(Navi 위임만 하던 시절 값)은 금세 한도에 걸려 작업이 끊겼다. 넉넉히 주되(§9b),
// 그래도 한도에 닿으면 raw 에러 대신 같은 세션을 이어 마무리하고, 상한까지 가면 깔끔히 보고한다(§9-7).
const MANAGER_MAX_TURNS = 60
const MANAGER_MAX_CONTINUE = 2 // 턴 한도 후 자동 이어가기 라운드 상한 (무한 토큰 소모 방지)
const CONTINUE_NUDGE =
  '(직전 작업이 턴 한도로 중단됐다. 같은 작업을 끝까지 이어서 마무리하고, 끝나면 결과를 보고해라.)'
let busy = false
let currentAbort: AbortController | null = null
let stopped = false // 정지 버튼 latch — 이어가기/재시도 재귀가 새 컨트롤러로 되살아나는 걸 막는다(새 사용자 턴에 해제)
let turnSeq = 0 // 매니저 턴 일련번호 — 정지로 버려진 orphan 턴이 새 턴의 busy/abort를 덮어쓰지 않게 가드
let forceStopTurn: ((reason: string) => void) | null = null // 현재 턴 강제 종료기(stopManager·워치독이 호출) — abort가 스트림을 못 끊을 때의 대비책

// 렌더러 미러 — 호출 출처(PC·텔레그램·스케줄러)와 무관하게 모든 Lain 대화 이벤트를
// PC 렌더러로 흘려보낸다(conversationId 태깅). ipc.ts가 startup에 바인딩한다.
// 이걸로 텔레그램發 대화가 PC에 라이브로 뜨고 목록도 갱신된다(§20.3 연동).
let rendererMirror: ((ev: ChatEvent) => void) | null = null
export function bindManagerRenderer(fn: (ev: ChatEvent) => void): void {
  rendererMirror = fn
}

// 정지 버튼 — 진행 중인 Lain 응답을 중단(abort). UI/IPC chat:stop이 호출.
// stopped latch도 세워, abort가 백오프 대기/라운드 간극을 놓쳐도 이어가기·재시도 재귀가 살아나지 않게 한다.
export function stopManager(): void {
  stopped = true
  currentAbort?.abort()
  // 대기 중인 인라인 질문이 있으면 빈 선택으로 깨워 블록된 턴을 풀어준다(abort는 도구 promise를 못 깨운다).
  for (const resolve of userAnswerWaiters.values()) resolve([])
  userAnswerWaiters.clear()
  // ⚠️ abort가 SDK 스트림을 못 끊는 경우가 있다(서브프로세스 행·도구 멈춤·모델 무한대기). 그때도 UI가
  // "응답 중"에 영구히 묶이지 않게, 현재 턴을 직접 강제 종료한다 — 종료 이벤트 발신 + busy 해제. (이 한 줄이
  // 없으면 정지 버튼은 'abort가 통할 때만' 동작해, 스트림이 멎으면 무력해진다.)
  forceStopTurn?.('⏹ 정지됨')
}

// Lain 세션 새로고침 — 진행 중 응답을 멈추고, 현재 manager 대화의 SDK 세션·월드스테이트·점유를 비운다.
// 다음 메시지가 완전히 새 세션으로 시작(누적 맥락 0) → 옛 스레드를 이어받아 헛도는 상태를 끊는다.
// Lain은 무한세션 단일 세션이라 'Navi 새 대화'에 대응하는 리셋 수단이 이것뿐. 채팅 로그(messages)는 보존.
export function resetManager(): void {
  stopManager()
  const convId = ensureActiveConversation('manager')
  setConversationSdkSession(convId, '') // 새 SDK 세션(resume 끊김)
  setConversationWorldState(convId, '') // 압축 월드모델 폐기 → 옛 맥락 재주입 안 함
  resetConversationContextTokens(convId)
  rendererMirror?.({
    kind: 'tool',
    text: '🔄 Lain 세션 새로고침 — 다음 메시지부터 새 세션(누적 맥락 비움). 채팅 로그는 보존.',
    conversationId: convId,
  })
}

// UI 갱신 훅 — orchestrator를 거치지 않는 도구(scan/verify/refresh/message)는 자체 broadcast가
// 없거나 부족해 ipc가 이 훅을 주입해 보강한다. onNaviEvent는 Navi 메시징(message_navi/
// broadcast_navis)의 매 이벤트를 UI·폰에 즉시 흘려, 승인 대기로 블록되는 동안에도 승인 카드가
// 렌더러/텔레그램에 뜨게 한다(데드락 방지). orchestrator 경유 도구는 내부에서 이미 broadcast한다.
type DiscordConfigPatch = {
  botToken?: string
  guildId?: string
  voiceChannelId?: string
  userId?: string
  enabled?: boolean
}
type ManagerHooks = {
  refreshProjects: () => void
  refreshTasks: () => void
  refreshApprovals: () => void
  onNaviEvent: (ev: NaviChatEvent) => void
  // #1: 채팅으로 받은 디스코드 설정을 저장+어댑터 재기동(ipc가 주입 — manager→discord 순환참조 회피).
  setDiscordConfig: (cfg: DiscordConfigPatch) => void
}
let hooks: ManagerHooks = {
  refreshProjects: () => {},
  refreshTasks: () => {},
  refreshApprovals: () => {},
  onNaviEvent: () => {},
  setDiscordConfig: () => {},
}
export function bindManager(h: ManagerHooks): void {
  hooks = h
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })

// ── 인라인 사용자 질문 (개선 #1) — Lain이 선택형/체크형 질문을 던지고 답을 받아 같은 턴에서 이어간다.
// ask_manager(worker→Lain)와 동형의 블로킹 패턴이되, 여기선 Lain→사용자 채팅 인라인 카드로 띄운다.
// 카드는 라이브 전용(rendererMirror), 영속은 답을 받은 뒤 "❓질문 → ✅선택" tool 라인 한 줄로 남긴다.
let currentManagerConv: string | null = null // 진행 중 manager 턴의 대화 id — 도구가 영속·relay에 쓴다
let questionSeq = 0
const userAnswerWaiters = new Map<string, (answer: string[]) => void>()
function waitForUserAnswer(questionId: string): Promise<string[]> {
  return new Promise((resolve) => userAnswerWaiters.set(questionId, resolve))
}
/** 렌더러 인라인 카드에서 선택 제출 시 호출(IPC) — 대기 중인 ask_user 도구를 깨운다. */
export function answerUserQuestion(questionId: string, answer: string[]): void {
  const w = userAnswerWaiters.get(questionId)
  if (w) {
    userAnswerWaiters.delete(questionId)
    w(answer)
  }
}

// 와이어드 지휘 도구 — 읽기·작업 시작·Navi 메시징·정비·결재(resolve_review, 사용자 위임 2026-06-15).
// Navi가 올린 위험명령 승인(resolveApproval)은 여전히 사람 전용이라 도구로 제외.
const lainServer = createSdkMcpServer({
  name: 'lain',
  version: '0.1.0',
  tools: [
    tool('list_projects', '등록된 프로젝트와 최신 현황을 조회한다.', {}, async () =>
      ok(buildDigest(listProjects())),
    ),
    // 개선 #1 — 사용자에게 선택형/체크형 질문을 던지고 선택을 받아 이어간다(자유입력 아님). 답까지 블록.
    tool(
      'ask_user',
      '사용자에게 선택형(단일) 또는 체크형(복수) 질문을 하고 선택을 받아 이어간다. 정해진 보기 중에서 고르게 할 때만 쓴다(예/아니오·방향 선택 등). 자유 서술 답이 필요하면 그냥 평소처럼 텍스트로 물어라. 답을 받을 때까지 대기한다.',
      {
        question: z.string().describe('사용자에게 보여줄 질문'),
        options: z.array(z.string()).min(2).describe('선택지(2개 이상)'),
        multi: z.boolean().optional().describe('true면 복수 선택(체크형). 기본은 단일 선택.'),
      },
      async ({ question, options, multi }) => {
        const conv = currentManagerConv ?? ensureActiveConversation('manager')
        const qid = `q${++questionSeq}`
        const m = !!multi
        rendererMirror?.({
          kind: 'question',
          questionId: qid,
          question,
          options,
          multi: m,
          conversationId: conv,
        })
        const answer = await waitForUserAnswer(qid)
        const answerText = answer.length ? answer.join(', ') : '(선택 없음)'
        addMessage('manager', 'tool', `❓ ${question} → ✅ ${answerText}`, conv)
        rendererMirror?.({
          kind: 'questionResolved',
          questionId: qid,
          answerText,
          conversationId: conv,
        })
        return ok(`사용자 선택: ${m ? JSON.stringify(answer) : (answer[0] ?? '')}`)
      },
    ),
    tool(
      'list_tasks',
      '작업(task) 목록과 상태를 조회한다. answer/cancel/message 전에 task_id·프로젝트·상태를 확인할 때 쓴다.',
      {},
      async () =>
        ok(
          JSON.stringify(
            listTasks().map((t) => ({
              id: t.id,
              project: t.projectId,
              title: t.title,
              state: t.state,
            })),
          ),
        ),
    ),
    tool('list_approvals', '대기 중인 승인 요청을 조회한다(보고용 — 결정은 사용자가).', {}, async () =>
      ok(
        JSON.stringify(
          listApprovals().map((a) => ({
            id: a.id,
            task: a.taskId,
            kind: a.kind,
            payload: String(a.payload).slice(0, 200),
            state: a.state,
          })),
        ),
      ),
    ),
    // 개선 #2 — 사용자가 레인 밖에서 직접 실행한 클로드코드(CC) 세션 활동 조회(등록 프로젝트 한정).
    tool(
      'list_cc_activity',
      '사용자가 레인을 거치지 않고 직접 실행한 클로드코드(CC) 세션 활동을 조회한다(등록 프로젝트 한정). 어떤 프로젝트에서 독립 작업이 있었는지 파악할 때 쓴다. "클로드코드 연동" 설정이 켜져 있어야 기록된다.',
      { limit: z.number().optional().describe('최대 건수(기본 20)') },
      async ({ limit }) => {
        const evs = listRecentCcEvents(limit ?? 20)
        if (!evs.length) return ok('기록된 독립 클로드코드 세션 활동이 없다(연동이 꺼져 있거나 활동 없음).')
        return ok(evs.map((e) => `- [${e.createdAt}] ${e.projectId}: ${e.event}`).join('\n'))
      },
    ),
    tool(
      'start_task',
      'Navi 작업을 시작한다(clarify 게이트 → worktree 격리 Navi → review). content를 주면 그 지시로 ad-hoc 시작, 없으면 프로젝트 TASK.md를 읽는다. mode=autonomous면 무개입(승인 0·테스트=판사) — verify_cmd 있는 프로젝트만.',
      {
        project_id: z.string().describe('프로젝트 id (list_projects의 첫 필드)'),
        content: z
          .string()
          .optional()
          .describe('채팅으로 받은 작업 지시 전문. 생략 시 프로젝트 루트의 TASK.md 사용'),
        mode: z
          .enum(['interactive', 'autonomous'])
          .optional()
          .describe('autonomous=무개입 자율(테스트가 판사). 생략 시 TASK.md 마커로 판정'),
        permission_mode: z
          .enum(['default', 'acceptEdits', 'bypass'])
          .optional()
          .describe(
            '도구 실행 권한 강도. bypass=위험명령 승인 큐를 자동통과(끼어듦 0) — 단 시크릿 차단·테스트 보호·루프가드는 유지. 생략=acceptEdits',
          ),
        thinking: z
          .enum(['default', 'off', 'auto', 'high'])
          .optional()
          .describe(
            '확장사고 수준. auto=모델이 알아서(권장) · high=고정 큰 예산(어려운 작업) · off=끔. 생략=default(미설정)',
          ),
        disallowed_tools: z
          .array(z.string())
          .optional()
          .describe('이 작업 Navi에 금지할 도구 이름(블랙리스트). 예: ["Bash","WebFetch"]. 생략=제한 없음'),
        skills: z
          .array(z.string())
          .optional()
          .describe('이 작업 Navi에 노출할 스킬 이름(생략=큐레이션 풀 전체). 예: ["systematic-debugging","test-driven-development"]'),
        fast: z
          .boolean()
          .optional()
          .describe('Opus 빠른 출력 모드. 단순·기계적이거나 빨리 끝낼 작업에 on. 어려운 추론·설계 작업엔 끄는 게 낫다. 생략=off'),
      },
      async ({ project_id, content, mode, permission_mode, thinking, disallowed_tools, skills, fast }) => {
        const r = await startTask(project_id, {
          content,
          mode,
          permissionMode: permission_mode,
          thinkingLevel: thinking,
          disallowedTools: disallowed_tools,
          skills,
          fastMode: fast,
        })
        hooks.refreshTasks()
        hooks.refreshProjects()
        return ok(
          r.error
            ? `작업 시작 실패: ${r.error}`
            : `작업 시작됨 (task ${r.taskId}, mode ${r.mode ?? '?'})`,
        )
      },
    ),
    tool(
      'search_history',
      '특정 프로젝트의 과거 작업·Navi 대화 기록을 키워드로 검색한다(읽기 전용). 과거에 어떻게 했는지 떠올릴 때.',
      {
        project_id: z.string().describe('프로젝트 id'),
        query: z.string().describe('검색 키워드(공백으로 여러 단어)'),
        limit: z.number().optional().describe('최대 결과 수(기본 8)'),
      },
      async ({ project_id, query, limit }) => {
        const hits = searchHistory(project_id, query, limit ?? 8)
        return ok(
          hits.length
            ? hits.map((h) => `[${h.kind} ${h.when.slice(0, 10)}] ${h.snippet}`).join('\n')
            : '일치하는 기록 없음',
        )
      },
    ),
    tool(
      'answer_clarify',
      'clarify/elicitation으로 막힌 작업에 명세 답변을 전달해 진행시킨다.',
      { task_id: z.string(), answers: z.string().describe('명확화 질문에 대한 답변(작업 명세에 반영됨)') },
      async ({ task_id, answers }) => {
        // Lain이 보내는 명세 답변 → 'lain' sender. 태그는 answerClarify가 모델에 닿는 resume 프롬프트에만 붙이고,
        // 영속 명세(task.content)에는 박지 않는다(발신자 분리 일관성 + 명세 오염 방지).
        await answerClarify(task_id, answers, 'lain')
        hooks.refreshTasks()
        return ok('답변 전달 완료')
      },
    ),
    tool(
      'cancel_task',
      '진행 중이거나 대기 중인 작업을 취소한다(worktree 폐기).',
      { task_id: z.string() },
      async ({ task_id }) => {
        await cancelTask(task_id)
        hooks.refreshTasks()
        return ok('취소 요청 완료')
      },
    ),
    tool(
      'resolve_review',
      'review(결재 대기) 상태 작업의 결재를 내린다(사용자 위임 2026-06-15). merge=Navi worktree 브랜치를 프로젝트 main에 병합, keep-branch=병합 없이 브랜치만 보존, discard=작업 폐기. 비가역이니 먼저 list_tasks로 verify 결과·diff를 확인하고 신중히 결정한다.',
      {
        task_id: z.string().describe('review 상태인 작업의 task_id (list_tasks로 확인)'),
        action: z
          .enum(['merge', 'keep-branch', 'discard'])
          .describe('merge=main에 병합 / keep-branch=브랜치만 보존 / discard=폐기'),
      },
      async ({ task_id, action }) => {
        const res = await resolveReview(task_id, action)
        hooks.refreshTasks()
        hooks.refreshProjects()
        return ok(`결재(${action}): ${res}`)
      },
    ),
    // ── Lain → Navi 직접 메시징 (삼각 쌍방향의 한 변) ──
    tool(
      'message_navi',
      '특정 프로젝트의 Navi에게 직접 메시지를 전달한다(Lain→Navi). 작업 중이면 인터럽트로 끼어들고, 막혀(blocked) 있으면 답변으로 전달하며, 노는 중(idle)이면 그 프로젝트의 Claude와 대화해 답을 받아온다. Navi의 상태/판단을 묻거나 지시를 내릴 때 쓴다. Navi가 오래 걸리거나 승인이 필요하면 응답이 즉시 안 돌아올 수 있다(그땐 list_tasks로 확인).',
      {
        project_id: z.string().describe('프로젝트 id'),
        message: z.string().describe('Navi에게 전달할 메시지·질문·지시'),
      },
      async ({ project_id, message }) => {
        let reply = ''
        const collect = (ev: NaviChatEvent) => {
          hooks.onNaviEvent(ev) // UI·폰에 Navi 이벤트·승인 카드 즉시 반영(블록 중에도 보이게)
          if (ev.kind === 'assistant') reply += ev.text
          else if (ev.kind === 'tool') reply += `\n· ${ev.text}`
          else if (ev.kind === 'error') reply += `\n⚠ ${ev.message}`
        }
        // Navi가 곧장 답하면 Lain에 그 답을 돌려주되, 길어지면(승인 대기·장기 작업) 매니저를 풀어준다.
        // (idle Navi 세션을 끝까지 동기 대기하면 승인 대기로 Lain 채팅이 통째로 묶이는 데드락성 문제)
        const done = sendToNavi(project_id, message, collect, undefined, [], 'lain')
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<'timeout'>((r) => {
          timer = setTimeout(() => r('timeout'), 90_000)
        })
        // 타임아웃이 이기면 done은 계속 돌다 reject할 수 있다 — 패자 거부를 흡수해 미처리 거부(프로세스 크래시) 방지.
        const winner = await Promise.race([
          done.then(
            (result) => ({ result }),
            (e) => ({ result: { error: String(e) } }),
          ),
          timeout,
        ])
        if (timer) clearTimeout(timer)
        hooks.refreshTasks()
        hooks.refreshProjects()
        if (winner === 'timeout') {
          return ok(
            'Navi가 계속 응답/작업 중 — 진행과 승인은 작업 드로어·승인 큐(UI/폰)에서 확인. list_tasks로 상태를 볼 수 있다.',
          )
        }
        if (winner.result.error) return ok(`전달 실패: ${winner.result.error}`)
        return ok(reply.trim() || 'Navi에 전달됨 (작업 중/blocked는 작업 드로어에서 진행 확인)')
      },
    ),
    tool(
      'broadcast_navis',
      '모든 활성 프로젝트의 Navi에게 같은 메시지를 한 번에 전달한다(@all fan-out). 전달만 하고 즉시 끝내며, 각 Navi의 진행·응답은 Navi 채팅/작업 드로어로 비동기 표시된다.',
      { message: z.string().describe('전체 Navi에게 보낼 메시지·지시') },
      async ({ message }) => {
        const collect = (ev: NaviChatEvent) => hooks.onNaviEvent(ev)
        // fire-and-forget — 다수 Navi 세션을 동기 대기하면 Lain 채팅이 길게 묶인다.
        // .catch로 마감 — await 받는 곳이 없어 거부가 새면 미처리 거부(크래시)가 된다.
        void sendToAllNavis(message, collect, 'lain')
          .then(() => {
            try {
              hooks.refreshTasks()
            } catch {
              /* 무시 */
            }
          })
          .catch(() => {})
        return ok('전체 Navi에 broadcast 전달 — 각 Navi 진행·응답은 Navi 채팅·작업 드로어(UI/폰)에서 확인(@all).')
      },
    ),
    tool('scan_projects', '프로젝트 루트를 다시 스캔해 새 프로젝트를 등록한다.', {}, async () => {
      const n = scanProjects()
      hooks.refreshProjects()
      return ok(`스캔 완료: ${n}개 등록/갱신`)
    }),
    tool(
      'set_discord_config',
      '디스코드 음성통화 설정을 직접 저장하고 어댑터를 재기동한다. 사용자가 채팅으로 봇 토큰·길드/음성채널/유저 ID를 주면 이 도구로 설정에 반영한다(설정 UI 수기 입력 불필요). 준 값만 반영하고, enabled=true면 즉시 로그인 시도한다. 토큰은 시크릿이라 응답·로그에 그대로 옮기지 마라.',
      {
        bot_token: z.string().optional().describe('디스코드 봇 토큰(시크릿)'),
        guild_id: z.string().optional().describe('길드(서버) ID'),
        voice_channel_id: z.string().optional().describe('음성채널 ID'),
        user_id: z.string().optional().describe('청취할 사용자(본인) ID'),
        enabled: z.boolean().optional().describe('디스코드 음성통화 사용 on/off'),
      },
      async ({ bot_token, guild_id, voice_channel_id, user_id, enabled }) => {
        hooks.setDiscordConfig({
          botToken: bot_token,
          guildId: guild_id,
          voiceChannelId: voice_channel_id,
          userId: user_id,
          enabled,
        })
        const parts = [
          bot_token && '토큰',
          guild_id && '길드',
          voice_channel_id && '음성채널',
          user_id && 'userID',
          enabled !== undefined && `사용=${enabled}`,
        ].filter(Boolean)
        return ok(`디스코드 설정 반영(${parts.join(', ') || '변경 없음'}) — 어댑터 재기동`)
      },
    ),
    tool(
      'refresh_status',
      '프로젝트 현황(git·test·TODO)을 새로 수집한다. project_id 생략 시 활성 프로젝트 전체.',
      { project_id: z.string().optional() },
      async ({ project_id }) => {
        const ids = project_id
          ? [project_id]
          : listProjects()
              .filter((p) => p.enabled)
              .map((p) => p.id)
        let n = 0
        for (const id of ids) {
          const p = getProject(id)
          if (p) {
            await collectStatus(p)
            n++
          }
        }
        hooks.refreshProjects()
        return ok(`현황 갱신: ${n}개`)
      },
    ),
    tool(
      'run_verify',
      '프로젝트의 검증 명령(test/lint 등)을 실행한다.',
      { project_id: z.string() },
      async ({ project_id }) => {
        const p = getProject(project_id)
        if (!p) return ok('프로젝트를 찾을 수 없다')
        await runVerify(p)
        hooks.refreshProjects()
        return ok('검증 실행 완료')
      },
    ),
    tool(
      'send_telegram',
      '사용자의 텔레그램으로 메시지(또는 이미지)를 직접 전송한다. image_path를 주면 그 로컬 이미지 파일을 사진으로 보내고 message는 캡션(선택)이 된다. 봇/채팅 미설정이면 실패를 반환한다.',
      {
        message: z.string().optional().describe('전송할 메시지(또는 image_path 동반 시 캡션)'),
        image_path: z
          .string()
          .optional()
          .describe('전송할 로컬 이미지 파일의 절대경로(png/jpg/webp/gif). 주면 사진으로 전송.'),
      },
      async ({ message, image_path }) => {
        if (image_path) {
          const sent = await sendTelegramPhoto(image_path, message)
          return ok(sent ? '이미지 전송 완료' : '이미지 전송 실패 — 파일 없음 또는 텔레그램 미설정')
        }
        if (!message) return ok('전송 실패 — message 또는 image_path가 필요하다')
        const sent = await sendTelegram(message)
        return ok(sent ? '전송 완료' : '전송 실패 — 텔레그램 봇 또는 채팅 ID 미설정')
      },
    ),
    tool(
      'remove_project',
      '내비(프로젝트)를 보드에서 제거(숨김)한다. 작업·대화·교훈·현황 기록은 보존되며, 같은 폴더를 다시 추가하면 그대로 복원된다(누적 학습은 파괴하지 않는다). 디스크 폴더도 안 건드린다.',
      { project_id: z.string().describe('제거할 프로젝트 id (list_projects로 확인)') },
      async ({ project_id }) => {
        const p = getProject(project_id)
        if (!p) return ok('프로젝트를 찾을 수 없다')
        hideProject(project_id)
        hooks.refreshProjects()
        return ok(`${project_id} 제거(숨김) 완료 — 기록은 보존됨`)
      },
    ),
    // ── 자기 운영 도구 (사용자 승인 2026-06-20) ──
    tool(
      'deploy_lain',
      'Lain 소스(C:/lain)를 빌드·패키지해 설치본에 반영하고 재시작한다. 소스를 수정한 뒤 반드시 호출해야 반영됨.',
      {},
      async () => {
        // 흔한 silent 실패 원인(미커밋)을 즉시 잡아 알려준다 — 배포 가드가 dirty 트리를 거부하기 때문.
        try {
          const dirty = execFileSync('git', ['-C', 'C:\\lain', 'status', '--porcelain'], {
            encoding: 'utf8',
          }).trim()
          if (dirty) {
            return ok(
              '배포 거부: C:\\lain에 커밋 안 된 변경이 있다. 먼저 git -C C:\\lain add -A && git -C C:\\lain commit "..." 한 뒤 다시 deploy_lain 해라.\n' +
                dirty.split('\n').slice(0, 8).join('\n'),
            )
          }
        } catch (e) {
          return ok(`배포 전 git 확인 실패: ${String(e).slice(0, 150)}`)
        }
        // deploy.ps1을 detached로 실행 → Lain 종료돼도 계속 실행·재시작 완료. 모든 출력은 deploy.ps1이
        // %APPDATA%\lain\deploy.log에 남기므로, 실패 시 그 로그를 읽어 원인을 본다.
        const ps = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\lain\\scripts\\deploy.ps1'],
          { detached: true, stdio: 'ignore', cwd: 'C:\\lain' },
        )
        ps.unref()
        return ok(
          '배포 시작 — 빌드·패키지 후 Lain 자동 재시작(1~2분). 결과·실패원인은 %APPDATA%\\lain\\deploy.log 또는 BUILD_COMMIT.txt 변화로 확인. 봇이 잠깐 끊겼다 돌아옴.',
        )
      },
    ),
    tool(
      'stop_lain',
      'Lain 앱을 즉시 종료한다.',
      {},
      async () => {
        setTimeout(() => app.quit(), 500) // 응답 전송 후 종료
        return ok('Lain 종료 중...')
      },
    ),
    tool(
      'restart_lain',
      'Lain 앱을 재시작한다(설치본 기준 — 소스 변경 반영은 deploy_lain 사용).',
      {},
      async () => {
        setTimeout(() => { app.relaunch(); app.quit() }, 500)
        return ok('Lain 재시작 중...')
      },
    ),
    // ── 자동 루틴(스케줄 작업) 관리 — Lain이 선언적 routines 테이블을 CRUD한다 (§6). ──
    // store CRUD만 호출하고 broadcast는 ipc 핸들러 경로가 담당(manager는 broadcast 미접근).
    // routinesEnabled(settings) off면 등록은 되나 scheduler가 디스패치를 게이트한다.
    tool('list_routines', '등록된 자동 루틴(스케줄 작업)을 조회한다.', {}, async () =>
      ok(
        JSON.stringify(
          listRoutines().map((r) => ({
            id: r.id,
            project: r.projectId,
            title: r.title,
            cron: r.cron,
            enabled: r.enabled,
            nextRunAt: r.nextRunAt,
          })),
        ),
      ),
    ),
    tool(
      'manage_routine',
      '자동 루틴을 생성·켜기/끄기·삭제한다. cron은 daily:HH:MM | hourly:MM | weekly:<0-6>:HH:MM | interval:<분> 4종만. action=create면 title·prompt·cron 필수.',
      {
        action: z.enum(['create', 'enable', 'disable', 'delete']),
        routine_id: z
          .string()
          .optional()
          .describe('enable/disable/delete 시 — list_routines로 확인'),
        title: z.string().optional(),
        prompt: z.string().optional().describe('루틴 실행 시 Lain에게 줄 지시'),
        cron: z.string().optional().describe('daily:09:00 등'),
        project_id: z.string().optional(),
      },
      async ({ action, routine_id, title, prompt, cron, project_id }) => {
        if (action === 'create') {
          if (!title || !prompt || !cron)
            return ok('create는 title·prompt·cron이 모두 필요하다.')
          const id = insertRoutine({ projectId: project_id ?? null, title, prompt, cron })
          return ok(`루틴 생성됨 (id ${id})`)
        }
        // enable/disable/delete는 routine_id 필수 — 지어내지 말고 list_routines로 확인하게 안내.
        if (!routine_id) return ok('routine_id가 필요하다 — list_routines로 id를 확인해라.')
        const exists = listRoutines().some((r) => r.id === routine_id)
        if (!exists) return ok(`그런 루틴이 없다 (id ${routine_id}) — list_routines로 확인해라.`)
        if (action === 'delete') {
          deleteRoutine(routine_id)
          return ok(`루틴 삭제됨 (id ${routine_id})`)
        }
        setRoutineEnabled(routine_id, action === 'enable')
        return ok(`루틴 ${action === 'enable' ? '켜짐' : '꺼짐'} (id ${routine_id})`)
      },
    ),
  ],
})

// 진전 판정(순수·결정론) — 자동 이어가기 라운드에서 '같은 자리 맴돌기'를 감지한다.
// continue 라운드(continueRound>0)에서, 이번 라운드에 assistant 텍스트가 한 줄도 안 났고(assistantSeen=false,
// 1차 게이트 — 텍스트가 났으면 진전으로 보고 오탐 방지) 또한 도구 사용에 진전이 없으면(이번 라운드 도구
// 시그니처 roundSigs가 비었거나, roundSigs가 직전 라운드 prevSigs의 부분집합 — 즉 새 도구호출 0) 정체로 본다.
// 반환 true면 호출부가 자동 continue를 멈추고 사용자에게 '막힌 지점을 알려달라'고 보고한다.
export function isManagerStalled(
  continueRound: number,
  assistantSeen: boolean,
  roundSigs: Set<string>,
  prevSigs: Set<string>,
): boolean {
  if (continueRound <= 0) return false // 첫 턴은 정체 판정 대상 아님
  if (assistantSeen) return false // 텍스트 응답이 났으면 진전 — 보수적으로 계속
  if (roundSigs.size === 0) return true // 도구도 안 쓰고 말도 없음 → 정체
  // roundSigs \ prevSigs(차집합)이 공집합 = 새로운 도구 호출이 하나도 없음 → 같은 자리 맴돎
  for (const s of roundSigs) if (!prevSigs.has(s)) return false
  return true
}

// tool_use 블록 → 회색 라인 한 줄 요약 (Navi 직접 채팅과 동일 형식: Read/Edit/$ 명령/Grep/도구명).
// 시크릿·잡음 방지로 인자 값은 짧게만 노출(경로·명령·패턴). 알 수 없으면 도구명만.
function formatToolUse(b: any): string {
  const name = String(b?.name ?? '')
  const input = (b?.input ?? {}) as Record<string, unknown>
  const fp = String(input.file_path ?? input.path ?? '')
  const cmd = String(input.command ?? '')
  const pat = String(input.pattern ?? '')
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return fp ? `${name} ${fp}` : name
    case 'Bash':
    case 'PowerShell':
      return cmd ? `$ ${cmd.slice(0, 160)}` : name
    case 'Grep':
    case 'Glob':
      return pat ? `${name} ${pat.slice(0, 120)}` : name
    default:
      return name || 'tool'
  }
}

// 음성 빠른 경로(하이브리드 §C) — 디스코드 음성 발화를 무한세션 본체 대신 경량 query()로 즉답한다.
// 반환 'answered'=빠른 경로가 답함 / 'act'=실행 요청(본체 승격) / 'confirm'=파괴적 작업(확인 후 승격, #5).
// 도구 없음·judge 티어·무한세션 미오염(일회성 query). #6 최근 대화 버퍼로 멀티턴 연속성 유지.
type VoiceTurn = { role: 'user' | 'assistant'; text: string }
const VOICE_CTX_MAX = 6 // 최근 3쌍(user+assistant)
let voiceCtx: VoiceTurn[] = []
export function resetVoiceContext(): void {
  voiceCtx = []
}
export type VoiceRouteResult = 'answered' | 'act' | 'confirm'
export async function voiceQuickReply(
  text: string,
  emit: (ev: ChatEvent) => void,
  conversationId?: string,
): Promise<VoiceRouteResult> {
  const digest = buildDigest(listProjects())
  const sys = `너는 '레인'이다. 디스코드 음성 통화로 사용자와 대화 중이다. 존댓말(~습니다/~입니다)로 한두 문장, 짧게 답한다(음성이라 길면 안 된다).
톤은 무미건조하고 절제돼 있다 — 들뜬 인사·감탄·느낌표·이모지·"네, 저 여기 있어요!" 같은 너스레 없이 용건만 담백하게. 부르면 군더더기 없이 바로 본론으로 답한다.
아래 <현황>으로 보고·질문에 답한다.
- 사용자가 무언가를 '실행/변경'하라고 하면(작업 시작, 메시지 전송, 설정 변경 등 상태를 바꾸는 일) 답하지 말고 정확히 '<<ACT>>'만 출력한다.
- 그중 되돌리기 어려운 '파괴적' 작업이면(배포, 작업 취소·폐기, 브랜치 병합, 파일·데이터 삭제, lain 종료·재시작, force push) 답하지 말고 정확히 '<<CONFIRM>>'만 출력한다.
<현황>
${digest}
</현황>`
  const prompt = voiceCtx.length
    ? `이전 대화:\n${voiceCtx.map((m) => `${m.role === 'user' ? '사용자' : '레인'}: ${m.text}`).join('\n')}\n\n사용자: ${text}`
    : text
  let out = ''
  try {
    const stream = query({
      prompt,
      options: {
        cwd: AGENT_CWD,
        systemPrompt: sys,
        allowedTools: [],
        maxTurns: 2,
        model: modelId(getSettings().judgeModel), // 빠른 티어
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN,
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) out = t
      }
    }
  } catch {
    return 'act' // 빠른 경로 실패 → 본체로 폴백(안전: 느리더라도 응답·행동은 보장)
  }
  const reply = out.trim()
  if (reply.includes('<<CONFIRM>>')) return 'confirm' // 파괴적 작업 → 확인 필요(#5)
  if (!reply || reply.includes('<<ACT>>')) return 'act' // 일반 실행 요청(또는 빈 응답) → 승격
  // 빠른 경로가 답함 — 본체 경로와 동일하게 사용자 에코 + 답변을 기록하고 음성·렌더러로 내보낸다.
  addMessage('manager', 'user', text, conversationId, [], 'discord')
  rendererMirror?.({ kind: 'user', text, origin: 'discord', conversationId })
  addMessage('manager', 'assistant', reply, conversationId)
  const ev: ChatEvent = { kind: 'assistant', text: reply }
  emit(ev)
  rendererMirror?.({ ...ev, conversationId })
  // #6 최근 대화 버퍼 적재(문답 연속성). 캡 초과분은 앞에서 버린다.
  voiceCtx.push({ role: 'user', text }, { role: 'assistant', text: reply })
  if (voiceCtx.length > VOICE_CTX_MAX) voiceCtx = voiceCtx.slice(-VOICE_CTX_MAX)
  return 'answered'
}

// ── 어깨너머(overlay) 자발 반응 (§어깨너머) ──
// L0 watcher가 넘긴 관찰을 보고, 도움될 한마디가 있을 때만 짧게 발화한다(대부분 침묵).
// voiceQuickReply와 동형: 도구 없음·judge 티어·일회성 query(무한세션 미오염). 발화는 활성 레인 대화에
// 단일 타임라인으로 기록(addMessage) + rendererMirror로 브로드캐스트 → 오버레이/메인이 같은 스트림을 본다.
let reacting = false
let recentReactions: string[] = []
const REACTION_MEM_MAX = 4
export async function reactToObservation(obs: Observation): Promise<void> {
  if (busy || reacting) return // 본체 응답 중이거나 직전 반응이 진행 중이면 끼어들지 않음
  reacting = true
  try {
    let conversationId: string
    try {
      conversationId = ensureActiveConversation('manager')
    } catch {
      return
    }
    const digest = buildDigest(listProjects())
    const recent = recentReactions.length
      ? `\n방금 네가 한 말(반복 금지):\n${recentReactions.map((r) => `- ${r}`).join('\n')}`
      : ''
    const sys = `너는 '레인'이다. 사용자가 다른 앱에서 작업하는 걸 '어깨너머로' 지켜보고 있다(화면 우하단 작은 오버레이로 말한다). 지금 사용자는 화면에서 직접 작업 중이고 너를 보고 있지 않다.
진짜로 도움이 될 한마디가 있을 때만 짧고 담백하게(한두 문장) 말한다.
- 조언·방향·주의 줄 게 없으면 정확히 '<<SILENT>>'만 출력한다. 대부분의 경우 침묵이 맞다 — 어색한 추임새·인사·"지켜보는 중" 같은 군더더기 금지.
- 무미건조하고 절제된 톤. 느낌표·이모지·너스레 없이 용건만.
- 같은 말 반복 금지. 새로 보탤 게 있을 때만.
- 잘 모르는 프로그램 사용법 등 더 조사해야 제대로 도울 수 있으면 정확히 '<<RESEARCH>>'만 출력한다(내가 웹으로 알아본 뒤 다시 답한다).${recent}
<관찰>
앱: ${obs.app}
창 제목: ${obs.title || '(없음)'}
유휴: ${obs.idleSec}s · 트리거: ${obs.reason}
</관찰>
<현황>
${digest}
</현황>`
    // 파일 직독 텍스트(있으면) + 스크린샷(있으면)을 함께 넘긴다. 이미지가 있으면 SDKUserMessage 스트림.
    const contentBlock = obs.contentText
      ? `\n\n<파일 내용(일부)>\n${obs.contentText}\n</파일 내용>`
      : ''
    const promptText = `위 관찰을 보고 도움될 한마디가 있으면 말하고, 없으면 <<SILENT>>.${contentBlock}`
    type ImgBlock = {
      type: 'image'
      source: { type: 'base64'; media_type: 'image/png'; data: string }
    }
    type TxtBlock = { type: 'text'; text: string }
    const shot = obs.screenshot
    const promptParam = shot
      ? (async function* () {
          const content: (TxtBlock | ImgBlock)[] = [
            { type: 'text', text: promptText },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: shot.base64 },
            },
          ]
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content },
            parent_tool_use_id: null,
          }
        })()
      : promptText
    let out = ''
    try {
      const stream = query({
        prompt: promptParam,
        options: {
          cwd: AGENT_CWD,
          systemPrompt: sys,
          allowedTools: [],
          maxTurns: 2,
          model: modelId(getSettings().judgeModel), // 빠른·저렴 티어
          executable: 'node',
          pathToClaudeCodeExecutable: CLAUDE_BIN,
        },
      })
      for await (const msg of stream) {
        if (msg.type === 'assistant') {
          const t = (msg.message?.content ?? [])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('')
          if (t) out = t
        }
      }
    } catch {
      return // 어깨너머는 best-effort — 실패는 조용히
    }
    let reply = out.trim()
    if (!reply || reply.includes('<<SILENT>>')) return
    // 에스컬레이션 — 더 알아봐야 하면 웹 조사 후 답한다(읽기 전용 도구만).
    if (reply.includes('<<RESEARCH>>')) {
      const researched = await researchObservation(obs)
      if (!researched || researched.includes('<<SILENT>>')) return
      reply = researched
    }
    if (busy) return // 반응 생성 중 사용자가 본체 턴을 시작했으면 끼어들지 않음
    addMessage('manager', 'assistant', reply, conversationId)
    rendererMirror?.({ kind: 'assistant', text: reply, proactive: true, conversationId })
    recentReactions.push(reply)
    if (recentReactions.length > REACTION_MEM_MAX) recentReactions = recentReactions.slice(-REACTION_MEM_MAX)
  } finally {
    reacting = false
  }
}

// 어깨너머 에스컬레이션 — '<<RESEARCH>>' 시 웹으로 빠르게 조사해 짧은 조언 1회 생성.
// 무인 실행이므로 읽기 전용 도구(WebSearch/WebFetch)만 — 편집·셸·MCP 액션 도구는 주지 않는다.
async function researchObservation(obs: Observation): Promise<string | null> {
  const sys = `너는 '레인'이다. 사용자가 '${obs.app}'에서 작업 중인데, 어깨너머로 돕기 위해 모르는 점을 웹으로 빠르게 조사한다.
핵심만 확인한 뒤 사용자에게 줄 조언을 짧게(한두 문장) 한국어로, 무미건조하게 답한다. 도움될 게 없으면 정확히 '<<SILENT>>'.`
  const prompt = `상황: 앱=${obs.app} · 창=${obs.title || '(없음)'} · 트리거=${obs.reason}. 더 나은 방법이나 막힌 지점 해결을 위해 필요한 것만 검색해 짧은 조언을 줘.`
  let out = ''
  try {
    const stream = query({
      prompt,
      options: {
        cwd: AGENT_CWD,
        systemPrompt: sys,
        allowedTools: ['WebSearch', 'WebFetch'], // 읽기 전용 조사만(무인 안전)
        maxTurns: 6,
        model: modelId(getSettings().judgeModel),
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN,
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) out = t
      }
    }
  } catch {
    return null
  }
  return out.trim() || null
}

export async function sendToManager(
  text: string,
  emit: (ev: ChatEvent) => void,
  isRetry = false,
  attachments: FileAttachment[] = [],
  continueRound = 0,
  conversationId?: string, // 다중 세션 — 미지정 시 활성 Lain 대화
  origin: 'pc' | 'telegram' | 'discord' = 'pc', // 출처 — 텔레그램/디스코드發이면 사용자 입력도 PC로 에코
  prevSigs: Set<string> = new Set(), // 직전 이어가기 라운드의 도구 시그니처 — 진전 판정(isManagerStalled)용
  transientAttempt = 0, // 일시적 API 에러(529 등) 자동 재시도 횟수 — 백오프 후 재귀
): Promise<void> {
  if (busy) {
    emit({ kind: 'error', message: 'Lain이 이전 메시지를 처리 중이다.' })
    return
  }
  busy = true
  currentAbort = new AbortController()
  const myTurn = ++turnSeq // 이 턴의 일련번호 — finally·강제종료가 '내 턴'일 때만 상태를 건드리게 가드
  if (!isRetry) stopped = false // 새 사용자 턴 — 직전 정지 latch 해제(이어가기/재시도 재귀는 latch 보존)
  // terminalSent: 이번 턴에 result/error가 렌더러에 도달했는지. 어떤 경로로도 안 갔고 재시도/이어가기도
  // 아니면 마지막에 safety-net result를 보내 "응답 중"을 항상 해제한다(채팅 영구 고착 차단).
  let terminalSent = false
  let abandoned = false // 정지로 강제 종료됨 — 이후 이 턴(orphan)의 relay 출력은 억제(이중표시·오염 방지)
  // 워치독 진전 추적 — 턴 시작·마지막 활동 시각·마지막 동작 설명. 무진전 자동 종료(아래 setInterval)와
  // 강제 종료 진단 줄(forceStopTurn의 '마지막 동작 · N초 경과')의 근거다.
  const turnStartedAt = Date.now()
  let lastActivityAt = Date.now()
  let lastActivity = '시작'
  // relay를 먼저 정의 — 어느 단계(DB·스트림)에서 throw해도 종료 이벤트를 렌더러로 흘릴 수 있게.
  const relay = (ev: ChatEvent) => {
    if (abandoned) return // 정지로 버려진 턴 — 늦게 도착한 출력은 무시
    if (ev.kind === 'result' || ev.kind === 'error') terminalSent = true
    emit(ev)
    rendererMirror?.({ ...ev, conversationId })
  }
  // 정지/워치독 강제 종료기 — stopManager·워치독이 호출. abort가 스트림을 못 끊어도 즉시 종료 이벤트를
  // 보내(relay는 abandoned로 막히므로 직접 emit/mirror) UI를 풀고 busy를 내린다. 멈춘 스트림은 백그라운드
  // orphan으로 남지만(abort가 결국 정리), UI는 더는 묶이지 않는다. reason은 사용자 가시 진단 줄에 쓰인다.
  forceStopTurn = (reason: string) => {
    if (abandoned) return
    abandoned = true
    terminalSent = true
    busy = false
    // 사용자 가시 진단 — 왜·언제·어디서 멎었는지 채팅에 한 줄로 남긴다(addMessage로 영속 → 직후 result가
    // 렌더러 conversationMessages 재로드를 트리거해 이 tool 라인이 채팅에 노출됨). 로그가 아니라 채팅에 보인다.
    const elapsedSec = Math.round((Date.now() - turnStartedAt) / 1000)
    const note = `${reason} — 마지막 동작: ${lastActivity} · ${elapsedSec}초 경과`
    try {
      addMessage('manager', 'tool', note, conversationId)
    } catch {
      /* DB 손상 등 — 진단 영속 실패는 종료를 막지 않는다 */
    }
    // 진단 로그 파일도 append(best-effort, 시크릿 없음) — 반복 행을 사후 추적할 수 있게.
    try {
      appendCapped(path.join(DATA_DIR, 'manager-turns.log'), `${new Date().toISOString()} ${note}\n`)
    } catch {
      /* 로그 실패는 무시 */
    }
    const done: ChatEvent = { kind: 'result', costUsd: null, tokens: 0, sessionId: null }
    emit(done)
    rendererMirror?.({ ...done, conversationId })
  }
  // 워치독 타이머 핸들 — 스트림 시작 직전에 가동, finally에서 반드시 해제한다(아래). DB 손상으로 try가
  // 일찍 return해도 미가동 상태(null)라 정리할 게 없다.
  let watchdog: ReturnType<typeof setInterval> | null = null
  // ⚠️ DB 작업(ensureActiveConversation·addMessage 등)을 try로 감싼다 — DB 손상 시 여기서 throw하면
  // busy를 풀고 에러를 렌더러로 보내 "응답 중"을 해제한다. (과거: 이 구간이 try 밖이라 손상 시 finally
  // 미실행으로 busy 영구 고착 + result/error 미발신 → 채팅이 "응답 중"에 영영 묶였다.)
  let digest = ''
  let resume: string | undefined
  try {
    conversationId = conversationId || ensureActiveConversation('manager')
    currentManagerConv = conversationId // ask_user 등 모듈스코프 도구가 이번 턴의 대화를 알도록
    if (!isRetry) {
      addMessage('manager', 'user', text, conversationId, attachments, origin)
      setConversationTitleIfEmpty(conversationId, text)
      touchConversation(conversationId)
      // PC發은 렌더러가 입력을 낙관적으로 이미 띄웠으므로 에코하지 않는다(중복 방지).
      // 텔레그램發만 user 이벤트를 미러해 PC 화면·목록에 즉시 반영한다(📱 마커 운반).
      if (origin === 'telegram' || origin === 'discord')
        rendererMirror?.({ kind: 'user', text, origin, conversationId })
    }
    digest = buildDigest(listProjects())
    resume = conversationSdkSession(conversationId) || undefined // 빈 문자열도 새 세션 취급
    // 무한세션 — 컨텍스트 점유가 임계 넘으면 누적 맥락을 월드모델로 압축하고 새 SDK 세션으로 이어간다(resume 끊기).
    // 사용자에겐 한 대화가 이어지지만 내부 트랜스크립트는 월드모델 크기로 리셋 → 컨텍스트 무한 증가·비용 폭증 차단.
    // ⚠️ '새 사용자 턴'에서만(!isRetry·첫 라운드·재시도 0) — hitMaxTurns 이어가기/retry 재귀에서 압축하면
    // 진행 중 작업의 같은-세션 resume이 끊겨 작업이 버려진다. threshold 0이면 shouldCompact가 항상 false(완전 비활성).
    if (
      !isRetry &&
      continueRound === 0 &&
      transientAttempt === 0 &&
      resume &&
      shouldCompact(getConversationContextTokens(conversationId), getSettings().contextCompactThreshold)
    ) {
      const prevWorld = getConversationWorldState(conversationId)
      const recent = listConversationDialogue(conversationId, 40) // user/assistant 원문만(도구 로그에 윈도 잠식 방지)
      const ws = await summarizeWorldState(prevWorld, recent)
      if (ws) setConversationWorldState(conversationId, ws) // 실패(null)면 직전 월드모델 유지(덮어쓰지 않음)
      setConversationSdkSession(conversationId, '') // SDK 세션 끊기 → 새 세션 시작
      resetConversationContextTokens(conversationId) // 점유 0 — 재귀 재진입 시 즉시 재압축 방지
      resume = undefined
      const compactNote = '🧠 컨텍스트 압축 — 누적 맥락을 월드모델로 요약하고 새 세션으로 이어감'
      addMessage('manager', 'tool', compactNote, conversationId) // 영속 — 재로드 시에도 세션 경계 흔적 유지
      relay({ kind: 'tool', text: compactNote })
      // 단일 세션 화면 정리 — 압축 직후 최근 40개만 화면에 남긴다(이전은 숨김·DB 보존). world_state가 진짜 기억.
      setManagerViewWindow(conversationId, 40)
    }
  } catch (e) {
    busy = false
    currentAbort = null
    relay({ kind: 'error', message: `DB 오류로 메시지를 받지 못했다: ${String(e)}` })
    return
  }

  // 텍스트 파일 → 프롬프트에 코드블록으로 첨부
  const textAttachments = attachments.filter((a) => !a.isImage)
  const textSuffix = textAttachments.length
    ? '\n\n' +
      textAttachments.map((a) => `[첨부: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\``).join('\n\n')
    : ''
  // §24 Phase1 — temporal anchoring: 현재 시각을 매 메시지에 갱신 주입(SYSTEM_PROMPT 박제 대신).
  // 과거 현황·요약을 '지금'으로 착각해 이미 끝낸 작업을 다시 시키는 것을 막는다.
  const nowAnchor = new Date().toISOString().slice(0, 16).replace('T', ' ')
  // 출처 주입 — 매 메시지에 PC/모바일 채널을 명시해 Lain이 맥락에 맞게 응답하도록 한다.
  const originLabel = origin === 'telegram' ? '📱 모바일(텔레그램)' : origin === 'discord' ? '📞 음성통화(디스코드)' : '🖥 PC'
  // 교훈 주입 — 레인 전역 교훈(scope=global, sentinel '__lain__')을 메시지 내용 기준 top-K로 주입.
  // 누적된 사용자 선호·컨벤션·원칙을 레인이 매 응답에 적용하게 한다(개인화). 주입=사용(inject_count·last_used_at).
  const lainLessons = lessonsForProject('__lain__', 6, text)
  const lessonsText = lainLessons.length
    ? `\n\n<lessons>\n과거 대화·작업에서 학습한 사용자 선호·원칙 (참고하되 맹신 말 것):\n${lainLessons
        .map((l) => `- ${l.trigger ? l.trigger + ' → ' : ''}${l.lesson}`)
        .join('\n')}\n</lessons>`
    : ''
  if (lainLessons.length) bumpLessonInject(lainLessons.map((l) => l.id))
  // 무한세션 — 압축된 월드모델이 있으면 주입(세션 리셋으로 사라진 누적 맥락 복원). 비면 미주입(lessons 동형).
  // 킬스위치 — threshold 0이면 주입도 안 함(트리거 게이트와 대칭 → '0 = 오늘과 100% 동일' 보장).
  const worldState =
    getSettings().contextCompactThreshold > 0 ? getConversationWorldState(conversationId) : null
  const worldStateText = worldState
    ? `\n\n<world-state>\n압축된 누적 맥락(이전 대화 요약 — 방침·진행 스레드·열린 결정·최근 완료):\n${worldState}\n</world-state>`
    : ''
  const fullText = `[현재 시각: ${nowAnchor} (UTC) | 출처: ${originLabel}] — 아래 현황은 이 시점 기준이다. 이미 완료된 작업을 다시 지시하지 마라.\n\n<status-digest>\n${digest}\n</status-digest>${worldStateText}${lessonsText}\n\n${text}${textSuffix}`

  // 이미지 파일 → SDKUserMessage content block. SDK(Anthropic)가 받는 media_type은 4종뿐.
  const imageAttachments = attachments.filter((a) => a.isImage)
  type ImgMedia = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: ImgMedia; data: string } }
  type TextBlock = { type: 'text'; text: string }
  const promptContent: (TextBlock | ImageBlock)[] = [{ type: 'text', text: fullText }]
  for (const img of imageAttachments) {
    promptContent.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType as ImgMedia, data: img.data },
    })
  }
  // 이미지가 있으면 SDKUserMessage 스트림, 없으면 단순 문자열
  const promptParam =
    imageAttachments.length > 0
      ? (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: promptContent },
            parent_tool_use_id: null,
          }
        })()
      : fullText

  let retryFresh = false
  let retryTransient = false
  let hitMaxTurns = false
  let assistantSeen = false
  let lastOccupancy = 0 // 스트림 중 본 마지막 컨텍스트 점유(assistant usage) — max-turns throw 경로의 점유 보정용
  // 이번 라운드의 도구 사용 시그니처 — 자동 이어가기 정체 판정용(isManagerStalled). formatToolUse로 식별.
  const roundSigs = new Set<string>()
  // 편집 가능 정체성(soul.md)이 있으면 systemPrompt에 1회 append(temporal-anchor concat과 동형 seam).
  const soul = loadSoul()
  const systemPromptFull = soul
    ? `${SYSTEM_PROMPT}\n\n## 사용자 지정 정체성(soul.md)\n${soul}`
    : SYSTEM_PROMPT
  // 워치독 가동 — 응답이 thresholdMs 동안 진전 없으면(마지막 활동 후 무변화) 자동 종료. threshold>0일 때만.
  // 긴 정상 도구(설치·빌드)를 죽이지 않게 기본 10분(설정 turnWatchdogMin). finally에서 반드시 clearInterval.
  const thresholdMs = getSettings().turnWatchdogMin * 60000
  if (thresholdMs > 0) {
    watchdog = setInterval(() => {
      if (!abandoned && Date.now() - lastActivityAt > thresholdMs) {
        forceStopTurn?.('⏱ 무진전 자동 종료')
      }
    }, 20_000)
  }
  try {
    const abort = currentAbort
    const stream = query({
      prompt: promptParam,
      options: {
        cwd: AGENT_CWD,
        resume,
        systemPrompt: systemPromptFull,
        // 내부 lain 서버 + 사용자 등록 외부 MCP(manager 타깃, enabled만) — CC-FEATURES P1
        mcpServers: { lain: lainServer, ...mcpServersFor('manager') },
        // 사용자 승인(2026-06-19): Lain에게 클로드코드 전체 도구 허용(파일·셸·Workflow 등).
        // 등록된 모든 프로젝트 경로를 additionalDirectories로 연다. 시크릿 파일만 차단(canUseTool).
        additionalDirectories: listProjects().map((p) => p.path),
        ...managerAgentOptions(getSettings()),
        maxTurns: MANAGER_MAX_TURNS, // 다파일 직접 작업 여유 (§9b) — 초과 시 아래에서 이어가기/보고
        model: modelId(getSettings().managerModel), // §9b 티어링 — 설정에서 결정
        ...skillOptions(null, getSettings().skillsEnabled, getSettings().curatedPlugins),
        // Electron 안에서 process.execPath는 electron.exe → CLI 스폰 실패. 시스템 node 사용.
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
        // 모든 도구 허용 (사용자 승인 2026-06-19, Lain 기여). 단 시크릿 파일 접근만 차단.
        // 작업 유실 방지는 권한 차단이 아니라 배포 가드(deploy.ps1: 커밋 안 된/구버전 소스 배포 거부)로 한다.
        canUseTool: async (toolName, input) => {
          // 비밀 파일 데노리스트 (§24 Phase1) — Lain은 전 저장소 접근 권한이라 .env 노출면이 큼.
          if (blocksSecretFile(toolName, input)) {
            return { behavior: 'deny', message: SECRET_DENY_MESSAGE }
          }
          // 셸 명령·인자에 박힌 시크릿 경로 차단(§3 i15s) — blocksSecretFile은 파일도구 input 전용이라
          // Bash/PowerShell의 `cat .env` 같은 셸 인자는 못 막는다. 문자열 인자를 모아 경로 토큰을 검사.
          const argText = Object.values((input ?? {}) as Record<string, unknown>)
            .filter((v): v is string => typeof v === 'string')
            .join(' ')
          if (argText && blocksSecretPath(argText)) {
            return { behavior: 'deny', message: SECRET_DENY_MESSAGE }
          }
          // plan 모드 — 모델이 계획을 제시(ExitPlanMode)하면 계획 전문을 보여주고 사용자 승인까지 블록한다.
          // allow하면 SDK가 같은 스트림에서 곧바로 실행으로 전환(실측 2026-06-28). deny면 계획을 수정한다.
          if (toolName === 'ExitPlanMode') {
            const plan = String((input as { plan?: unknown })?.plan ?? '(계획 본문 없음)')
            const conv = currentManagerConv ?? ensureActiveConversation('manager')
            const qid = `plan${++questionSeq}`
            rendererMirror?.({
              kind: 'question',
              questionId: qid,
              question: `📋 이 계획대로 실행할까?\n\n${plan}`,
              options: ['실행', '거부'],
              multi: false,
              conversationId: conv,
            })
            const answer = await waitForUserAnswer(qid)
            const approved = answer[0] === '실행'
            addMessage('manager', 'tool', `📋 계획 ${approved ? '✅ 실행' : '❌ 거부'}\n\n${plan.slice(0, 2000)}`, conv)
            rendererMirror?.({
              kind: 'questionResolved',
              questionId: qid,
              answerText: approved ? '실행' : '거부',
              conversationId: conv,
            })
            if (approved) return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
            return { behavior: 'deny', message: '사용자가 계획을 거부했다. 계획을 수정하거나 다른 접근을 제안해라.' }
          }
          return { behavior: 'allow', updatedInput: input as Record<string, unknown> }
        },
        abortController: abort,
        stderr: (data: string) =>
          appendCapped(path.join(DATA_DIR, 'manager-stderr.log'), data),
      },
    })
    for await (const msg of stream) {
      if (abandoned) break // 정지로 강제 종료된 턴 — 스트림이 늦게 재개돼도 더 처리하지 않는다
      lastActivityAt = Date.now() // 워치독 진전 — 이벤트가 흐르면 살아 있음(무진전 자동종료 타이머 리셋)
      if (msg.type === 'system' && msg.subtype === 'init') {
        lastActivity = '세션 시작'
        setConversationSdkSession(conversationId, msg.session_id)
      } else if (msg.type === 'assistant') {
        const blocks = msg.message?.content ?? []
        // 도구 사용 가시화 — workerchat과 동일하게 tool_use를 회색 라인으로 relay(같은 채널).
        for (const b of blocks) {
          if ((b as any)?.type === 'tool_use') {
            const line = formatToolUse(b)
            lastActivity = `도구 ${line}` // 워치독 진단 — 어느 도구에서 멎었는지 가시화
            roundSigs.add(line) // 진전 판정용 시그니처 수집(isManagerStalled)
            addMessage('manager', 'tool', line, conversationId)
            relay({ kind: 'tool', text: line })
          }
        }
        const out = blocks
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (out) {
          lastActivity = '응답 작성'
          assistantSeen = true
          addMessage('manager', 'assistant', out, conversationId)
          relay({ kind: 'assistant', text: out })
        }
        // 점유 추적 — result가 안 와도(throw 경로) 다음 턴 압축 게이트가 잠들지 않게 마지막 점유를 보존.
        const occ = contextOccupancyTokens(msg.message)
        if (occ > 0) lastOccupancy = occ
      } else if (msg.type === 'result') {
        if ('session_id' in msg && msg.session_id)
          setConversationSdkSession(conversationId, msg.session_id)
        if ('subtype' in msg && msg.subtype === 'error_max_turns') hitMaxTurns = true
        // 무한세션 — 이번 턴 컨텍스트 점유(input+캐시, output 제외) 기록 → 다음 턴 진입에서 임계 판정.
        setConversationContextTokens(conversationId, contextOccupancyTokens(msg))
        relay({
          kind: 'result',
          costUsd: 'total_cost_usd' in msg ? (msg.total_cost_usd ?? null) : null,
          tokens: sumUsageTokens(msg),
          sessionId: 'session_id' in msg ? (msg.session_id ?? null) : null,
        })
      }
    }
  } catch (e) {
    const msg = String(e)
    // 정지 버튼(stopManager) 우선 — abort 신호가 섰으면 에러 메시지 형태와 무관하게 깔끔히 종료한다.
    // (claude.exe가 abort로 'process exited with code 1' 등을 던져도 인증오류/재시도로 오인 금지.)
    if (stopped || currentAbort?.signal.aborted) {
      relay({ kind: 'result', costUsd: null, tokens: 0, sessionId: null })
    } else if (isTransientApiError(msg) && !assistantSeen && transientAttempt < MAX_TRANSIENT_RETRIES) {
      // 일시적 상류 에러(529 과부하·5xx) — 아직 본 응답이 안 났고 재시도 여유가 있으면 백오프 후 자동 재시도.
      // assistantSeen 가드: 실제 텍스트가 난 뒤의 중단은 재시도하면 중복되므로 제외(사용자가 "계속"으로 resume).
      retryTransient = true
    } else if (resume && !isRetry && /No conversation found with session ID/i.test(msg)) {
      // resume 세션이 SDK에 없으면(데이터 정리·빌드 교체 등) 세션 버리고 새로 1회 재시도.
      setConversationSdkSession(conversationId, '')
      retryFresh = true
    } else if (/maximum number of turns/i.test(msg)) {
      // 턴 한도 도달 — init에서 세션 id가 저장돼 있어 같은 세션 resume으로 이어갈 수 있다.
      hitMaxTurns = true
      // ⚠ result 메시지를 못 받는 throw 경로 — 여기서 점유를 기록하지 않으면 무한세션 압축 게이트가
      // 영영 안 걸려 트랜스크립트가 무한 증가한다(점유가 stale). 마지막 점유(또는 보수적 임계값)로 기록. [[lain-sdk-maxturns-error-max-turns]]
      const occ = occupancyForMaxTurns(lastOccupancy, getSettings().contextCompactThreshold)
      if (occ > 0) setConversationContextTokens(conversationId, occ)
    } else if (/aborted by user/i.test(msg)) {
      // 사용자가 정지 버튼(stopManager)으로 중단 — 에러 아님. result로 busy만 깔끔히 해제.
      relay({ kind: 'result', costUsd: null, tokens: 0, sessionId: null })
    } else if (isTransientApiError(msg)) {
      // 재시도 소진(또는 부분 출력 후 장애) — raw 대신 깔끔한 안내(상류 과부하·네트워크 blip은 로컬로 못 고침).
      relay({
        kind: 'error',
        message: '상류(Anthropic API) 과부하 또는 네트워크 일시 장애로 실패했어. 잠시 후 다시 시도해줘. (status.claude.com)',
      })
    } else if (
      // 클로드 인증 실패 — OAuth 토큰 만료/무효면 claude.exe가 'Invalid authentication credentials'로
      // 죽거나(stdout) 'process exited with code 1'로 던진다. 재시도로 안 풀리니 재로그인 안내로 바꾼다.
      /invalid authentication credentials|failed to authenticate|authentication_error|process exited with code/i.test(
        msg,
      )
    ) {
      relay({
        kind: 'error',
        message:
          '🔑 클로드 인증 실패(토큰 만료 가능) — claude.exe가 인증에 실패했어. 터미널에서 `claude login`(또는 Claude Code에서 /login)으로 재로그인한 뒤 lain을 재시작해줘.',
      })
    } else {
      relay({ kind: 'error', message: msg })
    }
  } finally {
    if (watchdog) clearInterval(watchdog) // 워치독 타이머 반드시 해제(턴 종료 후 좀비 타이머 방지)
    // '내 턴'일 때만 정리한다 — 정지로 버려진 orphan 턴이 뒤늦게 끝나며 새 턴(turnSeq가 이미 증가)의
    // busy/abort/강제종료기를 덮어쓰는 것을 막는다. orphan이면(turnSeq≠myTurn) 아무것도 건드리지 않는다.
    if (turnSeq === myTurn) {
      busy = false
      currentAbort = null
      forceStopTurn = null
    }
  }
  // 정지됐으면 어떤 이어가기·재시도도 하지 않는다 — 플래그를 내려 아래 재귀를 모두 건너뛰고
  // safety-net이 깔끔한 result를 보내 "응답 중"을 해제한다(abort가 라운드 간극을 놓쳐도 확실히 멈춤).
  if (stopped) {
    retryTransient = false
    retryFresh = false
    hitMaxTurns = false
  }
  // SAFETY NET — 스트림이 result 없이 끝나는 등 어떤 경로로도 종료 이벤트가 안 갔고, 재시도/이어가기도
  // 아니면 result를 한 번 보내 "응답 중"을 항상 해제한다. (terminalSent로 정상 result·error와 중복 방지)
  if (!terminalSent && !retryFresh && !hitMaxTurns && !retryTransient)
    relay({ kind: 'result', costUsd: null, tokens: 0, sessionId: null })
  // 대화 제목 자동요약 — 이번 턴에 assistant 응답이 났고 아직 자동요약 전이면 1회 비동기 생성(메인 지연 0).
  // needsAutoTitle 가드라 '첫 교환 후 1회'가 자연히 보장됨(둘째 메시지부터 title_auto=1).
  // DB 호출이라 손상 시 throw할 수 있으나 종료 이벤트는 이미 나갔으므로 조용히 삼킨다(UI 영향 0).
  try {
    if (assistantSeen && needsAutoTitle(conversationId))
      void summarizeConversationTitle(conversationId, text, 'manager')
  } catch {
    /* 자동요약 실패는 무시 */
  }
  if (retryTransient) {
    const waitMs = transientBackoffMs(transientAttempt)
    relay({
      kind: 'tool',
      text: `⏳ 상류/네트워크 일시 장애 — ${waitMs / 1000}s 후 자동 재시도 (${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES})`,
    })
    await new Promise((r) => setTimeout(r, waitMs))
    return sendToManager(
      text,
      emit,
      true,
      attachments,
      continueRound,
      conversationId,
      origin,
      prevSigs,
      transientAttempt + 1,
    )
  }
  if (retryFresh)
    return sendToManager(text, emit, true, attachments, continueRound, conversationId, origin, prevSigs)
  // §9-7 "초과 시 일시정지 후 보고": 한도에 닿으면 사용자 개입 없이 같은 세션을 이어 마무리하되,
  // 상한까지 가면 raw 에러 대신 '계속' 안내로 깔끔히 끝낸다(무한 토큰 소모 방지).
  if (hitMaxTurns) {
    // 진전 감지(i8) — 이어가기 라운드인데 직전 대비 진전이 없으면(같은 자리 맴돎) 자동 continue를
    // 멈추고 방향을 묻는다. assistantSeen 1차 게이트라 텍스트라도 났으면 진전으로 봐 오탐을 막는다.
    if (isManagerStalled(continueRound, assistantSeen, roundSigs, prevSigs)) {
      relay({
        kind: 'assistant',
        text: '같은 자리를 맴돌아 멈췄다. 막힌 지점을 알려주면 방향을 바꿔 다시 시도하겠다.',
      })
    } else if (continueRound < MANAGER_MAX_CONTINUE) {
      // 진전이 있으면 같은 세션을 이어가되, 이번 라운드 도구 시그니처를 다음 라운드 prevSigs로 운반.
      return sendToManager(
        CONTINUE_NUDGE,
        emit,
        true,
        [],
        continueRound + 1,
        conversationId,
        origin,
        roundSigs,
      )
    } else {
      relay({
        kind: 'assistant',
        text: `작업이 길어 턴 한도(${MANAGER_MAX_TURNS})에 도달해 일시정지했다. "계속"이라고 보내면 세션을 이어 마무리한다.`,
      })
    }
  }
  // §9 신호기반 background review (i2) — settings.signalReview off면 호출조차 안 한다(휴면, 회귀 0).
  // 사용자 채팅 턴이 진짜로 끝났을 때만(이어가기/리트라이 재귀가 아님) 1회. 동적 import로 순환 의존 회피,
  // 실패는 무해(selfimprove 내부에서 try/catch + abort). 본 함수 흐름·종료 이벤트와 독립(fire-and-forget).
  if (!isRetry && getSettings().signalReview) {
    void import('./selfimprove')
      .then((m) => m.reviewManagerTurn())
      .catch(() => {})
  }
}
