// Attention Inbox — 너를 기다리는 것 전부를 한 곳에서 처리(승인·질문·결재).
// 별도 백엔드 없음: App이 이미 들고 있는 approvals + tasks(blocked·review)를
// 합쳐 보여주는 파생 뷰. 액션도 기존 IPC 재사용(resolveApproval·answerClarify·resolveReview).
import { useEffect, useRef, useState } from 'react'
import type { Approval, Task } from '../../shared/types'

// 행 단위 키보드: 입력칸(INPUT/TEXTAREA) 포커스 중이면 단축키 무시(답변 타이핑·IME 보호).
function inField(e: React.KeyboardEvent): boolean {
  const t = e.target as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
}

interface Props {
  approvals: Approval[]
  tasks: Task[]
  onOpenTask: (taskId: string) => void
  onClose: () => void
}

const KIND_LABEL: Record<string, string> = {
  push: 'push',
  destructive: '파괴',
  dep_change: '의존성',
  network: '네트워크',
  outside_dev: '외부경로',
}

// approval.taskId → 사람이 읽을 프로젝트 라벨 (Navi 직접채팅 승인은 chat:<projectId>)
function projLabel(taskId: string, byId: Map<string, Task>): string {
  const t = byId.get(taskId)
  if (t) return t.projectId
  if (taskId.startsWith('chat:')) return taskId.slice(5)
  return taskId
}

// 위험 명령 승인 또는 ask_manager 질문(§5.2) — 둘 다 approvals 테이블에서 온다
function ApprovalRow({
  a,
  task,
  label,
  onOpenTask,
}: {
  a: Approval
  task: Task | undefined
  label: string
  onOpenTask: (taskId: string) => void
}) {
  const [text, setText] = useState('')
  const auto = task?.mode === 'autonomous'
  const proj = (
    <div className="ir-proj">
      {task ? (
        <span className="ir-link" onClick={() => onOpenTask(a.taskId)} title="콘솔 열기">
          {label}
        </span>
      ) : (
        label
      )}
      {auto && <span className="ir-auto" title="autonomous escalate (§21.5)">⚡auto</span>}
    </div>
  )

  if (a.kind === 'question') {
    const send = () => {
      if (!text.trim()) return
      window.lain.resolveApproval(a.id, true, text.trim())
      setText('')
    }
    return (
      <div className="inbox-row ir-question">
        <span className="ir-badge b-question">질문</span>
        <div className="ir-mid">
          {proj}
          <div className="ir-cmd">{a.payload}</div>
        </div>
        <div className="ir-acts">
          <input
            className="ir-ans"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="답변 — Navi가 이 답으로 이어감"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
            }}
          />
          <button className="ib-ok" disabled={!text.trim()} onClick={send}>
            ▶
          </button>
          <button className="ib-no" onClick={() => window.lain.resolveApproval(a.id, false)}>
            거부
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`inbox-row ir-${a.kind}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (inField(e)) return
        if ((e.key === 'y' || e.key === 'Y' || e.key === 'Enter') && !e.nativeEvent.isComposing) {
          e.preventDefault()
          window.lain.resolveApproval(a.id, true)
        } else if (e.key === 'n' || e.key === 'N') {
          e.preventDefault()
          window.lain.resolveApproval(a.id, false)
        }
      }}
    >
      <span className={`ir-badge b-${a.kind}`}>{auto ? 'escalate' : (KIND_LABEL[a.kind] ?? a.kind)}</span>
      <div className="ir-mid">
        {proj}
        <code className="ir-cmd">{a.payload}</code>
      </div>
      <div className="ir-acts">
        <button className="ib-ok" onClick={() => window.lain.resolveApproval(a.id, true)}>
          승인
        </button>
        <button className="ib-no" onClick={() => window.lain.resolveApproval(a.id, false)}>
          거절
        </button>
      </div>
    </div>
  )
}

// blocked 작업의 명확화 질문(§8) — answerClarify로 한 번에 답.
// 질문이 여럿이면 질문별 칸으로 나눠 받고(답변 배열), 제출 시 Q1/Q2…로 결합해 보낸다.
function ClarifyRow({ t, onOpenTask }: { t: Task; onOpenTask: (taskId: string) => void }) {
  const multi = t.questions.length > 1
  const [answers, setAnswers] = useState<string[]>([])
  // 질문 칸은 질문 수만큼 — 길이 맞춰 정규화(질문 변동 대비).
  const slots = multi ? t.questions.length : 1
  const get = (i: number) => answers[i] ?? ''
  const setAt = (i: number, v: string) =>
    setAnswers((prev) => {
      const next = prev.slice()
      next[i] = v
      return next
    })
  const filled = Array.from({ length: slots }, (_, i) => get(i).trim())
  const canSend = filled.some((a) => a)
  const send = () => {
    if (!canSend) return
    // 단일 질문은 평문, 여러 질문은 Q1/Q2…로 결합(빈 칸은 건너뜀).
    const combined = multi
      ? t.questions
          .map((_, i) => (filled[i] ? `Q${i + 1}: ${filled[i]}` : ''))
          .filter(Boolean)
          .join('\n')
      : filled[0]
    window.lain.answerClarify(t.id, combined)
    setAnswers([])
  }
  return (
    <div className="inbox-row ir-question">
      <span className="ir-badge b-question">질문</span>
      <div className="ir-mid">
        <div className="ir-proj">
          <span className="ir-link" onClick={() => onOpenTask(t.id)} title="콘솔 열기">
            {t.projectId}
          </span>{' '}
          · {t.title}
        </div>
        {multi ? (
          t.questions.map((q, i) => (
            <div key={i} className="ir-cmd">
              <span className="dim">Q{i + 1}.</span> {q}
              <input
                className="ir-ans"
                style={{ width: '100%', marginTop: 3, display: 'block' }}
                value={get(i)}
                onChange={(e) => setAt(i, e.target.value)}
                placeholder={`Q${i + 1} 답변`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
                }}
              />
            </div>
          ))
        ) : (
          <div className="ir-cmd">{t.questions[0] || '(질문 대기)'}</div>
        )}
      </div>
      <div className="ir-acts">
        {!multi && (
          <input
            className="ir-ans"
            value={get(0)}
            onChange={(e) => setAt(0, e.target.value)}
            placeholder="답변 (한 번에 모두)"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
            }}
          />
        )}
        <button className="ib-ok" disabled={!canSend} onClick={send}>
          ▶
        </button>
      </div>
    </div>
  )
}

// review 도달 작업의 결재(§8-9) — 병합/브랜치/폐기
function ReviewRow({ t, onOpenTask }: { t: Task; onOpenTask: (taskId: string) => void }) {
  return (
    <div
      className="inbox-row ir-review"
      tabIndex={0}
      onKeyDown={(e) => {
        if (inField(e)) return
        // 비가역 폐기(discard)는 키보드에서 제외(오발동 방지) — 마우스 전용.
        if ((e.key === 'm' || e.key === 'M' || e.key === 'Enter') && !e.nativeEvent.isComposing) {
          e.preventDefault()
          window.lain.resolveReview(t.id, 'merge')
        } else if (e.key === 'b' || e.key === 'B') {
          e.preventDefault()
          window.lain.resolveReview(t.id, 'keep-branch')
        }
      }}
    >
      <span className="ir-badge b-review">결재</span>
      <div className="ir-mid">
        <div className="ir-proj">
          <span className="ir-link" onClick={() => onOpenTask(t.id)} title="콘솔 열기">
            {t.projectId}
          </span>{' '}
          · {t.title}
        </div>
        <div className="ir-cmd">
          {t.verifyResult && (
            <span className={t.verifyResult === 'pass' ? 'ok' : 'warn'}>
              verify {t.verifyResult.slice(0, 48)}
            </span>
          )}
          {t.diffStat && <span className="dim"> · {t.diffStat.split('\n')[0]}</span>}
        </div>
      </div>
      <div className="ir-acts">
        <button className="ib-ok" onClick={() => window.lain.resolveReview(t.id, 'merge')}>
          병합
        </button>
        <button onClick={() => window.lain.resolveReview(t.id, 'keep-branch')}>브랜치</button>
        <button className="ib-no" onClick={() => window.lain.resolveReview(t.id, 'discard')}>
          폐기
        </button>
      </div>
    </div>
  )
}

export function AttentionInbox({ approvals, tasks, onOpenTask, onClose }: Props) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const blocked = tasks.filter((t) => t.state === 'blocked')
  const review = tasks.filter((t) => t.state === 'review')
  const total = approvals.length + blocked.length + review.length
  const listRef = useRef<HTMLDivElement>(null)

  // 마운트/목록 변동 시 첫 행에 포커스 — 키보드 승인을 바로 받을 수 있게(처리로 행이 사라지면 재포커스).
  useEffect(() => {
    const first = listRef.current?.querySelector<HTMLElement>('.inbox-row[tabindex]')
    first?.focus()
  }, [total])

  return (
    <div className="drawer panel inbox-panel">
      <div className="drawer-head">
        <span className="drawer-title">[ wired://inbox — 대기 ]</span>
        <span className="dim">
          {total}건 · 승인 {approvals.length} · 질문 {blocked.length} · 결재 {review.length}
        </span>
        <button onClick={onClose}>✕</button>
      </div>
      {total === 0 ? (
        <div className="empty">큐 비었음 — lain 대기 ●</div>
      ) : (
        <div className="inbox-list" ref={listRef}>
          {approvals.map((a) => (
            <ApprovalRow
              key={`a${a.id}`}
              a={a}
              task={byId.get(a.taskId)}
              label={projLabel(a.taskId, byId)}
              onOpenTask={onOpenTask}
            />
          ))}
          {blocked.map((t) => (
            <ClarifyRow key={`b${t.id}`} t={t} onOpenTask={onOpenTask} />
          ))}
          {review.map((t) => (
            <ReviewRow key={`r${t.id}`} t={t} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}
    </div>
  )
}
