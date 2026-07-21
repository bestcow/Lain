// 렌더러 순수 헬퍼 — App.tsx 컴포넌트 본문에서 분리한 상태 비의존 로직.
// import 부작용 0(window.lain·React 미사용)이라 단위테스트가 쉽다.
import type { ChatHistoryHit, ChatMessage, FileAttachment, Task, TaskEvent } from '../../shared/types'
import type { SlashCmd } from '../components/SlashMenu'
import { decodeToolLine } from '../../shared/toolline'
import { decodeTodoLine } from '../../shared/todoline'
import { decodeEditDiffLine } from '../../shared/editdiff'

/** Anthropic이 받는 이미지 4종만 이미지로 취급 — bmp/svg/tiff 등은 첨부 시 API 400 방지. */
export function isImageMime(mimeType: string): boolean {
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)
}

/** '/' 슬래시 명령 필터 — 첫 토큰(공백 분리) 접두 매칭, 대소문자 무시. */
export function filterSlash(input: string, commands: SlashCmd[]): SlashCmd[] {
  const first = input.split(/\s+/)[0].toLowerCase()
  return commands.filter((c) => c.cmd.toLowerCase().startsWith(first))
}

/** ChatEvent가 현재 열린 대화에 속하는지 — 레거시(conversationId 없음)·세션 불일치 분기. */
export function isEventForOpenConv(openConv: string | null, eventConvId: string | null | undefined): boolean {
  return !openConv || !eventConvId || eventConvId === openConv
}

/**
 * 이번 앱 실행 시작 시각 스탬프 — DB created_at(store.nowStamp)과 동일한
 * 'YYYY-MM-DD HH:MM:SS'(공백 구분, UTC) 포맷으로 만든다.
 * toISOString()의 'T'/'Z'·ms를 그대로 쓰면 ' '(0x20) < 'T'(0x54)라서 모든 DB 메시지가
 * 항상 더 작다고 판정돼 thisSession이 빈 배열을 반환(매 턴 채팅창이 리셋되는 버그) → 포맷을 맞춘다.
 */
export function sessionStartStamp(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * DB 타임스탬프를 epoch ms로. datetime('now')=UTC 'YYYY-MM-DD HH:MM:SS'(공백·Z 없음)를 로컬로 오독하지 않도록
 * 공백형엔 'Z'를 붙여 UTC로 해석한다(git %cI 등 'T'+오프셋은 그대로). tokenUsage.parseUtcStamp와 동일 규약
 * — 중복 최소화 위해 향후 공용 모듈로 합칠 여지(현재는 순환 의존 회피 위해 지역 헬퍼). 실패 시 NaN.
 */
export function parseStampMs(s: string): number {
  const t = s.trim()
  if (!t) return NaN
  const iso = t.includes('T') ? t : t.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? '' : 'Z')
  return Date.parse(iso)
}

/**
 * 기준 시각(ISO) 이후 경과 — '방금' / '12분째' / '3시간째' / 'N일째'.
 * TaskDrawer(작업 경과)·AttentionInbox(승인 대기, C5) 공용.
 */
export function fmtElapsed(fromIso: string): string {
  const start = parseStampMs(fromIso)
  if (Number.isNaN(start)) return ''
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000))
  if (sec < 60) return '방금'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분째`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간째`
  return `${Math.floor(hr / 24)}일째`
}

/**
 * 과거 시각(ISO) 기준 상대시간 — '방금' / '12분 전' / '3시간 전' / 'N일 전'.
 * fmtElapsed(진행 중 대기·작업 경과, '~째')와 달리 이미 끝난 사건(마지막 커밋 등, C2)용 '~전' 표현.
 */
export function fmtRelTime(fromIso: string): string {
  const start = parseStampMs(fromIso)
  if (Number.isNaN(start)) return ''
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000))
  if (sec < 60) return '방금'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  return `${Math.floor(hr / 24)}일 전`
}

/** fmtElapsed와 같은 경과시간을 분 단위 숫자로 — 임계 비교(C5 강조 배지)용. NaN이면 -1. */
export function elapsedMinutes(fromIso: string): number {
  const start = parseStampMs(fromIso)
  if (Number.isNaN(start)) return -1
  return Math.max(0, Math.floor((Date.now() - start) / 60000))
}

/** 인박스 헤더 툴팁(C5) — 대기 중인 항목들의 타임스탬프 중 가장 오래된 것을 fmtElapsed로. 없으면 null. */
export function longestWait(timestamps: string[]): string | null {
  if (timestamps.length === 0) return null
  const oldest = timestamps.reduce((a, b) => (parseStampMs(a) <= parseStampMs(b) ? a : b))
  return fmtElapsed(oldest)
}

/**
 * 비용 누적 표시(A5) — result 이벤트의 costUsd 합계를 '$X.XX'로 포맷. 구독 사용자는 costUsd가
 * 0/undefined/null이라(API 종량과 무관) '설정 표시=실제 일치' 원칙상 $ 부분 자체를 숨긴다(빈 문자열).
 */
export function fmtCost(usd: number): string {
  if (!usd || usd <= 0) return ''
  return `$${usd.toFixed(2)}`
}

/** 사용량 라벨(A5) — 'N tok' 또는 'N tok · $X.XX'(구독이면 costUsd 0/undefined라 $ 부분 자동 생략). */
export function usageLabel(tokens: string, costUsd: number): string {
  const cost = fmtCost(costUsd)
  return cost ? `${tokens} tok · ${cost}` : `${tokens} tok`
}

// 컨텍스트 게이지 %(A5) — 공용 단일 출처(shared/gauge.ts). 렌더러는 main을 import하지 않는 경계를
// 지키면서(shared는 양쪽 공용) 계산식을 한 곳에 둔다. 값은 ChatEvent.result에 실려 온다.
export { contextPercent } from '../../shared/gauge'

/** 대화 내 검색 — content substring(대소문자·trim 무시) 매치 메시지 id 목록.
 *  I4 — tool 라인은 content가 encodeToolLine('display\x1Fraw') 형태라 숨겨진 raw까지 매치하면
 *  하이라이트(display만) 없는 유령 히트가 카운트·스크롤에 잡힌다. 화면에 보이는 display만 검색한다
 *  (원문 검색 포기 — 매니저·Navi 공유 경로라 한 곳 수정으로 둘 다 반영).
 *  A4 — TodoWrite 라인(encodeTodoLine, §todo§ 접두사)은 화면에 위젯(체크리스트 칩)으로만 보이고
 *  raw JSON은 안 보이므로, 같은 원칙으로 검색 대상에서 제외한다(항목 텍스트 안의 우연한 매치=유령 히트 방지).
 *  P2-T3 — editdiff 라인(encodeEditDiffLine, §diff§ 접두사)도 diff JSON(파일경로·코드)이 EditDiffChip
 *  위젯으로만 렌더돼(query 미전달, 하이라이트 없음) 검색되면 유령 히트가 되므로 todo와 동일하게 제외한다. */
export function searchHitIds(msgs: ChatMessage[], query: string): number[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return msgs
    .filter(
      (m) =>
        !decodeTodoLine(m.content) &&
        !decodeEditDiffLine(m.content) &&
        decodeToolLine(m.content).display.toLowerCase().includes(q),
    )
    .map((m) => m.id)
}

/** 입력 히스토리 회상 시 ` [+N개 첨부]` 꼬리표 제거(앵커$ — 중간 삽입은 보존). */
export function stripAttachSuffix(content: string): string {
  return content.replace(/ \[\+\d+개 첨부\]$/, '')
}

/** 초안/회상 키 — manager는 세션(conv)별, Navi/@all은 대상별. */
export function computeTargetKey(target: string, conv: string | null): string {
  return target === 'manager' ? (conv ?? 'manager') : target
}

// B3 — document.activeElement 판정에 필요한 최소 shape만 취해 DOM 없이(jsdom 미의존) 단위테스트 가능.
// 실제 Element/HTMLElement는 구조적으로 이 타입을 만족한다.
interface FocusableLike {
  tagName: string
  isContentEditable?: boolean
}

/** B3 — 사용자가 타이핑 중인 요소(INPUT/TEXTAREA/contentEditable)인지. null이면 false(포커스 없음). */
export function isInteractiveElement(el: FocusableLike | null): boolean {
  if (!el) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  return el.isContentEditable === true
}

/**
 * B3 — 인박스 목록 변동 시 첫 행 재포커스를 강행해도 되는지 판정.
 * 처리로 행이 사라진 경우(개수 감소)에만 다음 행으로 넘어가고, 사용자가 답변 입력 중(activeEl이
 * 입력 요소)이면 새 항목이 도착해도(개수 증가) 포커스를 강탈하지 않는다.
 */
export function shouldRefocusInboxRow(prevTotal: number, total: number, activeEl: FocusableLike | null): boolean {
  if (total < prevTotal) return true // 행 처리 완료 → 다음 행으로
  if (isInteractiveElement(activeEl)) return false // 입력 중이면(신규 도착 포함) 스킵
  return true // 상호작용 중이 아니면 기존처럼 첫 행 포커스 유지
}

// A10 — Navi 직통 채팅 메시지 큐(naviId별). 레인 msgQueue(단일 배열, chatTarget='manager' 전용)를
// naviId 키 맵으로 일반화한 순수 버전 — App.tsx가 useState<Map<string, NaviQueueItem[]>>로 감싸 쓴다.
export interface NaviQueueItem {
  text: string
  attachments: FileAttachment[]
  localId: number
  conversationId?: string // 적재 시점의 대화(naviConv) — 자동 전송 시 사용자가 다른 대화로 전환했어도 원래 대화로 보낸다.
}

/** naviId 큐 끝에 항목을 추가한 새 맵(불변) — 없던 naviId면 새로 생성. */
export function enqueueNaviMsg(
  queues: Map<string, NaviQueueItem[]>,
  naviId: string,
  item: NaviQueueItem,
): Map<string, NaviQueueItem[]> {
  const next = new Map(queues)
  next.set(naviId, [...(next.get(naviId) ?? []), item])
  return next
}

/** naviId 큐의 첫 항목을 꺼낸 결과 — 큐가 비어 있으면 item=null. 소진되면 맵에서 키 자체를 제거(누수 방지). */
export function dequeueNaviMsg(
  queues: Map<string, NaviQueueItem[]>,
  naviId: string,
): { item: NaviQueueItem | null; queues: Map<string, NaviQueueItem[]> } {
  const cur = queues.get(naviId)
  if (!cur || cur.length === 0) return { item: null, queues }
  const [item, ...rest] = cur
  const next = new Map(queues)
  if (rest.length) next.set(naviId, rest)
  else next.delete(naviId)
  return { item, queues: next }
}

/** naviId 큐에서 localId로 특정 항목만 취소(✕) — 취소 후 큐가 비면 키 제거. */
export function cancelQueuedNaviMsg(
  queues: Map<string, NaviQueueItem[]>,
  naviId: string,
  localId: number,
): Map<string, NaviQueueItem[]> {
  const cur = queues.get(naviId)
  if (!cur) return queues
  const filtered = cur.filter((q) => q.localId !== localId)
  const next = new Map(queues)
  if (filtered.length) next.set(naviId, filtered)
  else next.delete(naviId)
  return next
}

/** naviId 큐 전체 비우기(정지·드릴 전환 시) — 제거된 localId 목록도 함께 반환(화면 낙관 메시지 제거용). */
export function clearNaviQueue(
  queues: Map<string, NaviQueueItem[]>,
  naviId: string,
): { removedIds: number[]; queues: Map<string, NaviQueueItem[]> } {
  const cur = queues.get(naviId)
  if (!cur || cur.length === 0) return { removedIds: [], queues }
  const next = new Map(queues)
  next.delete(naviId)
  return { removedIds: cur.map((q) => q.localId), queues: next }
}

/** naviId 큐 길이(UI 플레이스홀더 '큐 N' 표시용) — 없으면 0. */
export function naviQueueLength(queues: Map<string, NaviQueueItem[]>, naviId: string): number {
  return queues.get(naviId)?.length ?? 0
}

// A12 — @파일 자동완성. filterSlash(첫 토큰 접두 매칭)와 별개 트리거('@'는 커서 기준 임의 위치에서
// 시작 가능 — 슬래시는 입력 맨 앞 고정) 이라 전용 파싱 함수로 분리한다.

/** 커서 위치 기준 현재 입력 중인 '@단어' — start/end는 '@' 포함 토큰의 [시작, 끝) 오프셋. 없으면 null. */
export interface AtToken {
  start: number
  end: number
  query: string // '@' 뒤 텍스트(공백·개행 전까지)
}

/** input의 caret 위치 바로 앞에서 시작하는 '@단어'를 찾는다 — 공백/개행을 만나면 토큰 종료.
 *  '@' 앞이 공백/개행/문자열 시작이어야 트리거(이메일 등 단어 중간 '@' 오탐 방지). */
export function parseAtToken(input: string, caret: number): AtToken | null {
  const upToCaret = input.slice(0, caret)
  const at = upToCaret.lastIndexOf('@')
  if (at === -1) return null
  const before = at > 0 ? upToCaret[at - 1] : null
  if (before !== null && before !== ' ' && before !== '\n') return null
  const between = upToCaret.slice(at + 1, caret)
  if (/[\s]/.test(between)) return null // '@' 이후 공백이 caret 전에 있으면 이미 종료된 토큰
  // 토큰 끝(caret 이후 공백/개행/문자열 끝까지) — 삽입 시 뒷부분까지 치환 대상.
  let end = caret
  while (end < input.length && !/[\s]/.test(input[end])) end++
  return { start: at, end, query: input.slice(at + 1, end) }
}

/** @토큰(start~end, '@' 포함)을 상대경로로 치환 — 치환 뒤 공백 하나를 붙여 바로 다음 타이핑이 이어지게 한다. */
export function insertAtPath(input: string, token: AtToken, relPath: string): { text: string; caret: number } {
  const inserted = `@${relPath} `
  const text = input.slice(0, token.start) + inserted + input.slice(token.end)
  return { text, caret: token.start + inserted.length }
}

/** fuzzy 매칭 점수 — query 문자들이 candidate에 순서대로(연속 아니어도) 전부 나오면 매치.
 *  점수는 낮을수록 좋음(첫 매치 위치 + 문자 간 갭 합) — 정렬용. 매치 실패는 null. */
export function fuzzyScore(candidate: string, query: string): number | null {
  if (query === '') return 0
  const c = candidate.toLowerCase()
  const q = query.toLowerCase()
  let ci = 0
  let score = 0
  let firstMatch = -1
  let lastMatch = -1
  for (let qi = 0; qi < q.length; qi++) {
    const idx = c.indexOf(q[qi], ci)
    if (idx === -1) return null
    if (firstMatch === -1) firstMatch = idx
    if (lastMatch !== -1) score += idx - lastMatch - 1 // 갭이 클수록 점수 나쁨(연속 매치 우대)
    lastMatch = idx
    ci = idx + 1
  }
  return score + firstMatch // 앞쪽에서 시작하는 매치를 우대
}

/** 파일 경로 목록을 query로 fuzzy 필터+정렬(점수 오름차순, 동점이면 짧은 경로 우선) — 상위 limit개만. */
export function fuzzyFilterFiles(files: string[], query: string, limit = 30): string[] {
  const scored = files
    .map((f) => ({ f, s: fuzzyScore(f, query) }))
    .filter((x): x is { f: string; s: number } => x.s !== null)
  scored.sort((a, b) => a.s - b.s || a.f.length - b.f.length)
  return scored.slice(0, limit).map((x) => x.f)
}

// A15 — 대화 페이징(위로 스크롤 시 이전 페이지 prepend). 순수 함수로 분리해 커서 계산·병합·중복제거를
// DOM/스크롤과 독립적으로 검증한다(스크롤 위치 보존 자체는 ChatPanel의 effect가 DOM에서 담당).

/** 현재 로드된 메시지 중 가장 오래된(=맨 앞) id를 다음 페이지 요청의 beforeId로 — 비어 있으면 undefined
 *  (더 불러올 기준점이 없음). 음수 id(전송 직후 낙관적 로컬 메시지, 아직 DB 미반영)는 커서로 못 써 건너뛴다. */
export function nextBeforeId(messages: ChatMessage[]): number | undefined {
  const oldest = messages.find((m) => m.id > 0)
  return oldest?.id
}

/** 이전 페이지(older, id 오름차순)를 현재 배열 앞에 붙인다 — id 중복은 제거(older 쪽을 버림, current가 최신
 *  진실). older가 비어 있으면(더 없음) current 그대로. */
export function mergePagedMessages(older: ChatMessage[], current: ChatMessage[]): ChatMessage[] {
  if (older.length === 0) return current
  const existing = new Set(current.map((m) => m.id))
  return [...older.filter((m) => !existing.has(m.id)), ...current]
}

// A15 — Ctrl+F '전체 기간' 토글: 로컬 배열(searchHitIds)이 아니라 DB 전문검색(searchChatHistory) 결과를 쓴다.

/** DB 검색 히트를 화면 하이라이트용 id 목록으로 — 오래된→최신 순으로 뒤집는다(searchHitIds가 반환하는
 *  화면 스크롤 순서와 맞추기 위해. searchChatHistory는 최신순 DESC로 옴). */
export function searchHitIdsFromHistory(hits: ChatHistoryHit[]): number[] {
  return hits.map((h) => h.id).reverse()
}

/**
 * PI3 — 검색 히트 배열이 바뀌었을 때(검색어는 그대로, 예: 위로 스크롤 페이징으로 앞에 히트가 prepend)
 * 이전 활성 히트를 새 배열에서 다시 찾아 인덱스를 보존한다. 사라졌으면(또는 이전 활성이 없으면) 0.
 * 이렇게 하지 않으면 배열 앞이 늘어날 때 같은 인덱스가 다른(더 오래된) 히트를 가리켜 스크롤이 튄다.
 */
export function preserveHitIndex(prevHits: number[], prevIdx: number, newHits: number[]): number {
  if (prevHits.length === 0) return 0
  const prevActive = prevHits[Math.min(prevIdx, prevHits.length - 1)]
  if (prevActive == null) return 0
  const found = newHits.indexOf(prevActive)
  return found >= 0 ? found : 0
}

// C1 — 내비 타일 라이브 활동. worker.ts가 도구 호출마다 emit하는 TaskEvent를 taskId당 '마지막 활동 한 줄'로
// 좁혀 타일에 흘린다. App.tsx의 드로어(콘솔) 렌더 로직은 openTaskId 게이팅을 유지하되, 타일용 이 파생만은
// taskId 무관하게 갱신한다. 순수 함수로 분리해 decode·필터·선택을 DOM/상태 없이 검증한다.

/**
 * 한 TaskEvent를 타일에 흘릴 라이브 한 줄로 변환 — 표시 안 할 이벤트는 null(=타일 갱신 스킵).
 * - tool 라인은 encodeToolLine('display\x1Fraw') 인코딩일 수 있으니 decodeToolLine으로 display만 뽑는다
 *   (raw U+001F 노출 금지 — Phase 2 I2와 동일 함정).
 * - status의 승인 대기(approval:*)는 시스템 신호라 타일 라인으로 흘리지 않는다(드로어에서만 처리).
 * - todo(체크리스트 JSON)는 raw가 화면에 노출되면 안 되고 타일엔 별도 진행률(n/m)로 이미 보이므로 제외.
 * - text가 비면(공백뿐) null.
 */
export function taskActivityLine(ev: TaskEvent): string | null {
  if (ev.kind === 'todo') return null
  // exit는 종료 사유(done/blocked/error…)라 라이브 활동이 아니다 — 타일은 곧 done/blocked 상태로 전환되므로
  // '▸ done'·'▸ blocked: …'가 한 프레임 깜빡이는 것을 원천 차단.
  if (ev.kind === 'exit') return null
  if (ev.kind === 'status' && ev.text.startsWith('approval:')) return null
  const display = decodeToolLine(ev.text).display.trim()
  return display || null
}

/**
 * taskId → 마지막 활동 한 줄 맵을 갱신 — 값이 같으면 **같은 맵 참조를 그대로 반환**(App 리렌더 스킵).
 * taskId당 문자열 1개만 유지(누적 없음 — 스트리밍 폭주 대비). line이 null이면 갱신 없이 기존 맵 반환.
 */
export function updateActivityMap(
  map: Map<string, string>,
  taskId: string,
  line: string | null,
): Map<string, string> {
  if (line == null) return map
  if (map.get(taskId) === line) return map // 같은 값 → setState 스킵(참조 동일)
  const next = new Map(map)
  next.set(taskId, line)
  return next
}

// C1 — 타일 meta 줄 선택. 진행 중(작업 중·명확화) task가 있으면 task.title + 경과/턴/토큰으로 교체하고,
// 없으면 기존 정적 meta(stack·branch·변경 N)를 유지한다. 표시 조립(fmtElapsed·문자열)은 순수라 여기서 검증.

/** task가 '진행 중'(라이브 활동을 보여줄 상태)인가 — working·clarifying만. blocked/review/error는 주목 상태라 제외. */
export function isTaskActive(task: Task | null): boolean {
  return !!task && (task.state === 'working' || task.state === 'clarifying')
}

export interface TileMeta {
  /** true면 title 줄(진행 중), false면 정적 meta 유지 */
  active: boolean
  /** active일 때 첫 줄로 쓸 task.title */
  title: string
  /** active일 때 병기할 경과·턴·토큰(' · ' 조인, 빈 조각 생략). 예: '3분째 · 12턴 · 4.2k tok' */
  stats: string
}

/** 숫자 토큰을 짧게 — 1000 미만은 그대로, 이상은 'X.Xk'(불필요한 .0 제거). 타일은 좁아 간결 우선. */
function shortTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
}

/**
 * 타일 meta 선택 — 진행 중 task가 있으면 {active:true, title, stats}, 없으면 {active:false}(정적 meta 유지).
 * elapsed는 fmtElapsed 재사용(재구현 금지). turns/tokens는 0이면 생략(신호 대 소음).
 */
export function tileMeta(task: Task | null): TileMeta {
  // 큐 대기(슬롯 대기)는 '진행 중'은 아니지만 제목조차 안 보이면 유휴와 구분이 안 된다 — 제목 + '큐 대기'만.
  if (task && task.state === 'queued') return { active: true, title: task.title, stats: '큐 대기' }
  if (!isTaskActive(task)) return { active: false, title: '', stats: '' }
  const t = task!
  const stats = [
    t.createdAt ? fmtElapsed(t.createdAt) : '',
    t.turns > 0 ? `${t.turns}턴` : '',
    t.tokens > 0 ? `${shortTokens(t.tokens)} tok` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return { active: true, title: t.title, stats }
}
