import {
  Fragment,
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

const PREFIX: Record<ChatMessage['role'], string> = {
  user: 'user@lain:~$',
  assistant: 'Lain>',
  tool: 'sys>',
}

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

export function ChatPanel({
  messages,
  busy,
  onMessageContext,
  query = '',
  activeHitId = null,
  lead = null,
  sessionStart = '',
  pendingQuestion = null,
  onAnswerQuestion,
}: {
  messages: ChatMessage[]
  busy: boolean
  onMessageContext?: (e: MouseEvent, m: ChatMessage) => void
  query?: string
  activeHitId?: number | null
  lead?: ReactNode // 이번 실행 경계(구분선)에 붙는 첫 항목(레인 브리핑 위젯 등). 메시지 배열 밖, 스크롤 함께.
  sessionStart?: string // 이번 실행 시작 경계('여기부터 이번 실행' 구분선 위치). 빈 문자열이면 경계 없음(맨 위).
  pendingQuestion?: PendingQuestion | null // ask_user 인라인 질문 — 있으면 채팅 하단에 선택 카드 표시.
  onAnswerQuestion?: (answer: string[]) => void // 선택 제출 콜백(선택된 보기 텍스트 배열).
}) {
  const logRef = useRef<HTMLDivElement>(null)
  const boundaryRef = useRef<HTMLDivElement>(null)
  const { bottomRef } = useStickyScroll([messages.length, busy, !!pendingQuestion], {
    paused: !!query,
    activeHitId,
  })

  // 이번 실행 경계 = createdAt >= sessionStart인 첫 메시지. 그보다 옛 메시지는 경계 위(스크롤 위쪽)에 둔다.
  // 없으면(전부 이전 실행분) 경계는 맨 끝 — 브리핑이 바닥에 오고 옛 대화는 그 위. sessionStart 없으면 0(맨 위).
  let boundaryIdx = sessionStart ? messages.findIndex((m) => m.createdAt >= sessionStart) : 0
  if (sessionStart && boundaryIdx === -1) boundaryIdx = messages.length
  const hasPrior = !!sessionStart && boundaryIdx > 0 // 경계 위에 저번 대화가 있으면 구분선 노출

  // 초기 로드·대화 전환 시 경계(구분선/브리핑)를 뷰 맨 위에 정렬 — 옛 대화는 위로 밀어 숨기고 아래(이번 실행)만
  // 보이게 한다(콜드스타트 첫인상 유지). sticky 훅은 '바닥 근처'에서만 추종하므로 첫 로드엔 따라오지 않는다.
  // 첫 메시지 id가 바뀔 때(=데이터 로드/대화 전환)만 강제 정렬. 경계 ref가 없으면 평소처럼 바닥.
  const firstId = messages[0]?.id
  useLayoutEffect(() => {
    const el = logRef.current
    if (!el || messages.length === 0) return
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
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const atBoundary = i === boundaryIdx
        const sameSpeaker = prev != null && prev.role === m.role && !m.chapter && !atBoundary
        return (
          <Fragment key={m.id}>
            {atBoundary && boundaryMarker}
            {m.chapter && (
              <div className="chapter-divider" id={`lain-chap-${m.id}`}>
                <span className="chapter-label">❑ {m.chapter}</span>
              </div>
            )}
            <div
              id={`lain-msg-${m.id}`}
              className={`msg msg-${m.role}${m.chapter ? ' msg-chapter' : ''}${activeHitId === m.id ? ' msg-search-active' : ''}`}
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
                        📄 {a.name}
                      </span>
                    ),
                  )}
                </span>
              )}
              <span className="msg-time">{fmtTime(m.createdAt)}</span>
            </div>
          </Fragment>
        )
      })}
      {boundaryIdx >= messages.length && boundaryMarker}
      {busy && (
        <div className="msg msg-assistant">
          <span className="msg-prefix">Lain&gt;</span>
          <span className="msg-body blink">▋</span>
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
          ↓ 새 메시지
        </button>
      )}
    </div>
  )
}

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
    <div className="chat-question" id={`lain-q-${q.id}`}>
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
