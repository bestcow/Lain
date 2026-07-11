// 프로젝트 컨벤션 주입 — 사용자가 워크스페이스/프로젝트에 정리해 둔 컨벤션 md(CLAUDE.md·CONVENTIONS.md·
// AGENTS.md·OVERVIEW.md)를 읽어 Navi/매니저 프롬프트에 1회 주입한다. settingSources를 켜지 않고(정체성
// 오염·사용자 설정 누수 회피) 필요한 컨벤션만 직접 읽어 다듬는다. 부작용 없는 best-effort(없으면 빈 문자열).
// Navi 작업 세션은 worktree(DATA_DIR/wt) 안에서 돌아 상위가 워크스페이스가 아니므로, 반드시 '원본 프로젝트
// 경로'로 호출해 상위(워크스페이스) 컨벤션까지 닿게 한다.
import fs from 'node:fs'
import path from 'node:path'

const CONV_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONVENTIONS.md', 'OVERVIEW.md']
const PER_FILE_CAP = 4000 // 파일당 글자 상한
const TOTAL_CAP = 12000 // 전체 상한 — 프롬프트 비대화 방지
const MAX_DEPTH = 6 // 프로젝트 루트 + 상위 5단계까지(워크스페이스 루트 컨벤션 포함)

/** 프로젝트 경로 + 상위 디렉터리들에서 컨벤션 md를 모은다(가까운=프로젝트 것 먼저, 상한 적용). 없으면 ''. */
export function loadConventions(projectPath: string): string {
  if (!projectPath) return ''
  const found: { label: string; text: string }[] = []
  let dir = path.resolve(projectPath)
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    for (const name of CONV_FILES) {
      const f = path.join(dir, name)
      try {
        const raw = fs.readFileSync(f, 'utf8').trim()
        if (raw) found.push({ label: f, text: raw.slice(0, PER_FILE_CAP) })
      } catch {
        /* 없음/읽기 실패 무시 */
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break // 드라이브 루트 도달
    dir = parent
  }
  if (!found.length) return ''
  let out = ''
  for (const { label, text } of found) {
    const block = `### ${label}\n${text}\n\n`
    if (out.length + block.length > TOTAL_CAP) {
      out += '(이하 생략 — 컨벤션 길이 상한)\n'
      break
    }
    out += block
  }
  return out.trim()
}

/** Navi/매니저 프롬프트에 넣을 컨벤션 블록(없으면 ''). 세션당 1회 선두 주입용. */
export function conventionsBlock(projectPath: string): string {
  const c = loadConventions(projectPath)
  if (!c) return ''
  return `<프로젝트 컨벤션>\n이 프로젝트(및 상위 폴더)에 정리된 컨벤션 문서다. 이 프로젝트에서 작업할 땐 아래 규칙·형식·용어를 따른다.\n\n${c}\n</프로젝트 컨벤션>\n\n`
}
