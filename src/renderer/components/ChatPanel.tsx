import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type { ChatMessage } from '../../shared/types'
import { MessageBody } from '../lib/markdown'
import { useStickyScroll } from '../lib/useStickyScroll'
import { chatRowPropsEqual } from '../lib/messageRow'
import { SENDER_PREFIX as PREFIX } from '../../shared/exportMarkdown'
import { Icon } from './icons'

// ask_user 인라인 질문(개선 #1) — Lain이 띄운 선택형/체크형 질문. 동시 1개.
export interface PendingQuestion {
  id: string
  question: string
  options: string[]
  multi: boolean // true=복수(체크), false=단일(라디오·클릭 즉시 제출)
}

function fmtTime(iso: string): string {
  if (!iso) return '' // 합성 메시지(레인 브리핑 오프너 등)는 타임스탬프 없음
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// B4 — 메시지 행(마크다운 파싱을 포함해 렌더 비용의 대부분) 을 React.memo로 격리한다. 스트리밍 델타는
// 바뀐 메시지 1개만 새 객체로 교체하므로(App setMessages map) 나머지 행은 참조 동등으로 리렌더를 스킵한다.
// activeHitId·queuedIds 같은 배열 대상 상태는 여기 raw로 넘기지 않고 부모가 행별 프리미티브(isActiveHit·
// queued)로 분해해 넘긴다 — 그래야 히트/대기 상태 변화가 실제로 값이 달라진 행만 리렌더한다.
// 렌더 마크업은 기존 인라인 map과 100% 동일(챕터 구분선·prefix 연속·origin 배지·첨부·대기 태그·시간·취소).
interface ChatRowProps {
  m: ChatMessage
  query: string
  isActiveHit: boolean
  queued: boolean
  sameSpeaker: boolean
  onMessageContext?: (e: MouseEvent, m: ChatMessage) => void
  onCancelQueued?: (localId: number) => void
}

const MessageRow = memo(function MessageRow({
  m,
  query,
  isActiveHit,
  queued,
  sameSpeaker,
  onMessageContext,
  onCancelQueued,
}: ChatRowProps) {
  return (
    <>
      {m.chapter && (
        <div className="chapter-divider" id={`lain-chap-${m.id}`}>
          <span className="chapter-label">
            <Icon name="bookmark" size={14} /> {m.chapter}
          </span>
        </div>
      )}
      <div
        id={`lain-msg-${m.id}`}
        className={`msg msg-${m.role}${m.chapter ? ' msg-chapter' : ''}${isActiveHit ? ' msg-search-active' : ''}${queued ? ' msg-queued' : ''}${m.origin === 'overlay' ? ' msg-proactive' : ''}`}
        onContextMenu={onMessageContext ? (e) => onMessageContext(e, m) : undefined}
      >
        {sameSpeaker ? (
          <span className="msg-prefix msg-prefix-cont" />
        ) : (
          <span className="msg-prefix">{PREFIX[m.role]}</span>
        )}
        {m.origin === 'telegram' && (
          <span className="msg-origin" title="텔레그램에서 보냄">
            📱
          </span>
        )}
        {m.origin === 'overlay' && (
          <span className="msg-origin" title="어깨너머(유저 감시) — 레인이 먼저 건넨 말">
            👁
          </span>
        )}
        <div className="msg-body">
          <MessageBody content={m.content} query={query} />
        </div>
        {m.attachments && m.attachments.length > 0 && (
          <span className="msg-attachments">
            {m.attachments.map((a, idx) =>
              a.isImage && a.data ? (
                <img
                  key={idx}
                  className="msg-attach-img"
                  src={`data:${a.mimeType};base64,${a.data}`}
                  alt={a.name}
                  title={a.name}
                />
              ) : (
                <span key={idx} className="msg-attach-file" title={a.name}>
                  <Icon name="paperclip" size={14} /> {a.name}
                </span>
              ),
            )}
          </span>
        )}
        {queued && (
          <span className="msg-queued-tag" title="아직 전송 안 됨 — 대기열">
            ⏳ 대기
          </span>
        )}
        <span className="msg-time">{fmtTime(m.createdAt)}</span>
        {queued && onCancelQueued && (
          <button
            type="button"
            className="msg-cancel"
            title="이 대기 메시지 취소"
            onClick={() => onCancelQueued(m.id)}
          >
            <Icon name="x-circle" size={14} />
          </button>
        )}
      </div>
    </>
  )
}, chatRowPropsEqual)

function ChatPanelInner({
  messages,
  busy,
  liveTool = null,
  turnStartedAt = null,
  onMessageContext,
  query = '',
  activeHitId = null,
  lead = null,
  sessionStart = '',
  queuedIds = null,
  onCancelQueued,
  pendingQuestion = null,
  onAnswerQuestion,
  onLoadMore,
  loadingMore = false,
  hasMore = true,
}: {
  messages: ChatMessage[]
  busy: boolean
  liveTool?: string | null // A2 — busy 중 마지막 도구 활동 라인(임시). null이면 도구 라인 없이 ▋만.
  turnStartedAt?: number | null // A2 — 경과 시간(n초) 표시 기준(턴 시작=전송 시점). null이면 경과 시간 미표시.
  onMessageContext?: (e: MouseEvent, m: ChatMessage) => void
  query?: string
  activeHitId?: number | null
  lead?: ReactNode // 이번 실행 경계(구분선)에 붙는 첫 항목(레인 브리핑 위젯 등). 메시지 배열 밖, 스크롤 함께.
  sessionStart?: string // 이번 실행 시작 경계('여기부터 이번 실행' 구분선 위치). 빈 문자열이면 경계 없음(맨 위).
  queuedIds?: Set<number> | null // 아직 전송 안 된 대기열 메시지 id — 이 메시지에만 ✕(취소)를 단다.
  onCancelQueued?: (localId: number) => void // 대기 메시지 취소 콜백.
  pendingQuestion?: PendingQuestion | null // ask_user 인라인 질문 — 있으면 채팅 하단에 선택 카드 표시.
  onAnswerQuestion?: (answer: string[]) => void // 선택 제출 콜백(선택된 보기 텍스트 배열).
  onLoadMore?: () => void // A15 — 스크롤 맨 위 도달 시 이전 페이지 요청(beforeId 계산·prepend는 호출측 책임).
  loadingMore?: boolean // A15 — 이전 페이지 요청 중(중복 요청 방지 + '불러오는 중' 표시).
  hasMore?: boolean // A15 — false면 더 불러올 과거가 없음(맨 위 도달해도 onLoadMore 미호출).
}) {
  const logRef = useRef<HTMLDivElement>(null)
  const boundaryRef = useRef<HTMLDivElement>(null)
  const { bottomRef } = useStickyScroll([messages.length, busy, !!pendingQuestion], {
    paused: !!query,
    activeHitId,
  })
  // A15 — 위로 스크롤 페이징: prepend 직전 스크롤 높이를 기록해두고, messages 갱신 후 늘어난 높이만큼
  // scrollTop을 보정해 화면에 보이던 위치를 그대로 유지한다(점프 방지). firstId 정렬 effect와 경합하지
  // 않도록 이 값이 있으면 그 effect는 정렬을 건너뛴다.
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)

  // 이번 실행 경계 = createdAt >= sessionStart인 첫 메시지. 그보다 옛 메시지는 경계 위(스크롤 위쪽)에 둔다.
  // 없으면(전부 이전 실행분) 경계는 맨 끝 — 브리핑이 바닥에 오고 옛 대화는 그 위. sessionStart 없으면 0(맨 위).
  // '새 내용' 경계 — 이번 실행(sessionStart 이후) 첫 메시지를 기준으로 잡는다. 어깨너머(overlay)
  // 자발 발화도 이번 실행분이면 '새 내용'에 포함한다 — 최근 오버레이 제안이 구분선 위(옛 대화)로
  // 밀려 사용자를 헷갈리게 하던 문제 해소(이전 실행분 overlay는 createdAt<sessionStart라 자연히 제외).
  let boundaryIdx = sessionStart
    ? messages.findIndex((m) => m.createdAt >= sessionStart)
    : 0
  if (sessionStart && boundaryIdx === -1) boundaryIdx = messages.length
  const hasPrior = !!sessionStart && boundaryIdx > 0 // 경계 위에 저번 대화가 있으면 구분선 노출

  // 초기 로드·대화 전환 시 경계(구분선/브리핑)를 뷰 맨 위에 정렬 — 옛 대화는 위로 밀어 숨기고 아래(이번 실행)만
  // 보이게 한다(콜드스타트 첫인상 유지). sticky 훅은 '바닥 근처'에서만 추종하므로 첫 로드엔 따라오지 않는다.
  // 첫 메시지 id가 바뀔 때(=데이터 로드/대화 전환)만 강제 정렬. 경계 ref가 없으면 평소처럼 바닥.
  const firstId = messages[0]?.id
  useLayoutEffect(() => {
    const el = logRef.current
    if (!el || messages.length === 0) return
    // A15 — 이전 페이지 prepend로 firstId가 바뀐 경우: 경계 재정렬 대신 늘어난 높이만큼만 보정(점프 방지).
    const anchor = prependAnchorRef.current
    if (anchor) {
      el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight)
      prependAnchorRef.current = null
      return
    }
    const align = () => {
      const b = boundaryRef.current
      if (b) el.scrollTop += b.getBoundingClientRect().top - el.getBoundingClientRect().top
      else el.scrollTop = el.scrollHeight
    }
    align()
    const r = requestAnimationFrame(align) // 마크다운·이미지 등 지연 레이아웃 후 한 번 더 보정
    return () => cancelAnimationFrame(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId])

  // A15 — 검색 활성 히트(activeHitId)로 스크롤 점프. 전체기간 검색은 호출측이 messagesAround로 그
  // 구간을 messages에 실어준 뒤 activeHitId를 그 id로 맞추므로, 여기서는 DOM에 이미 있는 요소를
  // 화면 중앙으로 스크롤하기만 하면 된다(로컬 검색 히트에도 동일하게 적용 — 기존엔 하이라이트만 있고
  // 스크롤 이동이 없어 긴 대화에서 히트를 못 찾는 문제가 있었다).
  // deps에 messages가 필요한 건 '히트가 아직 DOM에 없을 때(범위 로드 지연) 다음 갱신에서 재시도'뿐이다.
  // 그래서 이미 스크롤한 히트(scrolledHitRef)면 messages가 바뀌어도(=페이징 prepend 등) 다시 스크롤하지
  // 않는다 — 안 그러면 페이징이 앵커로 복원한 스크롤 위치를 히트로 재중앙화해 화면이 튄다.
  const scrolledHitRef = useRef<number | null>(null)
  useEffect(() => {
    if (activeHitId == null) {
      scrolledHitRef.current = null
      return
    }
    if (scrolledHitRef.current === activeHitId) return // 이미 이 히트로 스크롤함 — 무관한 messages 변경(페이징) 무시
    const el = document.getElementById(`lain-msg-${activeHitId}`)
    if (!el) return // 아직 DOM에 없음(범위 미로드) — 표시하지 않고 다음 messages 갱신에서 재시도
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    scrolledHitRef.current = activeHitId
  }, [activeHitId, messages])

  // A15 — 스크롤이 맨 위(40px 이내)에 도달하면 이전 페이지 요청. prepend 직전 스크롤 높이/위치를
  // 기록해 위 effect가 점프 없이 보정할 수 있게 한다. loadingMore/hasMore=false면 재요청 안 함.
  useEffect(() => {
    const el = logRef.current
    if (!el || !onLoadMore) return
    const onScroll = () => {
      if (loadingMore || !hasMore) return
      if (el.scrollTop < 40) {
        prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
        onLoadMore()
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [onLoadMore, loadingMore, hasMore])

  // A2 — busy 경과 시간(n초) 표시용 틱. turnStartedAt이 있을 때만 1초 간격으로 리렌더를 강제해 초 단위를 갱신한다.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (!busy || turnStartedAt == null) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy, turnStartedAt])
  const elapsedSec = turnStartedAt != null ? Math.max(0, Math.round((nowTick - turnStartedAt) / 1000)) : null

  // 바닥에서 벗어나 있고 새 메시지가 오면 점프 버튼 노출(바닥 근처면 자동스크롤이 따라가므로 숨김).
  const [showJump, setShowJump] = useState(false)
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      setShowJump(!nearBottom)
    }
    onScroll()
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) setShowJump(false)
  }, [messages.length, busy])

  // 이번 실행 경계 마커 — 저번 대화가 위에 있을 때만 '여기부터 이번 실행' 구분선 + 브리핑(lead). 초기 스크롤 앵커.
  const boundaryMarker = (
    <div className="session-boundary" ref={boundaryRef}>
      {hasPrior && (
        <div className="session-divider">
          <span className="session-divider-label">새 내용</span>
        </div>
      )}
      {lead}
    </div>
  )

  return (
    <div className="chat-log" ref={logRef}>
      {loadingMore && <div className="chat-load-more">이전 대화 불러오는 중…</div>}
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const atBoundary = i === boundaryIdx
        const sameSpeaker = prev != null && prev.role === m.role && !m.chapter && !atBoundary
        const queued = !!queuedIds?.has(m.id) // 아직 전송 안 된 대기열 메시지
        return (
          <Fragment key={m.id}>
            {atBoundary && boundaryMarker}
            <MessageRow
              m={m}
              query={query}
              isActiveHit={activeHitId === m.id}
              queued={queued}
              sameSpeaker={sameSpeaker}
              onMessageContext={onMessageContext}
              onCancelQueued={onCancelQueued}
            />
          </Fragment>
        )
      })}
      {boundaryIdx >= messages.length && boundaryMarker}
      {busy && (
        <div className="msg msg-assistant">
          <span className="msg-prefix">Lain</span>
          <span className="msg-body blink">▋</span>
          {/* A2 — 도구 활동 라이브 표시: 마지막 1줄 + 경과 시간(n초). 델타 스트리밍 버블은 messages 안의
              별개 항목이라 이 busy 블록과 자연히 공존한다(델타 버블이 위, 이 상태줄이 그 아래 항상 마지막). */}
          {(liveTool || elapsedSec != null) && (
            <span className="msg-live-tool">
              {liveTool ?? '작업 중'}
              {elapsedSec != null && ` · ${elapsedSec}초`}
            </span>
          )}
        </div>
      )}
      {pendingQuestion && onAnswerQuestion && (
        <QuestionCard key={pendingQuestion.id} q={pendingQuestion} onAnswer={onAnswerQuestion} />
      )}
      <div ref={bottomRef} />
      {showJump && (
        <button
          className="chat-jump"
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
        >
          <Icon name="chevron-down" size={14} /> 새 메시지
        </button>
      )}
    </div>
  )
}

// B4 — 패널 자체를 React.memo로. 부모(App)가 넘기는 props(messages·콜백·lead·queuedIds 등)가 참조
// 안정적일 때 App의 무관한 리렌더(예: 입력창·타일 상태 변화)에서 패널 전체 재조정을 스킵한다. lead(briefLead)는
// App에서 useMemo로, 콜백은 useCallback으로 안정화돼 있어 memo가 실효한다.
export const ChatPanel = memo(ChatPanelInner)

// ask_user 인라인 질문 카드 — 단일 선택은 보기 클릭 즉시 제출, 복수 선택은 토글 후 '제출'.
// key={q.id}로 마운트돼 질문마다 로컬 선택 상태가 초기화된다.
function QuestionCard({
  q,
  onAnswer,
}: {
  q: PendingQuestion
  onAnswer: (answer: string[]) => void
}) {
  const [sel, setSel] = useState<string[]>([])
  const pick = (opt: string) => {
    if (q.multi) setSel((s) => (s.includes(opt) ? s.filter((x) => x !== opt) : [...s, opt]))
    else onAnswer([opt]) // 단일 선택 — 클릭 즉시 제출
  }
  return (
    <div className="chat-question">
      <div className="cq-q">❓ {q.question}</div>
      <div className="cq-opts">
        {q.options.map((opt) => {
          const on = sel.includes(opt)
          return (
            <button
              key={opt}
              type="button"
              className={`cq-opt${on ? ' cq-on' : ''}`}
              onClick={() => pick(opt)}
            >
              <span className="cq-mark">{q.multi ? (on ? '☑' : '☐') : '○'}</span>
              <span className="cq-label">{opt}</span>
            </button>
          )
        })}
      </div>
      {q.multi && (
        <button
          type="button"
          className="cq-submit"
          disabled={sel.length === 0}
          onClick={() => onAnswer(sel)}
        >
          제출 ({sel.length})
        </button>
      )}
    </div>
  )
}
