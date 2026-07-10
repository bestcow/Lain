// C9 — 통합(unified) git diff 문자열을 파일 단위로 쪼개는 순수 파서. taskDiff(`git diff <base>`)가
// 내놓는 표준 `diff --git a/… b/…` 헤더로 파일을 분할하고, 각 파일의 헝크에서 +/- 라인 수를 집계한다.
// TaskDiffSection이 파일 목록 요약·접이식 섹션을 얹는 데 쓴다. UI·색상 렌더와 분리(순수 로직만 여기).
//
// 방어: `diff --git`이 없는 비정상 입력(빈 문자열, 잘린 조각)은 files=[]로 조용히 넘긴다.
// rename·new file·deleted file·binary 헤더를 인식해 표시에 반영한다.

export interface DiffFile {
  /** 표시용 경로 — b쪽(변경 후). 삭제 파일은 a쪽. rename은 새 경로. */
  path: string
  /** rename일 때 이전 경로(그 외 null). */
  oldPath: string | null
  added: number // 추가 라인 수(+, 단 +++ 헤더 제외)
  removed: number // 삭제 라인 수(-, 단 --- 헤더 제외)
  binary: boolean // 바이너리 파일(라인 diff 없음)
  isNew: boolean
  isDeleted: boolean
  isRename: boolean
  /** 이 파일 블록의 원문 라인들(diff --git 헤더 포함). 색상 렌더·복사용. */
  lines: string[]
}

// `a/foo b/bar` 형태의 헤더 경로쌍을 뽑는다. 경로에 공백이 있으면 git이 따옴표로 감싸기도 하나(quotepath),
// lain의 taskDiff는 통상 ASCII 경로라 단순 분리로 충분 — a/·b/ 접두 제거 후 반환. 실패 시 null.
function parseHeaderPaths(header: string): { a: string; b: string } | null {
  // 'diff --git ' 이후를 대상으로. 가장 흔한 케이스: 'a/x b/x' (경로 공백 없음).
  const rest = header.slice('diff --git '.length)
  const m = rest.match(/^a\/(.+) b\/(.+)$/)
  if (!m) return null
  return { a: m[1], b: m[2] }
}

const stripPrefix = (p: string): string => p.replace(/^[ab]\//, '')

/**
 * 통합 git diff → 파일별 요약/블록. `diff --git` 헤더가 하나도 없으면 빈 배열.
 * 각 파일의 lines에는 자신의 `diff --git` 헤더부터 다음 헤더 직전까지가 담긴다(마지막 개행은 무시).
 */
export function parseDiffFiles(diff: string): DiffFile[] {
  if (!diff) return []
  const all = diff.split('\n')
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  // Pm-diff1 — 헝크(@@) 진입 여부. 파일 헤더 '--- a/x'·'+++ b/x'는 헝크 이전에만 나오므로, 헝크 본문에서
  // 내용이 '-'/'+'로 시작하는 줄(예: 삭제된 '-- 주석' → diff '--- 주석')을 파일헤더로 오인해 집계에서
  // 누락하던 버그를 위치로 차단한다(접두 문자열이 아니라 @@ 이후인지로 판정).
  let inHunk = false

  const flush = () => {
    if (cur) files.push(cur)
  }

  for (const line of all) {
    if (line.startsWith('diff --git ')) {
      flush()
      inHunk = false
      const paths = parseHeaderPaths(line)
      // 헤더 파싱 실패(비정상)여도 블록 자체는 유지 — path는 원문 헤더 꼬리로 폴백.
      const b = paths ? paths.b : line.slice('diff --git '.length).trim()
      cur = {
        path: stripPrefix(b),
        oldPath: null,
        added: 0,
        removed: 0,
        binary: false,
        isNew: false,
        isDeleted: false,
        isRename: false,
        lines: [line],
      }
      continue
    }
    if (!cur) continue // diff --git 이전 잡음(선행 텍스트)은 버린다
    cur.lines.push(line)

    if (line.startsWith('rename from ')) {
      cur.isRename = true
      cur.oldPath = line.slice('rename from '.length).trim()
    } else if (line.startsWith('rename to ')) {
      cur.isRename = true
      cur.path = line.slice('rename to '.length).trim()
    } else if (line.startsWith('new file')) {
      cur.isNew = true
    } else if (line.startsWith('deleted file')) {
      cur.isDeleted = true
    } else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      cur.binary = true
    } else if (line.startsWith('@@')) {
      inHunk = true // 헝크 시작 — 이후 +/-는 본문(내용이 -/+로 시작해도 집계 대상)
    } else if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) {
      // 파일 헤더(--- a/x, +++ b/x)는 헝크 이전에만 — 집계 제외. 헝크 본문의 ---/+++ 는 여기 안 온다.
    } else if (line.startsWith('+')) {
      cur.added++
    } else if (line.startsWith('-')) {
      cur.removed++
    }
  }
  flush()
  // 삭제 파일이면 표시 경로를 a쪽으로(b는 /dev/null). oldPath가 있고 표시 경로가 dev/null이면 보정.
  for (const f of files) {
    if (f.path === '/dev/null' && f.oldPath) f.path = f.oldPath
  }
  return files
}

/** 파일별 요약 배지 라벨 — '+3/-1', 바이너리는 'bin', 변화 없으면 '±0'. */
export function fileStatLabel(f: DiffFile): string {
  if (f.binary) return 'bin'
  if (f.added === 0 && f.removed === 0) return '±0'
  const parts: string[] = []
  if (f.added > 0) parts.push(`+${f.added}`)
  if (f.removed > 0) parts.push(`-${f.removed}`)
  return parts.join('/')
}

/** 전체 합계 — 헤더 요약(파일 N개 · +A/-B)용. */
export function totalDiffStat(files: DiffFile[]): { files: number; added: number; removed: number } {
  return files.reduce(
    (acc, f) => ({ files: acc.files + 1, added: acc.added + f.added, removed: acc.removed + f.removed }),
    { files: 0, added: 0, removed: 0 },
  )
}
