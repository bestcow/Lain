// 다중 세션 — 한 대상(Lain | Navi)의 대화 세션 목록(드릴다운). 헤더(◄ 뒤로 + 캐릭터 + 이름 + 새 대화)
// + 세션 행들. 세션 클릭 = 우측에서 그 세션으로 대화, "새 대화" = 새 세션 시작.
import { useState, useEffect, type ReactNode } from 'react'
import type { Conversation } from '../../shared/types'

// 5분 이내 텔레그램 메시지가 있으면 모바일 활성으로 판단 (Lain 기여)
const MOBILE_ACTIVE_MS = 5 * 60 * 1000
function isMobileActive(lastMobileAt: string | null | undefined, now: number): boolean {
  if (!lastMobileAt) return false
  return now - new Date(lastMobileAt).getTime() < MOBILE_ACTIVE_MS
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })
}

interface Props {
  name: string
  sprite: ReactNode
  conversations: Conversation[]
  openConv: string | null
  onPick: (conversationId: string) => void
  onNew: () => void
  onRename: (conversationId: string, title: string) => void
  onDelete: (conversationId: string) => void
  onBack: () => void
}

export function SessionList({
  name,
  sprite,
  conversations,
  openConv,
  onPick,
  onNew,
  onRename,
  onDelete,
  onBack,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  // 30s 틱 — 📱 아이콘 만료(5분) 자동 감지 (Lain 기여)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const startEdit = (c: Conversation) => {
    setEditingId(c.id)
    setDraft(c.title || '')
  }
  const commitEdit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? conversations.filter(
        (c) =>
          (c.title || '').toLowerCase().includes(q) ||
          (c.lastContent || '').toLowerCase().includes(q),
      )
    : conversations

  return (
    <div className="sessions">
      <div className="sessions-head">
        <button className="sessions-back" onClick={onBack} title="뒤로가기" aria-label="뒤로">
          ◄
        </button>
        <span className="sessions-sprite">{sprite}</span>
        <span className="sessions-name">{name}</span>
        <input
          className="sessions-search"
          value={query}
          placeholder="대화 검색…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="sessions-new" onClick={onNew} title="새 세션 시작">
          + 새 대화
        </button>
      </div>
      <div className="sessions-list">
        {conversations.length === 0 ? (
          <div className="empty">대화 없음 — "+ 새 대화"로 시작</div>
        ) : filtered.length === 0 ? (
          <div className="empty">검색 결과 없음</div>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              className={`session-row${openConv === c.id ? ' session-row-selected' : ''}`}
              onClick={() => editingId !== c.id && onPick(c.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (
                  editingId !== c.id &&
                  (e.key === 'Enter' || e.key === ' ') &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault()
                  onPick(c.id)
                }
              }}
              title={c.title || '새 대화'}
            >
              {editingId === c.id ? (
                <input
                  className="session-edit-input"
                  value={draft}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      commitEdit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setEditingId(null)
                    }
                  }}
                />
              ) : (
                <>
                  {/* 제목·설명을 각각 별도 줄로(전폭) — 한 줄 가로배치는 둘 다 좁게 잘렸다. */}
                  <div className="session-line">
                    <span className="session-title">
                      {c.title || '새 대화'}
                      {isMobileActive(c.lastMobileAt, now) && (
                        <span className="session-mobile-badge" title="모바일에서 활성 중">
                          {' '}📱
                        </span>
                      )}
                    </span>
                    {c.lastAt && <span className="session-time">{fmtWhen(c.lastAt)}</span>}
                    <span className="session-actions">
                      <button
                        className="session-act"
                        title="이름 변경"
                        aria-label="이름 변경"
                        onClick={(e) => {
                          e.stopPropagation()
                          startEdit(c)
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="session-act danger"
                        title="삭제"
                        aria-label="삭제"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(c.id)
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                  <span className="session-preview">
                    {c.lastContent ?? <span className="dim">비어 있음</span>}
                  </span>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
