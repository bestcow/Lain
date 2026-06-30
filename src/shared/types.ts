// 공유 타입 — main/preload/renderer 공용 (PLAN.md §6 데이터 모델 기반)

export type TestState = 'pass' | 'fail' | 'unknown' | 'running'

export interface Project {
  id: string // 워크스페이스 루트(C:\workspace) 기준 상대경로 (예: "apps/blog") — 안정 키
  path: string // 절대경로
  name: string
  stack: string | null
  isGit: boolean
  verifyCmd: string | null
  enabled: boolean
}

export interface ProjectStatus {
  projectId: string
  gitBranch: string | null
  ahead: number
  behind: number
  dirtyFiles: number
  lastCommit: string | null
  lastCommitAt: string | null
  testState: TestState
  testOutputTail: string | null
  todoCount: number
  hasTaskMd: boolean // 프로젝트 루트에 TASK.md 존재 여부
  summary: string | null // Navi 판단 요약 (Phase 1+)
  updatedAt: string
}

export interface ProjectView extends Project {
  status: ProjectStatus | null
}

export interface ChatMessage {
  id: number
  scope: 'user' | 'manager' | 'worker'
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt: string
  chapter?: string | null // 챕터로 고정한 메시지의 제목(§ 우클릭 메뉴) — 없으면 null
  attachments?: FileAttachment[] // user 메시지에 동봉된 첨부(이미지 썸네일·파일 칩 인라인 로그) — 없으면 undefined
  origin?: 'pc' | 'telegram' | 'lain' | 'discord' // 발신 출처. telegram=폰發(📱) / lain=관리자가 Navi에게 보낸 메시지(Navi 대화창에서 'lain>'으로 귀속) / discord=음성통화 / 없으면 PC 사용자
  projectId?: string | null // Navi 메시지의 소속 프로젝트. manager 대화엔 없음(undefined). @all 통합 뷰·필터용
}

// ── Phase 1: 작업 실행 (PLAN.md §6, §8) ──

export type TaskState =
  | 'clarifying'
  | 'blocked' // 명확화 질문 답변 대기
  | 'ready'
  | 'working'
  | 'review' // Navi 완료, 사람 결정 대기 (병합/브랜치만/폐기)
  | 'done'
  | 'error'
  | 'cancelled'

// §21.0 Navi 실행 모드: interactive(승인 큐) / autonomous(hands-off glass-box)
export type NaviMode = 'interactive' | 'autonomous'

// P2 권한모드 (CC-FEATURES) — 작업별 도구 실행 권한 강도. Lain·사용자가 지정(cascade).
// 'bypass'는 lain-네이티브: 승인 큐만 자동통과(끼어듦 없음), 시크릿 차단·spec-gaming·루프가드는 유지.
// (raw SDK bypassPermissions는 그 방어까지 전부 끄므로 쓰지 않는다 — §18 실측 확정.)
// 'plan'은 SDK plan 모드 — 계획만 제시·실행 보류(레인 입력창 바, Phase B 실측 후 배선).
export type TaskPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

// P2 thinking 예산 (CC-FEATURES) — 작업별 확장사고 수준. 'default'=옵션 미설정(현행 유지).
// auto=adaptive(모델이 알아서, 권장) · high=고정 예산 · off=사고 끔.
export type ThinkingLevel = 'default' | 'off' | 'auto' | 'high'

// 레인(manager) 작업량 — Claude Code effort 규격(낮음~최대) + Ultracode(xhigh + 워크플로 상시).
export type ManagerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode'

export interface Task {
  id: string
  projectId: string
  title: string
  state: TaskState
  mode: NaviMode // §21 — 기본 interactive
  permissionMode: TaskPermissionMode // P2 — 기본 acceptEdits. bypass=승인 자동통과(시크릿·테스트보호는 유지)
  thinkingLevel: ThinkingLevel // P2 — 확장사고 수준(기본 default=미설정)
  disallowedTools: string[] // P2 — 이 작업 Navi에 금지할 도구 이름(빈 배열=제한 없음). canUseTool 가드와 별개 SDK 필터
  content: string // TASK.md 내용 (+명확화 Q&A append)
  questions: string[] // blocked일 때 관리자 질문
  branch: string | null
  worktreePath: string | null
  naviSessionId: string | null
  contextTokens: number // Navi 유한세션 핸드오프(A) — 마지막 result의 컨텍스트 점유. resume 경계 교체 트리거용
  handoffMd: string | null // Navi가 직접 쓴 작업 핸드오프 md(세션 교체 후 재주입). ≠무한세션
  summary: string | null // Navi 최종 보고
  diffStat: string | null
  verifyResult: string | null // pass | fail | skipped(이유)
  costUsd: number
  tokens: number // 누적 토큰(input+output+cache) — 구독 모델용 표시
  turns: number
  error: string | null
  skills: string[] | null // Lain이 이 작업 Navi에 할당한 스킬(null=기본 풀 전체)
  images: FileAttachment[] // B17 — 작업 입력 이미지(드로어 직접첨부). 새 세션 시작 시 Navi 프롬프트에 주입
  fastMode: boolean // B4 — Opus 빠른 출력 모드(작업별). SDK settings.fastMode로 전달. 기본 off
  createdAt: string
  updatedAt: string
}

export interface Approval {
  id: number
  taskId: string
  kind: string // push | destructive | dep_change | network | outside_dev | question
  payload: string // 명령 원문 또는 질문
  state: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

// §6 선언적 루틴 — 단일 인터벌 스캔을 넘어선 다중 스케줄(additive, 기본 routine 없음)
//   cron은 lain 결정론 표현 4종만: daily:HH:MM | hourly:MM | weekly:<0-6>:HH:MM | interval:<분>
export interface Routine {
  id: string
  projectId: string | null // 특정 프로젝트 스코프(NULL=전역/Lain 차원 루틴)
  title: string
  prompt: string // 루틴 실행 시 Lain에게 줄 지시
  cron: string // daily:HH:MM | hourly:MM | weekly:<0-6>:HH:MM | interval:<분>
  enabled: boolean
  nextRunAt: string | null // ISO. NULL이면 미스케줄
  lastRunAt: string | null // 마지막 실행 ISO
  createdAt: string
}

// ── 외부 MCP 서버 (CC-FEATURES P1) — 백본 ③: 등록=사용자 UI, 사용=cascade(Lain·Navi) ──
// SDK mcpServers 레코드에 머지된다. transport 3종: stdio(command/args/env) / sse·http(url/headers).
export type McpTransport = 'stdio' | 'sse' | 'http'
export type McpTarget = 'manager' | 'navi' // cascade 레벨 할당 — 어느 계층이 이 서버를 쓰나

export interface McpServer {
  id: string
  name: string // mcpServers 레코드 키 + 도구 접두사(mcp__<name>__). [A-Za-z0-9_-], 'lain' 예약
  transport: McpTransport
  command: string | null // stdio
  args: string[] // stdio 인자
  env: Record<string, string> // stdio 환경변수 (시크릿 — 로그/다이제스트 금지 §9-6)
  url: string | null // sse/http
  headers: Record<string, string> // sse/http 헤더 (시크릿 §9-6)
  targets: McpTarget[] // 사용 계층(비면 아무도 안 씀)
  enabled: boolean // 토큰 게이팅 — enabled만 주입
  createdAt: string
}

// ── 클로드 플러그인 (CC-FEATURES P1) — claude CLI `plugin list --json` 정규화 ──
// 등록/설치/제거는 사용자 전용(②), 할당(어떤 걸 lain이 에이전트에 줄지)은 settings.curatedPlugins.
export interface PluginInfo {
  id: string // "name@marketplace"
  name: string // 표시·큐레이션 키(마켓 접두 제거)
  marketplace: string
  version: string | null
  description: string | null
  installed: boolean
  enabled: boolean // 설치본 enable 상태(CC 차원)
  hasMcp: boolean // 플러그인이 자체 MCP 서버 보유 여부(skipMcpDiscovery로 자동연결은 안 함)
  installCount: number | null // available 카탈로그 인기 지표
}

// add/update 입력 — 구조화 필드. 저장소가 args/env/headers를 JSON 직렬화·역직렬화한다.
export type McpServerInput = {
  name: string
  transport: McpTransport
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
  targets?: McpTarget[]
}

// ── 자기개선 (§22) — 검증된 작업에서 추출한 재사용 교훈 ──
// 모델 가중치가 아니라 "경험 누적 + retrieval"로 점점 똑똑해진다.
// 핵심 안전: verify pass(테스트=판사)로 review 도달한 작업의 교훈만 신뢰.
export interface Lesson {
  id: number
  projectId: string
  taskId: string
  scope: 'project' | 'global' // project=해당 repo 한정, global=모든 Navi에 주입
  trigger: string // 언제 적용되나 (작업 유형·키워드 — retrieval 매칭 힌트)
  lesson: string // 재사용 가능한 교훈 본문
  reuseCount: number // 이후 작업에 주입된 횟수 (성장 추이용)
  createdAt: string
  status: 'active' | 'stale' | 'archived' // §24 수명주기 — archived는 주입 제외(하드삭제 아님)
  lastUsedAt: string | null // 마지막 주입 시각(recency telemetry)
  pinned: boolean // 불가침 — 수명주기 전이·curator 폐기 제외
  origin: 'agent' | 'user' // agent=회고 추출, user=직접 입력(curator 폐기 대상에서 제외)
  absorbedInto: number | null // consolidation으로 흡수된 umbrella lesson id (revert 역참조 키), NULL=흡수 안됨
  consolidationBatch: string | null // 한 consolidate 호출을 묶는 batch id, NULL=curation 산물 아님
  injectCount: number // 실제 프롬프트 주입 횟수(reuseCount=선택 bump와 의미 분리)
}

// ── 평가 하네스 (§23) — 자기개선이 지표를 실제로 올리는지 A/B 측정 ──
export interface BenchTaskResult {
  benchTask: string // 벤치 task 식별자 (data/bench/<id>)
  condition: 'no-lessons' | 'with-lessons' // 교훈 off/on
  success: boolean // verify pass로 review 도달
  verifyFirstPass: boolean // verify 1회차에 통과(재시도 없이)
  turns: number
  costUsd: number
  tokens: number
}

export interface BenchSummary {
  runId: string
  startedAt: string
  byCondition: Record<
    string,
    {
      n: number
      successRate: number
      firstPassRate: number
      avgTurns: number
      avgCost: number
      avgTokens: number
    }
  >
  results: BenchTaskResult[]
  regression?: string | null // §24 — 교훈 ON이 지표를 악화시키면 경보(틀린 교훈 누적 감지), 없으면 null
}

// ── 설정 (settings 테이블의 타입 뷰, §9b 티어링 매핑 포함) ──

export type ModelTier = 'haiku' | 'sonnet' | 'opus'

// §20.3 텔레그램 어댑터 연결 상태 (CFG 패널에서 토큰 확인용)
export interface TelegramStatus {
  running: boolean // 폴링 루프 가동 중
  username: string | null // 봇 @username (getMe 성공 시)
  chatLinked: boolean // 허용 채팅 ID 등록됨
  lastError: string | null // 마지막 폴링/검증 에러 (토큰 비노출)
  pendingChatId: string | null // 부트스트랩 대기 — 미허용 채팅이 보낸 chat id(설정에 등록하면 연결). 없으면 null
}

// §20.3 디스코드 음성 통화 어댑터 연결 상태 (CFG 패널에서 확인용)
// #3 통화 파이프라인 단계 — UI 배지로 표시(듣는 중→전사→생각→말하는 중).
export type DiscordCallState =
  | 'idle' // 통화 아님(로그인만/꺼짐)
  | 'waiting' // 입장·대기(발화 청취 중)
  | 'listening' // 사용자 발화 감지 중
  | 'transcribing' // STT 진행
  | 'thinking' // 레인 응답 생성 중
  | 'speaking' // TTS 재생 중
  | 'error' // 직전 단계 실패
export interface DiscordStatus {
  running: boolean // 봇 로그인됨
  inCall: boolean // 음성채널 통화 중
  error: string | null // 마지막 에러 (토큰 비노출)
  callState: DiscordCallState // 통화 파이프라인 단계(#3)
}
export interface DiscordStateEvent {
  state: DiscordCallState
  error?: string
}

export interface LainSettings {
  concurrencyCap: number // 동시 working 작업 수 (§9-7)
  naviModel: ModelTier // Navi 본 작업 (§9b)
  managerModel: ModelTier // 관리자 채팅
  judgeModel: ModelTier // clarify 판정·ask_manager 즉답 등 짧은 판정류
  managerPermissionMode: TaskPermissionMode // 레인 채팅 권한 모드(입력창 바)
  managerEffort: ManagerEffort // 레인 작업량(effort) — 입력창 바
  managerEffortAuto: boolean // 작업량 자동 — 레인이 스스로(adaptive) 조절
  managerFastMode: boolean // 레인 빠른 모드(Opus 빠른 출력)
  defaultTaskMode: 'auto' | 'autonomous' | 'interactive' // 작업 위임 기본(auto=현 자동판정)
  // 어깨너머 모드 (실시간 감시 + 우하단 오버레이) — 메인창 안 볼 때 화면 작업을 관찰해 먼저 조언
  overlayMonitoringEnabled: boolean // 어깨너머 on/off (기본 off, opt-in)
  monitorSensitiveApps: string[] // 민감 앱 블랙리스트 — 포그라운드면 감시/조언 스킵 (시크릿 보호 §9-6)
  monitorCooldownSec: number // 반응 최소 간격(초) — 연속 수다 억제 (기본 30)
  monitorPollMs: number // 포그라운드/유휴 폴링 간격(ms) — L0 결정론 (기본 1500)
  // Phase 3 자동화 (§15, §12.5b)
  scanIntervalMin: number // 주기 스캔 간격(분), 0 = 끔
  closeToTray: boolean // 창 닫기 → 트레이 상주
  autoStart: boolean // 로그인 시 자동 시작 (트레이로)
  autoPriority: boolean // 주기 스캔 변화 시 관리자 자동 우선순위 판단 (LLM 비용)
  lessonCurator: boolean // §24 Phase3 — idle 시 judge가 중복 교훈을 semantic 병합 (LLM 비용, 기본 off)
  signalReview: boolean // §9 시그널 리뷰 — idle 시 Lain이 '지금 알아야 할 신호' 자발 보고 (LLM 비용, 기본 off)
  idleMin: number // idle 판정 임계(분) — 마지막 채팅 활동 후 이 시간 경과해야 끼어듦 허용 (기본 3)
  routinesEnabled: boolean // 선언적 routines 스케줄 디스패치 on/off (기본 off — off면 등록만 되고 실행 안 됨)
  ccHooksEnabled: boolean // 클로드코드 연동 — 레인 밖에서 직접 실행한 CC 세션을 레인이 인지(훅 자동 설치). 기본 off
  // §20.3 텔레그램 채널 — 자리 비웠을 때 폰으로 와이어드 지휘·결재
  telegramEnabled: boolean // 텔레그램 어댑터 on/off
  telegramBotToken: string // BotFather 토큰 (시크릿 — 로그/다이제스트 금지 §9-6)
  telegramChatId: string // 허용 채팅 ID 화이트리스트 (비면 첫 메시지로 부트스트랩, §20.5)
  groqApiKey: string // STT(Groq Whisper) 용 — 비면 음성 메시지 비활성화 (시크릿 §9-6)
  contextCompactThreshold: number // 무한세션 — 관리자 대화 컨텍스트 점유가 이 토큰 넘으면 월드모델 압축 후 새 세션. 0 = 끔
  naviHandoffThreshold: number // Navi 유한세션 핸드오프 — Navi 대화 점유가 이 토큰 넘으면 핸드오프 md 기록 후 새 세션(≠무한세션). 0 = 끔
  turnWatchdogMin: number // 무진전 자동종료 임계(분) — Lain 응답이 이 시간 동안 진전 없으면 자동 종료. 0 = 끔
  // §디스코드 음성 통화 — 봇이 VC에 입장해 양방향 음성 지휘
  skillsEnabled: boolean // 클로드 스킬 노출 킬스위치(기본 OFF — plugins/skills 안 붙임)
  curatedPlugins: string[] // lain이 에이전트에 할당할 플러그인 이름 목록(CC-FEATURES P1). 기본=큐레이션 코딩셋
  discordEnabled: boolean // 디스코드 어댑터 on/off
  discordBotToken: string // 봇 토큰 (시크릿 — 로그/다이제스트 금지 §9-6)
  discordGuildId: string // 대상 길드(서버) ID
  discordVoiceChannelId: string // 봇이 입장할 음성 채널 ID
  discordUserId: string // 내 디스코드 user ID — 이 사용자의 발화만 청취
  discordTtsVoice: string // 음성 응답 TTS 보이스(ko-KR-*Neural). 빈값=기본(SunHi)
  discordVoiceMode: 'always' | 'wake' // #7 항상 청취 / '레인' 호출 시에만(웨이크워드)
  // 음성 합성 백엔드 — edge(Edge TTS·클라우드) / gpt-sovits(로컬 api_v2 서버). 로컬은 빠르고 음성 복제 가능.
  ttsBackend: 'edge' | 'gpt-sovits' | 'supertonic'
  gptSovitsUrl: string // GPT-SoVITS api_v2 서버 주소 (기본 http://127.0.0.1:9880)
  gptSovitsRefAudio: string // 참조 음성 클립 경로(목소리 복제용 3~10초) — 서버가 접근할 로컬 경로
  gptSovitsRefText: string // 참조 클립의 전사(prompt_text)
  gptSovitsRefLang: string // 참조 클립의 언어(prompt_lang) — 'ko'|'ja'|'en'|'zh'(교차언어). 출력은 항상 한국어
  // Supertonic(로컬 ONNX 사이드카) — 한국어 내장 보이스, 파이썬 없음(모델 첫 사용 시 1회 다운로드)
  supertonicVoice: string // 보이스 스타일 F1~F5 / M1~M5 (기본 F5)
  supertonicSpeed: number // 말 속도 0.5~2.0 (기본 1.05)
  supertonicStep: number // 디노이즈 스텝 2~16 (높을수록 품질↑·느림, 기본 8)
  // 자동 업데이트 (electron-updater + GitHub Releases)
  updateNotify: boolean // ② 새 버전 감지 시 Lain이 자발 제안(작업 한가할 때만). 기본 on
  updateAutoDownload: boolean // ③ 백그라운드 자동 '다운로드'만(설치는 항상 수동). 기본 off
}

// 자동 업데이트 상태 — main(updater) → 렌더러(배너·설정 화면) 단일 출처.
export interface UpdateStatus {
  state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  currentVersion: string // 현재 설치 버전(app.getVersion). dev/미패키징은 state='disabled'
  version?: string // 감지/다운로드된 새 버전
  percent?: number // 다운로드 진행률(0~100)
  error?: string
  suggested?: boolean // ② Lain이 제안을 띄웠는지 — 렌더러 배너 트리거
}

// 작업 드로어를 대화 트랜스크립트로 렌더하기 위한 화자 귀속(옵션). 없으면 시스템 로그 줄(기존 표시).
//   worker=Navi 발화·ask_manager 질문 / lain=관리자 답(ask_manager) / user=작업 중 인터럽트
export type TaskSpeaker = 'worker' | 'lain' | 'user'

// §7b Navi 종료 사유 (glass-box) — exitReason은 렌더러 이벤트 전용, DB엔 kind='exit'로만 영속
export type ExitReason = 'done' | 'blocked' | 'aborted' | 'max_turns' | 'tool_loop' | 'error'

export type TaskEvent =
  | { taskId: string; kind: 'status'; text: string; speaker?: TaskSpeaker }
  | { taskId: string; kind: 'tool'; text: string; speaker?: TaskSpeaker }
  | { taskId: string; kind: 'text'; text: string; speaker?: TaskSpeaker }
  | { taskId: string; kind: 'error'; text: string; speaker?: TaskSpeaker }
  | { taskId: string; kind: 'subagent'; text: string; speaker?: TaskSpeaker } // B2 — 서브에이전트/백그라운드 task_* 가시화
  | { taskId: string; kind: 'exit'; text: string; speaker?: TaskSpeaker; exitReason: ExitReason }

type ChatEventKind =
  | { kind: 'user'; text: string; origin?: 'pc' | 'telegram' | 'discord' } // 사용자 입력 에코 — 텔레그램/디스코드發 메시지를 PC에 라이브 표시할 때(출처 운반)
  | { kind: 'assistant'; text: string; proactive?: boolean } // proactive=어깨너머 자발 발화(레인이 먼저)
  | { kind: 'tool'; text: string } // 승인 대기 등 시스템 라인 (§5.6 Navi 직접 채팅)
  | { kind: 'result'; costUsd: number | null; tokens: number | null; sessionId: string | null }
  | { kind: 'error'; message: string }
  // 인라인 선택형/체크형 질문(Lain→사용자) — ask_user 도구가 카드를 띄우고 답을 기다린다(라이브 전용).
  | { kind: 'question'; questionId: string; question: string; options: string[]; multi: boolean }
  | { kind: 'questionResolved'; questionId: string; answerText: string } // 답 제출됨 — 카드 제거

// conversationId: 어느 대화의 이벤트인지. 텔레그램·PC가 같은 대화를 공유하므로
// 렌더러가 '현재 연 대화면 본문에 추가, 아니면 목록 미리보기만 갱신'을 판별하는 데 쓴다.
export type ChatEvent = ChatEventKind & { conversationId?: string }

// §5.6 Navi 직접 채팅 — 프로젝트 단위 이벤트
export type NaviChatEvent = { projectId: string } & ChatEvent

// 대화 인박스 — 각 대화(Lain + 프로젝트별 Navi채팅)의 마지막 메시지 미리보기
export interface ConversationPreview {
  target: string // 'manager' | projectId
  role: ChatMessage['role'] | null
  content: string | null // 마지막 메시지 첫 줄(절단), 없으면 null
  createdAt: string | null
}

// 다중 세션 — 한 대상(Lain | Navi)이 여러 직접-대화 세션을 가진다 (클로드처럼 새로 시작/이어가기)
export interface Conversation {
  id: string // lain 내부 대화 id (SDK session_id와 별개 — SDK id는 main만 본다)
  target: string // 'manager' | projectId
  title: string // 자동 생성(첫 메시지) 또는 빈 문자열
  createdAt: string
  lastUsedAt: string
  lastContent: string | null // 마지막 메시지 미리보기(첫 줄·절단)
  lastAt: string | null
  lastMobileAt: string | null // 마지막 텔레그램(📱) 메시지 시각 — 5분 이내면 모바일 활성 표시 (Lain 기여)
}

// 파일 첨부 (채팅 입력 - 이미지·텍스트)
export interface FileAttachment {
  name: string
  mimeType: string   // e.g. "image/png", "text/plain"
  data: string       // 이미지: base64 인코딩(data: 부분만), 텍스트: UTF-8 내용
  isImage: boolean
}

// preload가 contextBridge로 노출하는 API 표면
export interface LainApi {
  listProjects(): Promise<ProjectView[]>
  scanProjects(): Promise<number>
  addProjectDialog(): Promise<ProjectView | null>
  setEnabled(id: string, enabled: boolean): Promise<void>
  removeProject(id: string): Promise<void>
  pushProject(id: string): Promise<{ ok: boolean; output: string }>
  refreshStatus(id?: string): Promise<void>
  runVerify(id: string): Promise<void>
  sendChat(text: string, attachments?: FileAttachment[], conversationId?: string): Promise<void>
  stopChat(): Promise<void>
  resetManager(): Promise<void> // Lain 무한세션 새로고침 — 진행 중 응답 멈추고 SDK 세션·월드스테이트 비움(로그는 보존)
  chatHistory(): Promise<ChatMessage[]>
  onProjectsUpdated(cb: (list: ProjectView[]) => void): () => void
  onChatEvent(cb: (ev: ChatEvent) => void): () => void
  getBriefing(): Promise<string | null>
  onBriefingUpdated(cb: (text: string) => void): () => void
  // 앱(main) 기동 시각 스탬프 — 렌더러 크래시 후 자동 reload돼도 불변. '이번 실행' 경계의 단일 출처.
  appStartedAt(): Promise<string>
  // Phase 1: tasks
  listTasks(): Promise<Task[]>
  startTask(projectId: string): Promise<{ taskId?: string; error?: string }>
  answerClarify(taskId: string, answers: string): Promise<void>
  resolveReview(taskId: string, action: 'merge' | 'keep-branch' | 'discard'): Promise<string>
  cancelTask(taskId: string): Promise<void>
  resumeTask(taskId: string): Promise<void> // B3 — error 상태 작업을 worktree·세션 그대로 수동 재개
  setTaskPermissionMode(taskId: string, mode: TaskPermissionMode): Promise<void> // P2 권한모드 변경
  setTaskThinking(taskId: string, level: ThinkingLevel): Promise<void> // P2 thinking 예산 변경
  setTaskDisallowedTools(taskId: string, tools: string[]): Promise<void> // P2 금지 도구 변경
  setTaskImages(taskId: string, images: FileAttachment[]): Promise<void> // B17 — 작업 입력 이미지 첨부(다음 실행/재개부터 Navi가 봄)
  setTaskFastMode(taskId: string, on: boolean): Promise<void> // B4 — Opus 빠른 출력 모드 토글(다음 실행/재개부터 적용)
  taskEvents(taskId: string): Promise<TaskEvent[]>
  taskDiff(taskId: string): Promise<string>
  listApprovals(): Promise<Approval[]>
  resolveApproval(id: number, approved: boolean, answer?: string): Promise<void>
  // 인라인 질문(ask_user) 답 제출 — 대기 중인 Lain 턴을 깨운다. answer는 선택된 보기 텍스트 배열.
  answerQuestion(questionId: string, answer: string[]): Promise<void>
  onTasksUpdated(cb: (list: Task[]) => void): () => void
  onTaskEvent(cb: (ev: TaskEvent) => void): () => void
  onApprovalsUpdated(cb: (list: Approval[]) => void): () => void
  // 설정
  getSettings(): Promise<LainSettings>
  setSettings(patch: Partial<LainSettings>): Promise<LainSettings>
  // 자동 업데이트 — ④ UI 버튼/상태 + ② Lain 제안 배너
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdate(): Promise<UpdateStatus>
  downloadUpdate(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
  // Supertonic TTS — 설정 테스트 재생(base64 WAV) + 모델 준비/다운로드 상태
  testTts(text?: string): Promise<string>
  supertonicStatus(): Promise<{ ready: boolean; downloading?: boolean; progress?: number } | null>
  // §20.3 텔레그램 — 어댑터 연결 상태 (토큰 검증용)
  telegramStatus(): Promise<TelegramStatus>
  // §20.3 디스코드 — 음성 통화 어댑터 연결 상태
  discordStatus(): Promise<DiscordStatus>
  onDiscordState(cb: (ev: DiscordStateEvent) => void): () => void // #3 통화 단계 라이브
  // §5.6 Navi 직접 채팅
  sendNaviChat(
    projectId: string,
    text: string,
    attachments?: FileAttachment[],
    conversationId?: string,
  ): Promise<{ error?: string }>
  naviChatHistory(projectId: string): Promise<ChatMessage[]>
  stopNaviChat(projectId: string): Promise<void>
  onNaviChatEvent(cb: (ev: NaviChatEvent) => void): () => void
  // 대화 제목 자동요약 갱신 알림 — target('manager' | projectId)의 대화목록/미리보기를 새로고침
  onConversationsUpdated(cb: (target: string) => void): () => void
  // 대화 인박스 — 전 대화의 마지막 메시지 미리보기
  conversationPreviews(): Promise<ConversationPreview[]>
  // 다중 세션 — 대상별 대화 목록 / 새 대화 / 대화 메시지 / 활성 대화
  listConversations(target: string): Promise<Conversation[]>
  createConversation(target: string): Promise<string> // 새 대화 id(활성으로 설정됨) 반환
  conversationMessages(conversationId: string): Promise<ChatMessage[]>
  getActiveConversation(target: string): Promise<string>
  setActiveConversation(target: string, conversationId: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  // 채팅 우클릭 메뉴 — 메시지 클립보드 복사 / 챕터 고정·해제(title=null이면 해제)
  copyText(text: string): void
  setChapter(messageId: number, title: string | null): Promise<void>
  // §22 자기개선 — 누적 교훈
  listLessons(): Promise<Lesson[]>
  // §24 교훈 수명주기 — 보관/복구/핀/직접추가
  flagLesson(id: number): Promise<boolean>
  unflagLesson(id: number): Promise<boolean>
  pinLesson(id: number, pinned: boolean): Promise<boolean>
  addLesson(lesson: {
    projectId: string
    scope?: 'project' | 'global'
    trigger: string
    lesson: string
  }): Promise<void>
  onLessonsUpdated(cb: (list: Lesson[]) => void): () => void
  // §curation revert — 한 batch의 umbrella archive + 흡수 교훈 active 복구, 복구된 교훈 수 반환
  revertConsolidation(batch: string): Promise<number>
  // §6 선언적 루틴 CRUD (향후 UI용)
  listRoutines(): Promise<Routine[]>
  createRoutine(r: {
    projectId?: string | null
    title: string
    prompt: string
    cron: string
  }): Promise<string> // 새 routine id 반환
  setRoutineEnabled(id: string, enabled: boolean): Promise<void>
  deleteRoutine(id: string): Promise<void>
  onRoutinesUpdated(cb: (list: Routine[]) => void): () => void
  // 외부 MCP 서버 (CC-FEATURES P1) — 등록=사용자, 사용=cascade(query 사이트가 머지)
  listMcpServers(): Promise<McpServer[]>
  addMcpServer(s: McpServerInput): Promise<{ id?: string; error?: string }>
  updateMcpServer(
    id: string,
    patch: Partial<McpServerInput>,
  ): Promise<{ ok: boolean; error?: string }>
  setMcpServerEnabled(id: string, enabled: boolean): Promise<void>
  removeMcpServer(id: string): Promise<void>
  onMcpServersUpdated(cb: (list: McpServer[]) => void): () => void
  // 클로드 플러그인 (CC-FEATURES P1) — 설치/제거=claude CLI 셸아웃, 할당=settings.curatedPlugins
  listPlugins(): Promise<{ installed: PluginInfo[]; available: PluginInfo[] }>
  installPlugin(id: string): Promise<{ ok: boolean; output: string }>
  uninstallPlugin(id: string): Promise<{ ok: boolean; output: string }>
  onPluginsUpdated(cb: () => void): () => void
  // §23 평가 하네스
  runBench(conditions?: ('no-lessons' | 'with-lessons')[]): Promise<BenchSummary>
  onBenchProgress(cb: (msg: string) => void): () => void
  // 창 제어 (frameless — OS 타이틀바를 헤더에 통합)
  windowMinimize(): Promise<void>
  windowMaximizeToggle(): Promise<boolean>
  windowClose(): Promise<void>
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
  onOpenInbox(cb: () => void): () => void
  // 인박스 열림/닫힘 통지 — main의 "자리 비움" 판단용 (fire-and-forget, copyText와 동일)
  setInboxOpen(open: boolean): void
  // 어깨너머 오버레이 — 클릭 시 메인창 복귀 / 내용 높이에 맞춰 창 리사이즈(fire-and-forget)
  openMainWindow(): Promise<void>
  overlayResize(height: number): void
  overlaySetVisible(visible: boolean): void // 유저 감시 — proactive 반응 시 오버레이 표시/숨김
}
