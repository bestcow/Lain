// Attention Inbox — 너를 기다리는 것 전부를 한 곳에서 처리(승인·질문·결재).
// 별도 백엔드 없음: App이 이미 들고 있는 approvals + tasks(blocked·review)를
// 합쳐 보여주는 파생 뷰. 액션도 기존 IPC 재사용(resolveApproval·answerClarify·resolveReview).
import { memo, useEffect, useRef, useState } from 'react'
import type { Approval, Task } from '../../shared/types'
import { elapsedMinutes, fmtElapsed, longestWait, shouldRefocusInboxRow } from '../lib/chat'
import { ConfirmWindow } from './ConfirmWindow'
import { Icon } from './icons'

// 행 단위 키보드: 입력칸(INPUT/TEXTAREA) 포커스 중이면 단축키 무시(답변 타이핑·IME 보호).
function inField(e: React.KeyboardEvent): boolean {
  const t = e.target as HTMLElement
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
}

// C5 — 대기 시간 배지. 임계(분) 초과면 강조색(ir-wait-over).
const WAIT_THRESHOLD_MIN = 10
function WaitBadge({ since }: { since: string }) {
  const over = elapsedMinutes(since) >= WAIT_THRESHOLD_MIN
  return (
    <span className={`ir-wait${over ? ' ir-wait-over' : ''}`} title={`대기 시작: ${since}`}>
      {fmtElapsed(since)}
    </span>
  )
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
  system: '⚠ 시스템',
  plan: '📋 계획',
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
      <WaitBadge since={a.createdAt} />
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
            <Icon name="send" size={14} />
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
          <WaitBadge since={t.updatedAt} />
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
          <Icon name="send" size={14} />
        </button>
      </div>
    </div>
  )
}

// review 도달 작업의 결재(§8-9) — 병합/브랜치/폐기
// 처리하면 이 행은 목록에서 사라지므로, main이 돌려주는 사유(병합 실패 등)는 패널 상단 줄(onResult)로 올린다.
function ReviewRow({
  t,
  onOpenTask,
  onResult,
}: {
  t: Task
  onOpenTask: (taskId: string) => void
  onResult: (projectId: string, msg: string) => void
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const resolve = async (action: 'merge' | 'keep-branch' | 'discard') => {
    const msg = await window.lain.resolveReview(t.id, action)
    onResult(t.projectId, msg)
  }
  return (
    <div
      className="inbox-row ir-review"
      tabIndex={0}
      onKeyDown={(e) => {
        if (inField(e)) return
        // 비가역 폐기(discard)는 키보드에서 제외(오발동 방지) — 마우스 전용, 그마저도 확인창 경유.
        if ((e.key === 'm' || e.key === 'M' || e.key === 'Enter') && !e.nativeEvent.isComposing) {
          e.preventDefault()
          void resolve('merge')
        } else if (e.key === 'b' || e.key === 'B') {
          e.preventDefault()
          void resolve('keep-branch')
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
          <WaitBadge since={t.updatedAt} />
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
        <button className="ib-ok" onClick={() => void resolve('merge')}>
          병합
        </button>
        <button onClick={() => void resolve('keep-branch')}>브랜치</button>
        <button className="ib-no" onClick={() => setConfirmDiscard(true)}>
          폐기
        </button>
      </div>
      {confirmDiscard && (
        <ConfirmWindow
          title="작업 폐기"
          message={
            <>
              <b>{t.title}</b>의 브랜치·변경사항을 폐기할까요? <b>되돌릴 수 없습니다.</b>
            </>
          }
          note={t.diffStat ? <pre className="confirm-diffstat">{t.diffStat}</pre> : undefined}
          confirmLabel="폐기"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            void resolve('discard')
            setConfirmDiscard(false)
          }}
        />
      )}
    </div>
  )
}

// 사후 검토(B1 소비) — 자율 통과(state='auto') 기록 행. '대기'가 아니라 이미 실행된 것의 확인이므로
// 승인/거절 대신 '확인' 하나만 있다(확인=auto_acked로 닫혀 목록에서 빠짐). 무엇이(kind·payload) 언제
// (createdAt) 어느 작업(taskId 링크)에서 자율 통과됐는지를 보인다.
function AutoReviewRow({
  a,
  task,
  label,
  onOpenTask,
  onAck,
}: {
  a: Approval
  task: Task | undefined
  label: string
  onOpenTask: (taskId: string) => void
  onAck: (id: number) => void
}) {
  return (
    <div className={`inbox-row ir-${a.kind}`}>
      <span className={`ir-badge b-${a.kind}`}>{KIND_LABEL[a.kind] ?? a.kind}</span>
      <div className="ir-mid">
        <div className="ir-proj">
          {task ? (
            <span className="ir-link" onClick={() => onOpenTask(a.taskId)} title="콘솔 열기">
              {label}
            </span>
          ) : (
            label
          )}
          <span className="ir-auto" title="자율 통과 (§21.5 autonomous/bypass)">⚡auto</span>
          <span className="ir-wait" title={`자율 통과 시각: ${a.createdAt}`}>
            {fmtElapsed(a.createdAt)}
          </span>
        </div>
        <code className="ir-cmd">{a.payload}</code>
      </div>
      <div className="ir-acts">
        <button className="ib-ok" title="확인 — 사후 검토 완료로 표시" onClick={() => onAck(a.id)}>
          확인
        </button>
      </div>
    </div>
  )
}

// C2 — 에러로 멈춘 작업. 인박스가 '너를 기다리는 것 전부'인데 error만 빠져 실패를 놓치면 '큐 비었음'으로 보였다.
// 소음을 줄이려 수동 재개가 가능한(worktree·세션 생존) 것만 넣는다 — 액션도 기존 resumeTask 재사용.
function ErrorRow({ t, onOpenTask }: { t: Task; onOpenTask: (taskId: string) => void }) {
  return (
    <div className="inbox-row ir-error">
      <span className="ir-badge b-error st-error">에러</span>
      <div className="ir-mid">
        <div className="ir-proj">
          <span className="ir-link" onClick={() => onOpenTask(t.id)} title="콘솔 열기">
            {t.projectId}
          </span>{' '}
          · {t.title}
          <WaitBadge since={t.updatedAt} />
        </div>
        <div className="ir-cmd warn">{t.error?.slice(0, 160) || '알 수 없는 오류'}</div>
      </div>
      <div className="ir-acts">
        <button
          className="ib-ok"
          title="작업트리·세션 그대로 마지막 중단 지점부터 재개"
          onClick={() => window.lain.resumeTask(t.id)}
        >
          재개
        </button>
      </div>
    </div>
  )
}

function AttentionInboxInner({ approvals, tasks, onOpenTask, onClose }: Props) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const blocked = tasks.filter((t) => t.state === 'blocked')
  const review = tasks.filter((t) => t.state === 'review')
  const errored = tasks.filter((t) => t.state === 'error' && !!t.worktreePath && !!t.naviSessionId)
  const total = approvals.length + blocked.length + review.length + errored.length
  const listRef = useRef<HTMLDivElement>(null)
  const prevTotalRef = useRef(total)
  const [, setNow] = useState(Date.now())
  // 결재 결과(병합 실패 사유 등) — 행은 처리 즉시 사라지므로 패널에 한 줄로 남긴다. 다음 결재에 덮어쓴다.
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  // 사후 검토 뷰(B1 소비) — 자율 통과(state='auto') 기록. pending 뷰와 데이터가 완전 분리(브로드캐스트에
  // 안 실림 — auto는 '기다리는 것'이 아니다)라 뷰 진입 시점에 당겨 읽는다. 배지·카운트(total)는 불변.
  const [view, setView] = useState<'pending' | 'after'>('pending')
  const [autoRows, setAutoRows] = useState<Approval[]>([])
  useEffect(() => {
    if (view !== 'after') return
    let alive = true
    void window.lain.listAutoApprovals().then((rows) => {
      if (alive) setAutoRows(rows)
    })
    return () => {
      alive = false
    }
  }, [view])
  const ackAuto = (id: number) => {
    void window.lain.ackAutoApproval(id)
    setAutoRows((prev) => prev.filter((r) => r.id !== id)) // 낙관 갱신 — 확인은 로컬 DB UPDATE라 실패 여지가 작다
  }
  // C5 — 대기 배지는 시간이 흐르면서 값이 바뀌는데, approvals/tasks는 이벤트 기반 갱신(App.tsx)이라
  // 변동 없인 리렌더가 없다 — TaskDrawer와 같은 30초 틱으로 배지를 계속 최신 유지.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])
  // C5 — 헤더 칩 툴팁용 최장 대기(승인은 created_at, 작업 기반 행은 updated_at=상태전이 시각).
  const longestWaitLabel = longestWait([
    ...approvals.map((a) => a.createdAt),
    ...blocked.map((t) => t.updatedAt),
    ...review.map((t) => t.updatedAt),
    ...errored.map((t) => t.updatedAt),
  ])

  // 마운트/목록 변동 시 첫 행에 포커스 — 키보드 승인을 바로 받을 수 있게(처리로 행이 사라지면 재포커스).
  // B3 — 답변 입력 중(activeElement가 입력요소)에 새 항목이 도착(개수 증가)해도 포커스를 강탈하지 않는다.
  // 행이 처리돼 사라진 경우(개수 감소)에만 다음 행으로 넘어간다.
  useEffect(() => {
    const prevTotal = prevTotalRef.current
    prevTotalRef.current = total
    if (!shouldRefocusInboxRow(prevTotal, total, document.activeElement)) return
    const first = listRef.current?.querySelector<HTMLElement>('.inbox-row[tabindex]')
    first?.focus()
  }, [total])

  return (
    <div className="drawer panel inbox-panel">
      <div className="drawer-head">
        <span className="drawer-title">
          [ wired://inbox — {view === 'after' ? '사후 검토' : '대기'} ]
        </span>
        <span
          className="dim"
          title={longestWaitLabel ? `최장 대기: ${longestWaitLabel}` : undefined}
        >
          {total}건 · 승인 {approvals.length} · 질문 {blocked.length} · 결재 {review.length}
          {errored.length > 0 ? ` · 에러 ${errored.length}` : ''}
        </span>
        <button
          className="dim"
          title={
            view === 'after'
              ? '대기 목록으로'
              : '자율 통과(autonomous/bypass) 기록 — 무엇이 자율로 실행됐는지 사후 확인'
          }
          onClick={() => setView(view === 'after' ? 'pending' : 'after')}
        >
          {view === 'after' ? '← 대기' : '사후 검토'}
        </button>
        <button onClick={onClose}><Icon name="x-circle" size={18} /></button>
      </div>
      {/* B10 — 키보드 힌트: 행에 포커스(Tab/자동) 후 아래 키로 즉시 처리. 실제 구현(ApprovalRow·ReviewRow)과 일치. */}
      {view === 'pending' && total > 0 && (
        <div className="inbox-hint dim">
          <kbd>y</kbd> 승인 · <kbd>n</kbd> 거절 · <kbd>m</kbd> 병합 · <kbd>b</kbd> 브랜치
        </div>
      )}
      {/* 결재 결과 한 줄 — 병합 실패('rebase 후 verify 실패' 등)를 성공과 구분해 남긴다 */}
      {view === 'pending' && actionMsg && <div className="inbox-hint warn">{actionMsg}</div>}
      {view === 'after' ? (
        autoRows.length === 0 ? (
          <div className="empty">자율 통과 기록 없음 — 전부 확인됨 ●</div>
        ) : (
          <div className="inbox-list">
            {autoRows.map((a) => (
              <AutoReviewRow
                key={`auto${a.id}`}
                a={a}
                task={byId.get(a.taskId)}
                label={projLabel(a.taskId, byId)}
                onOpenTask={onOpenTask}
                onAck={ackAuto}
              />
            ))}
          </div>
        )
      ) : total === 0 ? (
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
            <ReviewRow
              key={`r${t.id}`}
              t={t}
              onOpenTask={onOpenTask}
              onResult={(projectId, msg) => setActionMsg(`${projectId}: ${msg}`)}
            />
          ))}
          {errored.map((t) => (
            <ErrorRow key={`e${t.id}`} t={t} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}
    </div>
  )
}

// B4 — 인박스는 App의 모든 리렌더(키 입력 포함)에 딸려 다시 그려졌다. approvals·tasks·콜백이 그대로면 스킵.
export const AttentionInbox = memo(AttentionInboxInner)
