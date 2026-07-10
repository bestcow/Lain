import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type {
  Approval,
  ChatEvent,
  ChatHistoryHit,
  ChatMessage,
  Conversation,
  ConversationPreview,
  FileAttachment,
  ProjectView,
  Task,
  TaskEvent,
  TaskUsageRow,
  DiscordCallState,
  LainSettings,
  UpdateStatus,
} from '../shared/types'
import { spokenText } from '../shared/speech'
import { messagesToMarkdown } from '../shared/exportMarkdown'
import { decodeToolLine } from '../shared/toolline'
import { decodeTodoLine, todoProgress } from '../shared/todoline'
import { decodeEditDiffLine } from '../shared/editdiff'
import { NaviTile } from './components/NaviTile'
import { naviStatus } from './components/StageView'
import { SessionList } from './components/SessionList'
import { ChatPanel } from './components/ChatPanel'
import { ManagerSprite } from './components/Sprites'
import { LainBubble } from './components/LainBubble'
import { ProjectSprite } from './components/projectSprite'
import { TaskDrawer } from './components/TaskDrawer'
import { NaviChatPanel } from './components/NaviChatPanel'
import { LessonsPanel } from './components/LessonsPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { ActivityPanel } from './components/ActivityPanel'
import { UsagePopover } from './components/UsagePopover'
import { PlannerPanel } from './components/PlannerPanel'
import { BenchPanel } from './components/BenchPanel'
import { RoutinesPanel } from './components/RoutinesPanel'
import { AttentionInbox } from './components/AttentionInbox'
import { ConfirmWindow } from './components/ConfirmWindow'
import { ShortcutsHelp } from './components/ShortcutsHelp'
import { PrefsModal } from './components/PrefsModal'
import { OnboardingModal } from './components/OnboardingModal'
import { InputModeBar } from './components/InputModeBar'
import { Icon } from './components/icons'
import { ContextMenu, type CtxItem } from './components/ContextMenu'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { SlashMenu, SLASH_COMMANDS, type SlashCmd } from './components/SlashMenu'
import { AtFileMenu } from './components/AtFileMenu'
import {
  isImageMime,
  filterSlash,
  isEventForOpenConv,
  searchHitIds,
  searchHitIdsFromHistory,
  preserveHitIndex,
  nextBeforeId,
  mergePagedMessages,
  stripAttachSuffix,
  computeTargetKey,
  sessionStartStamp,
  usageLabel,
  contextPercent,
  enqueueNaviMsg,
  dequeueNaviMsg,
  cancelQueuedNaviMsg,
  clearNaviQueue,
  naviQueueLength,
  parseAtToken,
  insertAtPath,
  fuzzyFilterFiles,
  taskActivityLine,
  updateActivityMap,
  type NaviQueueItem,
} from './lib/chat'
import { summarizeUsage } from './lib/tokenUsage'
import { useConfirm } from './lib/useConfirm'
import { paletteHotkeys } from './lib/shortcuts'

let nextLocalId = -1

// 이번 앱 실행 시작 시각 — 매니저 채팅의 '여기부터 이번 실행' 구분선 경계. 콜드스타트라도 이전 대화는
// 잘라내지 않고 전부 그린다(위로 스크롤하면 저번 대화가 이어짐). 첫인상은 ChatPanel이 초기 스크롤을 이
// 경계에 맞춰 유지한다 — 경계를 뷰 맨 위에 두어 옛 대화는 위로 숨기고 아래(이번 실행/브리핑)만 보인다.
// ISO 8601은 사전순=시간순이라 문자열 비교로 충분. DB created_at(store.nowStamp)과 동일한
// 'YYYY-MM-DD HH:MM:SS'(공백·UTC) 포맷 — toISOString의 'T'/'Z'를 쓰면 ' '<'T'라 경계 판정이 깨진다(과거 버그).
//
// ⚠️ 경계는 '렌더러 로드'가 아니라 'main 프로세스 기동' 시각이어야 한다. 렌더러가 크래시하면 main이
// 자동 reload(index.ts render-process-gone)하는데, 그때 이 모듈이 재평가되며 경계가 '지금'으로 밀리면
// 구분선이 엉뚱하게 내려가 이번 실행분이 옛 대화 취급된다. 그래서 마운트 시 main의 APP_STARTED_AT(reload
// 불변)로 덮어쓴다. 아래 값은 그 전까지의 폴백.
let sessionStart = sessionStartStamp()

// #3 디스코드 통화 단계 배지 라벨(idle은 미표시).
const CALL_LABEL: Record<DiscordCallState, string> = {
  idle: '',
  waiting: '대기',
  listening: '듣는 중',
  transcribing: '전사 중',
  thinking: '생각 중',
  speaking: '말하는 중',
  error: '오류',
}

// 상주(트레이) 앱이라 채팅 배열이 무한히 쌓이면 메모리·렌더가 느려진다 — 최근 N개만 유지.
const MAX_CHAT = 800
// A15 — 대화 페이징 한 페이지 크기(conversations:messages 기본 limit과 동일). 응답이 이보다 적으면
// 더 불러올 과거가 없다는 신호로 쓴다(hasMore 판정).
const PAGE_SIZE = 200
const pushCapped = (prev: ChatMessage[], msg: ChatMessage): ChatMessage[] => {
  const next = [...prev, msg]
  return next.length > MAX_CHAT ? next.slice(-MAX_CHAT) : next
}

// B10 — 팔레트 항목 id → 단축키 표기(paletteHotkeys 단일 출처). 순수라 모듈 로드 시 1회 계산.
const PALETTE_HOTKEYS = paletteHotkeys()

// 토큰 수 사람이 읽기 좋게 (구독 모델 — $ 대신 토큰 표시)
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

export default function App() {
  // B15 — null=아직 미로드(초기 로딩), []=로드 완료했지만 진짜 빈 상태. 구분해야 기존 사용자에게
  // '프로젝트 없음' 안내가 listProjects 응답 전에 번쩍이지 않는다.
  const [projects, setProjects] = useState<ProjectView[] | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [managerBusy, setManagerBusy] = useState(false)
  // A2 — 도구 활동 라이브 표시: busy 중 마지막 tool 라인(임시·ephemeral). result/error로 턴이 끝나면 비워
  // DB 재로드가 만드는 실제 tool 행과 중복되지 않는다. turnStartedAt은 경과 시간(n초) 표시의 기준(전송 시점).
  const [managerLiveTool, setManagerLiveTool] = useState<string | null>(null)
  const [managerTurnStartedAt, setManagerTurnStartedAt] = useState<number | null>(null)
  // PC 네이티브 음성 — 디스코드 없이 창에서 직접 말하기(PTT) + 답변 음성 재생(toggle)
  const [recording, setRecording] = useState(false)
  const [voiceOut, setVoiceOut] = useState(false)
  const [voicePlaying, setVoicePlaying] = useState(false) // B7-3 — 재생 중 표시(voiceout 버튼 점멸)
  // B6/B7-2 — 입력창 옆 잠깐 뜨고 사라지는 실패 힌트(PTT 4분기 + TTS 로컬엔진 폴백 통보) 공용.
  const [voiceHint, setVoiceHint] = useState<string | null>(null)
  const voiceHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showVoiceHint = useCallback((msg: string) => {
    if (voiceHintTimerRef.current) clearTimeout(voiceHintTimerRef.current)
    setVoiceHint(msg)
    voiceHintTimerRef.current = setTimeout(() => setVoiceHint(null), 3200)
  }, [])
  const voiceOutRef = useRef(false) // onChatEvent 클로저에서 최신값 참조
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null) // 재생 중 Audio 참조 유지(GC 방지)
  const voiceGenRef = useRef(0) // 음성 세대 — 합성(speakTts) 대기 중 정지/새 응답이 끼면 늦게 온 결과를 폐기
  // 음성 재생 중단 — 새 응답 도착·전송·음성 토글 off 시 호출해 긴 음성이 쌓여 다음 작업을 막지 않게 한다.
  const stopVoice = useCallback(() => {
    voiceGenRef.current++ // 진행 중인 speakTts 프라미스를 무효화(세대 불일치로 .then이 재생을 건너뜀)
    setVoicePlaying(false)
    const a = voiceAudioRef.current
    if (!a) return
    try {
      a.pause()
      a.currentTime = 0
    } catch {
      /* ignore */
    }
    voiceAudioRef.current = null
  }, [])
  const mediaRecRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  // ① 스트리밍 — 현재 라이브로 채워지는 assistant 버블(음수 id + 누적 텍스트). 델타는 여기 이어붙이고
  // 최종 assistant 이벤트가 전문으로 확정한다. result/error 시 해제(DB 재로드가 실 행으로 대체).
  const streamingRef = useRef<{ id: number; text: string } | null>(null)
  // A9 — Navi 직통 채팅 스트리밍(레인 streamingRef 일반화) — naviId(projectId)별로 동시에 여러 Navi가
  // 응답할 수 있어 단일 ref가 아니라 맵. drillTarget으로 연 Navi만 화면에 반영(visible 가드는 이벤트 처리부).
  const naviStreamingRef = useRef<Map<string, { id: number; text: string }>>(new Map())
  // 인라인 선택형/체크형 질문(ask_user) — Lain이 답을 기다리는 동안 채팅 하단에 카드로 뜬다. 동시 1개.
  const [pendingQuestion, setPendingQuestion] = useState<{
    id: string
    question: string
    options: string[]
    multi: boolean
  } | null>(null)
  const [callState, setCallState] = useState<DiscordCallState>('idle') // #3 디스코드 통화 단계
  const [refreshing, setRefreshing] = useState(false)
  const [tokensUsed, setTokensUsed] = useState(0)
  const [costUsed, setCostUsed] = useState(0) // A5 — result.costUsd 누적(구독이면 0/undefined만 와 $ 표시가 계속 숨김)
  // A5 — 컨텍스트 게이지: 매 result에 실려 오는 현재 대화 점유/임계값. threshold 없으면(압축 비활성) null로 숨김.
  const [contextGauge, setContextGauge] = useState<{ tokens: number; threshold: number } | null>(null)
  // C4 — 토큰 사용량 일별 집계 원시 행(최근 15일). 헤더 토큰 클릭 팝오버 + '오늘' 정확화의 단일 출처.
  const [usageRows, setUsageRows] = useState<TaskUsageRow[] | null>(null)
  const [usageOpen, setUsageOpen] = useState(false) // 토큰 팝오버 열림
  const [crtFx, setCrtFx] = useState(() => localStorage.getItem('lain.fx') !== 'off')
  // B1 statusline-theme — 렌더러 전용 팔레트 전환(crtFx 선례 복제). 'wired'(기본)/'amber'/'mono'.
  const [theme, setTheme] = useState(() => localStorage.getItem('lain.theme') || 'wired')
  const [maximized, setMaximized] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [lessonsOpen, setLessonsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false) // C3 — 완료 작업 이력 패널
  const [activityOpen, setActivityOpen] = useState(false) // C6 — 전역 활동 피드 패널
  const [benchOpen, setBenchOpen] = useState(false)
  const [routinesOpen, setRoutinesOpen] = useState(false)
  const [plannerOpen, setPlannerOpen] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  // '숨김'(muted 내비 — 레인은 관리하되 먼저 언급 안 함) 섹션 — 기본 접힘. 구 대기실 대체.
  const [hiddenRoomOpen, setHiddenRoomOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [settings, setSettings] = useState<LainSettings | null>(null)
  useEffect(() => {
    void window.lain.getSettings().then(setSettings)
    return window.lain.onSettingsUpdated(setSettings) // 레인 도구·다른 창의 설정 변경을 라이브 반영(Prefs '내 호칭' 등)
  }, [])
  // E6 — 유효 워크스페이스 루트(env 오버라이드 반영). SCAN 제목·빈상태 문구를 실제 경로로 표시(하드코딩 제거).
  const [wsRoot, setWsRoot] = useState<string>('C:\\workspace')
  useEffect(() => {
    const load = (): void => void window.lain.workspaceInfo().then((w) => setWsRoot(w.root))
    load()
    return window.lain.onSettingsUpdated(load) // 설정에서 루트 변경 시 재조회
  }, [])
  // 음성 답변 토글(🔊)을 설정에서 복원 — 재시작/렌더러 리로드에도 유지(off로 리셋되던 문제 방지).
  useEffect(() => {
    if (settings) {
      voiceOutRef.current = settings.pcVoiceOut
      setVoiceOut(settings.pcVoiceOut)
    }
  }, [settings?.pcVoiceOut])
  // 자동 업데이트 — ② Lain 제안 배너(설정 화면 ④와 같은 onUpdateStatus 스트림 구독)
  const [upd, setUpd] = useState<UpdateStatus | null>(null)
  const [updDismissed, setUpdDismissed] = useState<string | null>(null) // '나중에' 한 버전(그 버전만 숨김)
  useEffect(() => {
    void window.lain.getUpdateStatus().then(setUpd)
    return window.lain.onUpdateStatus(setUpd)
  }, [])
  // Ctrl+K/Ctrl+P 명령 팔레트
  const [paletteOpen, setPaletteOpen] = useState(false)
  // B10 — '?' 키보드 단축키 도움말 오버레이
  const [helpOpen, setHelpOpen] = useState(false)
  // B9 — Promise 반환형 커스텀 확인창(useConfirm) — OS alert/confirm 대체(작업 시작 실패·대화 삭제·세션 리셋)
  const { pending: confirmPending, confirm, onConfirm: onConfirmOk, onCancel: onConfirmCancel } = useConfirm()
  // Esc 핸들러(마운트 클로저)에서 최신 확인창 상태를 보기 위한 ref — 열려 있으면 Esc=취소 최우선.
  const confirmPendingRef = useRef(confirmPending)
  confirmPendingRef.current = confirmPending
  // '/' 슬래시 명령 팝업(매니저 입력창 전용)
  const [slashOpen, setSlashOpen] = useState(false)
  // 입력창 '+' 메뉴(파일·사진/폴더/슬래시) — 화면 좌표에 ContextMenu로 띄운다.
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)
  // A12 — '@' 파일 자동완성 팝업. 레인(매니저)·Navi 입력이 분리돼 있어 각자 독립 상태를 갖는다.
  // atToken=null이면 팝업 닫힘. allFiles는 @ 진입 시 1회 IPC로 로드해 캐시(매 키 재-glob 금지),
  // 렌더러에서 fuzzyFilterFiles로만 필터링한다.
  const [atToken, setAtToken] = useState<ReturnType<typeof parseAtToken>>(null)
  const [atIdx, setAtIdx] = useState(0)
  const [atFiles, setAtFiles] = useState<string[] | null>(null)
  const [naviAtToken, setNaviAtToken] = useState<ReturnType<typeof parseAtToken>>(null)
  const [naviAtIdx, setNaviAtIdx] = useState(0)
  const [naviAtFiles, setNaviAtFiles] = useState<string[] | null>(null)
  // 대화 내 검색(Ctrl+F / 🔍)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHitIdx, setSearchHitIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // A15 — Ctrl+F '전체 기간' 토글(레인 대화만 — DB 전문검색은 scope='manager' 한정). 켜지면
  // searchHits가 로컬 substring 대신 DB 히트(historyHits)를 쓴다.
  const [searchAllTime, setSearchAllTime] = useState(false)
  const [historyHits, setHistoryHits] = useState<ChatHistoryHit[]>([])
  // PI4 — 전체기간 검색으로 과거 히트에 점프(messagesAround)한 동안 켜지는 '검색 점프 모드'. 이 동안엔
  // result/assistant_delta/assistant의 setMessages 재로드·append를 건너뛴다 — 안 그러면 매니저 턴이
  // 끝나거나 응답이 오는 순간 화면이 최신 페이지로 되돌아가 점프 위치가 소실된다(DB엔 정상 저장돼 유실 없음).
  // 검색바를 닫거나 전체기간을 끄면 해제하고 최신 페이지를 재로드한다.
  const jumpModeRef = useRef(false)
  const [jumpMode, setJumpMode] = useState(false)
  jumpModeRef.current = jumpMode
  // A15 — 위로 스크롤 페이징(레인 대화만) — 더 불러올 과거가 없으면 hasMore=false로 재요청을 멈춘다.
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  // 하단 레인(manager) 입력 대상 — 'manager'(기본) | '@all'(브로드캐스트). Navi 직통은 top-zone(drillTarget)으로 분리.
  const [chatTarget, setChatTarget] = useState<string>('manager')
  const [naviMsgs, setNaviMsgs] = useState<ChatMessage[]>([]) // top-zone에서 연 Navi(drillTarget)의 대화 메시지
  const [naviBusy, setNaviBusy] = useState<Set<string>>(new Set())
  // top-zone Navi 워크스페이스 전용 입력 표면(하단 레인 입력과 분리)
  const [naviInput, setNaviInput] = useState('')
  const [naviAttachments, setNaviAttachments] = useState<FileAttachment[]>([])
  const naviInputRef = useRef<HTMLTextAreaElement>(null)
  const naviFileInputRef = useRef<HTMLInputElement>(null)
  // 대화 인박스 — 대화별 마지막 메시지 미리보기 + 안 읽은(unread) 대화 표시
  const [previews, setPreviews] = useState<Map<string, ConversationPreview>>(new Map())
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const [briefing, setBriefing] = useState<string | null>(null) // B — 레인 prose 보고(Claude)
  // top-zone에서 연 Navi(null=타일 그리드). 그 Navi의 세션 목록(convList) + 열린 대화(naviConv)를 위에 띄운다.
  const [drillTarget, setDrillTarget] = useState<string | null>(null)
  const [convList, setConvList] = useState<Conversation[]>([])
  const [openConv, setOpenConv] = useState<string | null>(null) // 하단 레인(manager)의 활성 대화
  const openConvRef = useRef<string | null>(null)
  openConvRef.current = openConv
  const [naviConv, setNaviConv] = useState<string | null>(null) // top-zone Navi(drillTarget)의 열린 대화
  const naviConvRef = useRef<string | null>(null)
  naviConvRef.current = naviConv
  const drillTargetRef = useRef<string | null>(null)
  drillTargetRef.current = drillTarget
  // 채팅 우클릭 컨텍스트 메뉴 + 챕터 목차(TOC)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; msg: ChatMessage } | null>(null)
  // Navi 우클릭 컨텍스트 메뉴(카드·보드 공용) + 제거 확인 다이얼로그(우클릭 메뉴·호버 ✕ 둘 다 경유)
  const [naviMenu, setNaviMenu] = useState<{ x: number; y: number; project: ProjectView } | null>(
    null,
  )
  const [pendingRemove, setPendingRemove] = useState<ProjectView | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  const chatTargetRef = useRef('manager')
  chatTargetRef.current = chatTarget
  // B15 — null=아직 로드 전(TaskDrawer가 로딩/빈 상태를 구분해 표시)
  const [taskEvents, setTaskEvents] = useState<TaskEvent[] | null>(null)
  // C1 — 타일용 라이브 활동: taskId별 '마지막 활동 한 줄'(decode된 display만). 드로어와 무관하게 항상 갱신.
  const [taskActivity, setTaskActivity] = useState<Map<string, string>>(new Map())
  const openTaskIdRef = useRef<string | null>(null)
  openTaskIdRef.current = openTaskId
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0) // 드래그 enter/leave 중첩 카운터(자식 위 진입 시 깜빡임 방지)
  // 파일 첨부
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [dropActive, setDropActive] = useState(false) // 입력 영역에 파일 드래그 중
  // 입력 큐 — 응답 대기 중에도 채팅 전송 허용
  const [msgQueue, setMsgQueue] = useState<
    { text: string; attachments: FileAttachment[]; localId: number }[]
  >([])
  const msgQueueRef = useRef(msgQueue) // result 핸들러(마운트 클로저)에서 현재 큐 길이 참조용
  msgQueueRef.current = msgQueue
  // A10 — Navi 직통 채팅 입력 큐(naviId별 맵, lib/chat.ts 순수 함수로 적재/드레인/취소). 레인 msgQueue의
  // '단일 배열' 대신 Map인 이유: 여러 Navi를 동시에 드릴해도(탭 전환) 각자 큐가 독립적으로 밀려야 한다.
  const [naviMsgQueue, setNaviMsgQueue] = useState<Map<string, NaviQueueItem[]>>(new Map())
  const naviMsgQueueRef = useRef(naviMsgQueue) // result 핸들러(마운트 클로저)에서 현재 큐 참조용
  naviMsgQueueRef.current = naviMsgQueue
  // 대화별 미전송 입력 초안(대상키별) + 입력 히스토리 회상 인덱스(null=초안 편집 중, 0=최신 user)
  const draftsRef = useRef<Map<string, string>>(new Map())
  const histIdxRef = useRef<number | null>(null)
  // 현재 대화의 초안 키 — manager는 세션(openConv)별, Navi/@all은 chatTarget별
  const targetKey = useCallback(
    (target = chatTargetRef.current, conv = openConvRef.current): string =>
      computeTargetKey(target, conv),
    [],
  )

  // 파일 → FileAttachment 변환(파일선택·드롭 공용). 이미지=dataURL base64, 그 외=UTF-8 텍스트.
  const filesToAttachments = useCallback(
    (files: File[]): Promise<FileAttachment[]> =>
      Promise.all(
        files.map(
          (file) =>
            new Promise<FileAttachment>((resolve) => {
              const reader = new FileReader()
              // Anthropic이 받는 이미지 4종만 이미지로 취급 — bmp/svg/tiff 등은 첨부 시 API 400 방지
              const isImage = isImageMime(file.type)
              reader.onload = () => {
                const result = reader.result as string
                resolve({
                  name: file.name,
                  mimeType: file.type || 'application/octet-stream',
                  data: isImage ? result.split(',')[1] : result, // 이미지는 base64 부분만
                  isImage,
                })
              }
              if (isImage) reader.readAsDataURL(file)
              else reader.readAsText(file)
            }),
        ),
      ),
    [],
  )
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      const atts = await filesToAttachments(files)
      setAttachments((prev) => [...prev, ...atts])
    },
    [filesToAttachments],
  )
  // top-zone Navi 입력 첨부(하단 레인 첨부와 별개 표면)
  const addNaviFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      const atts = await filesToAttachments(files)
      setNaviAttachments((prev) => [...prev, ...atts])
    },
    [filesToAttachments],
  )

  // 인박스 — 대화 미리보기 갱신 + (현재 보고 있지 않은 대화면) unread 점등. 셋 다 stable.
  const bumpPreview = useCallback((target: string, role: ChatMessage['role'], text: string) => {
    setPreviews((prev) =>
      new Map(prev).set(target, {
        target,
        role,
        content: text.split('\n')[0].slice(0, 200),
        createdAt: new Date().toISOString(),
      }),
    )
    // manager는 하단에 상시 표시(unread 없음). Navi는 위(drillTarget)에 열려 있지 않을 때만 unread 점등.
    if (target !== 'manager' && target !== drillTargetRef.current)
      setUnread((prev) => new Set(prev).add(target))
  }, [])

  useEffect(() => {
    // 초기 로드 실패 공통 처리 — 콘솔 기록 + 채팅에 한 줄 표시(조용한 빈 화면 방지).
    // recover: 실패 시 상태를 확정값으로 떨궈 '영구 로딩'에 갇히지 않게 한다(예: projects=null→[]).
    const onInitLoadError = (label: string, recover?: () => void) => (e: unknown) => {
      console.error(`[init] ${label} 로드 실패`, e)
      recover?.()
      setMessages((prev) =>
        pushCapped(prev, {
          id: nextLocalId--,
          scope: 'manager',
          role: 'tool',
          content: `[error] ${label} 로드 실패: ${(e as Error).message}`,
          createdAt: new Date().toISOString(),
        }),
      )
    }
    // 실패 시 projects를 []로 — null(로딩) 유지 시 스테이지가 영구 '불러오는 중'에 갇힌다(빈 상태로 폴백).
    window.lain.listProjects().then(setProjects).catch(onInitLoadError('프로젝트 목록', () => setProjects([])))
    // '이번 실행' 경계를 main(APP_STARTED_AT)에서 받아 고정 — 렌더러 reload에도 불변(위 sessionStart 주석).
    // 매니저 대화는 보존된 전체 흐름을 로드한다(위로 스크롤하면 저번 대화가 이어짐). 경계는 '여기부터 이번
    // 실행' 구분선 위치로만 쓰이고, 초기 스크롤이 그 경계를 뷰 맨 위에 두어 첫인상은 콜드스타트 그대로다.
    // (활성 대화 id는 전송·SDK 세션 귀속에도 쓰여 항상 잡는다.)
    window.lain.appStartedAt().then((start) => {
      if (start) sessionStart = start
      window.lain.getActiveConversation('manager').then((cid) => {
        setOpenConv(cid)
        if (cid)
          window.lain.conversationMessages(cid).then((rows) => {
            setMessages(rows)
            setHasMore(rows.length >= PAGE_SIZE) // A15 — 첫 페이지가 꽉 찼으면 더 있을 가능성
          }).catch(onInitLoadError('대화 내역'))
      }).catch(onInitLoadError('활성 대화'))
    }).catch(onInitLoadError('세션 시작 시각'))
    window.lain.conversationPreviews().then((list) =>
      setPreviews(new Map(list.map((p) => [p.target, p]))),
    ).catch(onInitLoadError('대화 미리보기'))
    window.lain.listTasks().then(setTasks).catch(onInitLoadError('작업 목록'))
    window.lain.listApprovals().then(setApprovals).catch(onInitLoadError('승인 목록'))
    window.lain.getBriefing().then(setBriefing).catch(onInitLoadError('브리핑'))
    // C4 — 토큰 사용량(일별 집계 원시 행) 로드 + 작업 갱신 시 재조회('오늘'/추이는 작업 완료로 바뀜).
    window.lain.dailyUsage().then(setUsageRows).catch(onInitLoadError('토큰 사용량'))
    const offProjects = window.lain.onProjectsUpdated(setProjects)
    const offTasks = window.lain.onTasksUpdated((list) => {
      setTasks(list)
      window.lain.dailyUsage().then(setUsageRows).catch(() => {})
    })
    const offApprovals = window.lain.onApprovalsUpdated(setApprovals)
    const offBriefing = window.lain.onBriefingUpdated(setBriefing)
    const offTaskEvent = window.lain.onTaskEvent((ev) => {
      // C1 — 타일용 최소 상태(마지막 활동 한 줄)는 열린 드로어와 무관하게 항상 갱신한다.
      // updateActivityMap이 같은 값이면 같은 참조를 반환해 setState(=App 리렌더)를 스킵하고, taskId당 1개만 유지.
      const line = taskActivityLine(ev)
      if (line != null) setTaskActivity((prev) => updateActivityMap(prev, ev.taskId, line))
      if (ev.taskId === openTaskIdRef.current && !ev.text.startsWith('approval:')) {
        // 장시간/autonomous 작업은 이벤트를 대량 스트리밍한다 — 드로어가 열린 채면 무한 누적되므로 상한(콘솔 로그라 옛 줄 잘라도 무방).
        setTaskEvents((prev) => {
          const cur = prev ?? []
          return cur.length >= 2000 ? [...cur.slice(-1999), ev] : [...cur, ev]
        })
      }
    })
    const offChat = window.lain.onChatEvent((ev: ChatEvent) => {
      // 텔레그램·PC가 같은 '활성 대화'를 공유 — 이벤트의 conversationId가 지금 연 대화면 본문에
      // 추가하고, 아니면 목록 미리보기만 갱신한다. (conversationId 없는 레거시·스케줄러 이벤트는 표시)
      const forOpen = isEventForOpenConv(openConvRef.current, ev.conversationId)
      const append = (
        role: ChatMessage['role'],
        content: string,
        origin?: ChatMessage['origin'],
      ) =>
        setMessages((prev) =>
          pushCapped(prev, {
            id: nextLocalId--,
            scope: 'manager',
            role,
            content,
            origin,
            createdAt: new Date().toISOString(),
          }),
        )
      if (ev.kind === 'user') {
        // 텔레그램에서 친 메시지 — PC 화면·목록에 라이브 반영하고 '응답 중'으로 표시. 출처(📱) 운반.
        if (forOpen) {
          setMessages((prev) =>
            pushCapped(prev, {
              id: nextLocalId--,
              scope: 'manager',
              role: 'user',
              content: ev.text,
              origin: ev.origin,
              createdAt: new Date().toISOString(),
            }),
          )
          setManagerBusy(true)
          setManagerTurnStartedAt(Date.now()) // A2 — 경과 시간(n초) 표시 기준
        }
        bumpPreview('manager', 'user', ev.text)
      } else if (ev.kind === 'assistant_delta') {
        // ① 스트리밍 — 라이브 버블에 텍스트 증분을 이어붙인다(forOpen만). 최종 assistant가 전문으로 확정.
        // PI4 — 검색 점프 중이면 화면이 과거 구간이라 최신 델타를 섞지 않는다(DB엔 저장됨, 복귀 시 재로드).
        if (forOpen && ev.text && !jumpModeRef.current) {
          const s = streamingRef.current
          if (s) {
            s.text += ev.text
            const { id, text: full } = s
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: full } : m)))
          } else {
            const id = nextLocalId--
            streamingRef.current = { id, text: ev.text }
            setMessages((prev) =>
              pushCapped(prev, {
                id,
                scope: 'manager',
                role: 'assistant',
                content: ev.text,
                createdAt: new Date().toISOString(),
              }),
            )
          }
        }
      } else if (ev.kind === 'assistant') {
        // 어깨너머 자발 발화(proactive)는 origin='overlay'로 — 채팅에 흐리게 구분 표시(👁).
        // 스트리밍 중이던 라이브 버블이 있으면 새 버블 추가 대신 전문으로 확정(권위). 없으면 기존대로 추가.
        // PI4 — 검색 점프 중이면 화면이 과거 구간이라 최신 응답을 append/확정하지 않는다(DB 저장, 복귀 시 재로드).
        if (forOpen && !jumpModeRef.current) {
          const s = streamingRef.current
          if (s && !ev.proactive) {
            const id = s.id
            streamingRef.current = null
            const full = ev.text
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: full } : m)))
          } else {
            append('assistant', ev.text, ev.proactive ? 'overlay' : undefined)
          }
        }
        // 답변 음성(toggle) — 지금 연 대화의 '일반' 응답에만. 다른 대화로 온 이벤트나 어깨너머(proactive)
        // 발화는 재생 중인 음성을 끊지도, 스스로 읽지도 않는다(오버레이는 조용한 시각 채널).
        // 새 응답이 오면 이전 재생을 즉시 끊고(적체 방지) <<say:>> 한 줄 요약만 읽는다(spokenText).
        if (forOpen && !ev.proactive) {
          stopVoice() // 세대(voiceGenRef) 증가 포함 — 아래 대기 중이던 이전 speakTts는 폐기된다
          if (voiceOutRef.current) {
            const speech = spokenText(ev.text)
            if (speech) {
              const gen = voiceGenRef.current // 이 요청의 세대 — 결과 도착 시 아직 유효한지 확인
              window.lain
                .speakTts(speech)
                .then(({ uri, fallback }) => {
                  // 정지/새 응답이 끼어들었으면(세대 불일치) 늦게 온 오디오는 재생하지 않는다.
                  if (!uri || gen !== voiceGenRef.current) return
                  // B7-2 — 설정한 로컬 엔진(gpt-sovits/supertonic)이 실패해 edge로 대체됐다는 통보.
                  if (fallback) showVoiceHint('⚠ 로컬 TTS 실패 — edge로 대체')
                  const a = new Audio(uri) // mime 포함 data URI(edge=mp3, 나머지=wav)
                  voiceAudioRef.current = a // 참조 유지 — 미보관 시 재생 전 GC될 수 있음
                  setVoicePlaying(true) // B7-3 — voiceout 버튼을 재생 표시로 전환
                  a.onended = () => setVoicePlaying(false)
                  void a.play().catch(() => setVoicePlaying(false))
                })
                .catch(() => {})
            }
          }
        }
        bumpPreview('manager', 'assistant', ev.text)
      } else if (ev.kind === 'tool') {
        // A2 — 매니저 라이브 tool 라인을 busy 표시 영역에 임시(ephemeral)로 노출한다(구 동작: 채팅엔 안 보이고
        // result 후 DB 재로드로만 노출 — 수분짜리 턴 동안 화면이 침묵하는 문제를 뒤집는 결정). 최신 1줄만 유지,
        // result/error가 오면 비워 DB 재로드가 만드는 실제 tool 행과 중복되지 않는다. forOpen 대화에만 표시.
        // I2 — ev.text는 encodeToolLine('display\x1Fraw') 형태일 수 있다. busy 블록(ChatPanel)은 이 값을
        // decode 없이 렌더하므로, 저장 시점에 display만 뽑아 U+001F 제어문자·raw 노출을 막는다(원문은 turn
        // 종료 후 DB 재로드가 MessageBody 전개 토글로 보존).
        // A4 — TodoWrite는 별도 인코딩(encodeTodoLine, §todo§ 접두사)이라 decodeToolLine이 못 벗겨내고
        // JSON 원문이 그대로 노출된다 — todo면 먼저 짧은 진행률 요약으로 바꾼다.
        // A6 — Edit/Write diff(encodeEditDiffLine, §diff§ 접두사)도 같은 이유로 짧은 요약으로 바꾼다.
        const todos = decodeTodoLine(ev.text)
        const editDiff = decodeEditDiffLine(ev.text)
        const liveText = todos
          ? `TodoWrite ${todoProgress(todos).done}/${todoProgress(todos).total}`
          : editDiff
            ? `${editDiff.tool} ${editDiff.filePath}`
            : decodeToolLine(ev.text).display
        if (forOpen) setManagerLiveTool(liveText)
        // 단 transient 재시도 통지(⏳)가 오면 재시도가 새로 스트리밍하므로, 이전 부분 스트리밍 버블을 확정 종료해
        // 재시도 델타가 옛 부분텍스트에 이어붙어 깨지는 것을 막는다(리뷰 C). 이전 부분 버블은 다음 result의 DB 재로드로 정리.
        if (streamingRef.current && ev.text.startsWith('⏳')) streamingRef.current = null
      } else if (ev.kind === 'result') {
        if (ev.tokens) setTokensUsed((t) => t + ev.tokens!)
        // A5 — 비용 누적(구독 사용자는 costUsd가 계속 0/undefined라 표시가 자연히 숨겨진 채 유지됨).
        if (ev.costUsd) setCostUsed((c) => c + ev.costUsd!)
        // A5 — 컨텍스트 게이지 갱신(threshold 없으면 압축 비활성 — 게이지 자체를 숨긴다).
        if (ev.contextThreshold) setContextGauge({ tokens: ev.contextTokens ?? 0, threshold: ev.contextThreshold })
        setManagerBusy(false)
        setManagerLiveTool(null) // A2 — 턴 종료, 임시 tool 라인 정리(DB 재로드가 실 행으로 대체)
        setManagerTurnStartedAt(null)
        // A7 — 이번 턴 도구 실패가 있었으면 배지 한 줄 표시(성공은 이미 침묵 처리돼 관리자 스트림에서 안 옴).
        if (forOpen && ev.failedTools) append('tool', `⚠ 이번 턴 도구 실패 ${ev.failedTools}건`)
        streamingRef.current = null // 턴 종료 — 라이브 버블 확정 종료(아래 DB 재로드가 실 행으로 대체)
        // 라이브(음수 id) 메시지를 실 DB id로 동기화 — 챕터 고정 게이트(m.id<=0) 해제.
        // 큐가 비었을 때만 DB 전체로 교체한다. (예전 [...rows, ...음수id] 병합은 방금 턴의 낙관적
        // user/assistant가 rows에도·음수 꼬리에도 들어가 매 턴 메시지가 이중 표시되던 버그.)
        // 큐가 남아 있으면 미전송 메시지가 사라지지 않게 재로드를 건너뛴다 — 큐가 다 빠진 마지막 result에서 동기화.
        // PI4 — 검색 점프 중이면 화면이 과거 구간이라 최신 페이지로 통째 교체하지 않는다(점프 위치 소실 방지).
        // 백그라운드 DB엔 정상 저장돼 유실 없음 — 검색바를 닫거나 최신 복귀 시 재로드한다.
        const cid = ev.conversationId ?? openConvRef.current
        if (cid && cid === openConvRef.current && msgQueueRef.current.length === 0 && !jumpModeRef.current)
          window.lain.conversationMessages(cid).then((rows) => {
            setMessages(rows)
            setHasMore(rows.length >= PAGE_SIZE) // A15 — 최신 페이지로 통째 교체될 때마다 재평가
          })
      } else if (ev.kind === 'error') {
        streamingRef.current = null // 스트리밍 도중 오류 — 라이브 버블 확정 종료(다음 턴 새로 시작)
        setManagerLiveTool(null) // A2 — 턴이 오류로 끝나도 임시 tool 라인은 정리
        setManagerTurnStartedAt(null)
        if (forOpen) append('tool', `[error] ${ev.message}`)
        bumpPreview('manager', 'tool', `[error] ${ev.message}`)
        setManagerBusy(false)
      } else if (ev.kind === 'question') {
        // Lain이 선택형/체크형 질문을 띄움 — 답 대기 중이라 '응답 중'은 끈다. 카드는 그 질문이 지금 연
        // 대화 것일 때만 띄운다. ⚠️ busy 해제는 forOpen 밖으로 — 다른 대화로 온 question이어도 '응답 중'에
        // 묶여 입력이 막히는 엣지를 막는다(질문이 뜬 턴은 어떤 대화든 응답 대기로 멈춰 있으므로).
        setManagerBusy(false)
        setManagerLiveTool(null) // A2 — 질문 대기로 전환되면 직전 tool 라인은 정리(재개 시 stale 라인 방지)
        setManagerTurnStartedAt(null)
        if (forOpen) {
          setPendingQuestion({
            id: ev.questionId,
            question: ev.question,
            options: ev.options,
            multi: ev.multi,
          })
        }
      } else if (ev.kind === 'questionResolved') {
        // 답 제출됨 — 카드 제거, 요약 한 줄 낙관 추가(곧 result 재로드가 실 DB행으로 대체), Lain 재개.
        setPendingQuestion((q) => (q && q.id === ev.questionId ? null : q))
        if (forOpen) {
          append('tool', `❓ ${ev.answerText}`)
          setManagerBusy(true)
          setManagerTurnStartedAt(Date.now()) // A2 — 재개된 턴의 새 경과 시간 기준
        }
      }
    })
    const offNaviChat = window.lain.onNaviChatEvent((ev) => {
      // top-zone에 그 Navi가 열려 있으면(=drillTarget) 본문에 표시. broadcast 메타(@all)는 실제 대화 아님.
      const visible = ev.projectId === drillTargetRef.current && ev.projectId !== '@all'
      // 인박스 미리보기·unread는 현재 보고 있지 않은 Navi도 갱신(타일 점등용). broadcast 메타(@all) 제외.
      if (ev.projectId && ev.projectId !== '@all' && (ev.kind === 'assistant' || ev.kind === 'tool')) {
        // I2 — Navi tool 라인도 encodeToolLine 형태일 수 있어 인박스 미리보기엔 display만(제어문자·raw 숨김).
        // 본문(naviMsgs)은 아래에서 원문 그대로 push → MessageBody가 decode·전개 토글로 원문 보존.
        const previewText = ev.kind === 'tool' ? decodeToolLine(ev.text).display : ev.text
        bumpPreview(ev.projectId, ev.kind === 'assistant' ? 'assistant' : 'tool', previewText)
      }
      if (ev.kind === 'assistant_delta') {
        // A9 — 레인 streamingRef와 동형: naviId별 라이브 버블에 텍스트 증분을 이어붙인다(visible만).
        // 최종 assistant 이벤트가 전문으로 확정(아래)한다.
        if (visible && ev.text) {
          const s = naviStreamingRef.current.get(ev.projectId)
          if (s) {
            s.text += ev.text
            const { id, text: full } = s
            setNaviMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, content: full } : m)))
          } else {
            const id = nextLocalId--
            naviStreamingRef.current.set(ev.projectId, { id, text: ev.text })
            setNaviMsgs((prev) =>
              pushCapped(prev, {
                id,
                scope: 'worker',
                role: 'assistant',
                content: ev.text,
                projectId: ev.projectId,
                createdAt: new Date().toISOString(),
              }),
            )
          }
        }
      } else if (ev.kind === 'assistant' || ev.kind === 'tool') {
        if (visible) {
          // A9 — 스트리밍 중이던 라이브 버블이 있으면 새 버블 추가 대신 전문으로 확정(레인과 동형).
          const s = ev.kind === 'assistant' ? naviStreamingRef.current.get(ev.projectId) : undefined
          if (s) {
            naviStreamingRef.current.delete(ev.projectId)
            const id = s.id
            const full = ev.text
            setNaviMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, content: full } : m)))
          } else {
            setNaviMsgs((prev) =>
              pushCapped(prev, {
                id: nextLocalId--,
                scope: 'worker',
                role: ev.kind === 'assistant' ? 'assistant' : 'tool',
                content: ev.text,
                projectId: ev.projectId,
                createdAt: new Date().toISOString(),
              }),
            )
          }
        }
      } else if (ev.kind === 'result') {
        if (ev.tokens) setTokensUsed((t) => t + ev.tokens!)
        naviStreamingRef.current.delete(ev.projectId) // A9 — 턴 종료, 라이브 버블 확정 종료
        // A10 — 이 naviId 큐에 대기 메시지가 있으면 DB 재로드를 건너뛴다(레인 msgQueue와 동형 —
        // 미전송 낙관 메시지가 재로드로 사라지지 않게, 큐가 다 빠진 마지막 result에서만 동기화).
        if (
          ev.projectId === drillTargetRef.current &&
          naviConvRef.current &&
          naviQueueLength(naviMsgQueueRef.current, ev.projectId) === 0
        )
          window.lain.conversationMessages(naviConvRef.current).then(setNaviMsgs)
        setNaviBusy((prev) => {
          const next = new Set(prev)
          next.delete(ev.projectId)
          return next
        })
      } else if (ev.kind === 'error') {
        naviStreamingRef.current.delete(ev.projectId) // A9 — 스트리밍 도중 오류, 라이브 버블 확정 종료
        if (ev.projectId && ev.projectId !== '@all') bumpPreview(ev.projectId, 'tool', `[error] ${ev.message}`)
        if (visible) {
          setNaviMsgs((prev) =>
            pushCapped(prev, {
              id: nextLocalId--,
              scope: 'worker',
              role: 'tool',
              content: `[error] ${ev.message}`,
              projectId: ev.projectId,
              createdAt: new Date().toISOString(),
            }),
          )
        }
        setNaviBusy((prev) => {
          const next = new Set(prev)
          next.delete(ev.projectId)
          return next
        })
      }
    })
    const offWinMax = window.lain.onWindowMaximized(setMaximized)
    const offOpenInbox = window.lain.onOpenInbox(() => setInboxOpen(true))
    // B5 — 마운트/리로드 시 대기 중 인라인 질문 재조회로 카드 복원(pendingQuestion은 main 인메모리라 리로드에도 살아있다).
    // 렌더러 크래시 자동 reload 후에도 답 대기 카드가 사라져 턴이 교착되던 문제(감사 B5)를 막는다. 동시 다중이면 지금 연 대화 것 중 최신 1개.
    window.lain.pendingQuestions().then((qs) => {
      const forOpen = qs.filter((q) => isEventForOpenConv(openConvRef.current, q.conversationId))
      const q = forOpen[forOpen.length - 1]
      if (q) setPendingQuestion({ id: q.questionId, question: q.question, options: q.options, multi: q.multi })
    }).catch(() => { /* 조회 실패는 무해 — 라이브 question 이벤트로도 카드가 뜬다 */ })
    // #3 디스코드 통화 단계 — 초기 상태 + 라이브 갱신
    window.lain.discordStatus().then((s) => setCallState(s.callState))
    const offDiscordState = window.lain.onDiscordState((ev) => setCallState(ev.state))
    // 대화 제목 자동요약 완료 → 드릴 열린 대상이면 목록, 그리고 미리보기 새로고침
    const offConvUpd = window.lain.onConversationsUpdated((target) => {
      if (drillTargetRef.current === target)
        window.lain.listConversations(target).then(setConvList)
      window.lain
        .conversationPreviews()
        .then((list) => setPreviews(new Map(list.map((p) => [p.target, p]))))
    })
    return () => {
      offProjects()
      offChat()
      offTasks()
      offApprovals()
      offBriefing()
      offTaskEvent()
      offNaviChat()
      offWinMax()
      offOpenInbox()
      offConvUpd()
      offDiscordState()
    }
  }, [])

  // 입력창 자동 높이 — 줄 수에 맞춰 늘고, 10줄(=max-height) 넘으면 스크롤 (Claude 채팅창과 동일)
  useLayoutEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [input])
  // top-zone Navi 입력창 자동 높이 (하단 레인 입력과 별개 표면)
  useLayoutEffect(() => {
    const ta = naviInputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [naviInput, drillTarget])

  // FX 영속 (새로고침 후 유지)
  useEffect(() => {
    localStorage.setItem('lain.fx', crtFx ? 'on' : 'off')
  }, [crtFx])
  useEffect(() => {
    localStorage.setItem('lain.theme', theme)
  }, [theme])

  // 인박스 열림/닫힘을 main에 통지 — notify가 '자리 비움' 판단에 쓴다(ui:inbox-state).
  useEffect(() => {
    window.lain.setInboxOpen(inboxOpen)
  }, [inboxOpen])

  // Ctrl+K / Ctrl+P — 명령 팔레트 (textarea 포커스 중에도 window 레벨이라 동작). Ctrl+P 인쇄 차단.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key === 'k' || e.key === 'K' || e.key === 'p' || e.key === 'P')
      ) {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // B10 — '?' 단축키 도움말. 입력창(textarea/input) 밖에서만 — 타이핑 중 '?'는 물음표 문자여야 한다.
  // Shift+/(=?)만 잡고 수정키(Ctrl/Meta/Alt) 조합은 제외. contenteditable도 방어.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
      e.preventDefault()
      setHelpOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Ctrl+F — 대화 내 검색 열기 (@all 브로드캐스트 제외 — 전용 대화가 없음). 입력창 포커스 중에도 잡게 window 레벨.
  // A11 — 검색바는 이제 레인 채팅·Navi 드릴 뷰 둘 다에 렌더되므로(searchBar 공유), 드릴 가드는 제거.
  // 드릴 중엔 chatTarget(레인 대상)이 '@all'로 남아 있어도 검색은 naviMsgs를 보므로 항상 허용.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key === 'f' || e.key === 'F') &&
        (drillTargetRef.current != null || chatTargetRef.current !== '@all')
      ) {
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openTask = useCallback((taskId: string) => {
    setOpenTaskId(taskId)
    setTaskEvents(null) // B15 — 로드 전 상태로 리셋(TaskDrawer가 '로딩 중' 표시)
    window.lain.taskEvents(taskId).then(setTaskEvents)
  }, [])

  const startTask = useCallback(
    async (projectId: string) => {
      const res = await window.lain.startTask(projectId)
      if (res.error) {
        // B9 — OS alert 대신 CRT 테마 확인창(통지형 — 확인 버튼만 의미, 결과는 무시).
        void confirm({
          title: '작업 시작 실패',
          body: res.error,
          confirmLabel: '확인',
          danger: false,
          hideCancel: true,
        })
        return
      }
      if (res.taskId) openTask(res.taskId)
    },
    [openTask, confirm],
  )

  // ── 하단 레인(manager) 입력 대상 — 'manager' | '@all'(브로드캐스트). Navi 직통은 top-zone으로 분리. ──
  const switchTarget = useCallback((target: string) => {
    const t = target === '@all' ? '@all' : 'manager'
    // @all엔 검색바가 렌더되지 않는다(전용 대화 없음 — 검색 대상은 레인 대화·Navi 드릴뿐, A11).
    // 열린 채 넘어가면 하이라이트가 남고 Esc를 삼키므로 정리한다.
    if (t === '@all') {
      setSearchOpen(false)
      setSearchQuery('')
    }
    setChatTarget(t)
    setAtToken(null) // A12 — 대상 전환 시 이전 @팝업 토큰 위치 무효
  }, [])

  // ── top-zone Navi 워크스페이스 ──
  // 타일 클릭/포커스 → 그 Navi를 위에 연다(세션 목록 + 활성 대화). 다른 Navi에서 오면 입력 초안 보존·복원.
  // A10 fix — naviMsgs를 DB로 통째 교체하는 로드 경로(드릴 전환·세션 전환)에서, 아직 DB에 없는
  // 큐 대기 메시지의 낙관 user 버블이 사라지는 것 방지. 해당 naviId·conv의 큐 항목을 버블로 재구성해 뒤에 붙인다.
  // (큐는 naviId별 격리라 전환왕복에도 살아있지만 naviMsgs는 단일 공유 배열이라 재로드 시 버블만 유실됐다.)
  const queuedNaviBubbles = useCallback((naviId: string, convId: string | null): ChatMessage[] => {
    const items = naviMsgQueueRef.current.get(naviId) ?? []
    return items
      .filter((it) => !it.conversationId || it.conversationId === convId)
      .map((it) => ({
        id: it.localId,
        scope: 'worker' as const,
        role: 'user' as const,
        content: it.text + (it.attachments?.length ? ` [+${it.attachments.length}개 첨부]` : ''),
        attachments: it.attachments ?? [],
        createdAt: new Date().toISOString(),
      }))
  }, [])

  const openDrill = useCallback((naviId: string) => {
    const prev = drillTargetRef.current
    if (prev && prev !== naviId) draftsRef.current.set(prev, naviInputRef.current?.value ?? '')
    // A11 — 검색바가 드릴 뷰에도 렌더되므로(searchBar 공유) 더는 강제로 닫지 않는다. 다른 Navi로
    // 전환해도 검색어는 유지 — searchMsgs가 새 drillTarget의 naviMsgs를 자동으로 다시 본다.
    setDrillTarget(naviId)
    setNaviInput(draftsRef.current.get(naviId) ?? '')
    setNaviAtToken(null) // A12 — 다른 Navi로 전환하면 이전 @팝업 토큰 위치가 무효
    setNaviAttachments([])
    window.lain.listConversations(naviId).then(setConvList)
    window.lain.getActiveConversation(naviId).then((cid) => {
      setNaviConv(cid)
      window.lain.setActiveConversation(naviId, cid)
      setUnread((p) => {
        if (!p.has(naviId)) return p
        const n = new Set(p)
        n.delete(naviId)
        return n
      })
      window.lain.conversationMessages(cid).then((msgs) => setNaviMsgs([...msgs, ...queuedNaviBubbles(naviId, cid)]))
    })
  }, [queuedNaviBubbles])

  // top-zone에서 타일 그리드로 복귀 — 현재 Navi 입력 초안 보존.
  const closeDrill = useCallback(() => {
    const prev = drillTargetRef.current
    if (prev) draftsRef.current.set(prev, naviInputRef.current?.value ?? '')
    // A11 — 복귀할 레인 화면이 '@all'이면 그쪽엔 검색바가 없다(전용 대화 없음). 열린 채 두면 Esc를 삼키므로 닫는다.
    if (chatTargetRef.current === '@all') {
      setSearchOpen(false)
      setSearchQuery('')
    }
    setDrillTarget(null)
    setNaviConv(null)
    setNaviMsgs([])
    setNaviInput('')
    setNaviAtToken(null) // A12
  }, [])

  // 같은 Navi의 다른 세션(대화)을 연다 — SessionList onPick.
  const openNaviConversation = useCallback((convId: string) => {
    const naviId = drillTargetRef.current
    if (!naviId) return
    setNaviConv(convId)
    window.lain.setActiveConversation(naviId, convId)
    setUnread((p) => {
      if (!p.has(naviId)) return p
      const n = new Set(p)
      n.delete(naviId)
      return n
    })
    window.lain.conversationMessages(convId).then((msgs) => setNaviMsgs([...msgs, ...queuedNaviBubbles(naviId, convId)]))
  }, [queuedNaviBubbles])

  // 새 Navi 대화 생성 후 연다 — SessionList onNew.
  const newConversation = useCallback((naviId: string) => {
    window.lain.createConversation(naviId).then((cid) => {
      setNaviConv(cid)
      setNaviMsgs([])
      setNaviInput('')
      window.lain.setActiveConversation(naviId, cid)
      window.lain.listConversations(naviId).then(setConvList)
    })
  }, [])

  // 대화 이름변경 — 인라인 편집(SessionList) 확정 시 호출. DB 갱신 후 목록 새로고침.
  const renameConversation = useCallback((target: string, convId: string, title: string) => {
    window.lain
      .renameConversation(convId, title)
      .then(() => window.lain.listConversations(target).then(setConvList))
  }, [])

  // 대화 삭제 — 확인 후 DB 삭제, 목록·미리보기 갱신, 열린 대화면 폴백(다음 대화 또는 새 대화).
  // B9 — 축소안(스키마 무변경): 하드 삭제 전 확인창에 제목·메시지 수를 보여 오삭제를 줄인다(소프트삭제/undo는
  // deleted 컬럼 마이그레이션이 필요해 범위 과대 — report 참조). 메시지 수는 conversationMessageCount로
  // 전건을 얻는다 — conversationMessages는 limit(기본 200)·visible_from_id 워터마크가 걸려 실제 삭제량과
  // 어긋난다(I-del 리뷰 지적). 삭제는 워터마크 무관 전건이므로 카운트도 전건이어야 정확.
  const deleteConversation = useCallback(
    async (naviId: string, convId: string) => {
      const title = convList.find((c) => c.id === convId)?.title?.trim() || '(제목 없음)'
      const msgCount = await window.lain.conversationMessageCount(convId).catch(() => 0)
      const ok = await confirm({
        title: '대화 삭제',
        body: (
          <>
            <b>{title}</b> 대화를 삭제할까요? 메시지 <b>{msgCount}개</b>도 함께 지워집니다.
          </>
        ),
        note: '되돌릴 수 없습니다.',
        confirmLabel: '삭제',
        danger: true,
      })
      if (!ok) return
      window.lain.deleteConversation(convId).then(async () => {
        const list = await window.lain.listConversations(naviId)
        setConvList(list)
        window.lain
          .conversationPreviews()
          .then((l) => setPreviews(new Map(l.map((p) => [p.target, p]))))
        if (naviConvRef.current === convId) {
          const fb = list[0]
          if (fb) openNaviConversation(fb.id)
          else newConversation(naviId)
        }
      })
    },
    [openNaviConversation, newConversation, confirm, convList],
  )

  // ── 채팅 메시지 우클릭 메뉴 ──
  const onMessageContext = useCallback((e: ReactMouseEvent, m: ChatMessage) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, msg: m })
  }, [])

  // 메시지를 다음 입력의 텍스트 첨부(컨텍스트)로 추가 — lain 첨부 시스템 재사용
  const attachAsContext = useCallback((m: ChatMessage) => {
    const who = m.role === 'assistant' ? 'lain' : m.role === 'user' ? 'me' : 'sys'
    setAttachments((prev) => [
      ...prev,
      {
        name: `chat-${who}-${Math.abs(m.id)}.txt`,
        mimeType: 'text/plain',
        data: m.content,
        isImage: false,
      },
    ])
  }, [])

  // 입력창에 `> 인용` 형태로 삽입 후 이어 작성.
  // PI5 — ctxItems는 매니저·Navi 드릴 뷰 공용이라, worker 메시지(Navi 드릴)를 인용하면 Navi 입력창에
  // 삽입해야 한다. m.scope로 매니저(setInput/inputRef)/Navi(setNaviInput/naviInputRef)를 분기한다.
  const quoteReply = useCallback((m: ChatMessage) => {
    const quoted = m.content
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    if (m.scope === 'worker') {
      setNaviInput((prev) => (prev.trim() ? prev + '\n\n' : '') + quoted + '\n\n')
      naviInputRef.current?.focus()
    } else {
      setInput((prev) => (prev.trim() ? prev + '\n\n' : '') + quoted + '\n\n')
      inputRef.current?.focus()
    }
  }, [])

  // A13 — '수정해서 재전송': user 메시지 원문을 입력창에 그대로 채우고 포커스(quoteReply와 달리 인용 없이
  // 통째 대체 — 고쳐서 다시 보내는 용도). 완전 되감기·포크는 범위 밖(1단계 S만) — 그냥 채워서 사용자가
  // 직접 고쳐 전송하게 한다. 기존 입력 중이던 내용은 덮어쓴다(수정 목적이므로 이어붙이지 않음).
  // PI5 — 공용 ctxItems라 worker 메시지(Navi 드릴)를 재전송하면 진행 중 매니저 초안을 덮어쓰던 오배선을
  // m.scope로 분기해 바로잡는다(Navi면 Navi 입력창, 아니면 매니저 입력창).
  const editResend = useCallback((m: ChatMessage) => {
    if (m.scope === 'worker') {
      setNaviInput(m.content)
      naviInputRef.current?.focus()
    } else {
      setInput(m.content)
      inputRef.current?.focus()
    }
  }, [])

  // A15 — 채팅 스크롤 맨 위 도달 시 이전 페이지(beforeId 커서)를 prepend. 레인(manager) 대화 전용 —
  // Navi 드릴 뷰는 브리프 범위 밖(브리프가 'PC 채팅'=레인 대화의 접근성 문제로 한정). 진행 중 재요청·
  // 더 없음(hasMore=false)이면 조용히 무시(ChatPanel도 onScroll에서 동일 가드를 두지만 이중 방어).
  const loadOlderMessages = useCallback(() => {
    if (loadingMore || !hasMore || !openConv) return
    const before = nextBeforeId(messages)
    if (before == null) {
      setHasMore(false)
      return
    }
    setLoadingMore(true)
    window.lain
      .conversationMessages(openConv, PAGE_SIZE, before)
      .then((older) => {
        setHasMore(older.length >= PAGE_SIZE)
        setMessages((prev) => mergePagedMessages(older, prev))
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false))
  }, [loadingMore, hasMore, openConv, messages])

  // 챕터 고정/해제 — DB(messages.chapter) 영속 + 로컬 즉시 반영. 음수 id(라이브 미저장)는 비활성.
  // m.scope로 매니저(setMessages)/Navi(setNaviMsgs) 배열을 분기 갱신(우클릭 패널 공용 ctxMenu).
  const toggleChapter = useCallback((m: ChatMessage) => {
    const title = m.chapter
      ? null
      : m.content.split('\n').find((l) => l.trim())?.trim().slice(0, 40) || '챕터'
    window.lain.setChapter(m.id, title)
    const apply = (prev: ChatMessage[]) =>
      prev.map((x) => (x.id === m.id ? { ...x, chapter: title } : x))
    if (m.scope === 'worker') setNaviMsgs(apply)
    else setMessages(apply)
  }, [])

  // A16 — '여기까지 복사': 이 메시지까지 화면에 로드된 분량을 markdown(발신자 접두·챕터 헤딩)으로
  // 클립보드에 복사. m.scope로 매니저(messages)/Navi(naviMsgs) 중 어느 화면 배열인지 가른다.
  const copyUpTo = useCallback(
    (m: ChatMessage) => {
      const source = m.scope === 'worker' ? naviMsgs : messages
      const idx = source.findIndex((x) => x.id === m.id)
      const upTo = idx === -1 ? source : source.slice(0, idx + 1)
      window.lain.copyText(messagesToMarkdown(upTo))
    },
    [messages, naviMsgs],
  )

  // A16 — 대화 전체 .md 내보내기(showSaveDialog는 main에서, 전체 메시지 조회도 main에서 처리).
  // 취소하면 main이 { ok: false }만 반환 — 렌더러는 별도 처리 불필요.
  const exportConversation = useCallback((conversationId: string | null) => {
    if (!conversationId) return
    // 저장 실패(디스크 풀·권한 등)는 사용자에게 알린다 — 취소(error 없음)는 조용히 넘긴다.
    window.lain
      .exportConversationMarkdown(conversationId)
      .then((r) => {
        if (r && !r.ok && r.error) window.alert(`대화 내보내기 실패: ${r.error}`)
      })
      .catch((e) => window.alert(`대화 내보내기 실패: ${(e as Error).message}`))
  }, [])

  // B4 — 인라인 화살표였던 질문 답변 핸들러를 useCallback으로 안정화(ChatPanel React.memo가 실효하도록).
  // pendingQuestion에 의존하지만, 그 값이 바뀌면 ChatPanel은 pendingQuestion prop 변화로 어차피 리렌더된다.
  const answerQuestion = useCallback(
    (answer: string[]) => {
      if (pendingQuestion) window.lain.answerQuestion(pendingQuestion.id, answer)
      setPendingQuestion(null)
    },
    [pendingQuestion],
  )

  const ctxItems = useCallback(
    (m: ChatMessage): CtxItem[] => [
      { label: '메시지 복사', onClick: () => window.lain.copyText(m.content) },
      { label: '여기까지 복사', onClick: () => copyUpTo(m) },
      { label: '컨텍스트로 첨부', onClick: () => attachAsContext(m) },
      { label: '인용해서 답장', onClick: () => quoteReply(m) },
      // A13 — user 메시지에만 노출(수정 대상은 사용자 발화뿐 — tool/assistant는 재전송 개념이 없다).
      ...(m.role === 'user' ? [{ label: '수정해서 재전송', onClick: () => editResend(m) }] : []),
      m.chapter
        ? { label: '챕터 고정 해제', onClick: () => toggleChapter(m), danger: true }
        : { label: '챕터로 고정', onClick: () => toggleChapter(m), disabled: m.id <= 0 },
    ],
    [attachAsContext, quoteReply, editResend, toggleChapter, copyUpTo],
  )

  // ── Navi 추가/제거 ── (카드·보드 공용)
  // 우클릭 → 컨텍스트 메뉴를 커서 위치에 연다.
  const openNaviMenu = useCallback((e: ReactMouseEvent, project: ProjectView) => {
    e.preventDefault()
    setNaviMenu({ x: e.clientX, y: e.clientY, project })
  }, [])

  // 제거 요청(우클릭 '내비 제거' 또는 호버 ✕) → 확인 다이얼로그를 띄운다(즉시 삭제 안 함).
  const requestRemove = useCallback((project: ProjectView) => {
    setNaviMenu(null)
    setPendingRemove(project)
  }, [])

  // 확인 후 실제 제거 — DB 등록만 해제(디스크 폴더는 그대로). 현재 대화/드릴 대상이면 매니저로 되돌린다.
  // 같은 폴더를 나중에 다시 추가하면 id·name이 동일해 spriteFor가 같은 아이콘을 결정론적으로 복원한다.
  const confirmRemove = useCallback(() => {
    if (!pendingRemove) return
    window.lain.removeProject(pendingRemove.id)
    if (drillTargetRef.current === pendingRemove.id) closeDrill()
    setPendingRemove(null)
  }, [pendingRemove, closeDrill])

  const naviCtxItems = useCallback(
    (project: ProjectView): CtxItem[] => [
      { label: '직통 대화 열기', onClick: () => openDrill(project.id) },
      {
        // '숨김' 체크 토글 — 보드에서 숨김 창으로. 레인은 계속 관리하되 먼저 언급하지 않는다.
        label: project.muted ? '✓ 숨김 해제' : '숨김',
        onClick: () => window.lain.setMuted(project.id, !project.muted),
      },
      { label: '내비 제거', onClick: () => requestRemove(project), danger: true },
    ],
    [openDrill, requestRemove],
  )

  // 입력창 '+' 메뉴 항목 — 파일·사진 첨부 / 폴더 추가(내비 등록) / 슬래시 명령어.
  const openSlashMenu = useCallback(() => {
    if (chatTargetRef.current !== 'manager') switchTarget('manager') // 슬래시는 lain(manager) 전용
    setInput((prev) => (prev.startsWith('/') ? prev : '/'))
    setSlashOpen(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [switchTarget])
  const plusItems: CtxItem[] = [
    { label: '📎 파일·사진 추가', onClick: () => fileInputRef.current?.click() },
    { label: '📁 폴더 추가', onClick: () => window.lain.addProjectDialog() },
    { label: '/ 슬래시 명령어', onClick: openSlashMenu },
  ]

  // dev 전용 테스트 핸들 (LAIN_SHOT_JS 등에서 사용) — 프로덕션 빌드 제외
  useEffect(() => {
    if (import.meta.env.DEV) (window as any).__lainDev = { switchTarget, openDrill }
  }, [switchTarget, openDrill])

  // 입력 큐 처리 — managerBusy 해소 시 큐의 다음 메시지를 자동 전송(하단 레인 전용 큐).
  // (메시지 자체는 적재 시 이미 화면에 띄웠으므로 여기선 전송만 — 중복 표시 방지)
  useEffect(() => {
    if (managerBusy || msgQueue.length === 0) return
    const [next, ...rest] = msgQueue
    setMsgQueue(rest)
    setManagerBusy(true)
    setManagerTurnStartedAt(Date.now()) // A2 — 경과 시간(n초) 표시 기준
    window.lain
      .sendChat(next.text, next.attachments, openConvRef.current ?? undefined)
      .catch(() => setManagerBusy(false))
  }, [managerBusy, msgQueue])

  // 대기열 취소 — 응답 중 쌓아둔(아직 전송 안 된) 메시지를 X로 제거. 전송 예약(msgQueue)과
  // 화면에 미리 띄운 낙관 메시지(messages)를 localId로 함께 지운다. 이미 전송된 항목은 큐에 없어 무영향.
  const cancelQueued = useCallback((localId: number) => {
    setMsgQueue((prev) => prev.filter((q) => q.localId !== localId))
    setMessages((prev) => prev.filter((m) => m.id !== localId))
  }, [])
  // 현재 대기열에 남은(미전송) 낙관 메시지 id 집합 — ChatPanel이 이 메시지에만 ✕(취소)를 단다.
  const queuedIds = useMemo(() => new Set(msgQueue.map((q) => q.localId)), [msgQueue])

  // 완전 중단(정지·새로고침) — busy를 풀기 전에 미전송 대기열을 비운다. busy만 풀면 큐 드레인 이펙트가
  // 곧바로 다음 대기 메시지를 전송해 '정지를 눌러도 안 멈추는' 문제가 생긴다(정지=지금 멈춤). 낙관 표시도 제거.
  const haltAndClearQueue = useCallback(() => {
    const q = msgQueueRef.current
    if (q.length) {
      const ids = new Set(q.map((x) => x.localId))
      setMessages((prev) => prev.filter((m) => !ids.has(m.id)))
      setMsgQueue([])
    }
    setManagerBusy(false)
    stopVoice()
  }, [stopVoice])

  // A10 — Navi 대기열 취소(레인 cancelQueued와 동형) — ✕로 특정 항목만 제거(전송 예약 + 화면 낙관 메시지).
  const cancelQueuedNavi = useCallback((naviId: string, localId: number) => {
    setNaviMsgQueue((prev) => cancelQueuedNaviMsg(prev, naviId, localId))
    setNaviMsgs((prev) => prev.filter((m) => m.id !== localId))
  }, [])
  // 현재 drillTarget 대기열에 남은(미전송) 낙관 메시지 id 집합 — NaviChatPanel이 이 메시지에만 ✕를 단다.
  const naviQueuedIds = useMemo(
    () => new Set((drillTarget ? naviMsgQueue.get(drillTarget) : undefined)?.map((q) => q.localId) ?? []),
    [naviMsgQueue, drillTarget],
  )
  // B4 — NaviChatPanel React.memo가 실효하도록 참조 안정화: 승인 필터 배열은 useMemo, 취소 콜백은 useCallback.
  // (인라인 filter/화살표면 App 리렌더마다 새 참조라 memo 무력 — 스트리밍 델타 중 드릴 패널 전체가 재조정됨.)
  const naviApprovals = useMemo(
    () => approvals.filter((a) => a.taskId === `chat:${drillTarget}`),
    [approvals, drillTarget],
  )
  const onCancelQueuedNavi = useCallback(
    (localId: number) => {
      if (drillTarget) cancelQueuedNavi(drillTarget, localId)
    },
    [drillTarget, cancelQueuedNavi],
  )

  // A10 — Navi 완전 중단(정지·드릴 전환) — busy를 풀기 전에 그 naviId의 미전송 대기열을 비운다
  // (레인 haltAndClearQueue와 동형 — 정지=지금 멈춤, 큐 드레인 effect가 곧바로 다음 걸 쏘지 않게).
  const haltAndClearNaviQueue = useCallback((naviId: string) => {
    const { removedIds, queues } = clearNaviQueue(naviMsgQueueRef.current, naviId)
    if (removedIds.length) {
      const ids = new Set(removedIds)
      setNaviMsgs((prev) => prev.filter((m) => !ids.has(m.id)))
      setNaviMsgQueue(queues)
    }
  }, [])

  // Esc — 열린 오버레이를 위에서부터 닫기. (팔레트는 자체 핸들러로 stopPropagation해 여기 안 옴)
  // A14 — 최후순위: 오버레이·검색·슬래시·모달이 모두 닫힌 상태에서 응답 중이면 Esc로 정지(마우스 ■ 버튼과 동일 동작).
  // 입력창에 타이핑 중이어도 유효(입력 내용 보존 — preventDefault만 하고 텍스트는 건드리지 않음).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.isComposing) return // IME 조합 중 Esc는 조합 취소 용도 — 정지로 오발하지 않는다.
      // B9 — 확인창이 떠 있으면 최우선으로 취소(Esc=취소). 아래 오버레이를 건드리지 않게 여기서 끝낸다.
      if (confirmPendingRef.current) {
        e.preventDefault()
        onConfirmCancel()
        return
      }
      // B10 — 단축키 도움말 오버레이(자체 Esc 핸들러도 있으나 이중 방어). 다른 오버레이보다 위라 먼저 닫는다.
      if (helpOpen) {
        setHelpOpen(false)
        return
      }
      // 검색바는 채팅 위 인라인 요소라 체인 맨 앞 — 열려 있으면 그것만 닫는다.
      if (searchOpen) {
        setSearchOpen(false)
        setSearchQuery('')
        return
      }
      if (menuOpen) setMenuOpen(false)
      else if (usageOpen) setUsageOpen(false)
      else if (prefsOpen) setPrefsOpen(false)
      else if (inboxOpen) setInboxOpen(false)
      else if (lessonsOpen) setLessonsOpen(false)
      else if (benchOpen) setBenchOpen(false)
      else if (routinesOpen) setRoutinesOpen(false)
      else if (plannerOpen) setPlannerOpen(false)
      // C3 — HISTORY에서 연 드로어가 그 위에 뜨므로, 드로어를 먼저 닫고(openTaskId) 그다음 이력 패널을 닫는다.
      else if (openTaskIdRef.current) setOpenTaskId(null)
      else if (historyOpen) setHistoryOpen(false)
      else if (activityOpen) setActivityOpen(false)
      else if (slashOpen) setSlashOpen(false)
      else if (atToken) setAtToken(null) // A12
      else if (naviAtToken) setNaviAtToken(null) // A12
      else if (drillTargetRef.current) {
        // Navi 드릴 뷰 — 해당 Navi가 응답 중이면 정지(레인 stop-btn과 동일 로직).
        const target = drillTargetRef.current
        if (naviBusy.has(target)) {
          e.preventDefault()
          // A10 — busy를 풀기 전에 이 Navi의 미전송 대기열부터 비운다(레인 haltAndClearQueue와 동형 —
          // 순서를 바꾸면 큐 드레인 effect가 busy 해제를 보고 곧바로 다음 메시지를 쏴 '정지가 안 먹는' 문제).
          haltAndClearNaviQueue(target)
          window.lain.stopNaviChat(target)
          setNaviBusy((prev) => {
            const next = new Set(prev)
            next.delete(target)
            return next
          })
        }
      } else if (chatTargetRef.current === 'manager' && managerBusy) {
        // 레인 채팅 뷰 — 마우스 ■ 버튼과 동일: 낙관적으로 busy·대기열 먼저 비우고 실제 abort는 stopChat.
        e.preventDefault()
        haltAndClearQueue()
        window.lain.stopChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    helpOpen,
    onConfirmCancel,
    menuOpen,
    usageOpen,
    prefsOpen,
    inboxOpen,
    lessonsOpen,
    historyOpen,
    activityOpen,
    benchOpen,
    routinesOpen,
    plannerOpen,
    searchOpen,
    slashOpen,
    atToken,
    naviAtToken,
    managerBusy,
    naviBusy,
    haltAndClearQueue,
    haltAndClearNaviQueue,
  ])

  // 하단 레인 입력 전송 — chatTarget='manager'(매니저 대화) | '@all'(전 Navi 브로드캐스트).
  const send = useCallback((override?: unknown) => {
    // override가 문자열이면(음성 전사) 그 텍스트를 전송. onClick={send}로 들어오는 이벤트 객체는 무시.
    const text = (typeof override === 'string' ? override : input).trim()
    if (!text && attachments.length === 0) return
    stopVoice() // 사용자가 다음 메시지를 보내면 재생 중인 음성을 끊는다(다음 작업으로 넘어가게)
    const pendingAttachments = [...attachments]
    if (chatTarget === '@all') {
      // 브로드캐스트 — 전 Navi에 전달(전용 패널 없음, 응답은 각 Navi 타일 unread·워크스페이스로). 대화 conv 없음.
      setInput('')
      setAttachments([])
      window.lain.sendNaviChat('@all', text, pendingAttachments)
      return
    }
    // manager
    setInput('')
    setAttachments([])
    const content =
      text + (pendingAttachments.length ? ` [+${pendingAttachments.length}개 첨부]` : '')
    const optimistic = {
      id: nextLocalId--,
      scope: 'manager' as const,
      role: 'user' as const,
      content,
      attachments: pendingAttachments,
      createdAt: new Date().toISOString(),
    }
    if (managerBusy) {
      // 응답 대기 중 — 입력 큐에 적재(메시지는 지금 표시, 전송은 위 큐 effect가 처리).
      // localId로 큐 항목 ↔ 화면 낙관 메시지를 묶어 X 취소 시 둘 다 지운다.
      setMsgQueue((prev) => [
        ...prev,
        { text, attachments: pendingAttachments, localId: optimistic.id },
      ])
      setMessages((prev) => pushCapped(prev, optimistic))
      bumpPreview('manager', 'user', content)
      return
    }
    setManagerBusy(true)
    setManagerTurnStartedAt(Date.now()) // A2 — 경과 시간(n초) 표시 기준(전송 시점)
    setMessages((prev) => pushCapped(prev, optimistic))
    bumpPreview('manager', 'user', content)
    // 정상 흐름은 result/error chat:event가 managerBusy를 해제한다. IPC 자체가 거부되는 예외 상황엔
    // 종료 이벤트가 못 올 수 있으니(서버측 보장과 별개의 2차 방어) busy를 직접 풀어 "응답 중" 고착을 막는다.
    window.lain.sendChat(text, pendingAttachments, openConv ?? undefined).catch(() => setManagerBusy(false))
  }, [input, attachments, managerBusy, chatTarget, openConv, stopVoice])

  // PC 네이티브 음성 — 푸시투토크: 누르면 마이크 녹음 시작, 떼면 종료 → STT(ko) → 전사 텍스트를 전송.
  const startRec = useCallback(async () => {
    if (recording) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      recChunksRef.current = []
      mr.ondataavailable = (e) => {
        if (e.data.size) recChunksRef.current.push(e.data)
      }
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(recChunksRef.current, { type: 'audio/webm' })
        if (blob.size < 1500) {
          showVoiceHint('너무 짧게 들렸어 — 다시') // B6 — 너무 짧은 녹음 무시(오발동)
          return
        }
        try {
          const ab = await blob.arrayBuffer()
          // 무음/잡음 게이트 — 디코드해 피크 진폭이 너무 낮으면 STT를 건너뛴다(Whisper 환청 방지).
          try {
            const Ctx =
              window.AudioContext ||
              (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
            const ctx = new Ctx()
            const decoded = await ctx.decodeAudioData(ab.slice(0))
            void ctx.close()
            const ch = decoded.getChannelData(0)
            let peak = 0
            for (let i = 0; i < ch.length; i += 64) {
              const a = Math.abs(ch[i])
              if (a > peak) peak = a
            }
            if (peak < 0.045) {
              showVoiceHint('너무 작게 들렸어 — 다시') // B6 — 사실상 무음 → STT 미전송
              return
            }
          } catch {
            /* 디코드 실패 시 그냥 진행 */
          }
          const r = await window.lain.sttVoice(new Uint8Array(ab))
          if (r.text) send(r.text)
          else if (r.error) showVoiceHint(`STT 실패: ${r.error.slice(0, 40)}`) // B6 — 사유 축약(키 원문 없음)
        } catch (e) {
          // B6 — STT 예외(네트워크 등)도 원인 축약해 통보. 에러 원문 전체·시크릿은 로그에 남기지 않는다.
          showVoiceHint(`STT 실패: ${String((e as Error)?.message || e).slice(0, 40)}`)
        }
      }
      mr.start()
      mediaRecRef.current = mr
      setRecording(true)
    } catch {
      setRecording(false) // 마이크 권한 거부 등
      showVoiceHint('마이크 권한이 거부됨 — 시스템 설정 확인') // B6
    }
  }, [recording, send, showVoiceHint])
  const stopRec = useCallback(() => {
    const mr = mediaRecRef.current
    if (mr && mr.state !== 'inactive') mr.stop()
    setRecording(false)
  }, [])

  // A9/A10 실제 전송 — 큐 드레인(자동 재전송)과 sendNavi(사용자 전송) 공용. 낙관 메시지는 호출부가 이미
  // 표시했으므로 여기선 IPC 왕복 + 에러 처리만(레인 큐 드레인 effect와 동형 — 중복 표시 방지).
  const dispatchNavi = useCallback(
    (target: string, text: string, attachments: FileAttachment[], conversationId?: string) => {
      setNaviBusy((prev) => new Set(prev).add(target))
      window.lain.sendNaviChat(target, text, attachments, conversationId).then((res) => {
        if (res?.error) {
          if (target === drillTargetRef.current) {
            setNaviMsgs((prev) =>
              pushCapped(prev, {
                id: nextLocalId--,
                scope: 'worker',
                role: 'tool',
                content: res.error!,
                createdAt: new Date().toISOString(),
              }),
            )
          }
          setNaviBusy((prev) => {
            const next = new Set(prev)
            next.delete(target)
            return next
          })
        }
      })
    },
    [],
  )

  // top-zone Navi 워크스페이스 입력 전송 — drillTarget(현재 연 Navi)에게 직통.
  // A10 — 응답 중(naviBusy)이면 레인 큐(msgQueue)와 동형으로 로컬 큐에 적재(낙관 표시), result 시 자동 전송.
  const sendNavi = useCallback(() => {
    const target = drillTarget
    if (!target) return
    const text = naviInput.trim()
    if (!text && naviAttachments.length === 0) return
    setNaviInput('')
    const pendingAttachments = [...naviAttachments]
    setNaviAttachments([])
    const content =
      text + (pendingAttachments.length ? ` [+${pendingAttachments.length}개 첨부]` : '')
    const optimistic = {
      id: nextLocalId--,
      scope: 'worker' as const,
      role: 'user' as const,
      content,
      attachments: pendingAttachments,
      createdAt: new Date().toISOString(),
    }
    if (naviBusy.has(target)) {
      // 이 Navi가 응답 중 — 큐에 적재만(전송은 아래 드레인 effect가 busy 해제 시 처리). 화면엔 지금 표시.
      setNaviMsgQueue((prev) =>
        enqueueNaviMsg(prev, target, {
          text,
          attachments: pendingAttachments,
          localId: optimistic.id,
          conversationId: naviConv ?? undefined,
        }),
      )
      setNaviMsgs((prev) => pushCapped(prev, optimistic))
      bumpPreview(target, 'user', content)
      return
    }
    setNaviMsgs((prev) => pushCapped(prev, optimistic))
    bumpPreview(target, 'user', content)
    dispatchNavi(target, text, pendingAttachments, naviConv ?? undefined)
  }, [naviInput, naviAttachments, naviBusy, drillTarget, naviConv, dispatchNavi])

  // A10 — Navi 입력 큐 드레인: naviBusy에서 빠진(=result/error로 응답 종료된) naviId 중 큐가 남아 있으면
  // 다음 메시지를 자동 전송한다(레인 msgQueue 드레인 effect와 동형, naviId별로 일반화).
  useEffect(() => {
    for (const [naviId, queue] of naviMsgQueue) {
      if (queue.length === 0 || naviBusy.has(naviId)) continue
      const { item, queues } = dequeueNaviMsg(naviMsgQueue, naviId)
      if (!item) continue
      setNaviMsgQueue(queues)
      dispatchNavi(naviId, item.text, item.attachments, item.conversationId)
      break // 한 틱에 하나만 — 상태 갱신 후 effect가 다시 돌아 나머지를 순서대로 처리
    }
  }, [naviBusy, naviMsgQueue, dispatchNavi])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.lain.refreshStatus()
    } catch (e) {
      setMessages((prev) =>
        pushCapped(prev, {
          id: nextLocalId--,
          scope: 'manager',
          role: 'tool',
          content: `[error] 현황 수집 실패: ${(e as Error).message}`,
          createdAt: new Date().toISOString(),
        }),
      )
    } finally {
      setRefreshing(false)
    }
  }, [])

  const scan = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.lain.scanProjects()
    } catch (e) {
      setMessages((prev) =>
        pushCapped(prev, {
          id: nextLocalId--,
          scope: 'manager',
          role: 'tool',
          content: `[error] 프로젝트 스캔 실패: ${(e as Error).message}`,
          createdAt: new Date().toISOString(),
        }),
      )
    } finally {
      setRefreshing(false)
    }
  }, [])

  // B15 — 미로드(null)면 빈 배열로 취급. 렌더 분기(로딩 vs 빈 상태)는 projects 원본으로 별도 판정.
  const projectList = projects ?? []
  const enabled = projectList.filter((p) => p.enabled)
  const dirtyCount = enabled.filter((p) => (p.status?.dirtyFiles ?? 0) > 0).length
  const failCount = enabled.filter((p) => p.status?.testState === 'fail').length
  const activeTaskOf = (projectId: string) => {
    const act = tasks.filter(
      (t) => t.projectId === projectId && !['done', 'cancelled'].includes(t.state),
    )
    // D1 — queued가 최신이라(listTasks DESC) 진행 중(working/결재 등)을 가리는 문제 방지:
    // 비-queued(실제 진행)를 우선 표시하고, 없을 때만 queued('대기')를 보여준다.
    return act.find((t) => t.state !== 'queued') ?? act[0] ?? null
  }
  const reviewCount = tasks.filter((t) => t.state === 'review').length
  const blockedCount = tasks.filter((t) => t.state === 'blocked').length
  const inboxCount = approvals.length + reviewCount + blockedCount
  const taskTokens = tasks.reduce((sum, t) => sum + t.tokens, 0)
  // C4 — '오늘' 정확화: created_at 기준 오늘(로컬 날짜) 작업만 합산 + 일별 추이·프로젝트별 상위(팝오버용).
  // usageRows 미로드(null)면 이전 근사값(tokensUsed+taskTokens)으로 폴백해 라벨이 0으로 깜빡이지 않게 한다.
  const usage = useMemo(() => (usageRows ? summarizeUsage(usageRows) : null), [usageRows])
  const todayTokens = usage ? usage.todayTokens : tokensUsed + taskTokens
  const todayCost = usage ? usage.todayCost : costUsed
  // 레인 브리핑 위젯(레인의 첫 말) — 전부 결정론(이미 가진 상태로 계산, LLM·비용 0).
  const workingCount = tasks.filter((t) => t.state === 'working' || t.state === 'clarifying').length
  const errorCount = tasks.filter((t) => t.state === 'error').length
  const unpushedCount = enabled.filter((p) => (p.status?.ahead ?? 0) > 0).length
  const attnTotal = reviewCount + blockedCount + approvals.length + errorCount + failCount
  const attnPairs = [
    ['결재', reviewCount],
    ['질문', blockedCount],
    ['승인', approvals.length],
    ['에러', errorCount],
    ['검증실패', failCount],
  ] as [string, number][]
  const attnParts = attnPairs.filter(([, n]) => n > 0).map(([l, n]) => `${l} ${n}`)
  // 사이드 컬럼용 — '에러'는 전용 줄이 따로 있어 제외(결재·질문·승인·검증실패만 ⚠ 줄로).
  const sideAttnParts = attnPairs
    .filter(([l, n]) => l !== '에러' && n > 0)
    .map(([l, n]) => `${l} ${n}`)
  const openedTask = openTaskId ? (tasks.find((t) => t.id === openTaskId) ?? null) : null

  // ── 대화 내 검색 — substring(대소문자 무시) 매치 메시지 id 목록. 드릴(Navi) 뷰면 naviMsgs,
  // 아니면 하단 레인(manager) 대화(messages) 대상 — 검색바·상태(searchOpen 등)는 두 화면이 공유
  // (서로 배타적으로 렌더되므로 동시 사용 없음, A11).
  const searchMsgs = drillTarget ? naviMsgs : messages
  // A15 — '전체 기간' 토글은 레인 대화 전용(searchChatHistory가 scope='manager'만 검색) — 드릴 중엔 항상
  // 로컬(substring) 검색으로 강제한다(토글이 있어도 대상이 없으니 무의미).
  const allTimeActive = searchAllTime && !drillTarget
  // A15 — 전체 기간 DB 전문검색: 쿼리가 바뀔 때마다 조회(로컬 substring과 달리 왕복 필요). 짧은 쿼리(빈
  // 문자열)는 호출 생략. 토글 꺼지면 결과를 비워 로컬 검색으로 자연히 폴백.
  useEffect(() => {
    if (!allTimeActive || !searchQuery.trim()) {
      setHistoryHits([])
      return
    }
    let cancelled = false
    window.lain.searchChatHistory(searchQuery, 30).then((hits) => {
      if (!cancelled) setHistoryHits(hits)
    })
    return () => {
      cancelled = true
    }
  }, [allTimeActive, searchQuery])
  const searchHits = useMemo(
    () => (allTimeActive ? searchHitIdsFromHistory(historyHits) : searchHitIds(searchMsgs, searchQuery)),
    [allTimeActive, historyHits, searchQuery, searchMsgs],
  )
  // PI3 — 매치 인덱스 리셋을 '실제 검색 조건 변경'(searchQuery·allTimeActive)으로 좁힌다. 예전엔
  // deps에 searchMsgs.length가 있어, 로컬 검색 중 위로 스크롤 페이징(prepend로 배열이 커짐)만 해도
  // 0으로 리셋돼 activeHitId가 맨 위(가장 오래된) 히트로 튀고 스크롤이 거기로 점프했다.
  // 조건이 바뀌지 않았는데 히트 배열이 바뀐 경우(=페이징으로 앞에 항목 추가)엔 이전 활성 히트 id를
  // 새 배열에서 다시 찾아 인덱스를 보존한다(사라졌으면 0). prevSearchHitsRef는 직전 커밋의 히트 배열.
  const prevSearchCondRef = useRef({ query: '', allTime: false })
  const prevSearchHitsRef = useRef<number[]>([])
  useEffect(() => {
    const prevCond = prevSearchCondRef.current
    const condChanged = prevCond.query !== searchQuery || prevCond.allTime !== allTimeActive
    prevSearchCondRef.current = { query: searchQuery, allTime: allTimeActive }
    if (condChanged) {
      setSearchHitIdx(0) // 검색어/전체기간 토글 변경 — 기존대로 첫 히트로
    } else {
      // 조건 동일 + 히트 배열 변동(페이징 prepend 등) — 직전 활성 히트를 새 배열에서 다시 찾아 보존.
      setSearchHitIdx((idx) => preserveHitIndex(prevSearchHitsRef.current, idx, searchHits))
    }
    prevSearchHitsRef.current = searchHits
  }, [searchQuery, allTimeActive, searchHits])
  // A15 — 전체 기간 히트로 이동: 화면(messages)에 아직 없는 id면 그 메시지 주변 구간을 로드해 교체
  // 점프한다(messagesAround, 다른 대화의 히트도 그 대화로 전환·이동). activeHitId가 바뀔 때만 발동.
  const jumpedHitRef = useRef<number | null>(null)
  useEffect(() => {
    if (!allTimeActive || !searchHits.length) return
    const hitId = searchHits[Math.min(searchHitIdx, searchHits.length - 1)]
    if (hitId == null || jumpedHitRef.current === hitId) return
    if (messages.some((m) => m.id === hitId)) return // 이미 화면에 로드돼 있으면 스크롤만(ChatPanel이 처리)
    const hit = historyHits.find((h) => h.id === hitId)
    jumpedHitRef.current = hitId
    window.lain.messagesAround(hitId, 40, 40).then((around) => {
      if (around.length === 0) return
      setMessages(around)
      setJumpMode(true) // PI4 — 화면을 과거 구간으로 바꾼 상태 — 최신 재로드·append를 잠근다(복귀 전까지).
      setHasMore(true) // 점프 지점 기준 이전 페이지가 더 있을 수 있음 — 다시 위로 스크롤 가능하게
      if (hit?.conversationId && hit.conversationId !== openConv) setOpenConv(hit.conversationId)
    })
  }, [allTimeActive, searchHits, searchHitIdx, historyHits, messages, openConv])
  // PI4 — 검색바를 닫거나 전체기간을 끄면(점프 조건 해제) 점프 모드를 풀고 최신 페이지를 재로드한다.
  // 점프 중 잠겨 있던 result/assistant 반영이 누락된 만큼, DB에서 최신 상태를 다시 가져와 맞춘다.
  useEffect(() => {
    if (jumpMode && (!searchOpen || !allTimeActive)) {
      setJumpMode(false)
      jumpedHitRef.current = null
      const cid = openConvRef.current
      if (cid)
        window.lain.conversationMessages(cid).then((rows) => {
          setMessages(rows)
          setHasMore(rows.length >= PAGE_SIZE)
        })
    }
  }, [jumpMode, searchOpen, allTimeActive])
  // 슬래시 필터 변동 시 선택을 맨 위로
  useEffect(() => {
    setSlashIdx(0)
  }, [input, slashOpen])
  const activeHitId = searchHits.length
    ? (searchHits[Math.min(searchHitIdx, searchHits.length - 1)] ?? null)
    : null

  // 레인 브리핑 위젯 — 레인이 처음 꺼내는 말. 채팅 첫 메시지 슬롯(ChatPanel lead)에 lain> 메시지로 렌더.
  // prose(Claude, 있으면) + 결정론 현황 한 줄 + 처리대기/안정. 매 실행 새 오프닝 브리핑.
  // B4 — useMemo로 참조 안정화: lead가 매 렌더 새 JSX면 ChatPanel의 React.memo가 무력해진다(키 입력마다
  // 채팅 패널 전체 재조정). 브리핑 내용에 실제로 쓰이는 프리미티브만 deps로 — 그 값이 안 바뀌면 같은 참조 유지.
  const attnPartsStr = attnParts.join(' · ')
  const usageStr = usageLabel(fmtTokens(todayTokens), todayCost)
  const briefLead = useMemo(
    () => (
    <div className="msg msg-assistant lain-brief">
      <span className="msg-prefix">Lain</span>
      <div className="msg-body">
        {briefing && <div className="lain-brief-say">{briefing}</div>}
        <div className="lain-brief-line">
          감시 {enabled.length}
          {' · 작업 '}
          <span className={workingCount > 0 ? 'st-working' : ''}>{workingCount}</span>
          {' · 미커밋 '}
          <span className={dirtyCount > 0 ? 'st-dirty' : ''}>{dirtyCount}</span>
          {unpushedCount > 0 && (
            <>
              {' · 안 푸시 '}
              <span className="st-dirty">{unpushedCount}</span>
            </>
          )}
        </div>
        {attnTotal > 0 ? (
          <div className="lain-brief-attn"><Icon name="bell" size={14} /> 처리 대기 — {attnPartsStr}</div>
        ) : (
          <div className="lain-brief-ok">
            ✓ 모두 안정 · 오늘 {usageStr}
          </div>
        )}
      </div>
    </div>
    ),
    [briefing, enabled.length, workingCount, dirtyCount, unpushedCount, attnTotal, attnPartsStr, usageStr],
  )

  // ── '/' 슬래시 명령 필터(첫 토큰 접두 매칭) ──
  const slashFiltered = useMemo<SlashCmd[]>(() => {
    if (!slashOpen) return []
    return filterSlash(input, SLASH_COMMANDS)
  }, [slashOpen, input])

  // A12 — '@' 파일 fuzzy 필터. atFiles는 @ 진입 시 1회 로드된 캐시 — 여기선 렌더러 메모리에서만 필터.
  const atFiltered = useMemo<string[]>(() => {
    if (!atToken || !atFiles) return []
    return fuzzyFilterFiles(atFiles, atToken.query)
  }, [atToken, atFiles])
  const naviAtFiltered = useMemo<string[]>(() => {
    if (!naviAtToken || !naviAtFiles) return []
    return fuzzyFilterFiles(naviAtFiles, naviAtToken.query)
  }, [naviAtToken, naviAtFiles])
  // 필터 결과 변동 시 선택을 맨 위로(슬래시 팝업과 동일 패턴)
  useEffect(() => {
    setAtIdx(0)
  }, [atToken?.query])
  useEffect(() => {
    setNaviAtIdx(0)
  }, [naviAtToken?.query])

  // A5 — /compact 수동 압축: main이 결과 문구를 기존 tool 이벤트(chat:event)로 흘려주는데, 그 라인은
  // busy 표시 영역(ChatPanel liveTool)에서만 보이므로 요약 호출이 도는 동안 잠깐 busy를 세워 '압축 중'을
  // 보여준다(레인 응답 턴은 아니지만 같은 시각적 언어 재사용 — 신규 UI 부품 남발 방지). 완료(성공)는
  // performCompact가 이미 DB에 영속시킨 tool 행이라 여기서 재로드해 실 행으로 남긴다.
  const compactNow = useCallback(async () => {
    // I3 — 진행 중인 턴(managerBusy) 중엔 압축을 걸지 않는다. 걸면 finally의 setManagerBusy(false)가
    // 실제 턴 도중 busy를 뒤집어 큐 드레인 effect를 오발동시키고(main은 여전히 busy → error emit),
    // 큐 메시지를 유실한다. main compactManagerNow의 busy 가드와 대칭(거기선 {ok:false}+안내를 미러).
    if (managerBusy) {
      showVoiceHint('레인이 응답 중이라 지금은 압축할 수 없어 — 끝난 뒤 다시')
      return
    }
    const cid = openConvRef.current
    setManagerBusy(true)
    setManagerLiveTool('🧠 컨텍스트 압축 중…')
    try {
      const { ok } = await window.lain.compactNow(cid ?? undefined)
      if (ok && cid && cid === openConvRef.current)
        await window.lain.conversationMessages(cid).then((rows) => {
          setMessages(rows)
          setHasMore(rows.length >= PAGE_SIZE) // A15 — 압축이 워터마크를 전진시켜 이전 페이지가 줄었을 수 있음
        })
    } finally {
      setManagerBusy(false)
      setManagerLiveTool(null)
    }
  }, [managerBusy, showVoiceHint])

  // ── 명령 팔레트 항목 — 전부 기존 콜백/window.lain 재사용(신규 IPC 0) ──
  const paletteItems: PaletteItem[] = [
    { id: 'jump:manager', label: '@Lain 매니저로', group: '대상', run: () => switchTarget('manager') },
    { id: 'jump:@all', label: '@all 브로드캐스트', group: '대상', run: () => switchTarget('@all') },
    ...enabled.map((p) => ({
      id: `jump:${p.id}`,
      label: `@${p.id}`,
      hint: p.name,
      group: '대상',
      run: () => openDrill(p.id), // Navi 직통은 위(top-zone)에서 연다
    })),
    { id: 'act:scan', label: '프로젝트 스캔', group: '액션', run: () => void scan() },
    { id: 'act:refresh', label: '현황 새로고침', group: '액션', run: () => void refreshAll() },
    // Lain은 단일 총괄 세션이라 새 대화 없음 — top-zone에 Navi를 연 상태(drillTarget)에서만 새 대화 생성.
    { id: 'act:newconv', label: '새 대화', group: '액션', run: () => { if (drillTarget) newConversation(drillTarget) } },
    { id: 'act:prefs', label: '설정 열기', group: '액션', run: () => setPrefsOpen(true) },
    { id: 'act:inbox', label: '인박스 열기', group: '액션', run: () => setInboxOpen(true) },
    { id: 'act:lessons', label: '학습 (LEARNING)', group: '액션', run: () => setLessonsOpen(true) },
    { id: 'act:history', label: '작업 이력 (HISTORY)', group: '액션', run: () => setHistoryOpen(true) },
    { id: 'act:activity', label: '최근 활동 (ACTIVITY)', group: '액션', run: () => setActivityOpen(true) },
    { id: 'act:bench', label: '평가 (BENCH)', group: '액션', run: () => setBenchOpen(true) },
    { id: 'act:routines', label: '루틴 (ROUTINES)', group: '액션', run: () => setRoutinesOpen(true) },
    { id: 'act:planner', label: '플래너 (PLANNER)', group: '액션', run: () => setPlannerOpen(true) },
    { id: 'act:shortcuts', label: '단축키 도움말', group: '뷰', run: () => setHelpOpen(true) },
    { id: 'act:crt', label: 'CRT 효과 토글', group: '뷰', run: () => setCrtFx((v) => !v) },
    {
      id: 'act:theme',
      label: '테마 순환 (wired/amber/mono)',
      group: '뷰',
      run: () => setTheme((t) => (t === 'wired' ? 'amber' : t === 'amber' ? 'mono' : 'wired')),
    },
    ...enabled
      .filter((p) => p.verifyCmd)
      .map((p) => ({
        id: `verify:${p.id}`,
        label: `verify ${p.id}`,
        hint: p.verifyCmd ?? undefined,
        group: 'verify',
        run: () => window.lain.runVerify(p.id),
      })),
    ...enabled
      .filter((p) => p.status?.hasTaskMd)
      .map((p) => ({
        id: `task:${p.id}`,
        label: `작업 시작 ${p.id}`,
        group: '작업',
        run: () => void startTask(p.id),
      })),
    // B10 — 단축키가 있는 항목엔 우측 뱃지로 표기(paletteHotkeys 단일 출처 — 예: '단축키 도움말'=?).
  ].map((it) => (PALETTE_HOTKEYS[it.id] ? { ...it, hotkey: PALETTE_HOTKEYS[it.id] } : it))

  // 슬래시 명령 실행 — arg 없는 즉시 실행형은 바로, arg 있는 건 입력창에 채워 인자 입력 유도.
  const runSlash = useCallback(
    (c: SlashCmd) => {
      setSlashOpen(false)
      if (c.arg) {
        setInput(`${c.cmd} `) // 인자 대기 — 사용자가 id 입력 후 Enter
        inputRef.current?.focus()
        return
      }
      setInput('')
      switch (c.cmd) {
        case '/scan':
          void scan()
          break
        case '/refresh':
          void refreshAll()
          break
        case '/projects':
          switchTarget('manager') // 단일 세션 — Lain 대화 열기(예전 세션 목록 드릴다운 폐기)
          break
        case '/tasks':
        case '/approvals':
          setInboxOpen(true)
          break
        case '/plan':
          setPlannerOpen(true)
          break
        case '/compact':
          void compactNow()
          break
      }
    },
    [scan, refreshAll, switchTarget, compactNow],
  )

  // A12 — @ 파일 선택 → 상대경로로 @토큰 치환(첨부 변환 아님 — 레인이 경로를 읽고 스스로 Read).
  const pickAtFile = useCallback(
    (relPath: string) => {
      if (!atToken) return
      const { text, caret } = insertAtPath(input, atToken, relPath)
      setInput(text)
      setAtToken(null)
      const ta = inputRef.current
      ta?.focus()
      setTimeout(() => ta?.setSelectionRange(caret, caret), 0)
    },
    [atToken, input],
  )

  // A12 — @ 진입 시 1회 파일 목록 로드(캐시) 후 렌더러 fuzzy 필터. 레인 채팅은 등록 프로젝트 전체
  // (projectId 생략), Navi 드릴은 해당 프로젝트 cwd만(drillTarget=projectId). 이미 로드돼 있으면 재요청 안 함.
  const filesCacheRef = useRef<{ manager: string[] | null; navi: Map<string, string[]> }>({
    manager: null,
    navi: new Map(),
  })
  const ensureAtFilesLoaded = useCallback(async () => {
    if (filesCacheRef.current.manager) {
      setAtFiles(filesCacheRef.current.manager)
      return
    }
    const files = await window.lain.listFiles()
    filesCacheRef.current.manager = files
    setAtFiles(files)
  }, [])
  const ensureNaviAtFilesLoaded = useCallback(async (projectId: string) => {
    const cached = filesCacheRef.current.navi.get(projectId)
    if (cached) {
      setNaviAtFiles(cached)
      return
    }
    const files = await window.lain.listFiles(projectId)
    filesCacheRef.current.navi.set(projectId, files)
    setNaviAtFiles(files)
  }, [])

  // 입력 변경 — 회상 모드 종료(타이핑으로 새 기준) + 매니저에서 '/' 시작 시 슬래시 팝업 토글.
  // '/' 와 '@' 팝업은 트리거 문자로 분기해 배타(둘 다 열리지 않게) — '/'는 입력 맨 앞 고정이라
  // '/'로 시작하지 않을 때만 '@' 토큰을 검사한다.
  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value
      setInput(v)
      histIdxRef.current = null
      const isSlash = chatTargetRef.current === 'manager' && v.startsWith('/') && !v.includes('\n')
      setSlashOpen(isSlash)
      if (isSlash) {
        setAtToken(null)
        return
      }
      const caret = e.target.selectionStart ?? v.length
      const tok = parseAtToken(v, caret)
      setAtToken(tok)
      if (tok) void ensureAtFilesLoaded()
    },
    [ensureAtFilesLoaded],
  )

  // 입력창 키 처리 — 슬래시 팝업 우선 → 히스토리 회상(↑/↓) → Enter 전송.
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = inputRef.current
      // (1) 슬래시 팝업이 열려 있으면 ↑↓/Tab/Enter/Esc를 가로채 명령 선택
      if (slashOpen && slashFiltered.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSlashIdx((i) => (i + 1) % slashFiltered.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashIdx((i) => (i - 1 + slashFiltered.length) % slashFiltered.length)
          return
        }
        // 인자를 이미 타이핑한 상태('/learn 배포 절차')의 Enter는 명령 선택이 아니라 전송이다 —
        // runSlash가 입력을 '/cmd '로 리셋해 타이핑한 인자를 날리는 것을 막는다(Tab은 계속 선택).
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && /^\/\S+\s+\S/.test(input)) {
          e.preventDefault()
          setSlashOpen(false)
          send()
          return
        }
        if ((e.key === 'Tab' || e.key === 'Enter') && !e.nativeEvent.isComposing) {
          e.preventDefault()
          runSlash(slashFiltered[Math.min(slashIdx, slashFiltered.length - 1)])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation() // 전역 Esc까지 안 가게 — 슬래시 팝업만 닫음
          setSlashOpen(false)
          return
        }
      }
      // (1b) '@' 파일 팝업이 열려 있으면 ↑↓/Tab/Enter/Esc를 가로채 파일 선택(슬래시와 동일 패턴)
      if (atToken && atFiltered.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setAtIdx((i) => (i + 1) % atFiltered.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setAtIdx((i) => (i - 1 + atFiltered.length) % atFiltered.length)
          return
        }
        if ((e.key === 'Tab' || e.key === 'Enter') && !e.nativeEvent.isComposing) {
          e.preventDefault()
          pickAtFile(atFiltered[Math.min(atIdx, atFiltered.length - 1)])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setAtToken(null)
          return
        }
      }
      // (2) 히스토리 회상 — 입력이 비었거나 캐럿이 맨 앞일 때만(멀티라인 편집 보호). Shift/IME 제외.
      const caretAtStart = ta != null && ta.selectionStart === 0 && ta.selectionEnd === 0
      if (
        e.key === 'ArrowUp' &&
        !e.shiftKey &&
        !e.nativeEvent.isComposing &&
        (input === '' || caretAtStart)
      ) {
        const arr = messages
          .filter((m) => m.role === 'user')
          .map((m) => stripAttachSuffix(m.content))
        if (arr.length === 0) return
        e.preventDefault()
        if (histIdxRef.current === null) draftsRef.current.set(targetKey(), input) // 초안 보존
        const idx =
          histIdxRef.current === null ? 0 : Math.min(histIdxRef.current + 1, arr.length - 1)
        histIdxRef.current = idx
        const val = arr[arr.length - 1 - idx]
        setInput(val)
        setTimeout(() => ta?.setSelectionRange(val.length, val.length), 0)
        return
      }
      if (histIdxRef.current !== null && e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        const arr = messages
          .filter((m) => m.role === 'user')
          .map((m) => stripAttachSuffix(m.content))
        const idx = histIdxRef.current - 1
        if (idx < 0) {
          setInput(draftsRef.current.get(targetKey()) ?? '')
          histIdxRef.current = null
        } else {
          histIdxRef.current = idx
          setInput(arr[arr.length - 1 - idx])
        }
        return
      }
      // (3) Enter 전송 — Shift+Enter 줄바꿈, IME 조합 확정 Enter 제외(기존 동작)
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        setSlashOpen(false)
        setAtToken(null)
        send()
      }
    },
    [
      slashOpen,
      slashFiltered,
      slashIdx,
      runSlash,
      atToken,
      atFiltered,
      atIdx,
      pickAtFile,
      input,
      messages,
      targetKey,
      send,
    ],
  )

  // Ctrl+V 이미지 붙여넣기 — clipboard에 이미지 파일이 있으면 첨부 경로로(addFiles). 없으면 텍스트 기본 동작 유지.
  const onInputPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const imgs = Array.from(e.clipboardData.items)
        .filter((it) => it.kind === 'file' && it.type.startsWith('image'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f != null)
      if (imgs.length === 0) return // 이미지 없음 → 텍스트 기본 붙여넣기
      e.preventDefault()
      void addFiles(imgs)
    },
    [addFiles],
  )

  // ── top-zone Navi 입력 핸들러 (하단 레인 입력과 분리, 슬래시 없음 — A12 '@' 파일 자동완성은 있음) ──
  const naviHistIdxRef = useRef<number | null>(null)
  const naviOnChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value
      setNaviInput(v)
      naviHistIdxRef.current = null
      const caret = e.target.selectionStart ?? v.length
      const tok = parseAtToken(v, caret)
      setNaviAtToken(tok)
      if (tok && drillTarget) void ensureNaviAtFilesLoaded(drillTarget)
    },
    [drillTarget, ensureNaviAtFilesLoaded],
  )
  // A12 — @ 파일 선택 → 상대경로로 @토큰 치환(Navi cwd 기준 상대경로 그대로 — id 접두 없음).
  const pickNaviAtFile = useCallback(
    (relPath: string) => {
      if (!naviAtToken) return
      const { text, caret } = insertAtPath(naviInput, naviAtToken, relPath)
      setNaviInput(text)
      setNaviAtToken(null)
      const ta = naviInputRef.current
      ta?.focus()
      setTimeout(() => ta?.setSelectionRange(caret, caret), 0)
    },
    [naviAtToken, naviInput],
  )
  const naviOnKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = naviInputRef.current
      // (0) '@' 파일 팝업이 열려 있으면 ↑↓/Tab/Enter/Esc를 가로채 파일 선택(레인과 동일 패턴)
      if (naviAtToken && naviAtFiltered.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setNaviAtIdx((i) => (i + 1) % naviAtFiltered.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setNaviAtIdx((i) => (i - 1 + naviAtFiltered.length) % naviAtFiltered.length)
          return
        }
        if ((e.key === 'Tab' || e.key === 'Enter') && !e.nativeEvent.isComposing) {
          e.preventDefault()
          pickNaviAtFile(naviAtFiltered[Math.min(naviAtIdx, naviAtFiltered.length - 1)])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setNaviAtToken(null)
          return
        }
      }
      const caretAtStart = ta != null && ta.selectionStart === 0 && ta.selectionEnd === 0
      const userMsgs = () => naviMsgs.filter((m) => m.role === 'user').map((m) => stripAttachSuffix(m.content))
      if (
        e.key === 'ArrowUp' &&
        !e.shiftKey &&
        !e.nativeEvent.isComposing &&
        (naviInput === '' || caretAtStart)
      ) {
        const arr = userMsgs()
        if (arr.length === 0) return
        e.preventDefault()
        if (naviHistIdxRef.current === null && drillTarget)
          draftsRef.current.set(drillTarget, naviInput)
        const idx =
          naviHistIdxRef.current === null ? 0 : Math.min(naviHistIdxRef.current + 1, arr.length - 1)
        naviHistIdxRef.current = idx
        const val = arr[arr.length - 1 - idx]
        setNaviInput(val)
        setTimeout(() => ta?.setSelectionRange(val.length, val.length), 0)
        return
      }
      if (naviHistIdxRef.current !== null && e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        const arr = userMsgs()
        const idx = naviHistIdxRef.current - 1
        if (idx < 0) {
          setNaviInput(drillTarget ? (draftsRef.current.get(drillTarget) ?? '') : '')
          naviHistIdxRef.current = null
        } else {
          naviHistIdxRef.current = idx
          setNaviInput(arr[arr.length - 1 - idx])
        }
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        setNaviAtToken(null)
        sendNavi()
      }
    },
    [naviAtToken, naviAtFiltered, naviAtIdx, pickNaviAtFile, naviInput, naviMsgs, drillTarget, sendNavi],
  )
  const naviOnPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const imgs = Array.from(e.clipboardData.items)
        .filter((it) => it.kind === 'file' && it.type.startsWith('image'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f != null)
      if (imgs.length === 0) return
      e.preventDefault()
      void addNaviFiles(imgs)
    },
    [addNaviFiles],
  )

  // 검색바 JSX — 레인 채팅·Navi 드릴 뷰가 공유(A11). 대상은 searchMsgs(위에서 drillTarget 여부로 분기).
  const searchBar = searchOpen && (
    <div className="chat-search">
      <input
        ref={searchInputRef}
        className="chat-search-input"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="대화에서 검색 — Enter 다음 · Shift+Enter 이전"
        onKeyDown={(e) => {
          e.stopPropagation() // 전송(send)·전역 키와 분리
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (searchHits.length === 0) return
            setSearchHitIdx((i) =>
              e.shiftKey
                ? (i - 1 + searchHits.length) % searchHits.length
                : (i + 1) % searchHits.length,
            )
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setSearchOpen(false)
            setSearchQuery('')
          }
        }}
      />
      <span className="chat-search-count">
        {searchHits.length ? Math.min(searchHitIdx, searchHits.length - 1) + 1 : 0}/
        {searchHits.length}
      </span>
      {/* A15 — '전체 기간' 토글: 레인 대화(scope='manager') DB 전문검색으로 200개 페이지 밖도 찾는다.
          드릴(Navi) 뷰는 대상 없음 — 숨긴다(허수 UI 방지). */}
      {!drillTarget && (
        <button
          className={`chat-search-nav${searchAllTime ? ' chat-search-nav-on' : ''}`}
          title="전체 기간 검색(DB) — 최근 로드분 밖도 찾는다"
          onClick={() => setSearchAllTime((v) => !v)}
        >
          전체기간
        </button>
      )}
      <button
        className="chat-search-nav"
        title="이전 매치"
        disabled={searchHits.length === 0}
        onClick={() => setSearchHitIdx((i) => (i - 1 + searchHits.length) % searchHits.length)}
      >
        <Icon name="chevron-up" size={14} />
      </button>
      <button
        className="chat-search-nav"
        title="다음 매치"
        disabled={searchHits.length === 0}
        onClick={() => setSearchHitIdx((i) => (i + 1) % searchHits.length)}
      >
        <Icon name="chevron-down" size={14} />
      </button>
      <button
        className="chat-search-nav"
        title="검색 닫기"
        onClick={() => {
          setSearchOpen(false)
          setSearchQuery('')
        }}
      >
        <Icon name="x-circle" size={14} />
      </button>
    </div>
  )

  return (
    <div className={`app${crtFx ? ' crt' : ''}${theme !== 'wired' ? ` theme-${theme}` : ''}`}>
      {/* ② 자동 업데이트 — Lain이 한가할 때 띄우는 제안 배너(고정 토스트). '나중에'는 그 버전만 숨김. */}
      {upd?.suggested &&
        upd.version &&
        upd.version !== updDismissed &&
        (upd.state === 'available' || upd.state === 'downloading' || upd.state === 'downloaded') && (
          <div className="upd-banner">
            <span className="upd-banner-prefix">Lain</span>
            <span className="upd-banner-msg">
              {upd.state === 'downloaded'
                ? `새 버전 v${upd.version} 준비됐어. 재시작하면 적용돼.`
                : upd.state === 'downloading'
                  ? `새 버전 v${upd.version} 받는 중… ${upd.percent ?? 0}%`
                  : `새 버전 v${upd.version} 나왔어. 지금 받을까?`}
            </span>
            {upd.state === 'downloaded' ? (
              <button className="upd-banner-btn ok" onClick={() => void window.lain.installUpdate()}>
                지금 적용
              </button>
            ) : upd.state === 'available' ? (
              <button className="upd-banner-btn ok" onClick={() => void window.lain.downloadUpdate()}>
                지금 업데이트
              </button>
            ) : null}
            <button className="upd-banner-btn" onClick={() => setUpdDismissed(upd.version ?? null)}>
              나중에
            </button>
          </div>
        )}
      <header
        className="manager-bar panel"
        onDoubleClick={(e) => {
          // 드래그 영역 더블클릭 → 최대화 토글 (버튼·셀렉트 등 제외)
          if ((e.target as HTMLElement).closest('button,select,input,.hmenu')) return
          window.lain.windowMaximizeToggle()
        }}
      >
        <div className="hmenu-wrap">
          <button
            className="hamburger"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="메뉴"
            aria-expanded={menuOpen}
            title="메뉴 — 환경설정·학습·평가·CRT"
          >
            <Icon name="menu" size={14} />
          </button>
          {menuOpen && (
            <>
              <div className="hmenu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="hmenu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setPrefsOpen(true)
                    setMenuOpen(false)
                  }}
                >
                  <Icon name="gear" size={14} /> 환경설정
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setLessonsOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  <Icon name="book-open" size={14} /> 학습 (LEARNING)
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setHistoryOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  <Icon name="clock" size={14} /> 작업 이력 (HISTORY)
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setActivityOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  <Icon name="globe" size={14} /> 최근 활동 (ACTIVITY)
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setBenchOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  <Icon name="chart" size={14} /> 평가 (BENCH)
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setRoutinesOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  <Icon name="clock" size={14} /> 루틴 (ROUTINES)
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setPlannerOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  <Icon name="calendar" size={14} /> 플래너
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setCrtFx((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  CRT 효과 {crtFx ? '끄기' : '켜기'}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setTheme((t) => (t === 'wired' ? 'amber' : t === 'amber' ? 'mono' : 'wired'))
                  }}
                >
                  테마: {theme}
                </button>
              </div>
            </>
          )}
        </div>
        <span className="logo">
          lain<span className="logo-blink">_</span>
        </span>
        <span className="bar-stat">
          <span className="stat-text">
            projects {enabled.length} · dirty {dirtyCount} · fail {failCount} ·{' '}
          </span>
          {/* C4 — 토큰 표시 클릭 → 최근 14일 미니 바차트 + 프로젝트별 상위 소비 팝오버. '오늘'은 created_at 기준. */}
          <span className="usage-anchor">
            <button
              className="stat-usage-btn"
              onClick={() => setUsageOpen((v) => !v)}
              title="클릭하면 최근 14일 토큰 추이·프로젝트별 상위 소비"
            >
              오늘 {usageLabel(fmtTokens(todayTokens), todayCost)}
            </button>
            {usageOpen && usage && (
              <UsagePopover
                usage={usage}
                projects={projectList}
                onClose={() => setUsageOpen(false)}
              />
            )}
          </span>
          <button
            className={`chip chip-inbox${inboxCount > 0 ? ' chip-inbox-on' : ''}`}
            onClick={() => setInboxOpen((v) => !v)}
            title={
              inboxCount > 0 ? `${inboxCount}건 대기 — 클릭해 인박스 열기` : '대기 없음 — 인박스'
            }
          >
            {inboxCount > 0 ? <><Icon name="bell" size={14} /> {inboxCount} 대기</> : 'INBOX 0'}
          </button>
        </span>
        <span className="bar-actions">
          <button onClick={scan} disabled={refreshing} title={`${wsRoot} 스캔`}>
            <Icon name="magnifier" size={14} /> SCAN
          </button>
          <button onClick={refreshAll} disabled={refreshing} title="현황 새로고침">
            {refreshing ? '...' : <><Icon name="refresh" size={14} /> REFRESH</>}
          </button>
          <button onClick={() => window.lain.addProjectDialog()} title="프로젝트 추가">
            + ADD
          </button>
        </span>
        <span className="win-controls">
          <button
            className="wc"
            onClick={() => window.lain.windowMinimize()}
            aria-label="최소화"
            title="최소화"
          >
            ─
          </button>
          <button
            className="wc"
            onClick={() => window.lain.windowMaximizeToggle()}
            aria-label={maximized ? '이전 크기' : '최대화'}
            title={maximized ? '이전 크기' : '최대화'}
          >
            <Icon name="window" size={18} />
          </button>
          <button
            className="wc wc-close"
            onClick={() => window.lain.windowClose()}
            aria-label="닫기"
            title="닫기"
          >
            <Icon name="x-circle" size={18} />
          </button>
        </span>
      </header>

      <div className="body body-sidebar">
        {/* 왼쪽 = 내비 목록(기본)·세션 목록(드릴) 스크롤 + 레인 캐릭터(하단 고정) | 오른쪽 = 채팅 전체 높이 */}
        <aside className="side-col" aria-label="NAVIS">
          <div className="side-scroll">
            {drillTarget ? (
              <SessionList
                  name={projectList.find((p) => p.id === drillTarget)?.name ?? drillTarget}
                  sprite={(() => {
                    const dp = projectList.find((p) => p.id === drillTarget)
                    return dp ? <ProjectSprite project={dp} px={3} /> : null
                  })()}
                  conversations={convList}
                  openConv={naviConv}
                  onPick={openNaviConversation}
                  onNew={() => newConversation(drillTarget)}
                  onRename={(cid, t) => renameConversation(drillTarget, cid, t)}
                  onDelete={(cid) => deleteConversation(drillTarget, cid)}
                  onBack={closeDrill}
                />
            ) : projects === null ? (
            // B15 — 초기 로딩 중(응답 전). 빈 상태 안내와 구분되는 은은한 한 줄만.
            <div className="empty dim">불러오는 중…</div>
            ) : projectList.length === 0 ? (
            <div className="empty">
              등록된 프로젝트 없음 — <b>SCAN {wsRoot}</b> 또는 아래로 시작.
              <button
                className="add-navi-tile"
                onClick={() => window.lain.addProjectDialog()}
                title="프로젝트 폴더를 골라 새 내비로 추가"
                style={{ marginTop: 10 }}
              >
                ＋ 내비 추가
              </button>
            </div>
          ) : (
            <div className="top-grid">
              {/* 보이는 Navi(숨김 제외) — 우선순위(질문>결재>에러>작업>대기)로 정렬. prio는 naviStatus 재사용. */}
              {projectList
                .filter((p) => !p.muted)
                .map((p) => ({ p, prio: naviStatus(p, activeTaskOf(p.id)).prio }))
                .sort((a, b) => a.prio - b.prio)
                .map(({ p }) => (
                  <NaviTile
                    key={p.id}
                    project={p}
                    task={activeTaskOf(p.id)}
                    focused={false}
                    unread={unread.has(p.id)}
                    activity={(() => {
                      const t = activeTaskOf(p.id)
                      return t ? (taskActivity.get(t.id) ?? null) : null
                    })()}
                    onFocus={openDrill}
                    onOpenTask={openTask}
                    onStartTask={startTask}
                    onContextMenu={openNaviMenu}
                    onRequestRemove={requestRemove}
                  />
                ))}
              {/* 내비 추가 — 그리드 끝의 점선 타일(폴더 피커). */}
              <button
                className="add-navi-tile"
                onClick={() => window.lain.addProjectDialog()}
                title="프로젝트 폴더를 골라 새 내비로 추가"
              >
                ＋ 내비 추가
              </button>
              {/* 숨김 — 유저가 숨긴 내비(레인은 계속 관리, 먼저 언급만 안 함). 기본 접힘. 구 대기실 대체. */}
              {projectList.some((p) => p.muted) && (
                <div className="hidden-room">
                  <button
                    className="hidden-room-head"
                    onClick={() => setHiddenRoomOpen((v) => !v)}
                    title="숨긴 내비 — 레인이 관리는 계속하되 먼저 언급하지 않음. 클릭해 펼치기/접기"
                  >
                    {hiddenRoomOpen ? <Icon name="chevron-down" size={14} /> : <Icon name="chevron-right" size={14} />} 숨김 ·{' '}
                    {projectList.filter((p) => p.muted).length}
                  </button>
                  {hiddenRoomOpen && (
                    <div className="hidden-room-grid">
                      {projectList
                        .filter((p) => p.muted)
                        .map((p) => (
                          <NaviTile
                            key={p.id}
                            project={p}
                            task={activeTaskOf(p.id)}
                            focused={false}
                            unread={unread.has(p.id)}
                            activity={(() => {
                              const t = activeTaskOf(p.id)
                              return t ? (taskActivity.get(t.id) ?? null) : null
                            })()}
                            onFocus={openDrill}
                            onOpenTask={openTask}
                            onStartTask={startTask}
                            onContextMenu={openNaviMenu}
                            onRequestRemove={requestRemove}
                          />
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          </div>
          {/* 레인 캐릭터 — 사이드바 하단 고정(지금처럼 아래쪽). 캐릭터가 곧 lain 본인. */}
          <div className="lain-char">
            <LainBubble /> {/* 상호작용 대사(quips) 말풍선 — 절대배치, 클릭 통과 */}
            <ManagerSprite size={260} busy={managerBusy} />
            <div className="lain-meta">
            {/* 🔄 Lain 세션 새로고침 — 메타 컬럼 최상단. 무한세션이라 '새 대화'가 없어, 옛 스레드로 헛도는 Lain을 리셋 */}
            <button
              className="lain-reset"
              title="Lain 새로고침 — 진행 중 응답을 멈추고 누적 맥락(월드스테이트)을 비워 새 세션으로 시작. 채팅 로그는 남는다."
              onClick={async () => {
                // B9 — OS confirm 대신 CRT 테마 확인창. 파괴적이지 않아(로그 보존) danger=false.
                const ok = await confirm({
                  title: 'Lain 세션 새로고침',
                  body: '진행 중 응답을 멈추고 누적 맥락(월드스테이트)을 비워 새 세션으로 시작합니다.',
                  note: '채팅 로그는 남습니다.',
                  confirmLabel: '새로고침',
                  danger: false,
                })
                if (!ok) return
                // 즉시 '응답 중' 해제 + 미전송 대기열 폐기 — 새 세션으로 리셋하는데 큐가 남아 있으면
                // busy 해제가 곧바로 낡은 대기 메시지를 새 세션으로 쏴버린다. desync 고착도 함께 푼다.
                haltAndClearQueue()
                window.lain.resetManager()
              }}
            >
              <Icon name="refresh" size={16} />
            </button>
            <div className="lain-id">
              <span className="lain-id-name">Lain</span>
              <span className={`mgr-status ${managerBusy ? 'st-working' : 'st-idle'}`}>
                <span className="status-dot" />
                {managerBusy ? '응답 중' : '대기'}
              </span>
              {callState !== 'idle' && (
                <span className={`call-badge call-${callState}`} title="디스코드 음성 통화">
                  📞 {CALL_LABEL[callState]}
                </span>
              )}
            </div>
            {/* 카운터 — 항목별 한 줄(감시 중/작업 중/미커밋/미푸시/에러). 나머지 주의 항목은 ⚠ 줄 유지. */}
            <div className="lain-stat">
              <div className="lain-stat-line">감시 중 {enabled.length}</div>
              <div className="lain-stat-line">
                작업 중 <span className={workingCount > 0 ? 'st-working' : ''}>{workingCount}</span>
              </div>
              <div className="lain-stat-line">
                미커밋 <span className={dirtyCount > 0 ? 'st-dirty' : ''}>{dirtyCount}</span>
              </div>
              <div className="lain-stat-line">
                미푸시 <span className={unpushedCount > 0 ? 'st-dirty' : ''}>{unpushedCount}</span>
              </div>
              <div className="lain-stat-line">
                에러 <span className={errorCount > 0 ? 'st-dirty' : ''}>{errorCount}</span>
              </div>
              {sideAttnParts.length > 0 && (
                <div className="lain-stat-attn">
                  <Icon name="bell" size={14} /> {sideAttnParts.join(' · ')}
                </div>
              )}
              {attnTotal === 0 && (
                <div className="lain-stat-ok">
                  <Icon name="check" size={14} /> 모두 안정 · 오늘 {usageLabel(fmtTokens(todayTokens), todayCost)}
                </div>
              )}
            </div>
            {/* 유저 감시 토글 — 환경설정에서 메인(레인 이미지 아래)으로 이동. */}
            <label
              className="lain-watch"
              title="메인창을 안 볼 때 화면 작업을 관찰해, Lain이 먼저 도울 말이 있을 때만 우하단에 잠깐 떴다 사라집니다"
            >
              <input
                type="checkbox"
                checked={!!settings?.overlayMonitoringEnabled}
                onChange={(e) =>
                  void window.lain
                    .setSettings({ overlayMonitoringEnabled: e.target.checked })
                    .then(setSettings)
                }
              />
              <span>
                <Icon name={settings?.overlayMonitoringEnabled ? 'eye' : 'eye-off'} size={14} /> 유저 감시
              </span>
            </label>
            </div>
          </div>
        </aside>

        {/* 오른쪽 = 채팅 전체 높이. 기본=레인(manager), 내비 클릭 시=해당 내비 채팅으로 잠깐 전환. */}
        <main className="main-col" aria-label="LAIN">
          {openedTask && (
            <TaskDrawer
              task={openedTask}
              approvals={approvals}
              events={taskEvents}
              onClose={() => setOpenTaskId(null)}
            />
          )}
          {drillTarget ? (
            <>
              <section className="chat-main panel" aria-label="NAVI CHAT">
                <div className="panel-label">[ wired://navi/{drillTarget} ]</div>
                <div className="mgr-actions">
                  {activeTaskOf(drillTarget) ? (
                    <button onClick={() => openTask(activeTaskOf(drillTarget)!.id)}>
                      <Icon name="menu" size={14} /> 콘솔
                    </button>
                  ) : (
                    projectList.find((p) => p.id === drillTarget)?.status?.hasTaskMd && (
                      <button onClick={() => startTask(drillTarget)}>
                        <Icon name="play" size={14} /> 작업
                      </button>
                    )
                  )}
                  <button
                    onClick={() => exportConversation(naviConv)}
                    disabled={!naviConv}
                    title="대화 전체를 markdown(.md) 파일로 저장"
                  >
                    내보내기(.md)
                  </button>
                </div>
                {/* 막힌 작업의 명세 질문 — blocked 동안만, 답하면 사라진다 */}
                {activeTaskOf(drillTarget)?.state === 'blocked' && (
                  <div className="blocked-banner">
                    <div className="blocked-banner-q">
                      ❓ 이 작업이 막혔다 — 명세 질문:{' '}
                      {activeTaskOf(drillTarget)!.questions.join('  ·  ') ||
                        '(질문 없음 — 드로어 확인)'}
                    </div>
                    <div className="blocked-banner-hint">
                      아래에 입력하면 이 질문의 <b>답변으로</b> 전달된다(잡담 아님).
                    </div>
                  </div>
                )}
                {/* 검색바 — 레인 채팅과 공유(A11). searchMsgs가 드릴 중엔 naviMsgs를 본다. */}
                {searchBar}
                <NaviChatPanel
                  projectId={drillTarget}
                  messages={naviMsgs}
                  busy={naviBusy.has(drillTarget)}
                  approvals={naviApprovals}
                  onMessageContext={onMessageContext}
                  query={searchOpen ? searchQuery : ''}
                  activeHitId={activeHitId}
                  queuedIds={naviQueuedIds}
                  onCancelQueued={onCancelQueuedNavi}
                />
              </section>
              <footer className="input-row panel">
                {naviAttachments.length > 0 && (
                  <div className="attach-preview">
                    {naviAttachments.map((a, i) => (
                      <div
                        key={i}
                        className={`attach-tile${a.isImage ? ' is-image' : ''}`}
                        title={a.name}
                      >
                        {a.isImage ? (
                          <img
                            src={`data:${a.mimeType};base64,${a.data}`}
                            alt={a.name}
                            className="attach-tile-img"
                          />
                        ) : (
                          <div className="attach-tile-file">
                            <span className="attach-tile-icon">📄</span>
                            <span className="attach-tile-name">{a.name}</span>
                          </div>
                        )}
                        <button
                          className="attach-tile-remove"
                          onClick={() =>
                            setNaviAttachments((prev) => prev.filter((_, j) => j !== i))
                          }
                          title="첨부 제거"
                          aria-label="첨부 제거"
                        >
                          <Icon name="x-circle" size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {/* A12 — '@' 파일 자동완성 팝업(해당 프로젝트 cwd 범위) */}
                {naviAtToken && (
                  <AtFileMenu
                    items={naviAtFiltered}
                    activeIndex={Math.min(naviAtIdx, Math.max(0, naviAtFiltered.length - 1))}
                    onPick={pickNaviAtFile}
                    onHover={setNaviAtIdx}
                  />
                )}
                <div className="input-controls">
                  <input
                    ref={naviFileInputRef}
                    type="file"
                    multiple
                    accept="image/*,text/*,.md,.ts,.tsx,.js,.jsx,.py,.json,.yaml,.yml,.toml,.css,.html,.sh,.bat,.ps1,.csv,.xml,.sql"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      await addNaviFiles(Array.from(e.target.files ?? []))
                      e.target.value = ''
                    }}
                  />
                  <button
                    className="plus-btn"
                    onClick={() => naviFileInputRef.current?.click()}
                    title="파일·사진 추가"
                    aria-label="파일 추가"
                  >
                    ＋
                  </button>
                  <textarea
                    ref={naviInputRef}
                    className="input-ta"
                    rows={1}
                    value={naviInput}
                    onChange={naviOnChange}
                    onPaste={naviOnPaste}
                    onKeyDown={naviOnKeyDown}
                    placeholder={
                      naviBusy.has(drillTarget)
                        ? `Navi 응답 대기 중... (큐 ${naviQueueLength(naviMsgQueue, drillTarget)})`
                        : `@${drillTarget}에게…`
                    }
                  />
                  {naviBusy.has(drillTarget) ? (
                    <button
                      className="stop-btn"
                      onClick={() => {
                        const target = drillTarget
                        // A10 — busy 해제 전에 대기열부터 비운다(Esc 핸들러와 동일 순서 — 정지가 안 먹는 문제 방지).
                        haltAndClearNaviQueue(target)
                        window.lain.stopNaviChat(target)
                        setNaviBusy((prev) => {
                          const next = new Set(prev)
                          next.delete(target)
                          return next
                        })
                      }}
                      title="응답 정지 / 대기 해제"
                    >
                      ■
                    </button>
                  ) : (
                    <button
                      className="send-btn"
                      onClick={sendNavi}
                      title="전송 (Enter)"
                      disabled={!naviInput.trim() && naviAttachments.length === 0}
                    >
                      <Icon name="send" size={16} />
                    </button>
                  )}
                </div>
              </footer>
            </>
          ) : (
            <div
              className={`lain-main${dropActive ? ' drop-active' : ''}`}
              onDragEnter={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return
                e.preventDefault()
                dragDepth.current += 1
                setDropActive(true)
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }}
              onDragLeave={() => {
                dragDepth.current -= 1
                if (dragDepth.current <= 0) {
                  dragDepth.current = 0
                  setDropActive(false)
                }
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return
                e.preventDefault()
                dragDepth.current = 0
                setDropActive(false)
                void addFiles(Array.from(e.dataTransfer.files))
              }}
            >
              {dropActive && <div className="drop-overlay">여기에 놓아 첨부</div>}
            <section className="chat-main panel" aria-label="CHAT">
            <div className="panel-label">
              [ wired://{chatTarget === '@all' ? 'broadcast' : 'lain'} ]
            </div>
            {chatTarget !== '@all' && (
              <div className="mgr-actions">
                <button
                  onClick={() => exportConversation(openConv)}
                  disabled={!openConv}
                  title="대화 전체를 markdown(.md) 파일로 저장"
                >
                  내보내기(.md)
                </button>
              </div>
            )}
            {/* 상시 대기 배너 — 놓침 방지. 클릭 시 인박스 열기 (인박스 미오픈 + 대기 있을 때만) */}
            {inboxCount > 0 && !inboxOpen && (
              <button className="wait-banner" onClick={() => setInboxOpen(true)}>
                ⚠ 너를 기다리는 {inboxCount}건 — 승인 {approvals.length}·질문 {blockedCount}·결재{' '}
                {reviewCount} ▸
              </button>
            )}
            {/* 챕터 목차(TOC) — 레인 대화의 '챕터로 고정'한 메시지로 점프 */}
            {messages.some((m) => m.chapter) && (
              <div className="chat-toc">
                <button
                  className="toc-toggle"
                  onClick={() => setTocOpen((o) => !o)}
                  title="챕터 목차"
                >
                  <Icon name="bookmark" size={14} /> {messages.filter((m) => m.chapter).length}
                </button>
                {tocOpen && (
                  <div className="toc-list">
                    {messages
                      .filter((m) => m.chapter)
                      .map((c) => (
                        <button
                          key={c.id}
                          className="toc-item"
                          onClick={() => {
                            document
                              .getElementById(`lain-chap-${c.id}`)
                              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            setTocOpen(false)
                          }}
                        >
                          {c.chapter}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}
            {/* 검색 토글(🔍)·세션 새로고침(🔄) 버튼은 각각 Ctrl+F·레인 캐릭터 옆으로 이동됨 */}
            {/* 검색바 — 레인 대화 메시지를 클라이언트에서 필터·하이라이트·이동 (A11: 드릴 뷰에도 동일하게 렌더) */}
            {chatTarget !== '@all' && searchBar}
            <ChatPanel
              messages={messages}
              busy={managerBusy}
              liveTool={managerLiveTool}
              turnStartedAt={managerTurnStartedAt}
              onMessageContext={onMessageContext}
              query={searchOpen ? searchQuery : ''}
              activeHitId={activeHitId}
              lead={briefLead}
              sessionStart={sessionStart}
              queuedIds={queuedIds}
              onCancelQueued={cancelQueued}
              pendingQuestion={pendingQuestion}
              onAnswerQuestion={answerQuestion}
              onLoadMore={loadOlderMessages}
              loadingMore={loadingMore}
              hasMore={hasMore}
            />
          </section>

          {inboxOpen && (
            <AttentionInbox
              approvals={approvals}
              tasks={tasks}
              onOpenTask={openTask}
              onClose={() => setInboxOpen(false)}
            />
          )}

          <footer className="input-row panel">
            {/* B6/B7-2 — 음성 실패·폴백 힌트: 잠깐 뜨고 자동 소멸(showVoiceHint) */}
            {voiceHint && <div className="voice-hint">{voiceHint}</div>}
            {/* 파일 첨부 미리보기 (입력창 위) — 정사각형 썸네일 그리드 */}
            {attachments.length > 0 && (
              <div className="attach-preview">
                {attachments.map((a, i) => (
                  <div
                    key={i}
                    className={`attach-tile${a.isImage ? ' is-image' : ''}`}
                    title={a.name}
                  >
                    {a.isImage ? (
                      <img
                        src={`data:${a.mimeType};base64,${a.data}`}
                        alt={a.name}
                        className="attach-tile-img"
                      />
                    ) : (
                      <div className="attach-tile-file">
                        <span className="attach-tile-icon">📄</span>
                        <span className="attach-tile-name">{a.name}</span>
                      </div>
                    )}
                    <button
                      className="attach-tile-remove"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      title="첨부 제거"
                      aria-label="첨부 제거"
                    >
                      <Icon name="x-circle" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* '/' 슬래시 명령 팝업 — 입력창 위에 뜨는 필터형 세로 목록(레인 전용, 키 처리는 textarea) */}
            {slashOpen && (
              <SlashMenu
                items={slashFiltered}
                activeIndex={Math.min(slashIdx, Math.max(0, slashFiltered.length - 1))}
                onPick={runSlash}
                onHover={setSlashIdx}
              />
            )}
            {/* A12 — '@' 파일 자동완성 팝업(등록 프로젝트 전체) — '/'와 같은 자리, 배타적으로 뜬다 */}
            {atToken && (
              <AtFileMenu
                items={atFiltered}
                activeIndex={Math.min(atIdx, Math.max(0, atFiltered.length - 1))}
                onPick={pickAtFile}
                onHover={setAtIdx}
              />
            )}
            {/* 입력 컨트롤 행 — +메뉴 + 대상(레인/전체) + 입력 + 전송/정지 */}
            <div className="input-controls">
              {/* 숨김 파일 입력 — +메뉴의 '파일·사진 추가'가 트리거 */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,text/*,.md,.ts,.tsx,.js,.jsx,.py,.json,.yaml,.yml,.toml,.css,.html,.sh,.bat,.ps1,.csv,.xml,.sql"
                style={{ display: 'none' }}
                onChange={async (e) => {
                  await addFiles(Array.from(e.target.files ?? []))
                  e.target.value = '' // 같은 파일 재선택 허용
                }}
              />
              <select
                className="target-select"
                value={chatTarget}
                onChange={(e) => switchTarget(e.target.value)}
                title="메시지 대상 — 레인 또는 전체 Navi 브로드캐스트"
              >
                <option value="manager">@Lain</option>
                <option value="@all">@all (전체)</option>
              </select>
              <textarea
                ref={inputRef}
                className="input-ta"
                rows={1}
                value={input}
                onChange={onInputChange}
                onPaste={onInputPaste}
                onKeyDown={onInputKeyDown}
                placeholder={
                  chatTarget === '@all'
                    ? '@all — 전 Navi에게 브로드캐스트…'
                    : managerBusy
                      ? `lain 응답 중… (큐 ${msgQueue.length})`
                      : '/를 통해 명령어 입력'
                }
                autoFocus
              />
              {/* PC 네이티브 음성 — 매니저 대화에서만. 마이크 PTT + 답변 음성 듣기 토글. */}
              {chatTarget === 'manager' && (
                <>
                  <button
                    className={`mic-btn${recording ? ' rec' : ''}`}
                    title={
                      settings?.groqApiKey
                        ? '눌러서 말하기 (떼면 전송) — 디스코드 없이 PC에서 직접'
                        : '음성 입력엔 Groq STT 키 필요 (환경설정)'
                    }
                    disabled={!settings?.groqApiKey || managerBusy}
                    onMouseDown={startRec}
                    onMouseUp={stopRec}
                    onMouseLeave={() => recording && stopRec()}
                  >
                    {recording ? <Icon name="stop" size={14} /> : <Icon name="microphone" size={14} />}
                  </button>
                  <button
                    className={`voiceout-btn${voiceOut ? ' on' : ''}${voicePlaying ? ' playing' : ''}`}
                    title={voicePlaying ? '재생 중 — 클릭하면 정지' : '레인 답변을 음성으로 듣기 (Supertonic)'}
                    onClick={() => {
                      // B7-3 — 재생 중엔 클릭이 정지 전용(토글 상태는 그대로 유지, 다음 응답부턴 다시 읽는다).
                      if (voicePlaying) {
                        stopVoice()
                        return
                      }
                      const next = !voiceOut
                      voiceOutRef.current = next
                      setVoiceOut(next)
                      if (!next) stopVoice() // 끄면 재생 중인 음성도 즉시 중단
                      void window.lain.setSettings({ pcVoiceOut: next }) // 영구 저장
                    }}
                  >
                    {voiceOut || voicePlaying ? (
                      <Icon name="volume" size={14} />
                    ) : (
                      <Icon name="volume-off" size={14} />
                    )}
                  </button>
                </>
              )}
              {/* 전송/정지 — 매니저 응답 중이면 정지, 그 외 전송(↵). @all은 busy 없음. */}
              {chatTarget === 'manager' && managerBusy ? (
                <button
                  className="stop-btn"
                  onClick={() => {
                    // 즉시 '응답 중' 해제 + 미전송 대기열 폐기 — 메인 desync로 종료 이벤트가 못 와도 정지가
                    // 항상 먹히게(낙관). 큐를 안 비우면 busy 해제가 곧바로 다음 대기 메시지를 쏴 정지가 무효화된다.
                    // 실제 중단(abort·강제종료)은 stopChat이 메인에서 수행.
                    haltAndClearQueue()
                    window.lain.stopChat()
                  }}
                  title="응답 정지"
                >
                  ■
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={send}
                  title="전송 (Enter)"
                  disabled={!input.trim() && attachments.length === 0}
                >
                  <Icon name="send" size={16} />
                </button>
              )}
            </div>
          </footer>
          {settings && (
            <InputModeBar
              settings={settings}
              onPatch={(p) => void window.lain.setSettings(p).then(setSettings)}
              onPlus={(a) => setPlusMenu(a)}
              contextPercent={
                contextGauge ? contextPercent(contextGauge.tokens, contextGauge.threshold) : null
              }
            />
          )}
            </div>
          )}
        </main>
      </div>

      {/* 첫 실행 온보딩 — onboardingDone 전까지 1회. 기존 설치는 store 마이그레이션이 자동 스킵 */}
      {settings && !settings.onboardingDone && (
        <OnboardingModal settings={settings} onDone={setSettings} />
      )}

      {prefsOpen && <PrefsModal onClose={() => setPrefsOpen(false)} />}

      {lessonsOpen && <LessonsPanel onClose={() => setLessonsOpen(false)} />}

      {/* C3 — 완료 작업 이력. 행 클릭 시 openTask로 기존 TaskDrawer를 읽기전용 재사용(done/cancelled도 안전) */}
      {historyOpen && <HistoryPanel onClose={() => setHistoryOpen(false)} onOpenTask={openTask} />}

      {/* C6 — 전역 활동 피드(task_events+cc_events 시간 역순 병합) */}
      {activityOpen && <ActivityPanel onClose={() => setActivityOpen(false)} />}

      {benchOpen && <BenchPanel onClose={() => setBenchOpen(false)} />}
      {routinesOpen && <RoutinesPanel onClose={() => setRoutinesOpen(false)} />}
      {plannerOpen && <PlannerPanel onClose={() => setPlannerOpen(false)} />}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems(ctxMenu.msg)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {naviMenu && (
        <ContextMenu
          x={naviMenu.x}
          y={naviMenu.y}
          items={naviCtxItems(naviMenu.project)}
          onClose={() => setNaviMenu(null)}
        />
      )}

      {plusMenu && (
        <ContextMenu
          x={plusMenu.x}
          y={plusMenu.y}
          items={plusItems}
          onClose={() => setPlusMenu(null)}
          rounded
          openUp
        />
      )}

      {pendingRemove && (
        <ConfirmWindow
          title="내비 제거"
          message={
            <>
              <b>{pendingRemove.name}</b> 내비를 보드에서 제거할까요?
              <br />
              대화·학습·작업·현황 기록은 <b>보존</b>됩니다 — 같은 폴더를 다시 추가하면 그대로 복원됩니다.
            </>
          }
          note={
            <>
              보드에서 숨길 뿐, 디스크의 프로젝트 폴더(<code>{pendingRemove.path}</code>)와 기록은 그대로입니다.
            </>
          }
          confirmLabel="제거"
          onCancel={() => setPendingRemove(null)}
          onConfirm={confirmRemove}
        />
      )}

      {paletteOpen && (
        <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />
      )}

      {/* B10 — '?' 단축키 도움말 오버레이 */}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}

      {/* B9 — useConfirm(Promise 반환형) 확인창 — 작업 시작 실패·대화 삭제·세션 리셋 공용 */}
      {confirmPending && (
        <ConfirmWindow
          title={confirmPending.title}
          message={confirmPending.body}
          note={confirmPending.note}
          confirmLabel={confirmPending.confirmLabel}
          danger={confirmPending.danger}
          hideCancel={confirmPending.hideCancel}
          onCancel={onConfirmCancel}
          onConfirm={onConfirmOk}
        />
      )}
    </div>
  )
}
