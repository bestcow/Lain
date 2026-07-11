// 대화 내 검색 하이라이트 — content를 대소문자 무시로 분할해 매치 부분만 <mark>로 감싼다.
// pre-wrap 보존을 위해 텍스트 노드 + <mark> 혼합 반환. 정규식 특수문자는 escape.
import { Fragment, type ReactNode } from 'react'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function highlight(content: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return content
  const re = new RegExp(escapeRe(q), 'ig')
  const parts: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) parts.push(<Fragment key={i++}>{content.slice(last, m.index)}</Fragment>)
    parts.push(
      <mark className="chat-hl" key={i++}>
        {m[0]}
      </mark>,
    )
    last = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++ // 빈 매치 방어
  }
  if (last < content.length) parts.push(<Fragment key={i++}>{content.slice(last)}</Fragment>)
  return parts
}
