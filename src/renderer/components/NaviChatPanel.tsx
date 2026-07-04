// §5.6 Navi 직접 채팅 패널 — 선택한 프로젝트의 Claude와 직접 대화.
// 위험 명령 승인 카드는 합성 task_id(`chat:<projectId>`)로 필터해 여기 표시.
import { Fragment, useLayoutEffect, useState, type MouseEvent } from 'react'
import type { Approval, ChatMessage } from '../../shared/types'
import { MessageBody } from '../lib/markdown'
import { useStickyScroll } from '../lib/useStickyScroll'
import { projectColor } from './projectSprite'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
}

const PREFIX: Record<ChatMessage['role'], string> = {
  user: 'User',
  assistant: 'navi>',
  tool: 'sys>',
}

interface Props {
  projectId: string
  messages: ChatMessage[]
  busy: boolean
  approvals: Approval[] // 이미 chat:<projectId>로 필터된 것
  onMessageContext?: (e: MouseEvent, m: ChatMessage) => void
  query?: string
  activeHitId?: number | null
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

export function NaviChatPanel({
  projectId,
  messages,
  busy,
  approvals,
  onMessageContext,
  query = '',
  activeHitId = null,
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
        const prefix = m.origin === 'lain' ? 'Lain' : PREFIX[m.role]
        return (
          <Fragment key={m.id}>
            {m.chapter && (
              <div className="chapter-divider" id={`lain-chap-${m.id}`}>
                <span className="chapter-label">❑ {m.chapter}</span>
              </div>
            )}
            <div
              id={`lain-msg-${m.id}`}
              className={`msg msg-${m.role}${m.origin === 'lain' ? ' msg-lain' : ''}${m.chapter ? ' msg-chapter' : ''}${activeHitId === m.id ? ' msg-search-active' : ''}`}
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
          ↓ 새 메시지
        </button>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
