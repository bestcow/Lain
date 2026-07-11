// 대화 본문 마크다운 경량 렌더 — 코드펜스(```)·인라인 백틱·diff 라인만 처리한다(외부 의존 0).
// 코드블록 밖 텍스트에만 검색 query 하이라이트를 적용(코드 안은 평문 보존).
// 펜스 분리 정규식은 main/telegram.ts의 toTelegramHtml과 동일 패턴.
import { Fragment, useState, type CSSProperties, type ReactNode } from 'react'
import { highlight } from '../components/highlight'
import { extractSpeech } from '../../shared/speech'
import { decodeToolLine } from '../../shared/toolline'
import { decodeTodoLine, TODO_STATUS_ICON, todoProgress } from '../../shared/todoline'
import { decodeEditDiffLine, type DiffLine } from '../../shared/editdiff'
import { tokenizeLinks } from './linkify'
import { parseBlocks, tokenizeInline, type Block } from './blocks'
import { tokenizeCode } from './highlightCode'

// 코드펜스 분리 — split 결과의 홀수 인덱스가 펜스 블록(toTelegramHtml과 동일).
const FENCE = /(```[\w-]*\n?[\s\S]*?```)/g
// 펜스 여는 줄의 언어 태그만 추출(코드 본문에서 제거하기 전에 먼저 읽어야 함).
const FENCE_LANG_RE = /^```([\w-]*)/

// A17 — 이 줄 수를 넘는 코드블록은 기본 접힘(펼치기 토글). 짧은 스니펫은 그대로 펼친 채 유지.
export const CODE_FOLD_LINES = 25

/** 코드가 접기 임계를 넘는지 — 줄 수(빈 줄 포함) 기준. 순수 함수(테스트용으로 export). */
export function shouldFoldCode(code: string, maxLines = CODE_FOLD_LINES): boolean {
  return code.split('\n').length > maxLines
}

/** 코드블록 우상단 복사 버튼 — 클릭 시 잠시 '복사됨' 표시. */
function CopyButton({ code }: { code: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={`code-copy${done ? ' code-copy-done' : ''}`}
      onClick={() => {
        window.lain.copyText(code)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? '복사됨' : '복사'}
    </button>
  )
}

// position:relative — 절대배치 .code-copy 버튼의 기준. 가로 스크롤·고정폭은 인라인으로 자급.
const PRE_STYLE: CSSProperties = {
  position: 'relative',
  margin: '4px 0',
  padding: '6px 8px',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  fontFamily: 'var(--font)',
  fontSize: '11px',
  lineHeight: 1.45,
  overflowX: 'auto',
  whiteSpace: 'pre',
}

/** A8 — 구문강조 토큰을 클래스 지정 span으로. plain은 그냥 문자열(불필요한 span 방지). */
function renderCodeTokens(code: string, lang: string, keyBase: string): ReactNode[] {
  return tokenizeCode(code, lang).map((tok, i) => {
    if (tok.type === 'plain') return <Fragment key={`${keyBase}-${i}`}>{tok.value}</Fragment>
    const cls = tok.type === 'keyword' ? 'code-kw' : tok.type === 'string' ? 'code-str' : 'code-cm'
    return (
      <span key={`${keyBase}-${i}`} className={cls}>
        {tok.value}
      </span>
    )
  })
}

/** 코드블록 — pre>code(고정폭·가로 스크롤) + 복사 버튼. diff 라인은 줄 단위 배경.
 * A17 — CODE_FOLD_LINES줄 초과 시 기본 접힘(max-height + 그라디언트 페이드) + '펼치기(전체 M줄)' 토글.
 * A8 — lang이 지원 언어(ts/js/py/json/bash 등)면 키워드/문자열/주석 구문강조. diff 줄은 기존
 * diff-add/diff-del 색을 우선해 구문강조를 얹지 않는다(색 충돌 방지).
 * 복사 버튼은 접힘 여부와 무관하게 항상 code 전문(全文)을 복사(컴포넌트가 이미 code 전체를 갖고 있음). */
function CodeBlock({ code, lang = '' }: { code: string; lang?: string }) {
  const lines = code.split('\n')
  const foldable = lines.length > CODE_FOLD_LINES
  const [expanded, setExpanded] = useState(!foldable)
  // 줄 시작이 +/- 인 코드는 diff로 간주해 줄 단위 배경 부여(+++/--- 메타는 제외).
  const hasDiff = lines.some((l) => /^[+-](?![+-])/.test(l))
  return (
    <pre className={`msg-code${foldable && !expanded ? ' msg-code-folded' : ''}`} style={PRE_STYLE}>
      <CopyButton code={code} />
      <code>
        {hasDiff
          ? lines.map((line, i, arr) => {
              const add = /^\+(?!\+)/.test(line)
              const del = /^-(?!-)/.test(line)
              const text = line + (i < arr.length - 1 ? '\n' : '')
              if (!add && !del) return <Fragment key={i}>{text}</Fragment>
              return (
                <span
                  key={i}
                  className={add ? 'diff-add' : 'diff-del'}
                  style={{
                    display: 'block',
                    background: add ? 'rgba(102, 230, 176, 0.1)' : 'rgba(255, 90, 130, 0.1)',
                  }}
                >
                  {text}
                </span>
              )
            })
          : renderCodeTokens(code, lang, 'ctok')}
      </code>
      {foldable && (
        <button className="code-fold-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '접기' : `펼치기 (전체 ${lines.length}줄)`}
        </button>
      )}
    </pre>
  )
}

/** URL 클릭 — main IPC(shell.openExternal) 경유. http/https만(스킴은 main에서 재검증). */
function UrlLink({ url }: { url: string }) {
  return (
    <a
      className="msg-link"
      href={url}
      title={url}
      onClick={(e) => {
        e.preventDefault()
        window.lain.openExternalUrl(url).then((r) => {
          if (!r.ok) console.warn('[linkify] URL 열기 거부:', url, r.error)
        })
      }}
    >
      {url}
    </a>
  )
}

/** 파일 경로 클릭 — main IPC(shell.showItemInFolder) 경유. 상대경로는 main이 등록 프로젝트 루트로 해석. */
function PathLink({ path, line }: { path: string; line: number | null }) {
  const label = line ? `${path}:${line}` : path
  return (
    <span
      className="msg-link msg-path-link"
      title={label}
      onClick={() => {
        // 해석 실패(존재하지 않는 경로) 시 무동작 — 콘솔에만 이유를 남긴다(브리프: 간단 피드백은 선택).
        window.lain.revealPath(path).then((r) => {
          if (!r.ok) console.warn('[linkify] 경로를 찾지 못함:', path, r.error)
        })
      }}
    >
      {label}
    </span>
  )
}

/** 인라인 코드 밖 텍스트 조각을 URL/경로 토큰으로 나눠 렌더 — 나머지 평문엔 query 하이라이트. */
function renderLinkedText(text: string, query: string, keyBase: string): ReactNode[] {
  return tokenizeLinks(text).map((tok, i) => {
    const key = `${keyBase}-l${i}`
    if (tok.type === 'url') return <UrlLink key={key} url={tok.value} />
    if (tok.type === 'path') return <PathLink key={key} path={tok.value} line={tok.line} />
    return <Fragment key={key}>{query ? highlight(tok.value, query) : tok.value}</Fragment>
  })
}

/**
 * 인라인 코드(`code`) 내용이 경로 하나로 온전히 채워져 있으면 클릭 가능한 경로로,
 * 아니면 기존처럼 평범한 <code>로 렌더. 브리프 요구사항 — 인라인 코드로 감싼 경로가 가장 흔한 케이스.
 */
function renderInlineCode(code: string, key: string): ReactNode {
  const tokens = tokenizeLinks(code)
  if (tokens.length === 1 && tokens[0].type === 'path') {
    const tok = tokens[0]
    const label = tok.line ? `${tok.value}:${tok.line}` : tok.value
    return (
      <code
        className="msg-inline-code msg-path-link"
        key={key}
        title={label}
        onClick={() => {
          window.lain.revealPath(tok.value).then((r) => {
            if (!r.ok) console.warn('[linkify] 경로를 찾지 못함:', tok.value, r.error)
          })
        }}
      >
        {code}
      </code>
    )
  }
  return (
    <code className="msg-inline-code" key={key}>
      {code}
    </code>
  )
}

/** A1 — 굵게/이탤릭 인라인 마크업을 적용한 뒤 그 안쪽 텍스트에 링크화 + query 하이라이트. */
function renderInlineMarkup(text: string, query: string, keyBase: string): ReactNode[] {
  return tokenizeInline(text).map((tok, i) => {
    const key = `${keyBase}-m${i}`
    if (tok.type === 'text') return <Fragment key={key}>{renderLinkedText(tok.value, query, key)}</Fragment>
    const cls = tok.type === 'bold' ? 'msg-bold' : tok.type === 'italic' ? 'msg-italic' : 'msg-bolditalic'
    return (
      <span key={key} className={cls}>
        {renderLinkedText(tok.value, query, key)}
      </span>
    )
  })
}

/** 코드블록 밖 텍스트 — 인라인 백틱(`code`)을 <code>로(경로면 클릭 가능), 나머지는 굵게/이탤릭(A1) +
 * URL/경로 링크화 + query 하이라이트. */
function renderText(text: string, query: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  // 인라인 코드 분리 — split 결과 홀수 인덱스가 백틱 내부(bold/italic 파싱 대상 아님).
  text.split(/(`[^`\n]+`)/g).forEach((seg, i) => {
    if (i % 2 === 1) {
      out.push(renderInlineCode(seg.slice(1, -1), `${keyBase}-c${i}`))
    } else if (seg) {
      out.push(...renderInlineMarkup(seg, query, `${keyBase}-t${i}`))
    }
  })
  return out
}

/** A17 — 도구 라인 원문 전개 토글. display(축약) 옆에 '전개' 버튼을 붙이고 누르면 raw 전문을 그 아래 보여준다. */
function ToolRawToggle({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {' '}
      <button className="tool-raw-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '접기' : '전개'}
      </button>
      {open && <div className="tool-raw-full">{raw}</div>}
    </>
  )
}

/** A4 — 레인 채팅의 TodoWrite 접이식 진행 칩. 기본 접힘(요약 n/m만), 펼치면 항목별 체크리스트. */
function TodoChip({ todos }: { todos: ReturnType<typeof decodeTodoLine> }) {
  const [open, setOpen] = useState(false)
  if (!todos) return null
  const { done, total } = todoProgress(todos)
  return (
    <div className="todo-chip">
      <button className="todo-chip-head" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} 진행 체크리스트 · {done}/{total}
      </button>
      {open && (
        <div className="todo-chip-body">
          {todos.map((t, i) => (
            <div key={i} className={`todo-chip-item todo-chip-${t.status}`}>
              <span className="todo-chip-icon">{TODO_STATUS_ICON[t.status]}</span>
              <span>{t.status === 'in_progress' ? t.activeForm || t.content : t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A6 — diff 라인 하나를 TaskDrawer diff-add/diff-del 스타일로. 문맥(ctx)은 무채색 그대로. */
function DiffLineRow({ line, i }: { line: DiffLine; i: number }) {
  const cls = line.kind === 'add' ? 'diff-add' : line.kind === 'del' ? 'diff-del' : ''
  const mark = line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '
  return (
    <span key={i} className={cls}>
      {mark}
      {line.text}
      {'\n'}
    </span>
  )
}

/** A6 — 레인 직접 Edit/Write 편집의 접이식 diff 카드. 기본 접힘(파일 경로 + 줄 수 요약만),
 * 펼치면 라인 단위 diff(TaskDrawer diff-add/diff-del 색 재사용). 큰 diff는 main에서 이미
 * foldDiffLines로 잘려 truncated=true로 온다 — 카드 하단에 생략 안내를 덧붙인다. */
function EditDiffChip({ payload }: { payload: ReturnType<typeof decodeEditDiffLine> }) {
  const [open, setOpen] = useState(false)
  // D15 되감기 — 카드에 turnId가 실려 있으면(신규 카드만) '이 턴 편집 되돌리기'를 제공한다.
  // 확인은 카드 내부 인라인 2단계(파일 목록 + 경고)로 — markdown 칩은 App의 confirm() 컨텍스트 밖이라 자립형.
  const [confirming, setConfirming] = useState<{ filePath: string; existed: boolean }[] | null>(null)
  const [revertNote, setRevertNote] = useState<string | null>(null)
  if (!payload) return null
  const added = payload.lines.filter((l) => l.kind === 'add').length
  const removed = payload.lines.filter((l) => l.kind === 'del').length
  const turnId = payload.turnId
  return (
    <div className="todo-chip edit-diff-chip">
      <button className="todo-chip-head" onClick={() => setOpen((v) => !v)}>
        {/* 재리뷰 #4 — label이 있으면(un-revert 카드 등) 'tool 경로' 대신 라벨로. +0 -0은 노이즈라 숨김. */}
        {open ? '▾' : '▸'} {payload.label ?? `${payload.tool} ${payload.filePath}`}{' '}
        {added + removed > 0 && (
          <>
            <span className="diff-add">+{added}</span> <span className="diff-del">-{removed}</span>
          </>
        )}
      </button>
      {open && (
        <div className="todo-chip-body">
          <pre className="task-diff-body">
            {payload.lines.map((line, i) => (
              <DiffLineRow key={i} line={line} i={i} />
            ))}
          </pre>
          {payload.truncated && <div className="dim">… 이하 생략(큰 diff)</div>}
          {turnId && !revertNote && !confirming && (
            <button
              className="edit-revert-btn"
              title="이 편집이 속한 턴의 모든 편집을 편집 전 상태로 복원"
              onClick={() => {
                void window.lain.editTurnCheckpoints(turnId).then((files) => {
                  if (files.length === 0) setRevertNote('체크포인트가 없다(보존 기간 만료·정리됐을 수 있음)')
                  else setConfirming(files)
                })
              }}
            >
              ↶ 이 턴 편집 되돌리기
            </button>
          )}
          {turnId && confirming && (
            <div className="edit-revert-confirm">
              <div>이 턴의 편집 {confirming.length}개 파일을 편집 전 상태로 되돌린다:</div>
              <ul>
                {confirming.map((f) => (
                  <li key={f.filePath}>
                    {f.filePath}
                    {f.existed ? '' : ' (새로 만든 파일 → 삭제됨)'}
                  </li>
                ))}
              </ul>
              <div className="dim">
                ⚠ 이 턴 이후 해당 파일에 생긴 변경도 함께 사라진다. 복원 직전 상태도 체크포인트로 남아
                다시 되돌릴 수 있다.
              </div>
              <div className="edit-revert-actions">
                <button
                  className="edit-revert-btn danger"
                  onClick={() => {
                    void window.lain.revertEditTurn(turnId).then((r) => {
                      setConfirming(null)
                      setRevertNote(
                        r.ok
                          ? `복원됨 — ${r.restored}개 파일${r.error ? ` (일부 실패: ${r.error})` : ''}`
                          : `복원 실패: ${r.error ?? '알 수 없는 오류'}`,
                      )
                    })
                  }}
                >
                  되돌리기 실행
                </button>
                <button className="edit-revert-btn" onClick={() => setConfirming(null)}>
                  취소
                </button>
              </div>
            </div>
          )}
          {revertNote && <div className="dim">{revertNote}</div>}
        </div>
      )}
    </div>
  )
}

/** A1 — 파싱된 블록 하나를 렌더. 블록 내부 텍스트는 renderText로 굵게/이탤릭+링크+검색하이라이트 적용. */
function renderBlock(block: Block, query: string, key: string): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <Tag className="msg-heading" key={key}>
          {renderText(block.text, query, key)}
        </Tag>
      )
    }
    case 'hr':
      return <hr className="msg-hr" key={key} />
    case 'quote':
      return (
        <div className="msg-quote" key={key}>
          {renderText(block.text, query, key)}
        </div>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag className="msg-list" key={key}>
          {block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{renderText(item, query, `${key}-${i}`)}</li>
          ))}
        </Tag>
      )
    }
    case 'table':
      return (
        <div className="msg-table-wrap" key={key}>
          <table className="msg-table">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={`${key}-h${i}`}>{renderText(cell, query, `${key}-h${i}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={`${key}-r${ri}`}>
                  {row.map((cell, ci) => (
                    <td key={`${key}-r${ri}-${ci}`}>{renderText(cell, query, `${key}-r${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'paragraph':
      return <Fragment key={key}>{renderText(block.text, query, key)}</Fragment>
    case 'blank':
      return <Fragment key={key}>{'\n'}</Fragment>
  }
}

/** 메시지 본문 렌더 — 코드펜스·인라인 코드·diff를 처리하고 텍스트엔 query 강조.
 * A1 — 코드펜스 밖 파트는 줄 단위 블록 파서(parseBlocks)로 헤딩/리스트/인용/수평선/표를 인식한다. */
export function MessageBody({ content, query = '' }: { content: string; query?: string }): ReactNode {
  // 음성 요약 태그(<<say: ...>>)는 화면에 안 보이게 떼낸다(음성 전용). 본문은 그대로 표시.
  content = extractSpeech(content).clean
  // A4 — TodoWrite 진행 체크리스트: manager.ts가 encodeTodoLine으로 인코딩해 저장한 tool 라인이면
  // 통상 파이프라인(코드펜스·블록파서) 대신 접이식 진행 칩으로 렌더한다.
  const todos = decodeTodoLine(content)
  if (todos) return <TodoChip todos={todos} />
  // A6 — 레인 Edit/Write diff: manager.ts가 encodeEditDiffLine으로 인코딩해 저장한 tool 라인이면
  // 접이식 diff 카드로 렌더한다(todo와 동일 우선순위 — encodeToolLine과 태그 형식이 달라 안 겹침).
  const editDiff = decodeEditDiffLine(content)
  if (editDiff) return <EditDiffChip payload={editDiff} />
  // A17 — 도구 라인 원문 보존: content가 '축약원문' 형태로 인코딩돼 있으면(manager.ts·navichat.ts
  // encodeToolLine) 축약만 통상 파이프라인(코드펜스·링크화)에 태우고, 원문은 전개 토글로 뒤에 붙인다.
  const { display, raw } = decodeToolLine(content)
  const body = display.split(FENCE).map((part, idx) => {
    if (idx % 2 === 1) {
      // 펜스 블록 — 언어 태그를 구문강조용으로 읽어두고, 여는/닫는 백틱 제거 후 코드만 남긴다.
      const lang = FENCE_LANG_RE.exec(part)?.[1] ?? ''
      const code = part
        .replace(/^```[\w-]*\n?/, '')
        .replace(/```\s*$/, '')
        .replace(/\n+$/, '')
      return <CodeBlock key={idx} code={code} lang={lang} />
    }
    // 코드펜스 밖 — 블록 파서(A1)로 헤딩/리스트/인용/수평선/표를 인식. 그 외는 문단(paragraph)으로
    // renderText가 처리(굵게/이탤릭·인라인코드·링크·검색 하이라이트).
    return (
      <Fragment key={idx}>
        {parseBlocks(part).map((block, bi) => renderBlock(block, query, `${idx}-${bi}`))}
      </Fragment>
    )
  })
  return raw ? (
    <>
      {body}
      <ToolRawToggle raw={raw} />
    </>
  ) : (
    body
  )
}
