// 렌더러 순수 헬퍼 — 채팅 텍스트(코드펜스 밖)를 줄 단위로 스캔해 마크다운 블록으로 분리한다.
// import 부작용 0(React 미사용)이라 단위테스트가 쉽다. markdown.tsx MessageBody가 소비.
// 코드펜스 안 텍스트는 이 파서에 들어오지 않는다 — 호출부(markdown.tsx)가 FENCE로 먼저 분리해둔다.

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'hr' }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'paragraph'; text: string }
  | { type: 'blank' } // 빈 줄 — 렌더 시 개행 하나로 보존(기존 pre-wrap 문단 간격과 동일하게 유지).

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE_RE = /^>\s?(.*)$/
const UL_RE = /^[-*+]\s+(.*)$/
const OL_RE = /^\d+[.)]\s+(.*)$/
// 표 구분줄 — |---|:---:|---| 형태(콜론 정렬 표시 허용). 파이프를 반드시 포함해야 표로 인정한다
// (GFM 표준). 그래야 'A | B' 다음 줄의 '------'(수평선/강조선)이 표로 오인되지 않는다.
const TABLE_SEP_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/
function isTableSeparator(line: string): boolean {
  return line.includes('|') && TABLE_SEP_RE.test(line)
}

/** 파이프(|)로 나뉜 표 한 줄을 셀 배열로 — 양끝 파이프는 버리고 각 셀은 trim. */
function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** 표 헤더로 쓰일 수 있는 줄인지 — 파이프를 최소 1개 포함. */
function looksLikeTableRow(line: string): boolean {
  return line.includes('|')
}

/**
 * 텍스트(코드펜스 밖 한 조각)를 블록 배열로 파싱한다.
 * 인접한 리스트 항목/표 행은 하나의 블록으로 묶고, 그 외 줄은 문단으로 병합(연속 평문 줄은 하나의 paragraph).
 */
export function parseBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0
  let paraBuf: string[] = []

  const flushPara = () => {
    if (paraBuf.length > 0) {
      blocks.push({ type: 'paragraph', text: paraBuf.join('\n') })
      paraBuf = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    if (HR_RE.test(line)) {
      flushPara()
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushPara()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }

    const quote = QUOTE_RE.exec(line)
    if (quote) {
      flushPara()
      const qLines: string[] = [quote[1]]
      i++
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i])
        if (!m) break
        qLines.push(m[1])
        i++
      }
      blocks.push({ type: 'quote', text: qLines.join('\n') })
      continue
    }

    const ul = UL_RE.exec(line)
    const ol = OL_RE.exec(line)
    if (ul || ol) {
      flushPara()
      const ordered = !!ol
      const items: string[] = [(ul ?? ol)![1]]
      i++
      while (i < lines.length) {
        const m = ordered ? OL_RE.exec(lines[i]) : UL_RE.exec(lines[i])
        if (!m) break
        items.push(m[1])
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // 표 — 헤더 줄 다음이 구분줄(|---|---|)이어야 표로 인정(오탐 방지: 그냥 '|'가 든 문장 배제).
    if (looksLikeTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      flushPara()
      const header = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && looksLikeTableRow(lines[i]) && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    if (line.trim() === '') {
      flushPara()
      blocks.push({ type: 'blank' })
      i++
      continue
    }

    paraBuf.push(line)
    i++
  }
  flushPara()
  return blocks
}

// ── 인라인(문단 내부) 파싱 — 굵게/이탤릭 ──

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'bolditalic'; value: string }

// ***볼드+이탤릭*** > **볼드** > *이탤릭* 순으로 먼저 매치(긴 마커 우선). _underscore_ 계열도 동일 취급.
const INLINE_RE = /(\*\*\*|___)(.+?)\1|(\*\*|__)(.+?)\3|(\*|_)(.+?)\5/g

/** 문단 텍스트 한 줄(또는 여러 줄)을 굵게/이탤릭 토큰으로 분리 — 코드펜스는 호출 전 이미 제거됨. */
export function tokenizeInline(text: string): InlineToken[] {
  const out: InlineToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ type: 'bolditalic', value: m[2] })
    else if (m[3] !== undefined) out.push({ type: 'bold', value: m[4] })
    else out.push({ type: 'italic', value: m[6] })
    last = m.index + m[0].length
    if (m[0].length === 0) INLINE_RE.lastIndex++
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}
