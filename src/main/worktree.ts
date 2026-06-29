// 작업 격리 (PLAN.md §9-1, §15b) — task별 git worktree + 전용 브랜치.
// 사용자 라이브 작업트리·현재 브랜치와 절대 충돌하지 않는다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import type { Project } from '../shared/types'

const WT_ROOT = path.join(DATA_DIR, 'wt')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

export function branchName(taskId: string): string {
  return `lain/${taskId}`
}

/** worktree 생성: HEAD 기준 분기 + .env류 복사 + node_modules junction (§15b) */
export function createWorktree(
  project: Project,
  taskId: string,
): { path: string; branch: string; depsWarning: string | null } {
  const wtPath = path.join(WT_ROOT, taskId)
  const branch = branchName(taskId)
  fs.mkdirSync(WT_ROOT, { recursive: true })
  // 크래시·부분 실패로 같은 taskId의 worktree/브랜치 잔재가 남아 있으면 add가 충돌해 작업이 error로
  // 떨어진다(복원 시 특히). 선제 정리 후 -B(있으면 HEAD로 리셋)로 생성 — taskId가 유일해 정상
  // 경로에선 -b와 동일하게 동작하고, 잔재가 있을 때만 방어적으로 작동한다.
  if (fs.existsSync(wtPath)) {
    try {
      git(project.path, 'worktree', 'remove', '--force', wtPath)
    } catch {
      /* 폴더만 남은 경우 — 아래에서 직접 제거 */
    }
    fs.rmSync(wtPath, { recursive: true, force: true })
    try {
      git(project.path, 'worktree', 'prune')
    } catch {
      /* 무시 */
    }
  }
  git(project.path, 'worktree', 'add', '-B', branch, wtPath, 'HEAD')

  // 비추적 필수 파일 복사 (.env 등 — 값은 로그에 미노출 §9-6)
  for (const name of ['.env', '.env.local', '.env.development']) {
    const src = path.join(project.path, name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(wtPath, name))
  }

  // node_modules 재사용 (Windows: junction — 심링크 권한 불필요)
  const nm = path.join(project.path, 'node_modules')
  if (fs.existsSync(nm)) {
    try {
      fs.symlinkSync(nm, path.join(wtPath, 'node_modules'), 'junction')
    } catch {
      // 실패 시 Navi가 필요하면 직접 설치
    }
  }

  // §15b deps 헬스체크 — 메인 node_modules가 없거나 사실상 비어 있으면 Navi가
  // npm install 승인 대기에 막혀 토큰만 태운다(도그푸딩 실증). 미리 경고를 올린다.
  let depsWarning: string | null = null
  if (fs.existsSync(path.join(project.path, 'package.json'))) {
    let entries = 0
    try {
      entries = fs.existsSync(nm) ? fs.readdirSync(nm).length : 0
    } catch {
      /* 읽기 실패 = 없다고 간주 */
    }
    if (entries < 5) {
      depsWarning =
        `node_modules가 비어 있거나 부실하다(${entries}개) — ` +
        `메인 체크아웃(${project.path})에서 npm install을 먼저 돌리는 게 좋다. ` +
        `Navi가 설치를 시도하면 승인 큐(dep_change)를 거친다.`
    }
  }

  return { path: wtPath, branch, depsWarning }
}

/** worktree 제거 (+선택적으로 브랜치 삭제) */
export function removeWorktree(project: Project, taskId: string, deleteBranch: boolean): void {
  const wtPath = path.join(WT_ROOT, taskId)
  // junction은 worktree remove 전에 끊는다 (원본 node_modules 보호)
  const nmLink = path.join(wtPath, 'node_modules')
  try {
    if (fs.existsSync(nmLink) && fs.lstatSync(nmLink).isSymbolicLink()) fs.rmdirSync(nmLink)
  } catch {
    /* 무시 */
  }
  try {
    git(project.path, 'worktree', 'remove', '--force', wtPath)
  } catch {
    fs.rmSync(wtPath, { recursive: true, force: true })
    try {
      git(project.path, 'worktree', 'prune')
    } catch {
      /* 무시 */
    }
  }
  if (deleteBranch) {
    try {
      git(project.path, 'branch', '-D', branchName(taskId))
    } catch {
      /* 무시 */
    }
  }
}

/** 시작 시 고아 worktree 정리 (§15b GC) — 활성 task 목록에 없는 wt/ 폴더 제거 */
export function gcWorktrees(activeTaskIds: Set<string>, projects: Project[]): void {
  if (!fs.existsSync(WT_ROOT)) return
  for (const entry of fs.readdirSync(WT_ROOT)) {
    if (activeTaskIds.has(entry)) continue
    for (const p of projects) {
      try {
        removeWorktree(p, entry, false)
      } catch {
        /* 다음 프로젝트에서 시도 */
      }
    }
    // 파일 잠금(Windows junction 핸들 등)으로 rmSync가 throw하면 그 항목에서 루프가 멈춰 나머지 고아가 영영 남는다 —
    // 항목별로 격리해 다음 항목으로 진행.
    try {
      fs.rmSync(path.join(WT_ROOT, entry), { recursive: true, force: true })
    } catch {
      /* 잠긴 항목 — 다음 부팅 GC에서 재시도 */
    }
  }
}

/** diff 요약 (L0가 직접 git으로 — §10.1): 메인 HEAD와의 merge-base 기준 */
export function diffStat(project: Project, taskId: string): string {
  const wtPath = path.join(WT_ROOT, taskId)
  try {
    const mainHead = git(project.path, 'rev-parse', 'HEAD')
    const base = git(wtPath, 'merge-base', 'HEAD', mainHead)
    return git(wtPath, 'diff', '--stat', base, 'HEAD')
  } catch {
    try {
      return git(wtPath, 'log', '--oneline', '-5')
    } catch {
      return ''
    }
  }
}

/** 전체 diff 본문(merge-base..HEAD + 미커밋 추적변경). diffStat과 동일 base 로직, --stat 대신 patch.
 * 출력이 거대할 수 있어 상한(200KB)에서 절단 — 초과 시 말미에 잘림 표기. 실패 시 ''. */
export function diffBody(project: Project, taskId: string): string {
  const MAX_BYTES = 200 * 1024
  const wtPath = path.join(WT_ROOT, taskId)
  try {
    const mainHead = git(project.path, 'rev-parse', 'HEAD')
    const base = git(wtPath, 'merge-base', 'HEAD', mainHead)
    const body = git(wtPath, 'diff', base)
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
      return (
        body.slice(0, MAX_BYTES) +
        `\n\n… [diff가 너무 커서 ${Math.round(MAX_BYTES / 1024)}KB에서 잘림 — 전체는 작업 worktree에서 확인]`
      )
    }
    return body
  } catch {
    return ''
  }
}

/** 변경 파일 목록 (merge-base..작업트리, name-only). 커밋·미커밋 추적변경 모두 포함 —
 * §24 spec-gaming 사후검증(테스트 파일이 Bash sed 등으로 바뀌었는지)에 쓴다. */
export function changedFiles(project: Project, taskId: string): string[] {
  const wtPath = path.join(WT_ROOT, taskId)
  try {
    const mainHead = git(project.path, 'rev-parse', 'HEAD')
    const base = git(wtPath, 'merge-base', 'HEAD', mainHead)
    const out = git(wtPath, 'diff', '--name-only', base)
    return out ? out.split(/\r?\n/).filter(Boolean) : []
  } catch {
    return []
  }
}

/** 병합 시도: 메인 체크아웃이 clean하고 ff 가능할 때만 (PLAN.md §17 merge-back 보수적 버전)
 * untracked는 무시(-uno) — TASK.md 자체가 untracked로 프로젝트 루트에 있어서
 * 포함하면 모든 병합이 dirty 판정에 막힌다. ff 병합은 untracked와 충돌하지 않음
 * (Navi 브랜치는 HEAD에서 분기해 같은 untracked 파일을 갖지 않는다). */
export function tryMerge(project: Project, taskId: string): { merged: boolean; reason: string } {
  const porcelain = git(project.path, 'status', '--porcelain', '--untracked-files=no')
  if (porcelain) {
    return { merged: false, reason: '메인 작업트리가 dirty — 브랜치만 남김. 직접 머지해라.' }
  }
  try {
    git(project.path, 'merge', '--ff-only', branchName(taskId))
    return { merged: true, reason: 'fast-forward 병합 완료' }
  } catch {
    return {
      merged: false,
      reason: 'fast-forward 불가(분기 이후 메인에 새 커밋) — 브랜치만 남김. 직접 머지해라.',
    }
  }
}
