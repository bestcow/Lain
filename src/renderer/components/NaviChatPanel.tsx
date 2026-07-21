// §5.6 Navi 직접 채팅 패널 — 선택한 프로젝트의 Claude와 직접 대화.
// 위험 명령 승인 카드는 합성 task_id(`chat:<projectId>`)로 필터해 여기 표시.
import { memo, useLayoutEffect, useState, type MouseEvent } from 'react'
import type { Approval, ChatMessage } from '../../shared/types'
import { MessageBody } from '../lib/markdown'
import { useStickyScroll } from '../lib/useStickyScroll'
import { chatRowPropsEqual } from '../lib/messageRow'
import { projectColor } from './projectSprite'
import { Icon } from './icons'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
}

const PREFIX: Record<ChatMessage['role'], string> = {
  user: 'User',
  assistant: 'navi>',
  tool: 'sys>',
}

// B4 — Navi 메시지 행을 React.memo로 격리(레인 ChatPanel MessageRow와 동형). 스트리밍 델타는 바뀐 1개만
// 새 객체로 교체하므로(App setNaviMsgs map) 나머지 행은 참조 동등으로 리렌더(마크다운 재파싱)를 스킵한다.
// 렌더 마크업은 기존 인라인 map과 100% 동일(챕터 구분선·prefix 억제·worker-avatar·첨부·대기 태그·시간·취소).
interface NaviRowProps {
  m: ChatMessage
  query: string
  isActiveHit: boolean
  queued: boolean
  sameSpeaker: boolean
  onMessageContext?: (e: MouseEvent, m: ChatMessage) => void
  onCancelQueued?: (localId: number) => void
}

const NaviMessageRow = memo(function NaviMessageRow({
  m,
  query,
  isActiveHit,
  queued,
  sameSpeaker,
  onMessageContext,
  onCancelQueued,
}: NaviRowProps) {
  const prefix = m.origin === 'lain' ? 'Lain' : PREFIX[m.role]
  return (
    <>
      {m.chapter && (
        <div className="chapter-divider" id={`lain-chap-${m.id}`}>
          <span className="chapter-label">❑ {m.chapter}</span>
        </div>
      )}
      <div
        id={`lain-msg-${m.id}`}
        className={`msg msg-${m.role}${m.origin === 'lain' ? ' msg-lain' : ''}${m.chapter ? ' msg-chapter' : ''}${isActiveHit ? ' msg-search-active' : ''}${queued ? ' msg-queued' : ''}`}
        onContextMenu={onMessageContext ? (e) => onMessageContext(e, m) : undefined}
      >
        {!sameSpeaker && <span className="msg-prefix">{prefix}</span>}
        {m.projectId && (
          <span
            className="worker-avatar"
            style={{ color: projectColor({ id: m.projectId, name: m.projectId }) }}
            title={m.projectId}
          >
            ●
          </span>
        )}
        <div className="msg-body">
          <MessageBody content={m.content} query={query} />
        </div>
        {m.attachments && m.attachments.length > 0 && (
          <span className="msg-attachments">
            {m.attachments.map((a, ai) =>
              a.isImage && a.data ? (
                <img
                  key={ai}
                  className="msg-attach-img"
                  src={`data:${a.mimeType};base64,${a.data}`}
                  alt={a.name}
                  title={a.name}
                />
              ) : (
                <span key={ai} className="msg-attach-file" title={a.name}>
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

interface Props {
  projectId: string
  messages: ChatMessage[]
  busy: boolean
  approvals: Approval[] // 이미 chat:<projectId>로 필터된 것
  onMessageContext?: (e: MouseEvent, m: ChatMessage) => void
  query?: string
  activeHitId?: number | null
  // A10 — 응답 중 쌓인 로컬 큐(레인 ChatPanel과 동형) — 아직 전송 안 된 메시지에만 ⏳/✕ 표시.
  queuedIds?: Set<number> | null
  onCancelQueued?: (localId: number) => void
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const [answer, setAnswer] = useState('')
  if (approval.kind === 'question') {
    return (
      <div className="approval-card approval-question">
        <span className="approval-kind">[질문]</span>
        <span className="approval-cmd">{approval.payload}</span>
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="답변"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && answer.trim())
              window.lain.resolveApproval(approval.id, true, answer.trim())
          }}
        />
        <button
          disabled={!answer.trim()}
          onClick={() => window.lain.resolveApproval(approval.id, true, answer.trim())}
        >
          답변
        </button>
      </div>
    )
  }
  return (
    <div className="approval-card">
      <span className="approval-kind">[{approval.kind}]</span>
      <code className="approval-cmd">{approval.payload}</code>
      <button onClick={() => window.lain.resolveApproval(approval.id, true)}>승인</button>
      <button onClick={() => window.lain.resolveApproval(approval.id, false)}>거부</button>
    </div>
  )
}

function NaviChatPanelInner({
  projectId,
  messages,
  busy,
  approvals,
  onMessageContext,
  query = '',
  activeHitId = null,
  queuedIds = null,
  onCancelQueued,
}: Props) {
  const { bottomRef, showJump, jumpToBottom } = useStickyScroll(
    [messages.length, busy, approvals.length],
    { paused: !!query, activeHitId },
  )

  // 초기 로드·세션 전환 시 항상 바닥으로 (sticky는 바닥 근처에서만 추종 — 첫 로드는 맨 위라 안 내려감).
  const firstId = messages[0]?.id
  useLayoutEffect(() => {
    if (messages.length === 0) return
    jumpToBottom()
    const r = requestAnimationFrame(jumpToBottom)
    return () => cancelAnimationFrame(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId])

  return (
    <div className="chat-log navi-log">
      {messages.length === 0 && (
        <div className="empty">
          {projectId}의 Claude에게 직접 입력 — 그 프로젝트에서 Claude Code를 여는 것과 동일.
        </div>
      )}
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        // 연속 같은 화자(직전 메시지 role·projectId·origin 동일)면 prefix 억제. 챕터 구분선 직후엔 표시.
        const sameSpeaker =
          !!prev &&
          !m.chapter &&
          prev.role === m.role &&
          prev.origin === m.origin &&
          prev.projectId === m.projectId
        const queued = !!queuedIds?.has(m.id) // A10 — 아직 전송 안 된 대기열 메시지
        return (
          <NaviMessageRow
            key={m.id}
            m={m}
            query={query}
            isActiveHit={activeHitId === m.id}
            queued={queued}
            sameSpeaker={sameSpeaker}
            onMessageContext={onMessageContext}
            onCancelQueued={onCancelQueued}
          />
        )
      })}
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
      {busy && (
        <div className="msg msg-assistant">
          <span className="msg-prefix">navi&gt;</span>
          <span className="msg-body blink">▋</span>
        </div>
      )}
      {showJump && (
        <button className="chat-jump" onClick={jumpToBottom}>
          <Icon name="chevron-down" size={14} /> 새 메시지
        </button>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

// B4 — 패널 자체를 React.memo로(레인 ChatPanel과 동형). App의 무관한 리렌더에서 드릴 뷰 전체 재조정을
// 스킵한다. 넘어오는 messages·approvals·콜백(useCallback)·queuedIds(useMemo)가 참조 안정적이라 실효한다.
export const NaviChatPanel = memo(NaviChatPanelInner)
