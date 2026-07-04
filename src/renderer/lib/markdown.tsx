// 대화 본문 마크다운 경량 렌더 — 코드펜스(```)·인라인 백틱·diff 라인만 처리한다(외부 의존 0).
// 코드블록 밖 텍스트에만 검색 query 하이라이트를 적용(코드 안은 평문 보존).
// 펜스 분리 정규식은 main/telegram.ts의 toTelegramHtml과 동일 패턴.
import { Fragment, useState, type CSSProperties, type ReactNode } from 'react'
import { highlight } from '../components/highlight'
import { extractSpeech } from '../../shared/speech'

// 코드펜스 분리 — split 결과의 홀수 인덱스가 펜스 블록(toTelegramHtml과 동일).
const FENCE = /(```[\w-]*\n?[\s\S]*?```)/g

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

/** 코드블록 — pre>code(고정폭·가로 스크롤) + 복사 버튼. diff 라인은 줄 단위 배경. */
function CodeBlock({ code }: { code: string }) {
  // 줄 시작이 +/- 인 코드는 diff로 간주해 줄 단위 배경 부여(+++/--- 메타는 제외).
  const hasDiff = code.split('\n').some((l) => /^[+-](?![+-])/.test(l))
  return (
    <pre className="msg-code" style={PRE_STYLE}>
      <CopyButton code={code} />
      <code>
        {hasDiff
          ? code.split('\n').map((line, i, arr) => {
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
          : code}
      </code>
    </pre>
  )
}

/** 코드블록 밖 텍스트 — 인라인 백틱(`code`)을 <code>로, 나머지는 query 하이라이트. */
function renderText(text: string, query: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  // 인라인 코드 분리 — split 결과 홀수 인덱스가 백틱 내부.
  text.split(/(`[^`\n]+`)/g).forEach((seg, i) => {
    if (i % 2 === 1) {
      out.push(
        <code className="msg-inline-code" key={`${keyBase}-c${i}`}>
          {seg.slice(1, -1)}
        </code>,
      )
    } else if (seg) {
      out.push(<Fragment key={`${keyBase}-t${i}`}>{query ? highlight(seg, query) : seg}</Fragment>)
    }
  })
  return out
}

/** 메시지 본문 렌더 — 코드펜스·인라인 코드·diff를 처리하고 텍스트엔 query 강조. */
export function MessageBody({ content, query = '' }: { content: string; query?: string }): ReactNode {
  // 음성 요약 태그(<<say: ...>>)는 화면에 안 보이게 떼낸다(음성 전용). 본문은 그대로 표시.
  content = extractSpeech(content).clean
  return content.split(FENCE).map((part, idx) => {
    if (idx % 2 === 1) {
      // 펜스 블록 — 언어 태그·여는/닫는 백틱 제거 후 코드만.
      const code = part
        .replace(/^```[\w-]*\n?/, '')
        .replace(/```\s*$/, '')
        .replace(/\n+$/, '')
      return <CodeBlock key={idx} code={code} />
    }
    return <Fragment key={idx}>{renderText(part, query, String(idx))}</Fragment>
  })
}
