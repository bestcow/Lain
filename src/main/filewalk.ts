// @파일 자동완성(A12) — 프로젝트 파일 목록 수집. 순수 함수(파싱·매칭)는 fs 미의존이라 vitest로 검증하고,
// walkProjectFiles만 실제 fs.readdirSync로 디렉터리를 순회한다.
// 성능: 대형 레포 대비 상한(MAX_FILES)과 항상 배제할 디렉터리(node_modules·.git 등)로 조기 가지치기한다.
import fs from 'node:fs'
import path from 'node:path'

// glob 자체를 매 키 입력마다 돌리지 않기 위해(브리프 요구) @ 진입 시 1회만 부르는 프런트 IPC용 상한.
export const MAX_FILES = 5000
// 이 이름의 디렉터리는 .gitignore 유무와 무관하게 항상 배제 — 대형 레포 조기 가지치기.
const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.next', '.turbo'])

export interface GitignoreRule {
  // 원본 패턴 매치 함수(아래 wildcardMatchDP 기반 — 정규식 백트래킹 없음). dirOnly면 디렉터리에만
  // 매치, negate면 !(재포함) 규칙.
  match: (relPath: string) => boolean
  dirOnly: boolean
  negate: boolean
  anchored: boolean // '/'로 시작 — 루트(.gitignore가 있는 디렉터리) 기준 전체 경로만 매치
}

// 클론 관점 감사(#4) — 예전엔 glob을 정규식 소스로 변환해 `[^/]*`(단일 '*')·`.*`('**')를 이어붙이고
// RegExp.test로 매치했다. `*a*a*a*...*!` 같은 패턴을 담은 .gitignore(리포에 커밋된 파일이라 공급망
// 공격면)에서 파일명이 그 패턴에 결국 매치 실패하면, 인접한 `[^/]*` 구간들이 같은 문자를 나눠 가지는
// 조합을 지수적으로 재시도(백트래킹 폭발)해 @파일 자동완성이 통째로 멈췄다(실측: 40자 내외 입력에서도
// 수 초~수십 초 행). 아래는 토큰화 + DP(동적계획법)로 매치를 O(패턴길이 × 경로길이)에 상한 고정한다 —
// 백트래킹 자체가 없어 입력이 아무리 적대적이어도(별표 개수·문자열 길이 무관) 지수 폭발이 구조적으로
// 불가능하다(퍼즈 30만 케이스로 기존 정규식 구현과 동일 결과 확인, dp_perf 스트레스로 10만자 입력도 <100ms).
type GlobToken = { t: 'lit'; c: string } | { t: 'any1' } | { t: 'star' } | { t: 'globstar' }

/** glob 패턴을 토큰으로 분해. '*'는 세그먼트 내(비-'/'), '**'는 '/'까지 포함해 매치하는 토큰. */
function tokenizeGlob(glob: string): GlobToken[] {
  const toks: GlobToken[] = []
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        toks.push({ t: 'globstar' })
        i++
      } else {
        toks.push({ t: 'star' })
      }
    } else if (c === '?') {
      toks.push({ t: 'any1' })
    } else {
      toks.push({ t: 'lit', c }) // 정규식이 아니므로 이스케이프 불필요 — 모든 문자를 그대로 리터럴 비교
    }
  }
  return toks
}

/** 토큰 배열이 text 전체와 매치되는지 DP로 판정(백트래킹 없음, O(토큰수 × text길이), 행 하나만 유지). */
function wildcardMatchDP(toks: GlobToken[], text: string): boolean {
  const n = text.length
  let dp = new Array<boolean>(n + 1).fill(false)
  dp[0] = true
  for (const tok of toks) {
    const next = new Array<boolean>(n + 1).fill(false)
    if (tok.t === 'star' || tok.t === 'globstar') {
      next[0] = dp[0] // 별표는 빈 매치 허용
      for (let j = 1; j <= n; j++) {
        const canCross = tok.t === 'globstar' || text[j - 1] !== '/' // 일반 '*'는 '/'를 못 건넌다
        next[j] = dp[j] || (canCross && next[j - 1])
      }
    } else {
      for (let j = 1; j <= n; j++) {
        const ok = tok.t === 'lit' ? tok.c === text[j - 1] : text[j - 1] !== '/'
        next[j] = ok && dp[j - 1]
      }
    }
    dp = next
  }
  return dp[n]
}

/** anchored=false는 git의 '(경로 시작 | 임의 세그먼트 경계)에서 시작해 끝까지' 의미 — 각 '/' 경계 이후
 *  접미사에 대해서도 시도한다(경로 깊이만큼 반복이라 O(깊이)배, 여전히 다항식·상한 고정). */
function buildMatcher(pattern: string, anchored: boolean): (relPath: string) => boolean {
  const toks = tokenizeGlob(pattern)
  if (anchored) return (relPath: string) => wildcardMatchDP(toks, relPath)
  return (relPath: string) => {
    if (wildcardMatchDP(toks, relPath)) return true
    for (let i = 0; i < relPath.length; i++) {
      if (relPath[i] === '/' && wildcardMatchDP(toks, relPath.slice(i + 1))) return true
    }
    return false
  }
}

/** .gitignore 텍스트 → 규칙 목록. 주석(#)·빈 줄 무시, '!'는 재포함, 끝 '/'는 dirOnly, 시작 '/'는 루트 앵커. */
export function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    let anchored = false
    if (line.startsWith('/')) {
      anchored = true
      line = line.slice(1)
    }
    if (!line) continue
    // 앵커 없으면 경로 어디서든(세그먼트 시작 기준) 매치 — git 기본 동작 근사.
    rules.push({ match: buildMatcher(line, anchored), dirOnly, negate, anchored })
  }
  return rules
}

/**
 * relPath(항상 '/' 구분, 루트 기준 상대경로)가 규칙에 의해 무시되는지.
 * 나중 규칙이 먼저 규칙을 덮는다(git 동작 — 파일 뒤쪽 negate가 재포함).
 */
export function isIgnored(relPath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
  let ignored = false
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    if (r.match(relPath)) ignored = !r.negate
  }
  return ignored
}

/** 루트 디렉터리를 재귀 순회해 상대경로('/' 구분) 목록을 만든다. .gitignore는 만나는 하위 디렉터리마다 누적 적용. */
export function walkProjectFiles(rootDir: string, maxFiles: number = MAX_FILES): string[] {
  const results: string[] = []

  function walk(dir: string, relDir: string, inheritedRules: GitignoreRule[]): void {
    if (results.length >= maxFiles) return
    let rules = inheritedRules
    const gitignorePath = path.join(dir, '.gitignore')
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8')
      rules = [...inheritedRules, ...parseGitignore(content)]
    } catch {
      // .gitignore 없음 — 상속 규칙만 사용
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 권한 오류 등 — 조용히 스킵
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return
      // 심볼릭 링크/정션은 명시적으로 스킵 — 프로젝트 밖(예: 시스템 경로)을 가리키는 링크를 따라가면
      // @파일 목록에 스코프 밖 파일이 노출될 수 있다(경로 탈출 방어). Dirent는 링크를 lstat 기반으로 보고한다.
      if (entry.isSymbolicLink()) continue
      const name = entry.name
      const isDir = entry.isDirectory()
      if (isDir && ALWAYS_SKIP_DIRS.has(name)) continue
      const rel = relDir ? `${relDir}/${name}` : name
      if (isIgnored(rel, isDir, rules)) continue
      if (isDir) {
        walk(path.join(dir, name), rel, rules)
      } else if (entry.isFile()) {
        results.push(rel)
      }
    }
  }

  walk(rootDir, '', [])
  return results
}
