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
  // 원본 패턴을 정규식으로 변환. dirOnly면 디렉터리에만 매치, negate면 !(재포함) 규칙.
  regex: RegExp
  dirOnly: boolean
  negate: boolean
  anchored: boolean // '/'로 시작 — 루트(.gitignore가 있는 디렉터리) 기준 전체 경로만 매치
}

/** glob 세그먼트(* ? [...])를 정규식 소스로. '/'는 세그먼트 경계라 별도 처리(패턴 자체엔 '**'만 넘어옴). */
function globToRegexSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return out
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
    const src = globToRegexSource(line)
    // 앵커 없으면 경로 어디서든(세그먼트 시작 기준) 매치 — git 기본 동작 근사.
    const pattern = anchored ? `^${src}$` : `(^|/)${src}$`
    rules.push({ regex: new RegExp(pattern), dirOnly, negate, anchored })
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
    if (r.regex.test(relPath)) ignored = !r.negate
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
