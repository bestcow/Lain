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
  ChatMessage,
  Conversation,
  ConversationPreview,
  FileAttachment,
  ProjectView,
  Task,
  TaskEvent,
  DiscordCallState,
  LainSettings,
  UpdateStatus,
} from '../shared/types'
import { NaviTile } from './components/NaviTile'
import { naviStatus } from './components/StageView'
import { SessionList } from './components/SessionList'
import { ChatPanel } from './components/ChatPanel'
import { ManagerSprite } from './components/Sprites'
import { ProjectSprite } from './components/projectSprite'
import { TaskDrawer } from './components/TaskDrawer'
import { NaviChatPanel } from './components/NaviChatPanel'
import { LessonsPanel } from './components/LessonsPanel'
import { BenchPanel } from './components/BenchPanel'
import { RoutinesPanel } from './components/RoutinesPanel'
import { AttentionInbox } from './components/AttentionInbox'
import { PrefsModal } from './components/PrefsModal'
import { InputModeBar } from './components/InputModeBar'
import { ContextMenu, type CtxItem } from './components/ContextMenu'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { SlashMenu, SLASH_COMMANDS, type SlashCmd } from './components/SlashMenu'
import {
  isImageMime,
  filterSlash,
  isEventForOpenConv,
  searchHitIds,
  stripAttachSuffix,
  computeTargetKey,
  sessionStartStamp,
} from './lib/chat'
import { useSplitRatio } from './lib/useSplitRatio'

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
const pushCapped = (prev: ChatMessage[], msg: ChatMessage): ChatMessage[] => {
  const next = [...prev, msg]
  return next.length > MAX_CHAT ? next.slice(-MAX_CHAT) : next
}

// 토큰 수 사람이 읽기 좋게 (구독 모델 — $ 대신 토큰 표시)
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

export default function App() {
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [managerBusy, setManagerBusy] = useState(false)
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
  const [crtFx, setCrtFx] = useState(() => localStorage.getItem('lain.fx') !== 'off')
  // B1 statusline-theme — 렌더러 전용 팔레트 전환(crtFx 선례 복제). 'wired'(기본)/'amber'/'mono'.
  const [theme, setTheme] = useState(() => localStorage.getItem('lain.theme') || 'wired')
  const [maximized, setMaximized] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [lessonsOpen, setLessonsOpen] = useState(false)
  const [benchOpen, setBenchOpen] = useState(false)
  const [routinesOpen, setRoutinesOpen] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  // '대기실'(비활성 프로젝트) 섹션 — 기본 접힘
  const [waitRoomOpen, setWaitRoomOpen] = useState(false)
  // 상하 2분할 — top-zone(그리드/Navi워크스페이스) : lain-zone(레인 고정) 세로 비율
  const { ratio, onDragStart } = useSplitRatio()
  const [menuOpen, setMenuOpen] = useState(false)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [settings, setSettings] = useState<LainSettings | null>(null)
  useEffect(() => {
    void window.lain.getSettings().then(setSettings)
  }, [])
  // 자동 업데이트 — ② Lain 제안 배너(설정 화면 ④와 같은 onUpdateStatus 스트림 구독)
  const [upd, setUpd] = useState<UpdateStatus | null>(null)
  const [updDismissed, setUpdDismissed] = useState<string | null>(null) // '나중에' 한 버전(그 버전만 숨김)
  useEffect(() => {
    void window.lain.getUpdateStatus().then(setUpd)
    return window.lain.onUpdateStatus(setUpd)
  }, [])
  // Ctrl+K/Ctrl+P 명령 팔레트
  const [paletteOpen, setPaletteOpen] = useState(false)
  // '/' 슬래시 명령 팝업(매니저 입력창 전용)
  const [slashOpen, setSlashOpen] = useState(false)
  // 입력창 '+' 메뉴(파일·사진/폴더/슬래시) — 화면 좌표에 ContextMenu로 띄운다.
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)
  // 대화 내 검색(Ctrl+F / 🔍)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHitIdx, setSearchHitIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
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
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([])
  const openTaskIdRef = useRef<string | null>(null)
  openTaskIdRef.current = openTaskId
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0) // 드래그 enter/leave 중첩 카운터(자식 위 진입 시 깜빡임 방지)
  // 파일 첨부
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [dropActive, setDropActive] = useState(false) // 입력 영역에 파일 드래그 중
  // 입력 큐 — 응답 대기 중에도 채팅 전송 허용
  const [msgQueue, setMsgQueue] = useState<{ text: string; attachments: FileAttachment[] }[]>([])
  const msgQueueRef = useRef(msgQueue) // result 핸들러(마운트 클로저)에서 현재 큐 길이 참조용
  msgQueueRef.current = msgQueue
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
    window.lain.listProjects().then(setProjects)
    // '이번 실행' 경계를 main(APP_STARTED_AT)에서 받아 고정 — 렌더러 reload에도 불변(위 sessionStart 주석).
    // 매니저 대화는 보존된 전체 흐름을 로드한다(위로 스크롤하면 저번 대화가 이어짐). 경계는 '여기부터 이번
    // 실행' 구분선 위치로만 쓰이고, 초기 스크롤이 그 경계를 뷰 맨 위에 두어 첫인상은 콜드스타트 그대로다.
    // (활성 대화 id는 전송·SDK 세션 귀속에도 쓰여 항상 잡는다.)
    window.lain.appStartedAt().then((start) => {
      if (start) sessionStart = start
      window.lain.getActiveConversation('manager').then((cid) => {
        setOpenConv(cid)
        if (cid) window.lain.conversationMessages(cid).then(setMessages)
      })
    })
    window.lain.conversationPreviews().then((list) =>
      setPreviews(new Map(list.map((p) => [p.target, p]))),
    )
    window.lain.listTasks().then(setTasks)
    window.lain.listApprovals().then(setApprovals)
    window.lain.getBriefing().then(setBriefing)
    const offProjects = window.lain.onProjectsUpdated(setProjects)
    const offTasks = window.lain.onTasksUpdated(setTasks)
    const offApprovals = window.lain.onApprovalsUpdated(setApprovals)
    const offBriefing = window.lain.onBriefingUpdated(setBriefing)
    const offTaskEvent = window.lain.onTaskEvent((ev) => {
      if (ev.taskId === openTaskIdRef.current && !ev.text.startsWith('approval:')) {
        // 장시간/autonomous 작업은 이벤트를 대량 스트리밍한다 — 드로어가 열린 채면 무한 누적되므로 상한(콘솔 로그라 옛 줄 잘라도 무방).
        setTaskEvents((prev) => (prev.length >= 2000 ? [...prev.slice(-1999), ev] : [...prev, ev]))
      }
    })
    const offChat = window.lain.onChatEvent((ev: ChatEvent) => {
      // 텔레그램·PC가 같은 '활성 대화'를 공유 — 이벤트의 conversationId가 지금 연 대화면 본문에
      // 추가하고, 아니면 목록 미리보기만 갱신한다. (conversationId 없는 레거시·스케줄러 이벤트는 표시)
      const forOpen = isEventForOpenConv(openConvRef.current, ev.conversationId)
      const append = (role: ChatMessage['role'], content: string) =>
        setMessages((prev) =>
          pushCapped(prev, {
            id: nextLocalId--,
            scope: 'manager',
            role,
            content,
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
        }
        bumpPreview('manager', 'user', ev.text)
      } else if (ev.kind === 'assistant') {
        if (forOpen) append('assistant', ev.text)
        bumpPreview('manager', 'assistant', ev.text)
      } else if (ev.kind === 'result') {
        if (ev.tokens) setTokensUsed((t) => t + ev.tokens!)
        setManagerBusy(false)
        // 라이브(음수 id) 메시지를 실 DB id로 동기화 — 챕터 고정 게이트(m.id<=0) 해제.
        // 큐가 비었을 때만 DB 전체로 교체한다. (예전 [...rows, ...음수id] 병합은 방금 턴의 낙관적
        // user/assistant가 rows에도·음수 꼬리에도 들어가 매 턴 메시지가 이중 표시되던 버그.)
        // 큐가 남아 있으면 미전송 메시지가 사라지지 않게 재로드를 건너뛴다 — 큐가 다 빠진 마지막 result에서 동기화.
        const cid = ev.conversationId ?? openConvRef.current
        if (cid && cid === openConvRef.current && msgQueueRef.current.length === 0)
          window.lain.conversationMessages(cid).then(setMessages)
      } else if (ev.kind === 'error') {
        if (forOpen) append('tool', `[error] ${ev.message}`)
        bumpPreview('manager', 'tool', `[error] ${ev.message}`)
        setManagerBusy(false)
      } else if (ev.kind === 'question') {
        // Lain이 선택형/체크형 질문을 띄움 — 답 대기 중이라 '응답 중'은 끈다. 카드는 그 질문이 지금 연
        // 대화 것일 때만 띄운다. ⚠️ busy 해제는 forOpen 밖으로 — 다른 대화로 온 question이어도 '응답 중'에
        // 묶여 입력이 막히는 엣지를 막는다(질문이 뜬 턴은 어떤 대화든 응답 대기로 멈춰 있으므로).
        setManagerBusy(false)
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
        }
      }
    })
    const offNaviChat = window.lain.onNaviChatEvent((ev) => {
      // top-zone에 그 Navi가 열려 있으면(=drillTarget) 본문에 표시. broadcast 메타(@all)는 실제 대화 아님.
      const visible = ev.projectId === drillTargetRef.current && ev.projectId !== '@all'
      // 인박스 미리보기·unread는 현재 보고 있지 않은 Navi도 갱신(타일 점등용). broadcast 메타(@all) 제외.
      if (ev.projectId && ev.projectId !== '@all' && (ev.kind === 'assistant' || ev.kind === 'tool')) {
        bumpPreview(ev.projectId, ev.kind === 'assistant' ? 'assistant' : 'tool', ev.text)
      }
      if (ev.kind === 'assistant' || ev.kind === 'tool') {
        if (visible) {
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
      } else if (ev.kind === 'result') {
        if (ev.tokens) setTokensUsed((t) => t + ev.tokens!)
        // Navi는 입력 큐가 없어 라이브 메시지가 전부 이번 턴 것 → DB 전체로 교체(음수 id → 실 id 동기화).
        if (ev.projectId === drillTargetRef.current && naviConvRef.current)
          window.lain.conversationMessages(naviConvRef.current).then(setNaviMsgs)
        setNaviBusy((prev) => {
          const next = new Set(prev)
          next.delete(ev.projectId)
          return next
        })
      } else if (ev.kind === 'error') {
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

  // Esc — 열린 오버레이를 위에서부터 닫기. (팔레트는 자체 핸들러로 stopPropagation해 여기 안 옴)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 검색바는 채팅 위 인라인 요소라 체인 맨 앞 — 열려 있으면 그것만 닫는다.
      if (searchOpen) {
        setSearchOpen(false)
        setSearchQuery('')
        return
      }
      if (menuOpen) setMenuOpen(false)
      else if (prefsOpen) setPrefsOpen(false)
      else if (inboxOpen) setInboxOpen(false)
      else if (lessonsOpen) setLessonsOpen(false)
      else if (benchOpen) setBenchOpen(false)
      else if (routinesOpen) setRoutinesOpen(false)
      else if (openTaskIdRef.current) setOpenTaskId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen, prefsOpen, inboxOpen, lessonsOpen, benchOpen, routinesOpen, searchOpen])

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

  // Ctrl+F — 대화 내 검색 열기 (@all 제외). 입력창 포커스 중에도 잡게 window 레벨.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key === 'f' || e.key === 'F') &&
        chatTargetRef.current !== '@all'
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
    setTaskEvents([])
    window.lain.taskEvents(taskId).then(setTaskEvents)
  }, [])

  const startTask = useCallback(
    async (projectId: string) => {
      const res = await window.lain.startTask(projectId)
      if (res.error) {
        alert(res.error)
        return
      }
      if (res.taskId) openTask(res.taskId)
    },
    [openTask],
  )

  // ── 하단 레인(manager) 입력 대상 — 'manager' | '@all'(브로드캐스트). Navi 직통은 top-zone으로 분리. ──
  const switchTarget = useCallback((target: string) => {
    setChatTarget(target === '@all' ? '@all' : 'manager')
  }, [])

  // ── top-zone Navi 워크스페이스 ──
  // 타일 클릭/포커스 → 그 Navi를 위에 연다(세션 목록 + 활성 대화). 다른 Navi에서 오면 입력 초안 보존·복원.
  const openDrill = useCallback((naviId: string) => {
    const prev = drillTargetRef.current
    if (prev && prev !== naviId) draftsRef.current.set(prev, naviInputRef.current?.value ?? '')
    setDrillTarget(naviId)
    setNaviInput(draftsRef.current.get(naviId) ?? '')
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
      window.lain.conversationMessages(cid).then(setNaviMsgs)
    })
  }, [])

  // top-zone에서 타일 그리드로 복귀 — 현재 Navi 입력 초안 보존.
  const closeDrill = useCallback(() => {
    const prev = drillTargetRef.current
    if (prev) draftsRef.current.set(prev, naviInputRef.current?.value ?? '')
    setDrillTarget(null)
    setNaviConv(null)
    setNaviMsgs([])
    setNaviInput('')
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
    window.lain.conversationMessages(convId).then(setNaviMsgs)
  }, [])

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
  const deleteConversation = useCallback(
    (naviId: string, convId: string) => {
      if (!window.confirm('이 대화를 삭제할까? 메시지도 함께 지워진다.')) return
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
    [openNaviConversation, newConversation],
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

  // 입력창에 `> 인용` 형태로 삽입 후 이어 작성
  const quoteReply = useCallback((m: ChatMessage) => {
    const quoted = m.content
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    setInput((prev) => (prev.trim() ? prev + '\n\n' : '') + quoted + '\n\n')
    inputRef.current?.focus()
  }, [])

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

  const ctxItems = useCallback(
    (m: ChatMessage): CtxItem[] => [
      { label: '메시지 복사', onClick: () => window.lain.copyText(m.content) },
      { label: '컨텍스트로 첨부', onClick: () => attachAsContext(m) },
      { label: '인용해서 답장', onClick: () => quoteReply(m) },
      m.chapter
        ? { label: '챕터 고정 해제', onClick: () => toggleChapter(m), danger: true }
        : { label: '챕터로 고정', onClick: () => toggleChapter(m), disabled: m.id <= 0 },
    ],
    [attachAsContext, quoteReply, toggleChapter],
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
        label: project.enabled ? '감시 해제' : '감시 복귀',
        onClick: () => window.lain.setEnabled(project.id, !project.enabled),
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
    window.lain
      .sendChat(next.text, next.attachments, openConvRef.current ?? undefined)
      .catch(() => setManagerBusy(false))
  }, [managerBusy, msgQueue])

  // 하단 레인 입력 전송 — chatTarget='manager'(매니저 대화) | '@all'(전 Navi 브로드캐스트).
  const send = useCallback(() => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
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
      // 응답 대기 중 — 입력 큐에 적재(메시지는 지금 표시, 전송은 위 큐 effect가 처리)
      setMsgQueue((prev) => [...prev, { text, attachments: pendingAttachments }])
      setMessages((prev) => pushCapped(prev, optimistic))
      bumpPreview('manager', 'user', content)
      return
    }
    setManagerBusy(true)
    setMessages((prev) => pushCapped(prev, optimistic))
    bumpPreview('manager', 'user', content)
    // 정상 흐름은 result/error chat:event가 managerBusy를 해제한다. IPC 자체가 거부되는 예외 상황엔
    // 종료 이벤트가 못 올 수 있으니(서버측 보장과 별개의 2차 방어) busy를 직접 풀어 "응답 중" 고착을 막는다.
    window.lain.sendChat(text, pendingAttachments, openConv ?? undefined).catch(() => setManagerBusy(false))
  }, [input, attachments, managerBusy, chatTarget, openConv])

  // top-zone Navi 워크스페이스 입력 전송 — drillTarget(현재 연 Navi)에게 직통. working 중이면 main이 거절.
  const sendNavi = useCallback(() => {
    const target = drillTarget
    if (!target) return
    const text = naviInput.trim()
    if ((!text && naviAttachments.length === 0) || naviBusy.has(target)) return
    setNaviInput('')
    const pendingAttachments = [...naviAttachments]
    setNaviAttachments([])
    const content =
      text + (pendingAttachments.length ? ` [+${pendingAttachments.length}개 첨부]` : '')
    setNaviBusy((prev) => new Set(prev).add(target))
    setNaviMsgs((prev) =>
      pushCapped(prev, {
        id: nextLocalId--,
        scope: 'worker',
        role: 'user',
        content,
        attachments: pendingAttachments,
        createdAt: new Date().toISOString(),
      }),
    )
    bumpPreview(target, 'user', content)
    window.lain.sendNaviChat(target, text, pendingAttachments, naviConv ?? undefined).then((res) => {
      if (res?.error) {
        setNaviMsgs((prev) =>
          pushCapped(prev, {
            id: nextLocalId--,
            scope: 'worker',
            role: 'tool',
            content: res.error!,
            createdAt: new Date().toISOString(),
          }),
        )
        setNaviBusy((prev) => {
          const next = new Set(prev)
          next.delete(target)
          return next
        })
      }
    })
  }, [naviInput, naviAttachments, naviBusy, drillTarget, naviConv])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.lain.refreshStatus()
    } finally {
      setRefreshing(false)
    }
  }, [])

  const scan = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.lain.scanProjects()
    } finally {
      setRefreshing(false)
    }
  }, [])

  const enabled = projects.filter((p) => p.enabled)
  const dirtyCount = enabled.filter((p) => (p.status?.dirtyFiles ?? 0) > 0).length
  const failCount = enabled.filter((p) => p.status?.testState === 'fail').length
  const activeTaskOf = (projectId: string) =>
    tasks.find(
      (t) => t.projectId === projectId && !['done', 'cancelled'].includes(t.state),
    ) ?? null
  const reviewCount = tasks.filter((t) => t.state === 'review').length
  const blockedCount = tasks.filter((t) => t.state === 'blocked').length
  const inboxCount = approvals.length + reviewCount + blockedCount
  const taskTokens = tasks.reduce((sum, t) => sum + t.tokens, 0)
  // 레인 브리핑 위젯(레인의 첫 말) — 전부 결정론(이미 가진 상태로 계산, LLM·비용 0).
  const workingCount = tasks.filter((t) => t.state === 'working' || t.state === 'clarifying').length
  const errorCount = tasks.filter((t) => t.state === 'error').length
  const unpushedCount = enabled.filter((p) => (p.status?.ahead ?? 0) > 0).length
  const attnTotal = reviewCount + blockedCount + approvals.length + errorCount + failCount
  const attnParts = (
    [
      ['결재', reviewCount],
      ['질문', blockedCount],
      ['승인', approvals.length],
      ['에러', errorCount],
      ['검증실패', failCount],
    ] as [string, number][]
  )
    .filter(([, n]) => n > 0)
    .map(([l, n]) => `${l} ${n}`)
  const openedTask = openTaskId ? (tasks.find((t) => t.id === openTaskId) ?? null) : null

  // ── 대화 내 검색 — 하단 레인(manager) 대화에서 substring(대소문자 무시) 매치 메시지 id 목록 ──
  const searchMsgs = messages
  const searchHits = useMemo(
    () => searchHitIds(searchMsgs, searchQuery),
    [searchQuery, searchMsgs],
  )
  // 쿼리/배열 변동 시 매치 인덱스 0으로 리셋
  useEffect(() => {
    setSearchHitIdx(0)
  }, [searchQuery, searchMsgs.length])
  // 슬래시 필터 변동 시 선택을 맨 위로
  useEffect(() => {
    setSlashIdx(0)
  }, [input, slashOpen])
  const activeHitId = searchHits.length
    ? (searchHits[Math.min(searchHitIdx, searchHits.length - 1)] ?? null)
    : null

  // 레인 브리핑 위젯 — 레인이 처음 꺼내는 말. 채팅 첫 메시지 슬롯(ChatPanel lead)에 lain> 메시지로 렌더.
  // prose(Claude, 있으면) + 결정론 현황 한 줄 + 처리대기/안정. 매 실행 새 오프닝 브리핑.
  const briefLead = (
    <div className="msg msg-assistant lain-brief">
      <span className="msg-prefix">Lain&gt;</span>
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
          <div className="lain-brief-attn">⚠ 처리 대기 — {attnParts.join(' · ')}</div>
        ) : (
          <div className="lain-brief-ok">
            ✓ 모두 안정 · 오늘 {fmtTokens(tokensUsed + taskTokens)} tok
          </div>
        )}
      </div>
    </div>
  )

  // ── '/' 슬래시 명령 필터(첫 토큰 접두 매칭) ──
  const slashFiltered = useMemo<SlashCmd[]>(() => {
    if (!slashOpen) return []
    return filterSlash(input, SLASH_COMMANDS)
  }, [slashOpen, input])

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
    { id: 'act:lessons', label: '교훈 (LESSONS)', group: '액션', run: () => setLessonsOpen(true) },
    { id: 'act:bench', label: '평가 (BENCH)', group: '액션', run: () => setBenchOpen(true) },
    { id: 'act:routines', label: '루틴 (ROUTINES)', group: '액션', run: () => setRoutinesOpen(true) },
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
  ]

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
      }
    },
    [scan, refreshAll, switchTarget],
  )

  // 입력 변경 — 회상 모드 종료(타이핑으로 새 기준) + 매니저에서 '/' 시작 시 슬래시 팝업 토글.
  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value
      setInput(v)
      histIdxRef.current = null
      if (chatTargetRef.current === 'manager') setSlashOpen(v.startsWith('/') && !v.includes('\n'))
      else setSlashOpen(false)
    },
    [],
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
        send()
      }
    },
    [slashOpen, slashFiltered, slashIdx, runSlash, input, messages, targetKey, send],
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

  // ── top-zone Navi 입력 핸들러 (하단 레인 입력과 분리, 슬래시·검색 없음) ──
  const naviHistIdxRef = useRef<number | null>(null)
  const naviOnChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNaviInput(e.target.value)
    naviHistIdxRef.current = null
  }, [])
  const naviOnKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = naviInputRef.current
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
        sendNavi()
      }
    },
    [naviInput, naviMsgs, drillTarget, sendNavi],
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

  return (
    <div className={`app${crtFx ? ' crt' : ''}${theme !== 'wired' ? ` theme-${theme}` : ''}`}>
      {/* ② 자동 업데이트 — Lain이 한가할 때 띄우는 제안 배너(고정 토스트). '나중에'는 그 버전만 숨김. */}
      {upd?.suggested &&
        upd.version &&
        upd.version !== updDismissed &&
        (upd.state === 'available' || upd.state === 'downloading' || upd.state === 'downloaded') && (
          <div className="upd-banner">
            <span className="upd-banner-prefix">Lain&gt;</span>
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
            title="메뉴 — 환경설정·교훈·평가·CRT"
          >
            ☰
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
                  환경설정
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setLessonsOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  🧠 교훈 (LESSONS)
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setBenchOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  📊 평가 (BENCH)
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setRoutinesOpen((v) => !v)
                    setMenuOpen(false)
                  }}
                >
                  🔁 루틴 (ROUTINES)
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
            {fmtTokens(tokensUsed + taskTokens)} tok
          </span>
          <button
            className={`chip chip-inbox${inboxCount > 0 ? ' chip-inbox-on' : ''}`}
            onClick={() => setInboxOpen((v) => !v)}
            title={
              inboxCount > 0 ? `${inboxCount}건 대기 — 클릭해 인박스 열기` : '대기 없음 — 인박스'
            }
          >
            {inboxCount > 0 ? `⚠ ${inboxCount} 대기` : 'INBOX 0'}
          </button>
        </span>
        <span className="bar-actions">
          <button onClick={scan} disabled={refreshing} title="C:\workspace 스캔">
            ⌕ SCAN
          </button>
          <button onClick={refreshAll} disabled={refreshing} title="현황 새로고침">
            {refreshing ? '...' : '⟳ REFRESH'}
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
            {maximized ? '❐' : '▢'}
          </button>
          <button
            className="wc wc-close"
            onClick={() => window.lain.windowClose()}
            aria-label="닫기"
            title="닫기"
          >
            ✕
          </button>
        </span>
      </header>

      <div className="body">
        {/* 위 — Navi 타일 4열 그리드(기본) 또는 포커스된 Navi 워크스페이스(A안: 위에서 열림) */}
        <section className="top-zone" style={{ flexBasis: `${ratio * 100}%` }} aria-label="NAVIS">
          {drillTarget ? (
            <div className="navi-workspace">
              <div className="navi-ws-sessions">
                <SessionList
                  name={projects.find((p) => p.id === drillTarget)?.name ?? drillTarget}
                  sprite={(() => {
                    const dp = projects.find((p) => p.id === drillTarget)
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
              </div>
              <div className="navi-ws-chat">
                <section className="chat-main panel" aria-label="NAVI CHAT">
                  <div className="panel-label">[ wired://navi/{drillTarget} ]</div>
                  <div className="mgr-actions">
                    {activeTaskOf(drillTarget) ? (
                      <button onClick={() => openTask(activeTaskOf(drillTarget)!.id)}>☰ 콘솔</button>
                    ) : (
                      projects.find((p) => p.id === drillTarget)?.status?.hasTaskMd && (
                        <button onClick={() => startTask(drillTarget)}>▶ 작업</button>
                      )
                    )}
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
                  <NaviChatPanel
                    projectId={drillTarget}
                    messages={naviMsgs}
                    busy={naviBusy.has(drillTarget)}
                    approvals={approvals.filter((a) => a.taskId === `chat:${drillTarget}`)}
                    onMessageContext={onMessageContext}
                    query=""
                    activeHitId={null}
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
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
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
                        naviBusy.has(drillTarget) ? 'Navi 응답 대기 중...' : `@${drillTarget}에게…`
                      }
                    />
                    {naviBusy.has(drillTarget) ? (
                      <button
                        className="stop-btn"
                        onClick={() => {
                          const target = drillTarget
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
                        ↵
                      </button>
                    )}
                  </div>
                </footer>
              </div>
            </div>
          ) : projects.length === 0 ? (
            <div className="empty">
              등록된 프로젝트 없음 — <b>SCAN C:\workspace</b> 또는 아래로 시작.
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
              {/* 활성 Navi — 우선순위(질문>결재>에러>작업>대기)로 정렬. prio는 naviStatus 재사용. */}
              {projects
                .filter((p) => p.enabled)
                .map((p) => ({ p, prio: naviStatus(p, activeTaskOf(p.id)).prio }))
                .sort((a, b) => a.prio - b.prio)
                .map(({ p }) => (
                  <NaviTile
                    key={p.id}
                    project={p}
                    task={activeTaskOf(p.id)}
                    focused={false}
                    unread={unread.has(p.id)}
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
              {/* 대기실 — 비활성 프로젝트. 기본 접힘, 헤더 클릭으로 펼침. */}
              {projects.some((p) => !p.enabled) && (
                <div className="wait-room">
                  <button
                    className="wait-room-head"
                    onClick={() => setWaitRoomOpen((v) => !v)}
                    title="비활성 프로젝트 — 클릭해 펼치기/접기"
                  >
                    {waitRoomOpen ? '▾' : '▸'} 대기실 · {projects.filter((p) => !p.enabled).length}
                  </button>
                  {waitRoomOpen && (
                    <div className="wait-room-grid">
                      {projects
                        .filter((p) => !p.enabled)
                        .map((p) => (
                          <NaviTile
                            key={p.id}
                            project={p}
                            task={activeTaskOf(p.id)}
                            focused={false}
                            unread={unread.has(p.id)}
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
        </section>

        <div className="split-divider" onMouseDown={onDragStart} title="드래그로 높이 조절" />

        {/* 아래 — 레인(manager) 고정: 브리프 헤더 + 채팅 + 입력 (전폭) */}
        <section
          className={`lain-zone${dropActive ? ' drop-active' : ''}`}
          style={{ flexBasis: `${(1 - ratio) * 100}%` }}
          aria-label="LAIN"
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
          {/* 왼쪽 = 레인 캐릭터 (lain 본인) + 상시 현재 상태(스크롤 안 됨 — 채팅 오프너와 별개로 항상 보임). */}
          <div className="lain-char">
            <ManagerSprite size={230} busy={managerBusy} />
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
            <div className="lain-stat">
              <div className="lain-stat-line">
                감시 {enabled.length} · 작업{' '}
                <span className={workingCount > 0 ? 'st-working' : ''}>{workingCount}</span> · 미커밋{' '}
                <span className={dirtyCount > 0 ? 'st-dirty' : ''}>{dirtyCount}</span>
                {unpushedCount > 0 && (
                  <>
                    {' · 안 푸시 '}
                    <span className="st-dirty">{unpushedCount}</span>
                  </>
                )}
              </div>
              {attnTotal > 0 ? (
                <div className="lain-stat-attn">⚠ {attnParts.join(' · ')}</div>
              ) : (
                <div className="lain-stat-ok">✓ 모두 안정 · {fmtTokens(tokensUsed + taskTokens)} tok</div>
              )}
            </div>
          </div>

          {/* 오른쪽 = 하나의 레인 채팅창. 브리핑은 레인이 처음 꺼내는 말(첫 assistant 메시지). */}
          <div className="lain-main">
            <section className="chat-main panel" aria-label="CHAT">
            <div className="panel-label">
              [ wired://{chatTarget === '@all' ? 'broadcast' : 'lain'} ]
            </div>
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
                  ❑ {messages.filter((m) => m.chapter).length}
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
            {/* 🔍 대화 내 검색 토글 — @all 모드 제외 */}
            {chatTarget !== '@all' && (
              <button
                className="chat-search-toggle"
                onClick={() => {
                  setSearchOpen((o) => !o)
                  if (!searchOpen) setTimeout(() => searchInputRef.current?.focus(), 0)
                }}
                title="대화 내 검색 (Ctrl+F)"
              >
                🔍
              </button>
            )}
            {/* 🔄 Lain 세션 새로고침 — 무한세션이라 '새 대화'가 없어, 옛 스레드로 헛도는 Lain을 리셋 */}
            {chatTarget !== '@all' && (
              <button
                className="chat-reset"
                title="Lain 새로고침 — 진행 중 응답을 멈추고 누적 맥락(월드스테이트)을 비워 새 세션으로 시작. 채팅 로그는 남는다."
                onClick={() => {
                  if (
                    window.confirm(
                      'Lain 세션을 새로고침할까?\n진행 중 응답을 멈추고 누적 맥락(월드스테이트)을 비워 새 세션으로 시작한다. 채팅 로그는 남는다.',
                    )
                  )
                    window.lain.resetManager()
                }}
              >
                🔄
              </button>
            )}
            {/* 검색바 — 레인 대화 메시지를 클라이언트에서 필터·하이라이트·이동 */}
            {searchOpen && chatTarget !== '@all' && (
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
                <button
                  className="chat-search-nav"
                  title="이전 매치"
                  disabled={searchHits.length === 0}
                  onClick={() =>
                    setSearchHitIdx((i) => (i - 1 + searchHits.length) % searchHits.length)
                  }
                >
                  ▲
                </button>
                <button
                  className="chat-search-nav"
                  title="다음 매치"
                  disabled={searchHits.length === 0}
                  onClick={() => setSearchHitIdx((i) => (i + 1) % searchHits.length)}
                >
                  ▼
                </button>
                <button
                  className="chat-search-nav"
                  title="검색 닫기"
                  onClick={() => {
                    setSearchOpen(false)
                    setSearchQuery('')
                  }}
                >
                  ✕
                </button>
              </div>
            )}
            <ChatPanel
              messages={messages}
              busy={managerBusy}
              onMessageContext={onMessageContext}
              query={searchOpen ? searchQuery : ''}
              activeHitId={activeHitId}
              lead={briefLead}
              sessionStart={sessionStart}
              pendingQuestion={pendingQuestion}
              onAnswerQuestion={(answer) => {
                if (pendingQuestion) window.lain.answerQuestion(pendingQuestion.id, answer)
                setPendingQuestion(null)
              }}
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

          {openedTask && (
            <TaskDrawer
              task={openedTask}
              approvals={approvals}
              events={taskEvents}
              onClose={() => setOpenTaskId(null)}
            />
          )}

          <footer className="input-row panel">
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
                      ✕
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
              <button
                className="plus-btn"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setPlusMenu({ x: r.left, y: r.top })
                }}
                title="추가 — 파일·사진 / 폴더 / 슬래시 명령어"
                aria-label="추가 메뉴"
              >
                ＋
              </button>
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
              {/* 전송/정지 — 매니저 응답 중이면 정지, 그 외 전송(↵). @all은 busy 없음. */}
              {chatTarget === 'manager' && managerBusy ? (
                <button className="stop-btn" onClick={() => window.lain.stopChat()} title="응답 정지">
                  ■
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={send}
                  title="전송 (Enter)"
                  disabled={!input.trim() && attachments.length === 0}
                >
                  ↵
                </button>
              )}
            </div>
          </footer>
          {settings && (
            <InputModeBar
              settings={settings}
              onPatch={(p) => void window.lain.setSettings(p).then(setSettings)}
            />
          )}
          </div>
        </section>
      </div>

      {prefsOpen && <PrefsModal onClose={() => setPrefsOpen(false)} />}

      {lessonsOpen && <LessonsPanel onClose={() => setLessonsOpen(false)} />}

      {benchOpen && <BenchPanel onClose={() => setBenchOpen(false)} />}
      {routinesOpen && <RoutinesPanel onClose={() => setRoutinesOpen(false)} />}

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
        <ContextMenu x={plusMenu.x} y={plusMenu.y} items={plusItems} onClose={() => setPlusMenu(null)} />
      )}

      {pendingRemove && (
        <div className="modal-backdrop" onClick={() => setPendingRemove(null)}>
          <div className="confirm-window" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">내비 제거</div>
            <div className="confirm-msg">
              <b>{pendingRemove.name}</b> 내비를 보드에서 제거할까요?
              <br />
              대화·교훈·작업·현황 기록은 <b>보존</b>됩니다 — 같은 폴더를 다시 추가하면 그대로 복원됩니다.
            </div>
            <div className="confirm-note">
              보드에서 숨길 뿐, 디스크의 프로젝트 폴더(<code>{pendingRemove.path}</code>)와 기록은 그대로입니다.
            </div>
            <div className="confirm-actions">
              <button autoFocus onClick={() => setPendingRemove(null)}>
                취소
              </button>
              <button className="btn-danger" onClick={confirmRemove}>
                제거
              </button>
            </div>
          </div>
        </div>
      )}

      {paletteOpen && (
        <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />
      )}
    </div>
  )
}
