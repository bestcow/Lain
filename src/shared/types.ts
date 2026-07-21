// 공유 타입 — main/preload/renderer 공용 (PLAN.md §6 데이터 모델 기반)

export type TestState = 'pass' | 'fail' | 'unknown' | 'running'

export interface Project {
  id: string // 워크스페이스 루트(C:\workspace) 기준 상대경로 (예: "apps/blog") — 안정 키
  path: string // 절대경로
  name: string
  stack: string | null
  isGit: boolean
  verifyCmd: string | null
  muted?: boolean // '숨김' — 레인은 계속 관리하되 유저가 먼저 언급하기 전엔 화제로 꺼내지 않음. 보드에선 숨김 창에.
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
  pendingApprovals?: number // C2 — listProjects()가 병합하는 프로젝트별 대기 승인 수(approvals.state='pending')
  lastCcAt?: string // C1 — listProjects()가 병합하는 프로젝트별 마지막 CC(Claude Code) 이벤트 시각(cc_events MAX(created_at))
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
  origin?: 'pc' | 'telegram' | 'lain' | 'discord' | 'overlay' // 발신 출처. telegram=폰發(📱) / lain=관리자가 Navi에게 보낸 메시지 / discord=음성통화 / overlay=어깨너머(유저 감시) 자발 발화(👁·흐리게·월드모델 제외) / 없으면 PC 사용자
  projectId?: string | null // Navi 메시지의 소속 프로젝트. manager 대화엔 없음(undefined). @all 통합 뷰·필터용
}

// ── Phase 1: 작업 실행 (PLAN.md §6, §8) ──

export type TaskState =
  | 'queued' // D1 — cap 초과·프로젝트 중복으로 대기 중(슬롯 열리면 드레인이 자동 착수). 활성 아님
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

// 작업 실행 엔진 — worker(작업 Navi)만 선택 가능. 매니저(Lain)·judge는 Claude 고정.
// codex는 OpenAI Codex CLI(전역 설치+로그인) 필요. 승인 큐 대신 codex 샌드박스가 방어선.
export type TaskEngine = 'claude' | 'codex'

// L4(P6) — 리뷰 강도 다이얼: light=독립 심사 생략(verify만 신뢰) · standard=judge 1콜 심사(기본) ·
// adversarial=3렌즈(요구사항/완료조건/회귀) 병렬 심사 후 과반 합의(비용↑, opt-in). audit.ts runAudit이 분기.
export type ReviewDepth = 'light' | 'standard' | 'adversarial'

// A4 — TodoWrite 진행 체크리스트. Claude Code TodoWrite 도구의 todos 규격(shared/todoline.ts가
// 파싱·진행률 순수 함수의 단일 출처). status별 아이콘은 todoline.ts TODO_STATUS_ICON.
export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm: string
}

export interface Task {
  id: string
  projectId: string
  title: string
  state: TaskState
  mode: NaviMode // §21 — 기본 interactive
  engine: TaskEngine // 실행 엔진(기본 claude)
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
  tokens: number // 이 세션 누적 토큰(input+output+cache) — 구독 모델용 표시(세션 교체 시 리셋됨)
  tokensTotal: number // I4 — 라이프타임 누적 토큰(모든 세션 합) = sessionBaseTokens + 현재 세션 cumulative. 작업별 예산 판정 기준
  sessionBaseTokens: number // I4 — 현재 세션 이전 세션들의 누계(baseline). 동일세션 재갱신=교체·새 세션=가산을 위한 내부 상태
  turns: number
  error: string | null
  autoRetryCount: number // D3 — runNavi throw로 error 확정 전 자동 재시도한 횟수(영속·무한루프 방지). 상한 도달하면 에스컬레이션 후 error 확정. review 도달 시 0으로 리셋됨(everAutoRetried와 달리 "지금 예산"용)
  everAutoRetried?: boolean // L6(P6) — 이 작업이 생애 한 번이라도 자동 재개(D3)를 겪었는지. autoRetryCount와 달리 리셋되지 않음(loopStats firstPass 판정용)
  skills: string[] | null // Lain이 이 작업 Navi에 할당한 스킬(null=기본 풀 전체)
  images: FileAttachment[] // B17 — 작업 입력 이미지(드로어 직접첨부). 새 세션 시작 시 Navi 프롬프트에 주입
  fastMode: boolean // B4 — Opus 빠른 출력 모드(작업별). SDK settings.fastMode로 전달. 기본 off
  modelOverride: ModelTier | '' // D10 — 작업별 모델 고정('' = 전역 naviModel 따름). 다음 실행/재개부터 적용
  todos: TodoItem[] | null // A4 — 최신 TodoWrite 스냅샷(누적 아님, 마지막 호출이 현재 상태). 없으면 null
  priority: number // D1 — 대기 큐 드레인 순서. 낮을수록 먼저, 기본 0. queued 아닌 상태에선 무의미(보존만)
  dependsOn: string[] // D2 — 선행 task id 배열([]=없음). 전부 done(병합·keep-branch 포함)이어야 queued에서 착수. 선행 실패는 자동취소 없이 통지 후 사람/레인 결정
  groupId: string | null // D13 — 크로스레포 작업 그룹 소속(null=단독). 그룹 소속이면 개별 병합 봉쇄, resolve_group으로 all-or-nothing 결재
  mergeBaseSha: string | null // D8 — ff 병합 시 포착한 병합 직전 main tip(되돌릴 범위 하한, exclusive). null=되돌릴 병합 없음(keep-branch/discard/미병합)
  mergeHeadSha: string | null // D8 — 병합 후 main tip=Navi 브랜치 tip(되돌릴 범위 상한, inclusive). revert 범위 = base..head
  auditResult?: string // T14(P6) — 마지막 독립 완료 심사 판정(JSON AuditVerdict). 없으면 미심사(verify 미통과·verify_cmd 없음)
  auditRetried?: boolean // T14(P6) — 심사 미통과로 1회 자동 재작업했는지(1회 한정 플래그, 영속·무한루프 방지)
  reworkCount: number // T15(P6) — 결재 '수정 요청(rework)'으로 재작업한 횟수(영속). REWORK_MAX회 도달하면 rework 거부(발산 방지)
  criteria?: string[] // L3(P6) — elicit(§21.3) 산출 완료 조건(구조화). Navi 프롬프트 자기검증·audit 우선순위·결재 체크리스트에 쓰인다. 없으면 content의 '## 합격 기준' 텍스트로만 존재(하위호환)
  reviewDepth?: ReviewDepth // L4(P6) — 이 작업의 독립 심사 강도(생략 시 설정 reviewDepthDefault 따름). 시작 시 고정, insertTask에 영속
  createdAt: string
  updatedAt: string
}

export interface Approval {
  id: number
  taskId: string
  kind: string // push | destructive | dep_change | network | outside_dev | question | system(OS 파괴 — taskId 'lain'이면 매니저發) | plan(D9 — Navi plan 모드 계획 승인)
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

// ── 자기개선 (§22) — 검증된 작업에서 추출한 재사용 학습 ──
// 모델 가중치가 아니라 "경험 누적 + retrieval"로 점점 똑똑해진다.
// 핵심 안전: verify pass(테스트=판사)로 review 도달한 작업의 학습만 신뢰.
export interface Lesson {
  id: number
  projectId: string
  taskId: string
  scope: 'project' | 'global' // project=해당 repo 한정, global=모든 Navi에 주입
  trigger: string // 언제 적용되나 (작업 유형·키워드 — retrieval 매칭 힌트)
  lesson: string // 재사용 가능한 학습 본문
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
  condition: 'no-lessons' | 'with-lessons' // 학습 off/on
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
  regression?: string | null // §24 — 학습 ON이 지표를 악화시키면 경보(틀린 학습 누적 감지), 없으면 null
}

// ── 설정 (settings 테이블의 타입 뷰, §9b 티어링 매핑 포함) ──

export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'local'

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
// 통화 단계만 싣는다 — 에러 본문은 dlog와 getDiscordStatus().error로 이미 남아 렌더러가 여기서 읽지 않는다.
export interface DiscordStateEvent {
  state: DiscordCallState
}

// TTS 스트리밍 청크('tts:chunk' 이벤트) — id=스트림 세대(불일치 청크는 렌더러가 폐기),
// seq=청크 순번, uri=mime 포함 data URI, fallback=로컬 엔진 실패로 edge 대체(B7-2 통보용), last=마지막.
// error=전 엔진 합성 실패(edge 폴백까지) — main이 seq:-1·uri:'' 종료 청크로 알린다(원인 없는 무음 방지).
export interface TtsChunkEvent {
  id: number
  seq: number
  uri: string
  fallback?: boolean
  last: boolean
  error?: string
}

export interface LainSettings {
  concurrencyCap: number // 동시 working 작업 수 (§9-7)
  projectParallelCap: number // D14 — 프로젝트당 동시 활성 작업 상한(기본 1=현행). 2~4=같은 레포 병렬 opt-in — 충돌은 D8 rebase→verify가 사후 판사
  taskTokenBudget: number // D7 — 작업 하나의 누적 토큰이 이 값을 넘으면 세션 경계에서 일시정지(blocked)+에스컬레이션. 0 = 무제한(off)
  usageWindowTokenLimit: number // D7 — 최근 창(USAGE_WINDOW_MIN분) 전역 누적 토큰 한도. 근접 시 신규 스폰을 큐로 우회하고 judge 티어를 강등. 0 = off
  naviModel: ModelTier // Navi 본 작업 (§9b)
  managerModel: ModelTier // 관리자 채팅
  judgeModel: ModelTier // clarify 판정·ask_manager 즉답 등 짧은 판정류
  localBaseUrl: string // 'local' 티어의 llama-server 주소(Anthropic /v1/messages 네이티브). 기본 http://127.0.0.1:8080
  anthropicApiKey: string // E5 — 구독 로그인 대신 API 키로 인증(비었으면 구독 OAuth 사용). 설정 시 non-local 티어 spawn env의 ANTHROPIC_API_KEY로 주입. 시크릿(로그 금지 §9-6)
  managerPermissionMode: TaskPermissionMode // 레인 채팅 권한 모드(입력창 바)
  managerEffort: ManagerEffort // 레인 작업량(effort) — 입력창 바
  managerEffortAuto: boolean // 작업량 자동 — 레인이 스스로(adaptive) 조절
  managerFastMode: boolean // 레인 빠른 모드(Opus 빠른 출력)
  managerFastChat: boolean // 빠른 대화 레인 — 작업 아닌 대화 턴은 도구 없는 경량 선응답으로 즉답, 행동이면 본체로 승격 (기본 on)
  userTitle: string // 레인이 사용자를 부르는 호칭(기본 '유저'). 채팅 라벨·레인 말투에 반영. set_user_title 도구/환경설정으로 변경
  userAliases: string[] // 외부 앱(디스코드·카톡 등) 채팅에서 사용자 본인의 표시명/닉네임 — 감시(오버레이)가 화면 속 본인/타인을 구별하는 데 사용
  defaultTaskMode: 'auto' | 'autonomous' | 'interactive' // 작업 위임 기본(auto=현 자동판정)
  reviewDepthDefault: ReviewDepth // L4(P6) — 작업별 reviewDepth 미지정 시 기본 강도(기본 standard). start_task로 작업별 override 가능
  // 어깨너머 모드 (실시간 감시 + 우하단 오버레이) — 메인창 안 볼 때 화면 작업을 관찰해 먼저 조언
  overlayMonitoringEnabled: boolean // 어깨너머 on/off (기본 off, opt-in)
  monitorSensitiveApps: string[] // 민감 앱 블랙리스트 — 포그라운드면 감시/조언 스킵 (시크릿 보호 §9-6)
  monitorCooldownSec: number // 반응 최소 간격(초) — 연속 수다 억제 (기본 30)
  monitorPollMs: number // 포그라운드/유휴 폴링 간격(ms) — L0 결정론 (기본 1500)
  overlayDevApps: string // 개발 컨텍스트 화이트리스트 사용자 확장(CSV, 기본 ''). 기본 목록(devfocus.DEFAULT_DEV_APPS)에 더해짐 — 개발 도구 화면이 아니면 감시 자체를 스킵(P4)
  chattiness: number // 말수 0~4 (0=묵언 · 2=기본 · 4=수다쟁이) — UI 상호작용 대사(quips)+감시 선제발화 빈도. 감시 on/off와 별개
  // E6 — 워크스페이스 자동 스캔 대상. 빈값이면 기본(C:\workspace / apps·games·tools). 환경변수
  // LAIN_WORKSPACE·LAIN_SCAN_DIRS가 있으면 그쪽이 우선(오버라이드).
  workspaceRoot: string // 스캔 루트('' = 기본 C:\workspace)
  scanDirs: string[] // 루트 하위 스캔 폴더([] = 기본 apps/games/tools)
  // Phase 3 자동화 (§15, §12.5b)
  scanIntervalMin: number // 주기 스캔 간격(분), 0 = 끔
  closeToTray: boolean // 창 닫기 → 트레이 상주
  autoStart: boolean // 로그인 시 자동 시작 (트레이로)
  autoPriority: boolean // 주기 스캔 변화 시 관리자 자동 우선순위 판단 (LLM 비용)
  autoStartTaskMd: boolean // D5 — 새 TASK.md 발견 시 mode:autonomous 마커+verify_cmd 있으면 자동 착수 (기본 off, opt-in)
  autoRebaseOnMerge: boolean // D8 — merge(결재)가 ff 불가일 때 worktree 브랜치를 main에 자동 rebase→verify 재실행→ff 재시도. 충돌·verify실패면 무해하게 브랜치만 남김(비파괴). 기본 on
  lessonCurator: boolean // §24 Phase3 — idle 시 judge가 중복 학습을 semantic 병합 (LLM 비용, 기본 off)
  turnReviewEnabled: boolean // 학습루프 T3 — 레인 채팅 턴 종료 후 judge가 학습/스킬 후보를 자동 추출 (기본 on, 구 signalReview 대체)
  verifyNudgeEnabled: boolean // 학습루프 T7 — 레인이 코드 수정 후 검증 없이 턴을 끝내면 다음 턴에 1회 넛지 (기본 on)
  idleMin: number // idle 판정 임계(분) — 마지막 채팅 활동 후 이 시간 경과해야 끼어듦 허용 (기본 3)
  routinesEnabled: boolean // 선언적 routines 스케줄 디스패치 on/off (기본 off — off면 등록만 되고 실행 안 됨)
  ccHooksEnabled: boolean // 클로드코드 연동 — 레인 밖에서 직접 실행한 CC 세션을 레인이 인지(훅 자동 설치). 기본 off
  onboardingDone: boolean // 첫 실행 위저드 완료 플래그(기존 설치는 마이그레이션에서 자동 true)
  // §20.3 텔레그램 채널 — 자리 비웠을 때 폰으로 와이어드 지휘·결재
  telegramEnabled: boolean // 텔레그램 어댑터 on/off
  telegramBotToken: string // BotFather 토큰 (시크릿 — 로그/다이제스트 금지 §9-6)
  telegramChatId: string // 허용 채팅 ID 화이트리스트 (비면 첫 메시지로 부트스트랩, §20.5)
  groqApiKey: string // STT(Groq Whisper) 용 — 비면 음성 메시지 비활성화 (시크릿 §9-6)
  contextCompactThreshold: number // 무한세션 — 관리자 대화 컨텍스트 점유가 이 토큰 넘으면 월드모델 압축 후 새 세션. 0 = 끔
  naviHandoffThreshold: number // Navi 유한세션 핸드오프 — Navi 대화 점유가 이 토큰 넘으면 핸드오프 md 기록 후 새 세션(≠무한세션). 0 = 끔
  turnWatchdogMin: number // 무진전 자동종료 임계(분) — Lain 응답이 이 시간 동안 진전 없으면 자동 종료. 0 = 끔
  approvalTimeoutMin: number // D4 — 작업 Navi 승인 대기가 이 시간 무응답이면 '재알림 1회'(PC·텔레그램). 거절 아님 — 이후 무한 대기(세션·worktree 보존). 0 = 재알림 끔(무한 대기). 기본 30
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
  gptSovitsSpeed: number // 말 속도(speed_factor) 0.5~2.0 (기본 1.15 — 기본 1.0보다 조금 빠르게)
  // Supertonic(로컬 ONNX 사이드카) — 한국어 내장 보이스, 파이썬 없음(모델 첫 사용 시 1회 다운로드)
  supertonicVoice: string // 보이스 스타일 F1~F5 / M1~M5 (기본 F5) / 'custom'(개인 보이스·로컬)
  supertonicCustomVoice: string // 개인 보이스(로컬) JSON 파일명 — %APPDATA%\lain\voices\ 안에 위치. 배포 미포함(사용자가 직접 가져옴)
  supertonicCustomSample: string // 가져온 개인 음성 샘플(오디오) 파일명 — voices\ 에 영구 보관(기억·표시용). 보이스로 쓰려면 스타일 JSON 변환 필요
  supertonicSpeed: number // 말 속도 0.5~2.0 (기본 1.05)
  supertonicStep: number // 디노이즈 스텝 2~16 (높을수록 품질↑·느림, 기본 8)
  voiceTone: 'deadpan' | 'subtle' | 'expressive' // 음성 답변 기본 톤(감정 태그 사용량). 기본 deadpan(무미건조·태그 0)
  koreanizeTts: boolean // 한국어 발음 필터 — 영어/숫자를 한글 음차로(Supertonic 전용). 기본 on
  pcVoiceOut: boolean // PC 창에서 레인 답변을 음성으로 재생(🔊 토글). 영구 저장 — 재시작에도 유지. 기본 off
  pcVoiceIn: boolean // PC 창에서 마이크 입력(STT) 버튼 표시. 기본 off
  // 자동 업데이트 (electron-updater + GitHub Releases)
  updateNotify: boolean // ② 새 버전 감지 시 Lain이 자발 제안(작업 한가할 때만). 기본 on
  updateAutoDownload: boolean // ③ 백그라운드 자동 '다운로드'만(설치는 항상 수동). 기본 off
  // E8 확장 — 자동 백업. 하루 1회(로컬 날짜 기준) lain.sqlite를 데이터 폴더 backups\에 복사.
  autoBackupEnabled: boolean // 하루 1회 자동 백업 on/off (기본 on)
  autoBackupKeep: number // 자동 백업 보존 개수 — 초과분은 오래된 것부터 삭제 (기본 7)
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
  // A4 — TodoWrite 진행 체크리스트. text는 JSON.stringify(TodoItem[])(그 시점의 todos 전체 — 최신 상태가 진실).
  | { taskId: string; kind: 'todo'; text: string; speaker?: TaskSpeaker }
  // D6 — 장기 작업 중간보고. text="진행중: N턴 · 커밋 M · +X/-Y"(결정론 계산, LLM 없음). speaker 없음(시스템 로그 줄).
  | { taskId: string; kind: 'checkpoint'; text: string; speaker?: TaskSpeaker }
  // D12 — codex 명령 실행 감사. codex는 승인 큐가 없어(샌드박스가 방어선) 사후 명령 로그가 유일한 관측창이라
  // generic status와 구분해 감사 가시 이벤트로 노출한다. text="$ <cmd> → OK|exit N"(exit!=0는 렌더러가 경고색).
  | { taskId: string; kind: 'exec'; text: string; speaker?: TaskSpeaker }

type ChatEventKind =
  | { kind: 'user'; text: string; origin?: 'pc' | 'telegram' | 'discord' } // 사용자 입력 에코 — 텔레그램/디스코드發 메시지를 PC에 라이브 표시할 때(출처 운반)
  | { kind: 'assistant'; text: string; proactive?: boolean } // proactive=어깨너머 자발 발화(레인이 먼저)
  | { kind: 'assistant_delta'; text: string } // 스트리밍 텍스트 증분 — 렌더러가 라이브 버블에 이어붙임(영속X, 최종 assistant가 확정)
  | { kind: 'tool'; text: string } // 승인 대기 등 시스템 라인 (§5.6 Navi 직접 채팅)
  // failedTools: 이번 턴 도구 실패(is_error) 건수(A7) — 0이거나 없으면 배지 미표시.
  // contextTokens/contextThreshold(A5): 무한세션 컨텍스트 게이지 배선 — 매 result에 실어 보낸다(조회 IPC 대신
  // 기존 이벤트에 편승, 별도 왕복 없음). threshold<=0(압축 비활성)이면 게이트가 죽어 있으므로 둘 다 생략.
  | {
      kind: 'result'
      costUsd: number | null
      tokens: number | null
      sessionId: string | null
      failedTools?: number
      contextTokens?: number
      contextThreshold?: number
    }
  | { kind: 'error'; message: string }
  // 인라인 선택형/체크형 질문(Lain→사용자) — ask_user 도구가 카드를 띄우고 답을 기다린다(라이브 전용).
  | { kind: 'question'; questionId: string; question: string; options: string[]; multi: boolean }
  | { kind: 'questionResolved'; questionId: string; answerText: string } // 답 제출됨 — 카드 제거

// conversationId: 어느 대화의 이벤트인지. 텔레그램·PC가 같은 대화를 공유하므로
// 렌더러가 '현재 연 대화면 본문에 추가, 아니면 목록 미리보기만 갱신'을 판별하는 데 쓴다.
export type ChatEvent = ChatEventKind & { conversationId?: string }

// B5 — 대기 중 인라인 질문(ask_user·편집/계획 승인). main 인메모리 보관 → 렌더러 리로드 시 question:pending으로 복원.
export interface PendingQuestion {
  questionId: string
  question: string
  options: string[]
  multi: boolean
  conversationId: string
  createdAt: number // main epoch ms — 표시엔 안 쓰이나 정렬·진단용
}

// §5.6 Navi 직접 채팅 — 프로젝트 단위 이벤트
export type NaviChatEvent = { projectId: string } & ChatEvent

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

// A15 — Ctrl+F '전체 기간' DB 전문검색(store.searchChatHistory) 히트 1건.
export interface ChatHistoryHit {
  id: number
  conversationId: string | null
  role: string
  when: string
  snippet: string
}

// C4 — 토큰 사용량 일별 집계용 원시 작업 행. main은 창(window) 내 원시 행만 넘기고, 로컬 날짜 버킷팅은
// 렌더러 순수 함수(tokenUsage.summarizeUsage)가 한다(created_at은 UTC 저장이라 SQL date()면 하루 어긋남).
export interface TaskUsageRow {
  projectId: string
  tokens: number
  costUsd: number
  createdAt: string // UTC 'YYYY-MM-DD HH:MM:SS'
}

// C6 — 전역 활동 피드 원시 행(main→렌더러). task_events(의미있는 kind)·cc_events를 하나로 실어 보낸다.
// 병합/정렬/라벨링은 렌더러 순수 함수(activityFeed.mergeActivity)가 한다.
export interface ActivityRaw {
  source: 'task' | 'cc'
  at: string // created_at (UTC 'YYYY-MM-DD HH:MM:SS')
  detail: string // task: kind(status|error|exit…) / cc: event(SessionStart|SessionEnd)
  text?: string | null // task_events.content (status/error 본문). cc는 없음
  taskId?: string | null // task 출처
  projectId?: string | null // cc 출처
  summary?: string | null // cc 출처: cc_events.summary (SessionEnd 요약)
}

// C6 — 병합·라벨링된 활동 요소(표시용). mergeActivity 산출물.
export interface ActivityItem {
  source: 'task' | 'cc'
  at: string
  projectId: string | null
  taskId: string | null
  label: string // 사람이 읽을 한 줄
  kind: string // 원본 kind/event (렌더러 아이콘 분기용)
}

// 파일 첨부 (채팅 입력 - 이미지·텍스트)
export interface FileAttachment {
  name: string
  mimeType: string   // e.g. "image/png", "text/plain"
  data: string       // 이미지: base64 인코딩(data: 부분만), 텍스트: UTF-8 내용
  isImage: boolean
}

// 클로드코드(데스크톱/터미널) 세션 메타 — ~/.claude/projects 트랜스크립트에서 읽음(ccsessions.ts)
export interface CcSessionInfo {
  id: string // 세션 id(파일명)
  title: string // custom-title 또는 첫 사용자 메시지 머리
  firstUserText: string
  lastAt: number // 마지막 활동(파일 mtime, ms)
  cwd: string
  gitBranch: string
  entrypoint: string // 'claude-desktop' 등 — 데스크톱/CLI 출처 구분
}

// preload가 contextBridge로 노출하는 API 표면
export interface LainApi {
  listProjects(): Promise<ProjectView[]>
  scanProjects(): Promise<number>
  addProjectDialog(): Promise<ProjectView | null>
  setMuted(id: string, muted: boolean): Promise<void> // '숨김' 토글 — 구 대기실(setEnabled) 대체
  removeProject(id: string): Promise<void>
  refreshStatus(id?: string): Promise<void>
  runVerify(id: string): Promise<void>
  // A12 — @파일 자동완성용 파일 목록(.gitignore 존중, 상한 적용). projectId 있으면 그 프로젝트 cwd만
  // (Navi 드릴 범위, 상대경로), 없으면 등록된 모든 프로젝트(레인 채팅 범위, 'projectId/상대경로' 형태).
  listFiles(projectId?: string): Promise<string[]>
  // CC 세션 열람 — 프로젝트의 클로드코드(데스크톱/터미널) 세션 목록·내용 발췌(읽기 전용)
  listCcSessions(projectId: string): Promise<CcSessionInfo[]>
  ccSessionDigest(projectId: string, sessionId: string): Promise<string | null>
  sendChat(text: string, attachments?: FileAttachment[], conversationId?: string): Promise<void>
  stopChat(): Promise<void>
  resetManager(): Promise<void> // Lain 무한세션 새로고침 — 진행 중 응답 멈추고 SDK 세션·월드스테이트 비움(로그는 보존)
  compactNow(conversationId?: string): Promise<{ ok: boolean; message: string }> // A5 — /compact 수동 압축(자동 압축과 동일 로직 재사용)
  onProjectsUpdated(cb: (list: ProjectView[]) => void): () => void
  onChatEvent(cb: (ev: ChatEvent) => void): () => void
  getBriefing(): Promise<string | null>
  onBriefingUpdated(cb: (text: string) => void): () => void
  // 앱(main) 기동 시각 스탬프 — 렌더러 크래시 후 자동 reload돼도 불변. '이번 실행' 경계의 단일 출처.
  appStartedAt(): Promise<string>
  // Phase 1: tasks
  listTasks(): Promise<Task[]>
  startTask(
    projectId: string,
  ): Promise<{ taskId?: string; mode?: NaviMode; error?: string; queued?: boolean; queuePos?: number }> // D1/D7 — queued=큐 적재됨, queuePos=대기 순위
  answerClarify(taskId: string, answers: string): Promise<void>
  resolveReview(
    taskId: string,
    action: 'merge' | 'keep-branch' | 'discard' | 'rework',
    comment?: string, // T15 — rework일 때 지적사항(수정 요청 내용)
  ): Promise<string>
  revertMerge(taskId: string): Promise<string> // D8 — done+병합된 작업의 병합을 되돌린다(비파괴 범위 revert)
  cancelTask(taskId: string): Promise<void>
  resumeTask(taskId: string): Promise<void> // B3 — error 상태 작업을 worktree·세션 그대로 수동 재개
  setTaskPermissionMode(taskId: string, mode: TaskPermissionMode): Promise<void> // P2 권한모드 변경
  setTaskThinking(taskId: string, level: ThinkingLevel): Promise<void> // P2 thinking 예산 변경
  setTaskDisallowedTools(taskId: string, tools: string[]): Promise<void> // P2 금지 도구 변경
  // B17 — 작업 입력 이미지 첨부(다음 실행/재개부터 Navi가 봄). 상한(장수·크기·이미지만)의 단일 출처는 main —
  // accepted=실제 저장된 장수, dropped=상한에 걸려 버려진 장수(렌더러가 상한을 복제해 세지 않아도 된다).
  setTaskImages(
    taskId: string,
    images: FileAttachment[],
  ): Promise<{ accepted: number; dropped: number }>
  setTaskFastMode(taskId: string, on: boolean): Promise<void> // B4 — Opus 빠른 출력 모드 토글(다음 실행/재개부터 적용)
  setTaskModel(taskId: string, model: ModelTier | ''): Promise<void> // D10 — 작업별 모델 고정('' = 전역, 다음 실행/재개부터 적용)
  rerunTask(taskId: string): Promise<{ taskId?: string; mode?: NaviMode; error?: string }> // D11 — done/cancelled 작업을 같은 content로 새 task 생성해 착수(원본 보존). mode=재판정된 실행 모드(orchestrator.rerunTask→startTask 반환)
  taskEvents(taskId: string): Promise<TaskEvent[]>
  taskDiff(taskId: string): Promise<string>
  listApprovals(): Promise<Approval[]>
  resolveApproval(id: number, approved: boolean, answer?: string): Promise<void>
  // 인라인 질문(ask_user) 답 제출 — 대기 중인 Lain 턴을 깨운다. answer는 선택된 보기 텍스트 배열.
  answerQuestion(questionId: string, answer: string[]): Promise<void>
  // B5 — 대기 중 인라인 질문 조회. 렌더러 마운트/리로드 시 재요청해 카드를 복원(main 인메모리 → 리로드 유실 방어).
  pendingQuestions(): Promise<PendingQuestion[]>
  onTasksUpdated(cb: (list: Task[]) => void): () => void
  onTaskEvent(cb: (ev: TaskEvent) => void): () => void
  onApprovalsUpdated(cb: (list: Approval[]) => void): () => void
  // 설정
  getSettings(): Promise<LainSettings>
  setSettings(patch: Partial<LainSettings>): Promise<LainSettings>
  // 온보딩(첫 실행 위저드) — Claude 실행 파일·로그인 자격증명 결정론 검사
  // claudeBinPath: 기대 경로(CLAUDE_BIN) — 진단용 표기. isPackaged: 패키징 실행 여부(dev면 npm install 안내 분기).
  onboardingStatus(): Promise<{
    claudeBin: boolean
    loggedIn: boolean
    claudeBinPath: string
    isPackaged: boolean
  }>
  // E2 — 온보딩 '로그인 터미널 열기'. 번들 claude로 새 콘솔에 `auth login`(구독 OAuth)을 띄운다.
  onboardingLogin(): Promise<{ ok: boolean; error?: string }>
  // E6 — 유효 워크스페이스 루트/스캔폴더(env 오버라이드 반영). 빈상태 문구·SCAN 제목·폴더추가 기본경로 표시용.
  workspaceInfo(): Promise<{
    root: string
    scanDirs: string[]
    envRootOverride: boolean
    envScanOverride: boolean
  }>
  // E8 — 데이터 폴더 열기(%APPDATA%\lain). 반환은 연 경로.
  openDataFolder(): Promise<string>
  // E8 — 백업 내보내기(WAL 병합 후 lain.sqlite를 사용자 선택 경로로 복사). busy=병합 미완(잠시 후 다시).
  backupData(): Promise<{ ok?: boolean; bytes?: number; busy?: boolean; canceled?: boolean; error?: string }>
  // E8 확장 — 자동 백업 상태. lastAt=마지막 성공 시각(ISO), lastError=마지막 실패 사유(성공하면 비워짐).
  // 둘 다 기록이 없으면 null — 설정 화면의 '자동 백업' 힌트에 '최근 백업 …' / 실패 표시로 쓴다.
  autoBackupStatus(): Promise<{ lastAt: string | null; lastError: string | null }>
  onSettingsUpdated(cb: (s: LainSettings) => void): () => void // 설정 변경 라이브 반영(레인 도구·Prefs → 라벨 등)
  onQuip(cb: (q: { text: string }) => void): () => void // 상호작용 대사(quip) 수신 — 캐릭터 옆 말풍선 표시(수신 전용 push)
  // D15 되감기 — 레인 직접 편집 턴 체크포인트. 요약=확인창 파일 목록(existed=false면 복원 시 삭제),
  // 복원=파일별 pre-turn 스냅샷 되쓰기(복원 직전 상태도 revertTurnId 그룹으로 남아 재되돌리기 가능).
  editTurnCheckpoints(turnId: string): Promise<{ filePath: string; existed: boolean }[]>
  // files·conversationId는 재리뷰 #4 — main(ipc)이 un-revert 카드를 emit하는 소스(렌더러는 ok/restored/error만 소비).
  revertEditTurn(turnId: string): Promise<{
    ok: boolean
    restored: number
    revertTurnId?: string
    files: string[]
    conversationId: string
    error?: string
  }>
  // D13 크로스레포 그룹 — 결재 패널 정보 + all-or-nothing 일괄 결재
  taskGroupInfo(groupId: string): Promise<{
    id: string
    title: string
    children: { taskId: string; projectId: string; title: string; state: TaskState; verifyResult: string | null }[]
  } | null>
  resolveGroup(groupId: string, action: 'merge' | 'keep-branch' | 'discard'): Promise<string>
  // 자동 업데이트 — ④ UI 버튼/상태 + ② Lain 제안 배너
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdate(): Promise<UpdateStatus>
  downloadUpdate(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
  // TTS 설정 테스트 재생 — 현재 엔진으로 합성한 오디오 data URI(mime 포함, 빈 텍스트면 '') + 모델 상태
  testTts(text?: string): Promise<string>
  importVoice(): Promise<{ file: string; kind: 'json' | 'audio'; error?: string } | null>
  openVoicesFolder(): Promise<string>
  sttVoice(bytes: Uint8Array): Promise<{ text?: string; error?: string }>
  // TTS 스트리밍 — 문장 단위 합성 청크가 'tts:chunk' 이벤트로 흐른다(첫 문장부터 즉시 재생).
  // speakTtsStream은 스트림 id를 즉시 반환(합성은 배경) — 렌더러는 id 불일치 청크를 폐기해 레이스 차단.
  speakTtsStream(text: string): Promise<{ id: number }>
  stopTtsSpeak(): Promise<void>
  onTtsChunk(cb: (ev: TtsChunkEvent) => void): () => void
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
  stopNaviChat(projectId: string): Promise<void>
  onNaviChatEvent(cb: (ev: NaviChatEvent) => void): () => void
  // 대화 제목 자동요약 갱신 알림 — target('manager' | projectId)의 대화목록/미리보기를 새로고침
  onConversationsUpdated(cb: (target: string) => void): () => void
  // 다중 세션 — 대상별 대화 목록 / 새 대화 / 대화 메시지 / 활성 대화
  listConversations(target: string): Promise<Conversation[]>
  createConversation(target: string): Promise<string> // 새 대화 id(활성으로 설정됨) 반환
  // A15 — beforeId(옵션)로 위로 스크롤 페이징: 그 id보다 오래된 메시지 limit개(기본 200)를 더 로드.
  conversationMessages(conversationId: string, limit?: number, beforeId?: number): Promise<ChatMessage[]>
  getActiveConversation(target: string): Promise<string>
  setActiveConversation(target: string, conversationId: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  // B9 — 삭제 확인창용 전건 메시지 수(워터마크·limit 무관, 실제 삭제량과 일치).
  conversationMessageCount(id: string): Promise<number>
  renameConversation(id: string, title: string): Promise<void>
  // 채팅 우클릭 메뉴 — 메시지 클립보드 복사 / 챕터 고정·해제(title=null이면 해제)
  copyText(text: string): void
  setChapter(messageId: number, title: string | null): Promise<void>
  // A16 — 대화 전체를 markdown(.md)으로 저장(showSaveDialog). 취소 시 { ok: false }.
  exportConversationMarkdown(conversationId: string): Promise<{ ok: boolean; filePath?: string; error?: string }>
  // 채팅 텍스트 링크화(A3) — URL은 브라우저로, 파일 경로는 탐색기에서 선택 상태로 열기(main 경유 필수)
  openExternalUrl(url: string): Promise<{ ok: boolean; error?: string }>
  revealPath(path: string): Promise<{ ok: boolean; error?: string }>
  // A15 — Ctrl+F '전체 기간' 토글: 레인 대화(scope='manager') DB 전문검색(store.searchChatHistory 그대로).
  searchChatHistory(query: string, limit?: number): Promise<ChatHistoryHit[]>
  // A15 — 전체기간 검색 히트 클릭 시 그 메시지가 속한 대화의 주변 구간을 시간순으로 로드(점프용).
  messagesAround(messageId: number, before?: number, after?: number): Promise<ChatMessage[]>
  // C4 — 토큰 사용량 일별 집계: 최근 windowDays일(기본 15)에 생성된 작업의 원시 행. 로컬 날짜 버킷팅은
  // 렌더러(summarizeUsage)가 한다. UTC/로컬 경계 slop 흡수용으로 창을 표시일수(14)보다 하루 넓게 잡는다.
  dailyUsage(windowDays?: number): Promise<TaskUsageRow[]>
  // C6 — 전역 활동 피드: task_events(의미있는 kind)+cc_events 원시 행(시간 역순 병합은 렌더러 mergeActivity).
  recentActivity(limit?: number): Promise<ActivityRaw[]>
  // §22 자기개선 — 누적 학습
  listLessons(): Promise<Lesson[]>
  // C7 — 병합 통합본(umbrella)에 흡수된 원본 학습 목록(absorbed_into 역참조, 읽기 전용 SELECT).
  lessonsAbsorbedInto(umbrellaId: number): Promise<Lesson[]>
  // §24 학습 수명주기 — 보관/복구/핀/직접추가
  unflagLesson(id: number): Promise<boolean>
  archiveLesson(id: number): Promise<boolean> // 수동 미사용(보관) — pinned·user 무관 항상 보관
  pinLesson(id: number, pinned: boolean): Promise<boolean>
  addLesson(lesson: {
    projectId: string
    scope?: 'project' | 'global'
    trigger: string
    lesson: string
  }): Promise<void>
  onLessonsUpdated(cb: (list: Lesson[]) => void): () => void
  // §curation revert — 한 batch의 umbrella archive + 흡수 학습 active 복구, 복구된 학습 수 반환
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
  listBenchRuns(): Promise<BenchSummary[]> // C10 — 영속된 벤치 이력, 시간순(오래된 런 먼저)
  // 창 제어 (frameless — OS 타이틀바를 헤더에 통합)
  windowMinimize(): Promise<void>
  windowMaximizeToggle(): Promise<boolean>
  windowClose(): Promise<void>
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
  onOpenInbox(cb: () => void): () => void
  // 인박스 열림/닫힘 통지 — main의 "자리 비움" 판단용 (fire-and-forget, copyText와 동일)
  setInboxOpen(open: boolean): void
  // 렌더러 조용한 실패·렌더 예외 보고 — main이 renderer-crash.log에 한 줄 남긴다(message/스택만, 시크릿 금지).
  reportError(payload: { kind: string; message: string; componentStack?: string }): Promise<void>
  // 어깨너머 오버레이 — 클릭 시 메인창 복귀 / 내용 높이에 맞춰 창 리사이즈(fire-and-forget)
  openMainWindow(): Promise<void>
  overlayResize(height: number): void
  overlaySetVisible(visible: boolean): void // 유저 감시 — proactive 반응 시 오버레이 표시/숨김
}
