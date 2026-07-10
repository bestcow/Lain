// 시스템/OS 파괴 명령 분류기 (HANDOFF 2026-07-04 설계) — 순수함수, LLM 없음.
// RISKY(worker.ts)가 개발 위험(push·rm -rf·의존성·네트워크)을 다룬다면, 여기는
// "PC 자체를 망가뜨리는" 명령만 좁게 잡는다: 전원/세션 종료, 디스크 포맷,
// 레지스트리 삭제, 시스템·홈 루트 삭제, 중요 프로세스 강제 종료.
// 오탐 금지가 제1 원칙 — worktree 국소 rm -rf node_modules·npm run deploy·
// taskkill /im lain.exe 같은 일상 운영은 절대 걸리면 안 된다(걸리면 매우 성가심).
// 이 분류는 bypass·autonomous 자율 진행의 예외 없이 항상 사람 승인을 요구한다.

/** 세그먼트 경계 — 파이프/체이닝으로 이어진 각 명령을 따로 검사한다. */
function segments(cmd: string): string[] {
  return cmd.split(/[;|&]+/).map((s) => s.trim()).filter(Boolean)
}

// ── 단순 패턴군: 하나라도 매치하면 해당 사유 반환 ──
const PATTERNS: Array<{ reason: string; re: RegExp }> = [
  // 전원/세션 — shutdown은 플래그 동반형만(산문 속 단어 오탐 방지). logoff는 단독 토큰.
  { reason: 'power', re: /(^|[\s;&|('"`])shutdown(\.exe)?\s+[-/][a-z]/i },
  { reason: 'power', re: /\b(Stop-Computer|Restart-Computer)\b/i },
  { reason: 'power', re: /(^|[\s;&|])logoff(\.exe)?(\s|$)/i },
  // 디스크/파일시스템 파괴
  { reason: 'disk', re: /(^|[\s;&|('"`])format(\.com|\.exe)?\s+[a-z]:/i },
  { reason: 'disk', re: /(^|[\s;&|('"`])diskpart\b/i },
  { reason: 'disk', re: /\bmkfs(\.[a-z0-9]+)?\b/i },
  { reason: 'disk', re: /(^|[\s;&|('"`])bcdedit\b/i },
  { reason: 'disk', re: /\bvssadmin\s+delete\b/i },
  { reason: 'disk', re: /\b(Clear-Disk|Format-Volume|Initialize-Disk)\b/i },
  // 레지스트리 삭제 — reg delete는 대상이 항상 하이브라 무조건. PS 삭제 cmdlet은 HK* 경로 동반 시.
  { reason: 'registry', re: /\breg(\.exe)?\s+delete\b/i },
  {
    reason: 'registry',
    re: /\b(Remove-Item|Remove-ItemProperty)\b[^;|&]*\b(HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER):?/i,
  },
  // 중요 프로세스 강제 종료 — lain.exe 등 앱 프로세스는 제외(배포 일상).
  {
    reason: 'critical_process',
    re: /\btaskkill\b[^;|&]*\/im\s+"?(winlogon|csrss|lsass|smss|services|wininit|explorer)(\.exe)?"?/i,
  },
  {
    reason: 'critical_process',
    re: /\bStop-Process\b[^;|&]*-Name\s+["']?(winlogon|csrss|lsass|smss|services|wininit|explorer)\b/i,
  },
]

// ── 루트 삭제 판정 — 재귀 삭제 동사 + 루트급 대상 토큰의 조합만 잡는다 ──
// 대상이 시스템 루트/드라이브 루트/홈 "그 자체"일 때만. 하위 경로(예: 홈 아래 프로젝트 폴더)는 통과.
const DELETE_VERB = /\b(rm|rd|rmdir|del|Remove-Item|ri)(\.exe)?\b/i
const RECURSE_FLAG = /(^|\s)(-[a-z]*r[a-z]*f?|-fr|--recursive|-Recurse|\/s)(\s|$)/i

/** 토큰이 "루트급" 경로인가 — 드라이브 루트, /, ~, 홈, 시스템 디렉터리 자체.
 *  posixRoots: rm(POSIX)일 때만 git-bash 루트(/c)를 인정 — del/rd의 /q·/f 스위치 오탐 방지. */
function isRootTarget(tok: string, posixRoots: boolean): boolean {
  const t = tok.replace(/^["']|["']$/g, '').replace(/\\+$/, '\\').trim()
  if (!t) return false
  return (
    /^[a-z]:\\?\*?$/i.test(t) || // C:\  C:\*
    /^[a-z]:\\(windows|users|program files( \(x86\))?)\\?\*?$/i.test(t) || // 시스템 최상위 디렉터리 자체
    /^[a-z]:\\users\\[^\\\s"']+\\?$/i.test(t) || // 사용자 프로필 통째
    /^%(SystemRoot|WINDIR|USERPROFILE|SystemDrive)%\\?\*?$/i.test(t) ||
    /^\$env:(SystemRoot|windir|USERPROFILE|SystemDrive)\\?\*?$/i.test(t) ||
    t === '/' || t === '/*' || t === '~' || t === '~/' || t === '~/*' || t === '$HOME' ||
    (posixRoots && /^\/[a-z](\/\*?)?$/i.test(t)) // git-bash 드라이브 루트 /c, /c/*
  )
}

function isRootDelete(seg: string): boolean {
  const verb = DELETE_VERB.exec(seg)
  if (!verb) return false
  const verbName = verb[1].toLowerCase()
  // rm/Remove-Item/del은 재귀(또는 /s) 플래그 동반형만 — 단건 파일 삭제는 여기서 안 잡는다
  const needsRecurse = verbName === 'rm' || verbName === 'remove-item' || verbName === 'ri' || verbName === 'del'
  if (needsRecurse && !RECURSE_FLAG.test(seg)) return false
  const posix = verbName === 'rm' || verbName === 'ri' // POSIX/PS alias만 /c 루트 인정
  const rest = seg.slice(verb.index + verb[0].length)
  return rest.split(/\s+/).some((tok) => {
    if (!tok || tok.startsWith('-')) return false
    if (!posix && /^\/[a-z]$/i.test(tok)) return false // del/rd/rmdir의 /s /q /f 스위치
    return isRootTarget(tok, posix)
  })
}

/**
 * 시스템 파괴 명령이면 사유('power'|'disk'|'registry'|'root_delete'|'critical_process')를,
 * 아니면 null을 반환. 히트 시 호출부는 bypass·autonomous 무시하고 승인 큐로 보낸다.
 */
export function classifySystemDestructive(cmd: string): string | null {
  if (!cmd) return null
  for (const p of PATTERNS) if (p.re.test(cmd)) return p.reason
  for (const seg of segments(cmd)) if (isRootDelete(seg)) return 'root_delete'
  return null
}
