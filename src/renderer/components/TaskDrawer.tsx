import { useEffect, useRef, useState } from 'react'
import type {
  Approval,
  FileAttachment,
  Task,
  TaskEvent,
  TaskPermissionMode,
  ThinkingLevel,
} from '../../shared/types'
import { fmtTokens } from '../App'
import { isImageMime } from '../lib/chat'

// B17 이미지 입력 — 파일 → 이미지 FileAttachment. Anthropic 4종 media_type만(isImageMime) 이미지로 취급.
function fileToImageAttachment(file: File): Promise<FileAttachment | null> {
  if (!isImageMime(file.type)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () =>
      resolve({
        name: file.name,
        mimeType: file.type,
        data: (reader.result as string).split(',')[1], // base64 부분만
        isImage: true,
      })
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

// B17 — 작업 입력 이미지 첨부(드로어 직접첨부, 옵션3). 단일 출처 = task.images(로컬 중복 보관 금지).
// 메인(ipc tasks:setImages)이 cap(최대 6장·크기·이미지만)을 강제 → 화면은 task.images를 그대로 비춤.
function ImageAttachSection({ task }: { task: Task }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const imgs = task.images ?? []
  const add = async (files: File[]) => {
    const conv = (await Promise.all(files.map(fileToImageAttachment))).filter(
      (a): a is FileAttachment => a !== null,
    )
    if (conv.length) window.lain.setTaskImages(task.id, [...imgs, ...conv])
  }
  const removeAt = (idx: number) =>
    window.lain.setTaskImages(
      task.id,
      imgs.filter((_, j) => j !== idx),
    )
  return (
    <div className="task-images">
      <button
        className="task-img-add"
        title="작업 입력 이미지 첨부 — Navi가 다음 실행/재개 때 본다(스크린샷으로 UI 버그 재현 등). 최대 6장"
        onClick={() => fileRef.current?.click()}
      >
        🖼 이미지 첨부{imgs.length > 0 ? ` (${imgs.length})` : ''}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          void add(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      {imgs.length > 0 && (
        <span className="task-img-tiles">
          {imgs.map((a, i) => (
            <span key={i} className="task-img-tile" title={a.name}>
              <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
              <button className="task-img-rm" title="제거" onClick={() => removeAt(i)}>
                ×
              </button>
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

interface Props {
  task: Task
  approvals: Approval[]
  events: TaskEvent[]
  onClose: () => void
}

const KIND_PREFIX: Record<string, string> = {
  status: '◆',
  tool: '▸',
  text: '»',
  error: '✗',
  subagent: '⑂', // B2 — 서브에이전트/백그라운드 task
}

// 작업 시작 이후 경과 — createdAt(ISO) 기준. '방금' / '12분째' / '3시간째'
function fmtElapsed(createdAt: string): string {
  const start = Date.parse(createdAt)
  if (Number.isNaN(start)) return ''
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000))
  if (sec < 60) return '방금'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분째`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간째`
  return `${Math.floor(hr / 24)}일째`
}

// elicitation 산출 합격 기준(= 실행의 판사) 추출 — §21.3에서 지시서에 주입한 블록
function extractCriteria(content: string): string[] {
  const m = content.match(/##\s*합격 기준[^\n]*\n([\s\S]*?)(?:\n##\s|\s*$)/)
  if (!m) return []
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
}

// P2 금지 도구(블랙리스트) 입력 — 쉼표 구분. blur/Enter에 커밋(키스트로크마다 IPC 방지). 다음 재개부터 적용.
function DisallowedToolsInput({ task }: { task: Task }) {
  const joined = task.disallowedTools.join(', ')
  const [v, setV] = useState(joined)
  useEffect(() => {
    setV(joined)
  }, [joined])
  const commit = () => {
    const tools = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (tools.join(',') !== task.disallowedTools.join(',')) {
      window.lain.setTaskDisallowedTools(task.id, tools)
    }
  }
  // B1 web-tools-ui — 웹검색/웹페치 전용 토글. task.disallowedTools 단일 출처에서 상태 도출(로컬 중복 보관 금지).
  const blocked = (t: string) => task.disallowedTools.includes(t)
  const toggleTool = (t: string) => {
    const next = blocked(t) ? task.disallowedTools.filter((x) => x !== t) : [...task.disallowedTools, t]
    window.lain.setTaskDisallowedTools(task.id, next)
  }
  return (
    <span className="task-tools" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
      <input
        className="task-denytools"
        value={v}
        placeholder="금지 도구 (쉼표)"
        title="이 Navi에 금지할 도구 — 예: Bash, WebFetch. 시크릿·테스트 가드와 별개의 SDK 필터. 다음 재개부터 적용"
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit()
        }}
        style={{ width: 110 }}
      />
      <label className="dim" title="체크 시 웹검색(WebSearch) 차단" style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
        <input type="checkbox" checked={blocked('WebSearch')} onChange={() => toggleTool('WebSearch')} />🚫검색
      </label>
      <label className="dim" title="체크 시 웹페치(WebFetch) 차단" style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
        <input type="checkbox" checked={blocked('WebFetch')} onChange={() => toggleTool('WebFetch')} />페치
      </label>
    </span>
  )
}

// B1 diff-viewer — review 외 상태(working/error 등)에서도 변경 diff를 본다. 열 때마다 재요청(진행 중 diff는 변함) + 전체 복사.
function TaskDiffSection({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState<string | null>(null)
  const toggle = async () => {
    if (!open) setBody(await window.lain.taskDiff(task.id))
    setOpen((v) => !v)
  }
  return (
    <div className="task-diff-wrap">
      <button className="task-diff-toggle" onClick={toggle}>
        ◇ diff 보기 {open ? '▾' : '▸'}
        {open && body ? (
          <span
            className="task-diff-copy"
            title="전체 복사"
            onClick={(e) => {
              e.stopPropagation()
              window.lain.copyText(body)
            }}
          >
            {' '}
            ⧉ 복사
          </span>
        ) : null}
      </button>
      {open && (
        <div className="task-diff">
          <pre className="task-diff-body">
            {body === null
              ? '…'
              : body === ''
                ? '(변경 없음)'
                : body.split('\n').map((line, i) => {
                    const cls =
                      line.startsWith('+++') || line.startsWith('---')
                        ? 'diff-meta'
                        : line.startsWith('@@')
                          ? 'diff-hunk'
                          : line.startsWith('+')
                            ? 'diff-add'
                            : line.startsWith('-')
                              ? 'diff-del'
                              : line.startsWith('diff ') ||
                                  line.startsWith('index ') ||
                                  line.startsWith('new file') ||
                                  line.startsWith('deleted file') ||
                                  line.startsWith('rename ')
                                ? 'diff-meta'
                                : ''
                    return (
                      <span key={i} className={cls}>
                        {line + '\n'}
                      </span>
                    )
                  })}
          </pre>
        </div>
      )}
    </div>
  )
}

// ask_manager 에스컬레이션 — Navi가 답변을 기다리며 멈춰 있다
function QuestionCard({ approval }: { approval: Approval }) {
  const [text, setText] = useState('')
  const send = () => {
    if (!text.trim()) return
    window.lain.resolveApproval(approval.id, true, text.trim())
    setText('')
  }
  return (
    <div className="approval-card approval-question">
      <span className="approval-kind">[질문]</span>
      <span className="approval-cmd">{approval.payload}</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="답변 — Navi가 이 답으로 이어간다"
        onKeyDown={(e) => {
          if (e.key === 'Enter') send()
        }}
      />
      <button disabled={!text.trim()} onClick={send}>
        ▶ 답변
      </button>
      <button onClick={() => window.lain.resolveApproval(approval.id, false)}>거부</button>
    </div>
  )
}

export function TaskDrawer({ task, approvals, events, onClose }: Props) {
  const [answer, setAnswer] = useState('')
  const [answers, setAnswers] = useState<string[]>([])
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [, setNow] = useState(Date.now())
  const bottomRef = useRef<HTMLDivElement>(null)
  const taskApprovals = approvals.filter((a) => a.taskId === task.id)
  const criteria = extractCriteria(task.content)
  const multiQ = task.questions.length >= 2

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  // 경과시간 틱 — 30초마다 리렌더
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  // 질문별 입력칸을 'Q1: …' 줄바꿈 결합해 기존 answerClarify로 전달
  const multiReady = multiQ && task.questions.every((_, i) => (answers[i] ?? '').trim() !== '')
  const submitMulti = (): boolean => {
    if (!multiReady) return false
    const combined = task.questions
      .map((_, i) => `Q${i + 1}: ${(answers[i] ?? '').trim()}`)
      .join('\n')
    window.lain.answerClarify(task.id, combined)
    setAnswers([])
    return true
  }

  return (
    <div className="drawer panel">
      <div className="drawer-head">
        <span className={`drawer-state st-task-${task.state}`}>[{task.state}]</span>
        {task.mode === 'autonomous' && (
          <span className="task-mode-badge" title="autonomous (glass-box, §21)">
            ⚡auto
          </span>
        )}
        {/* P2 권한모드 — bypass=승인 자동통과(시크릿·테스트보호는 유지). 진행 중 변경은 다음 재개부터 적용. */}
        <select
          className="task-permmode"
          value={task.permissionMode}
          title="권한모드 — bypass는 위험명령 승인을 자동통과(끼어듦 0). 시크릿 차단·테스트 보호는 유지"
          onChange={(e) =>
            window.lain.setTaskPermissionMode(task.id, e.target.value as TaskPermissionMode)
          }
        >
          <option value="default">default</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="bypass">bypass</option>
        </select>
        {/* P2 thinking 예산 — auto=모델판단(권장)·high=큰 예산. 다음 재개부터 적용. */}
        <select
          className="task-thinking"
          value={task.thinkingLevel}
          title="확장사고 — auto=모델이 알아서(권장), high=큰 예산(어려운 작업), off=끔"
          onChange={(e) =>
            window.lain.setTaskThinking(task.id, e.target.value as ThinkingLevel)
          }
        >
          <option value="default">think:기본</option>
          <option value="off">think:off</option>
          <option value="auto">think:auto</option>
          <option value="high">think:high</option>
        </select>
        {/* B4 fast-mode — Opus 빠른 출력 모드 토글. 다음 재개부터 적용. */}
        <label
          className="task-fast dim"
          title="Opus 빠른 출력 모드 — 단순·빨리 끝낼 작업에. 다음 실행/재개부터 적용"
          style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}
        >
          <input
            type="checkbox"
            checked={task.fastMode}
            onChange={(e) => window.lain.setTaskFastMode(task.id, e.target.checked)}
          />
          ⚡fast
        </label>
        <DisallowedToolsInput task={task} />
        <span className="drawer-title">
          {task.projectId} — {task.title}
        </span>
        {task.skills && task.skills.length > 0 && (
          <span className="task-skills dim" title="이 작업에 할당된 스킬">
            🧩 {task.skills.join(' · ')}
          </span>
        )}
        <span className="dim">
          {fmtTokens(task.tokens)} tok · {task.turns}턴{task.branch ? ` · ${task.branch}` : ''} ·{' '}
          {fmtElapsed(task.createdAt)}
        </span>
        {(task.state === 'working' || task.state === 'clarifying') && (
          <button onClick={() => window.lain.cancelTask(task.id)}>■ 취소</button>
        )}
        <button onClick={onClose}>✕</button>
      </div>

      {/* B17 작업 입력 이미지 — Navi가 다음 실행/재개 때 본다(드로어 직접첨부) */}
      <ImageAttachSection task={task} />

      {/* 합격 기준 (§21.3 elicitation 산출 = 판사) */}
      {criteria.length > 0 && (
        <div className="criteria-box">
          <div className="criteria-label">합격 기준 · 판사 (§21.3)</div>
          {criteria.map((c, i) => (
            <div key={i} className="criteria-item">
              ✓ {c}
            </div>
          ))}
        </div>
      )}

      {/* 승인/질문 대기 카드 (§9-4, §5.2 ask_manager 에스컬레이션) */}
      {taskApprovals.map((a) =>
        a.kind === 'question' ? (
          <QuestionCard key={a.id} approval={a} />
        ) : (
          <div key={a.id} className="approval-card">
            <span className="approval-kind">[{a.kind}]</span>
            <code className="approval-cmd">{a.payload}</code>
            <button onClick={() => window.lain.resolveApproval(a.id, true)}>승인</button>
            <button onClick={() => window.lain.resolveApproval(a.id, false)}>거절</button>
          </div>
        ),
      )}

      {/* 명확화/blocked 질문 */}
      {task.state === 'blocked' &&
        (multiQ ? (
          <div className="clarify-box">
            {task.questions.map((q, i) => (
              <div key={i} className="clarify-qa">
                <div className="clarify-q">
                  Q{i + 1}. {q}
                </div>
                <input
                  value={answers[i] ?? ''}
                  onChange={(e) => {
                    const next = [...answers]
                    next[i] = e.target.value
                    setAnswers(next)
                  }}
                  placeholder={`Q${i + 1} 답변`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitMulti()
                  }}
                />
              </div>
            ))}
            <div className="clarify-input">
              <button disabled={!multiReady} onClick={submitMulti}>
                ▶ 답변
              </button>
            </div>
          </div>
        ) : (
          <div className="clarify-box">
            {task.questions.map((q, i) => (
              <div key={i} className="clarify-q">
                Q{i + 1}. {q}
              </div>
            ))}
            <div className="clarify-input">
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="답변 입력 (한 번에 모두)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && answer.trim()) {
                    window.lain.answerClarify(task.id, answer.trim())
                    setAnswer('')
                  }
                }}
              />
              <button
                disabled={!answer.trim()}
                onClick={() => {
                  window.lain.answerClarify(task.id, answer.trim())
                  setAnswer('')
                }}
              >
                ▶ 답변
              </button>
            </div>
          </div>
        ))}

      {/* 검토 (§8-9) */}
      {task.state === 'review' && (
        <div className="review-box">
          {task.summary && <pre className="review-summary">{task.summary}</pre>}
          {task.diffStat && <pre className="review-diff">{task.diffStat}</pre>}
          {/* diff 본문은 아래 standalone TaskDiffSection으로 이동(B1 — review 외 상태에서도 보이게) */}

          {task.verifyResult && (
            <div className={task.verifyResult === 'pass' ? 'ok' : 'warn'}>
              {task.verifyResult.length > 200 ? (
                <details onToggle={(e) => setVerifyOpen(e.currentTarget.open)}>
                  <summary>
                    verify: {verifyOpen ? '' : task.verifyResult.slice(0, 200) + '… '}
                    <span className="dim">[{verifyOpen ? '접기' : '전부 보기'}]</span>
                  </summary>
                  <pre className="review-verify-full">{task.verifyResult}</pre>
                </details>
              ) : (
                <>verify: {task.verifyResult}</>
              )}
            </div>
          )}
          <div className="review-actions">
            <button onClick={() => window.lain.resolveReview(task.id, 'merge')}>
              ✓ 병합 승인 (clean+ff일 때만)
            </button>
            <button onClick={() => window.lain.resolveReview(task.id, 'keep-branch')}>
              ⎇ 브랜치만 남기고 완료
            </button>
            <button onClick={() => window.lain.resolveReview(task.id, 'discard')}>
              ✗ 폐기
            </button>
          </div>
        </div>
      )}

      {task.state === 'error' && (
        <div className="err drawer-error">
          {task.error}
          {/* B3 resume-continue — worktree·세션 생존 시에만 수동 재개 노출 */}
          {task.worktreePath && task.naviSessionId && (
            <button
              className="task-resume"
              style={{ marginLeft: 8 }}
              title="작업트리·세션 그대로 마지막 중단 지점부터 재개"
              onClick={() => window.lain.resumeTask(task.id)}
            >
              ▶ 재개
            </button>
          )}
        </div>
      )}

      {/* B1 diff — worktree/브랜치가 있으면 어느 상태에서든 변경을 본다(review 전용 아님) */}
      {(task.worktreePath || task.branch) && <TaskDiffSection task={task} />}

      {/* 이벤트 스트림 — 화자(speaker)가 있으면 대화 트랜스크립트로, 없으면 시스템 로그 줄로 */}
      <div className="drawer-log">
        {events.map((ev, i) => {
          const sp = ev.speaker
          const prefix =
            sp === 'worker' ? 'navi>' : sp === 'lain' ? 'Lain>' : sp === 'user' ? '나▸' : KIND_PREFIX[ev.kind] ?? '·'
          return (
            <div key={i} className={`ev ev-${ev.kind}${sp ? ` ev-sp-${sp}` : ''}`}>
              <span className="ev-prefix">{prefix}</span>
              <span className="ev-text">{ev.text}</span>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
