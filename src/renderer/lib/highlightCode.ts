// 렌더러 순수 헬퍼 — 코드블록 언어 태그(ts/js/py/json/bash 등)에 맞춰 키워드·문자열·주석 3분류로
// 토큰화한다. highlight.js 등 외부 의존 없이 정규식 기반 경량 토크나이저(외부 의존 0 원칙).
// import 부작용 0이라 단위테스트가 쉽다. markdown.tsx CodeBlock이 소비.

export type CodeToken =
  | { type: 'plain'; value: string }
  | { type: 'keyword'; value: string }
  | { type: 'string'; value: string }
  | { type: 'comment'; value: string }

type LangKind = 'ts' | 'py' | 'bash' | 'json' | 'none'

const TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'default', 'break', 'continue', 'class', 'extends', 'implements', 'interface', 'type', 'enum',
  'import', 'export', 'from', 'as', 'new', 'this', 'super', 'try', 'catch', 'finally', 'throw',
  'async', 'await', 'yield', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'null',
  'undefined', 'true', 'false', 'public', 'private', 'protected', 'readonly', 'static', 'abstract',
  'namespace', 'declare', 'module', 'get', 'set', 'constructor', 'extends', 'keyof', 'infer',
])

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'pass',
  'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'global',
  'nonlocal', 'assert', 'del', 'in', 'is', 'not', 'and', 'or', 'True', 'False', 'None', 'self',
  'async', 'await', 'match', 'case',
])

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac',
  'function', 'return', 'exit', 'export', 'local', 'readonly', 'set', 'unset', 'echo', 'source',
])

const JSON_KEYWORDS = new Set(['true', 'false', 'null'])

const LANG_MAP: Record<string, LangKind> = {
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', javascript: 'ts', typescript: 'ts', mjs: 'ts', cjs: 'ts',
  py: 'py', python: 'py',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', powershell: 'bash', ps1: 'bash',
  json: 'json', jsonc: 'json',
}

/** 펜스 언어 태그(예: 'ts', 'python', '') → 지원 카테고리. 미지원/빈 태그는 'none'(구문강조 생략). */
export function resolveLangKind(lang: string): LangKind {
  return LANG_MAP[lang.trim().toLowerCase()] ?? 'none'
}

function keywordSetFor(kind: LangKind): Set<string> | null {
  if (kind === 'ts') return TS_KEYWORDS
  if (kind === 'py') return PY_KEYWORDS
  if (kind === 'bash') return BASH_KEYWORDS
  if (kind === 'json') return JSON_KEYWORDS
  return null
}

// 한 줄 주석 마커 — bash/py는 #, ts는 //. json은 표준상 주석 없음.
function lineCommentRe(kind: LangKind): RegExp | null {
  if (kind === 'ts') return /\/\/.*$/
  if (kind === 'py' || kind === 'bash') return /#.*$/
  return null
}

// 문자열 리터럴 — '...' "..." `...`(템플릿 포함, 백틱 안 개행 허용은 생략해 단순화).
const STRING_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g
// TS만 블록 주석(/* */) 지원.
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g

/**
 * 코드 문자열 하나(pre>code 안 전체 텍스트, 여러 줄 가능)를 언어 카테고리에 맞춰
 * plain/keyword/string/comment 토큰 배열로 나눈다. lang이 'none'이면 plain 토큰 하나만 반환.
 */
export function tokenizeCode(code: string, lang: string): CodeToken[] {
  const kind = resolveLangKind(lang)
  if (kind === 'none') return code ? [{ type: 'plain', value: code }] : []

  // 1단계: 문자열·주석 구간을 먼저 찾아 "보호 구간"으로 표시(키워드 매칭이 문자열 내부를 침범하지 않도록).
  type Span = { start: number; end: number; type: 'string' | 'comment' }
  const spans: Span[] = []

  const blockCommentRanges: Array<{ start: number; end: number }> = []
  if (kind === 'ts') {
    BLOCK_COMMENT_RE.lastIndex = 0
    let bm: RegExpExecArray | null
    while ((bm = BLOCK_COMMENT_RE.exec(code)) !== null) {
      blockCommentRanges.push({ start: bm.index, end: bm.index + bm[0].length })
      spans.push({ start: bm.index, end: bm.index + bm[0].length, type: 'comment' })
      if (bm[0].length === 0) BLOCK_COMMENT_RE.lastIndex++
    }
  }
  const insideBlockComment = (idx: number) => blockCommentRanges.some((r) => idx >= r.start && idx < r.end)

  STRING_RE.lastIndex = 0
  let sm: RegExpExecArray | null
  while ((sm = STRING_RE.exec(code)) !== null) {
    if (!insideBlockComment(sm.index)) {
      spans.push({ start: sm.index, end: sm.index + sm[0].length, type: 'string' })
    }
    if (sm[0].length === 0) STRING_RE.lastIndex++
  }

  const lineRe = lineCommentRe(kind)
  if (lineRe) {
    // 줄 단위로 검사해 문자열 안의 '//', '#' 등을 주석으로 오인하지 않도록 스팬과 교차 체크.
    let offset = 0
    for (const lineText of code.split('\n')) {
      const re = new RegExp(lineRe.source)
      const m = re.exec(lineText)
      if (m) {
        const start = offset + m.index
        const end = offset + lineText.length
        const overlapsString = spans.some(
          (s) => s.type === 'string' && s.start < end && s.end > start && s.start <= start,
        )
        // 주석 시작 지점 자체가 기존 문자열 스팬 내부에 있으면(예: "http://") 스킵.
        const startInsideString = spans.some((s) => s.type === 'string' && start >= s.start && start < s.end)
        if (!startInsideString) {
          spans.push({ start, end, type: 'comment' })
        }
        void overlapsString
      }
      offset += lineText.length + 1 // '\n' 만큼
    }
  }

  spans.sort((a, b) => a.start - b.start)
  // 겹치는 스팬 제거(먼저 발견된 것 우선 — string이 comment보다 앞서 push 됐으면 string 유지).
  const merged: Span[] = []
  for (const s of spans) {
    const prev = merged[merged.length - 1]
    if (prev && s.start < prev.end) continue
    merged.push(s)
  }

  // 2단계: 보호 구간 밖 텍스트에서 키워드 매칭 + 나머지는 plain.
  const keywords = keywordSetFor(kind)
  const tokens: CodeToken[] = []
  let cursor = 0

  const pushPlainWithKeywords = (segment: string) => {
    if (!segment) return
    if (!keywords) {
      tokens.push({ type: 'plain', value: segment })
      return
    }
    const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/g
    let last = 0
    let wm: RegExpExecArray | null
    while ((wm = WORD_RE.exec(segment)) !== null) {
      if (wm.index > last) tokens.push({ type: 'plain', value: segment.slice(last, wm.index) })
      if (keywords.has(wm[0])) tokens.push({ type: 'keyword', value: wm[0] })
      else tokens.push({ type: 'plain', value: wm[0] })
      last = wm.index + wm[0].length
    }
    if (last < segment.length) tokens.push({ type: 'plain', value: segment.slice(last) })
  }

  for (const span of merged) {
    if (span.start > cursor) pushPlainWithKeywords(code.slice(cursor, span.start))
    tokens.push({ type: span.type, value: code.slice(span.start, span.end) })
    cursor = span.end
  }
  if (cursor < code.length) pushPlainWithKeywords(code.slice(cursor))

  return tokens
}
