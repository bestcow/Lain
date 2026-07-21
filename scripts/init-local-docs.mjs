// 클론 직후 개인 작업기록 파일 준비 — example 틀 → 실파일(없을 때만) 복사.
// HANDOFF.md·UPDATE.md는 사용자별 내용이라 gitignore 대상이고, example만 추적된다(.env/.env.example 패턴).
// npm install의 postinstall이 실행하므로 클론 즉시 워크플로가 준비된다(관례 의존 제거).
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PAIRS = [
  ['HANDOFF.example.md', 'HANDOFF.md'],
  ['UPDATE.example.md', 'UPDATE.md'],
]

/** example → 실파일을 "없을 때만" 복사하고 실제 생성한 파일명을 반환한다(멱등). */
export function initLocalDocs(rootDir) {
  const created = []
  for (const [example, actual] of PAIRS) {
    const src = join(rootDir, example)
    const dest = join(rootDir, actual)
    if (!existsSync(src)) continue // 틀이 없으면 조용히 건너뜀(부분 체크아웃 등)
    if (existsSync(dest)) continue // 사용자 내용 보존 — 절대 덮어쓰지 않는다
    copyFileSync(src, dest)
    created.push(actual)
  }
  return created
}

// postinstall 진입점 — 직접 실행될 때만 동작(import 시에는 조용).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const created = initLocalDocs(root)
  if (created.length) console.log(`[init-local-docs] 생성: ${created.join(', ')}`)
}
