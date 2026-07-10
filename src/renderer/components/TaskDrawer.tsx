import { useEffect, useRef, useState } from 'react'
import type {
  Approval,
  FileAttachment,
  ModelTier,
  Task,
  TaskEvent,
  TaskPermissionMode,
  ThinkingLevel,
} from '../../shared/types'
import { MODEL_TIERS, MODEL_NAME } from '../../shared/models'
import { TODO_STATUS_ICON, todoProgress, decodeTodoLine } from '../../shared/todoline'
import { fmtTokens } from '../App'
import { fmtElapsed, isImageMime } from '../lib/chat'
import { useStickyScroll } from '../lib/useStickyScroll'
import { parseDiffFiles, fileStatLabel, totalDiffStat, type DiffFile } from '../lib/diffParse'
import { ConfirmWindow } from './ConfirmWindow'
import { Icon } from './icons'

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
        <Icon name="image" size={14} /> 이미지 첨부{imgs.length > 0 ? ` (${imgs.length})` : ''}
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
  // B15 — null=아직 로드 전(작업 열자마자), []=로드 완료했지만 이벤트가 아직 없음. 구분해서 빈 공백 방지.
  events: TaskEvent[] | null
  onClose: () => void
}

const KIND_PREFIX: Record<string, string> = {
  status: '◆',
  tool: '▸',
  text: '»',
  error: '✗',
  subagent: '⑂', // B2 — 서브에이전트/백그라운드 task
  todo: '☑', // A4 — TodoWrite 갱신(원본 로그엔 진행률 요약만, 원문 JSON 노출 방지)
  checkpoint: '◷', // D6 — 장기 작업 중간보고(진행중: N턴 · 커밋 M · +X/-Y)
  exec: '⌘', // D12 — codex 명령 실행 감사(승인 큐 없는 codex의 유일한 관측창). 실패는 경고색으로 부각.
}

// D12 — codex exec 감사 이벤트의 실패 여부(exit!=0) — text 접미가 "→ OK"가 아니면 실패로 부각(경고색).
function isExecFailure(ev: TaskEvent): boolean {
  return ev.kind === 'exec' && !/→ OK$/.test(ev.text)
}

// A4 — 원본 이벤트 로그의 todo 줄은 encodeTodoLine(§todo§{JSON}) 원문 대신 진행률 요약으로 표시.
// (상단 TodoChecklist 위젯이 현재 상태를 보여주므로 로그엔 '갱신됨 · n/m'만.)
function todoLogText(raw: string): string {
  const todos = decodeTodoLine(raw)
  if (!todos || todos.length === 0) return '진행 체크리스트 갱신'
  const { done, total } = todoProgress(todos)
  return `진행 체크리스트 갱신 · ${done}/${total}`
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

// diff 한 줄 → 색상 클래스. TaskDiffSection의 파일별 블록·폴백 전문 렌더가 공유.
// inHunk: @@ 헝크 진입 후인지(DiffLines가 추적해 전달) — 헝크 본문의 '---'/'+++' 로 시작하는 내용을
// 파일 헤더로 오인해 회색(diff-meta)으로 칠하지 않고 삭제/추가 색으로 정확히 렌더하기 위함(Pm-diff1과 동형).
function diffLineClass(line: string, inHunk: boolean): string {
  if (line.startsWith('@@')) return 'diff-hunk'
  if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('Binary files')
  )
    return 'diff-meta'
  return ''
}

// diff 줄 배열 → 색상 렌더. keyBase로 파일 블록 간 key 충돌 방지.
function DiffLines({ lines, keyBase }: { lines: string[]; keyBase: string }) {
  // 헝크 진입 여부를 줄 순서대로 추적해 diffLineClass에 넘긴다(파일별 블록은 diff --git으로 시작하지만,
  // 폴백 전문 렌더는 여러 파일이 이어지므로 diff --git마다 리셋). @@ 이후 본문의 ---/+++ 오색 방지.
  let inHunk = false
  return (
    <>
      {lines.map((line, i) => {
        if (line.startsWith('diff --git ')) inHunk = false
        else if (line.startsWith('@@')) inHunk = true
        return (
          <span key={`${keyBase}:${i}`} className={diffLineClass(line, inHunk)}>
            {line + '\n'}
          </span>
        )
      })}
    </>
  )
}

// C9 — 파일 단위 접이식 섹션. 파일명 + +N/-M 배지 헤더 클릭으로 그 파일의 diff 본문을 토글.
function DiffFileBlock({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="diff-file">
      <button className="diff-file-head" onClick={() => setOpen((v) => !v)}>
        {open ? <Icon name="chevron-down" size={12} /> : <Icon name="chevron-right" size={12} />}
        <span className="diff-file-path">
          {file.isRename && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {file.isNew && <span className="diff-file-tag">new</span>}
        {file.isDeleted && <span className="diff-file-tag">del</span>}
        <span className={`diff-file-stat${file.binary ? ' diff-file-bin' : ''}`}>{fileStatLabel(file)}</span>
      </button>
      {open && (
        <pre className="task-diff-body diff-file-body">
          <DiffLines lines={file.lines} keyBase={file.path} />
        </pre>
      )}
    </div>
  )
}

// D13 — 크로스레포 그룹 결재 패널. 그룹 소속 review 작업에서 개별 병합 대신 all-or-nothing 일괄 결재.
// 병합은 모든 child가 review일 때만 활성화(하나라도 아니면 어디가 덜 됐는지 표시).
function GroupReviewPanel({ groupId }: { groupId: string }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.lain.taskGroupInfo>>>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const load = () => void window.lain.taskGroupInfo(groupId).then(setInfo)
  useEffect(() => {
    load()
    const off = window.lain.onTasksUpdated(() => load()) // child 상태 변화 라이브 반영
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId])
  if (!info) return null
  const reviewCount = info.children.filter((c) => c.state === 'review').length
  const allReady = reviewCount === info.children.length
  const run = async (action: 'merge' | 'keep-branch' | 'discard') => {
    setBusy(true)
    setMsg(null)
    const res = await window.lain.resolveGroup(groupId, action)
    setMsg(res)
    setBusy(false)
    load()
  }
  return (
    <div className="group-review">
      <div className="group-review-head">
        크로스레포 그룹 · <b>{info.title}</b> — review {reviewCount}/{info.children.length}
      </div>
      <ul className="group-review-children">
        {info.children.map((c) => (
          <li key={c.taskId} className={c.state === 'review' ? 'ok' : 'dim'}>
            {c.state === 'review' ? '✓' : '·'} {c.projectId} — {c.state}
            {c.verifyResult ? ` (verify: ${c.verifyResult.slice(0, 40)})` : ''}
          </li>
        ))}
      </ul>
      <div className="review-actions">
        <button
          disabled={busy || !allReady}
          title={allReady ? '모든 레포에 일괄 병합(하나라도 막히면 자동 롤백)' : '모든 child가 review가 되어야 병합 가능'}
          onClick={() => run('merge')}
        >
          <Icon name="check" size={14} /> 그룹 일괄 병합 (all-or-nothing)
        </button>
        <button disabled={busy} onClick={() => run('keep-branch')}>
          <Icon name="branch" size={14} /> 브랜치 전부 보존
        </button>
        <button disabled={busy} onClick={() => run('discard')}>
          <Icon name="trash" size={14} /> 그룹 전부 폐기
        </button>
      </div>
      {msg && <pre className="group-review-msg">{msg}</pre>}
    </div>
  )
}

// B1 diff-viewer — review 외 상태(working/error 등)에서도 변경 diff를 본다. 열 때마다 재요청(진행 중 diff는 변함) + 전체 복사.
// C9 — 전문 통짜 스크롤 대신 파일 목록 요약 + 파일별 접이식 섹션(파일 많으면 기본 접힘). 파싱은 순수(lib/diffParse).
const DIFF_COLLAPSE_THRESHOLD = 4 // 이보다 많으면 파일 블록 기본 접힘(요약만 먼저 보여준다)

function TaskDiffSection({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState<string | null>(null)
  const toggle = async () => {
    if (!open) setBody(await window.lain.taskDiff(task.id))
    setOpen((v) => !v)
  }
  const files = body ? parseDiffFiles(body) : []
  const total = totalDiffStat(files)
  const defaultOpen = files.length <= DIFF_COLLAPSE_THRESHOLD
  return (
    <div className="task-diff-wrap">
      <button className="task-diff-toggle" onClick={toggle}>
        ◇ diff 보기 {open ? <Icon name="chevron-down" size={14} /> : <Icon name="chevron-right" size={14} />}
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
          {body === null ? (
            <pre className="task-diff-body">…</pre>
          ) : body === '' ? (
            <pre className="task-diff-body">(변경 없음)</pre>
          ) : files.length === 0 ? (
            // diff --git 헤더가 없는 비정상/특수 출력(log 폴백 등) — 통짜로 색상만 입혀 보여준다.
            <pre className="task-diff-body">
              <DiffLines lines={body.split('\n')} keyBase="raw" />
            </pre>
          ) : (
            <>
              <div className="diff-summary">
                파일 {total.files}개
                {total.added > 0 && <span className="diff-add"> +{total.added}</span>}
                {total.removed > 0 && <span className="diff-del"> -{total.removed}</span>}
              </div>
              {files.map((f, i) => (
                // Pm-diff2 — 비정상 헤더 폴백에서 경로가 겹칠 수 있어 index를 key에 병용(형제 open 상태 오공유 방지).
                <DiffFileBlock key={`${i}:${f.path}`} file={f} defaultOpen={defaultOpen} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// A4 — TodoWrite 진행 체크리스트 위젯. task.todos는 최신 TodoWrite 스냅샷(누적 아님 — 마지막
// 호출이 현재 상태). 없으면(아직 TodoWrite 미사용) 렌더 안 함.
function TodoChecklist({ task }: { task: Task }) {
  const todos = task.todos
  if (!todos || todos.length === 0) return null
  const { done, total } = todoProgress(todos)
  return (
    <div className="task-todos">
      <div className="task-todos-head">
        진행 체크리스트 · {done}/{total}
      </div>
      {todos.map((t, i) => (
        <div key={i} className={`task-todo-item task-todo-${t.status}`}>
          <span className="task-todo-icon">{TODO_STATUS_ICON[t.status]}</span>
          <span className="task-todo-text">{t.status === 'in_progress' ? t.activeForm || t.content : t.content}</span>
        </div>
      ))}
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
<Icon name="send" size={14} /> 답변
      </button>
      <button onClick={() => window.lain.resolveApproval(approval.id, false)}>거부</button>
    </div>
  )
}

export function TaskDrawer({ task, approvals, events, onClose }: Props) {
  const [answer, setAnswer] = useState('')
  const [answers, setAnswers] = useState<string[]>([])
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmRevert, setConfirmRevert] = useState(false) // D8 — 병합 되돌리기 확인창
  const [, setNow] = useState(Date.now())
  // B2 — ChatPanel의 near-bottom 스티키 스크롤 이식: 바닥 근처일 때만 추종, 벗어나면 '↓ 최신' 점프 버튼.
  const { bottomRef, showJump, jumpToBottom } = useStickyScroll([events?.length ?? 0])
  const taskApprovals = approvals.filter((a) => a.taskId === task.id)
  const criteria = extractCriteria(task.content)
  const multiQ = task.questions.length >= 2

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
        {task.engine === 'codex' && (
          <span className="task-mode-badge" title="OpenAI Codex CLI 엔진 — 승인 큐 대신 codex 샌드박스가 방어선">
            ◆codex
          </span>
        )}
        {/* P2 권한모드 — bypass=승인 자동통과(시크릿·테스트보호는 유지). 진행 중 변경은 다음 재개부터 적용. */}
        <select
          className="task-permmode"
          value={task.permissionMode}
          title="권한모드 — plan은 계획 전문을 승인 카드로 띄우고 승인해야 실행. bypass는 위험명령 승인을 자동통과(끼어듦 0). 시크릿 차단·테스트 보호는 유지"
          onChange={(e) =>
            window.lain.setTaskPermissionMode(task.id, e.target.value as TaskPermissionMode)
          }
        >
          <option value="default">default</option>
          <option value="plan">plan</option>
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
        {/* D10 — 작업별 모델 고정. 빈 값(전역)=설정의 naviModel 따름. 다음 실행/재개부터 적용. */}
        <select
          className="task-model"
          value={task.modelOverride}
          title="모델 — 이 작업만 고정할 모델(전역=설정의 Navi 모델을 따름). 다음 실행/재개부터 적용"
          onChange={(e) => window.lain.setTaskModel(task.id, e.target.value as ModelTier | '')}
        >
          <option value="">모델:전역</option>
          {MODEL_TIERS.map((t) => (
            <option key={t} value={t}>
              모델:{MODEL_NAME[t]}
            </option>
          ))}
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
        {task.dependsOn.length > 0 && (
          <span className="dim" title="D2 — 선행 작업이 전부 done(결재 완료) 되면 자동 착수">
            ⏳ 선행: {task.dependsOn.join(' · ')}
          </span>
        )}
        {task.groupId && (
          <span className="dim" title="D13 — 크로스레포 그룹 소속. 개별 병합 불가 — 그룹 일괄 결재(review 패널)">
            🔗 그룹: {task.groupId}
          </span>
        )}
        <span className="dim">
          {fmtTokens(task.tokens)} tok · {task.turns}턴{task.branch ? ` · ${task.branch}` : ''} ·{' '}
          {fmtElapsed(task.createdAt)}
        </span>
        {(task.state === 'working' ||
          task.state === 'clarifying' ||
          task.state === 'queued') && (
          <button onClick={() => window.lain.cancelTask(task.id)}>
            <Icon name="stop" size={14} /> 취소
          </button>
        )}
        <button onClick={onClose}>
          <Icon name="x-circle" size={14} />
        </button>
      </div>

      {/* A4 — TodoWrite 진행 체크리스트(있을 때만) */}
      <TodoChecklist task={task} />

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
        <Icon name="send" size={14} /> 답변
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
        <Icon name="send" size={14} /> 답변
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
          {/* D13 — 그룹 소속이면 개별 병합 불가. 그룹 일괄 결재 패널로 대체(병합은 all-or-nothing). */}
          {task.groupId ? (
            <GroupReviewPanel groupId={task.groupId} />
          ) : (
            <div className="review-actions">
              <button onClick={() => window.lain.resolveReview(task.id, 'merge')}>
                <Icon name="check" size={14} /> 병합 승인 (clean+ff일 때만)
              </button>
              <button onClick={() => window.lain.resolveReview(task.id, 'keep-branch')}>
                <Icon name="branch" size={14} /> 브랜치만 남기고 완료
              </button>
              <button onClick={() => setConfirmDiscard(true)}>
                <Icon name="trash" size={14} /> 폐기
              </button>
            </div>
          )}
        </div>
      )}

      {confirmDiscard && (
        <ConfirmWindow
          title="작업 폐기"
          message={
            <>
              <b>{task.title}</b>의 브랜치·변경사항을 폐기할까요? <b>되돌릴 수 없습니다.</b>
            </>
          }
          note={task.diffStat ? <pre className="confirm-diffstat">{task.diffStat}</pre> : undefined}
          confirmLabel="폐기"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            window.lain.resolveReview(task.id, 'discard')
            setConfirmDiscard(false)
          }}
        />
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
<Icon name="play" size={14} /> 재개
            </button>
          )}
        </div>
      )}

      {/* D11 — done/cancelled(종결) 작업의 원클릭 재실행. 새 task를 만들어 착수하고(원본 보존) 드로어를 닫는다
          — 새 task는 tasks:updated 구독으로 보드/목록에 곧 나타난다. */}
      {(task.state === 'done' || task.state === 'cancelled') && (
        <div className="drawer-rerun">
          <button
            className="task-rerun"
            title="같은 지시서(합격 기준 포함)로 새 작업을 만들어 다시 시작한다. 원본은 그대로 보존된다."
            onClick={async () => {
              const r = await window.lain.rerunTask(task.id)
              if (r.error) window.alert(`재실행 실패: ${r.error}`)
              else onClose()
            }}
          >
            <Icon name="play" size={14} /> 재실행
          </button>
          {/* D8 — done + ff 병합된 작업(범위 저장됨)만 병합 되돌리기 노출. 비파괴 revert(새 커밋). */}
          {task.state === 'done' && task.mergeBaseSha && task.mergeHeadSha && (
            <button
              className="task-revert"
              title="이 작업이 main에 병합한 커밋 범위를 git revert로 되돌린다(새 revert 커밋 생성 — 비파괴). 충돌·dirty면 자동 abort."
              onClick={() => setConfirmRevert(true)}
            >
              <Icon name="branch" size={14} /> 병합 되돌리기(revert)
            </button>
          )}
        </div>
      )}

      {confirmRevert && (
        <ConfirmWindow
          title="병합 되돌리기(revert)"
          message={
            <>
              <b>{task.title}</b>의 병합을 되돌릴까요? main에 <b>새 revert 커밋</b>을 만들어 변경을
              무효화합니다(히스토리는 그대로 — 비파괴). 충돌·작업트리 dirty면 자동으로 중단됩니다.
            </>
          }
          confirmLabel="되돌리기"
          onCancel={() => setConfirmRevert(false)}
          onConfirm={async () => {
            setConfirmRevert(false)
            const res = await window.lain.revertMerge(task.id)
            window.alert(res)
          }}
        />
      )}

      {/* B1 diff — worktree/브랜치가 있으면 어느 상태에서든 변경을 본다(review 전용 아님) */}
      {(task.worktreePath || task.branch) && <TaskDiffSection task={task} />}

      {/* 이벤트 스트림 — 화자(speaker)가 있으면 대화 트랜스크립트로, 없으면 시스템 로그 줄로 */}
      <div className="drawer-log">
        {/* B15 — null(로드 전) vs 빈 배열(로드 완료, 이벤트 없음)을 구분해 안내한다 */}
        {events === null ? (
          <div className="dim">이벤트 로딩 중…</div>
        ) : events.length === 0 ? (
          <div className="dim">아직 이벤트 없음 — Navi 시작 대기</div>
        ) : (
          events.map((ev, i) => {
            const sp = ev.speaker
            const prefix =
              sp === 'worker' ? 'navi>' : sp === 'lain' ? 'Lain' : sp === 'user' ? 'User' : KIND_PREFIX[ev.kind] ?? '·'
            return (
              <div
                key={i}
                className={`ev ev-${ev.kind}${sp ? ` ev-sp-${sp}` : ''}${isExecFailure(ev) ? ' ev-exec-fail' : ''}`}
              >
                <span className="ev-prefix">{prefix}</span>
                <span className="ev-text">{ev.kind === 'todo' ? todoLogText(ev.text) : ev.text}</span>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
        {/* B2 — ChatPanel/NaviChatPanel과 동일한 chat-jump 스타일 재사용(near-bottom 스티키 이식) */}
        {showJump && (
          <button className="chat-jump" onClick={jumpToBottom}>
            <Icon name="chevron-down" size={14} /> 최신
          </button>
        )}
      </div>
    </div>
  )
}
