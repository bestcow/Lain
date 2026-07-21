// 렌더러 순수 헬퍼 — 채팅 텍스트 속 URL·파일 경로를 감지해 클릭 가능한 토큰으로 분리한다.
// import 부작용 0(window.lain·React 미사용)이라 단위테스트가 쉽다. markdown.tsx renderText가 소비.

export type LinkToken =
  | { type: 'text'; value: string }
  | { type: 'url'; value: string } // http(s):// 로 시작하는 URL 원문
  | { type: 'path'; value: string; line: number | null } // 파일 경로(선택적 :줄번호 분리됨)

// URL — http/https만(스킴 화이트리스트는 main IPC에서도 재검증). 공백·한글·전각 문장부호에서 끊는다.
// eslint 계열 no-control-regex는 프로젝트 미사용 — 경계 문자 집합만 배제하는 단순 매칭.
const URL_RE = /https?:\/\/[^\s<>"'`ㄱ-힝]+/g

// 파일 경로 — 절대경로(C:\..., C:/..., \\서버\..., POSIX /...) 또는 상대경로(중간에 최소 1개
// 슬래시 포함). 끝에 옵션으로 :줄번호(:123 또는 :123:45)까지 한 번에 매치해 경로 본문과 함께 뗀다.
// 한글 문장 속에서도 경로 부분만 뽑도록 공백·한글·구두점에서 끊는다.
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])[A-Za-z0-9_.\-\\/]*[A-Za-z0-9_\-\\/](?::\d+(?::\d+)?)?/g

// 경로 뒤에 붙은 :줄번호(:123 또는 :123:45) 분리 — PATH_RE가 이미 통째로 캡처한 결과에서 재추출.
const LINE_SUFFIX_RE = /:(\d+)(?::\d+)?$/

// 꼬리에 붙기 쉬운 구두점/괄호(문장부호) — 매치 끝에서 반복 제거.
const TRAILING_PUNCT_RE = /[).,!?;:'"，。」』】]+$/

// 경로로 오인되기 쉬운 흔한 오탐(확장자 없는 단순 비율/시간 표기 등)을 걸러내는 최소 확장자 화이트리스트는
// 두지 않는다 — 대신 슬래시/백슬래시가 최소 1개 있어야 매치되므로 "3/4" 같은 짧은 분수는 자연히 배제 안 됨.
// 그런 케이스는 드물고(설계 범위 밖) 오탐보다 미검출이 안전하므로 YAGNI.

/** 매치 문자열 끝의 흔한 문장부호 꼬리를 제거하고, 제거분을 뒤 텍스트로 돌려준다. */
function trimTrailingPunct(s: string): { core: string; tail: string } {
  const m = TRAILING_PUNCT_RE.exec(s)
  if (!m) return { core: s, tail: '' }
  return { core: s.slice(0, m.index), tail: m[0] }
}

/**
 * 경로 후보 문자열이 실제 "경로처럼" 보이는지 최소 검증.
 * - 슬래시/백슬래시를 최소 1개 포함해야 한다(단일 파일명 "readme.md"는 대상 아님 — 브리프 범위=경로).
 * - 슬래시 하나 없이 드라이브 문자만 있는 경우("C:")는 제외(위 정규식이 이미 ':\' 를 요구해 커버).
 */
function looksLikePath(s: string): boolean {
  return /[\\/]/.test(s)
}

/**
 * 텍스트 한 조각(코드블록/인라인코드 밖 또는 안 — 호출부가 결정)을 URL·경로·평문 토큰으로 분리한다.
 * URL이 경로보다 우선(둘 다 슬래시를 포함하므로 URL 매치 구간은 먼저 떼어내고 나머지에서 경로를 찾는다).
 */
export function tokenizeLinks(text: string): LinkToken[] {
  const out: LinkToken[] = []
  let cursor = 0
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  const urlRanges: Array<{ start: number; end: number }> = []
  while ((m = URL_RE.exec(text)) !== null) {
    urlRanges.push({ start: m.index, end: m.index + m[0].length })
    if (m[0].length === 0) URL_RE.lastIndex++
  }

  // URL 구간을 기준으로 텍스트를 [비URL, URL, 비URL, URL, ...] 순서로 순회하며
  // 비URL 구간에서 경로를 추가로 찾는다.
  const pushTextAndPaths = (segment: string) => {
    let last = 0
    PATH_RE.lastIndex = 0
    let pm: RegExpExecArray | null
    while ((pm = PATH_RE.exec(segment)) !== null) {
      const raw = pm[0]
      if (pm[0].length === 0) {
        PATH_RE.lastIndex++
        continue
      }
      if (!looksLikePath(raw)) continue
      // :줄번호 접미사는 PATH_RE가 이미 통째로 캡처했으므로 구두점 트리밍보다 먼저 떼어낸다
      // (콜론이 TRAILING_PUNCT_RE 대상이라 순서를 바꾸면 ":120"이 통째로 날아간다).
      const lineMatch = LINE_SUFFIX_RE.exec(raw)
      const withoutLine = lineMatch ? raw.slice(0, lineMatch.index) : raw
      const { core: pathOnly, tail } = trimTrailingPunct(withoutLine)
      if (!pathOnly) continue
      // pathOnly 자체가 실질 세그먼트(영숫자/./-) 없이 구분자만 있으면 스킵.
      if (!/[A-Za-z0-9_.-]/.test(pathOnly)) continue
      if (pm.index > last) out.push({ type: 'text', value: segment.slice(last, pm.index) })
      out.push({ type: 'path', value: pathOnly, line: lineMatch ? Number(lineMatch[1]) : null })
      if (tail) out.push({ type: 'text', value: tail })
      last = pm.index + raw.length
    }
    if (last < segment.length) out.push({ type: 'text', value: segment.slice(last) })
  }

  for (const range of urlRanges) {
    if (range.start > cursor) pushTextAndPaths(text.slice(cursor, range.start))
    const raw = text.slice(range.start, range.end)
    const { core, tail } = trimTrailingPunct(raw)
    if (core) out.push({ type: 'url', value: core })
    if (tail) out.push({ type: 'text', value: tail })
    cursor = range.end
  }
  if (cursor < text.length) pushTextAndPaths(text.slice(cursor))

  return out
}
