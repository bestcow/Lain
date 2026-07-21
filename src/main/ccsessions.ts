// 클로드코드(CC) 세션 열람 — 데스크톱 앱/터미널이 공유하는 ~/.claude/projects/<슬러그>/<세션id>.jsonl 을
// 읽어 프로젝트별 세션 목록·내용 다이제스트를 만든다(전부 결정론 — 판단·요약은 레인 몫, PLAN §4).
// 실측 구조(2026-07-13, CC 2.1.205): 한 줄 = JSON. type:'user'|'assistant'(message.content),
// 'custom-title'(customTitle — 파일 끝쪽), 'queue-operation'·'mode'·attachment 등 메타. user.content는
// 문자열 또는 블록 배열, assistant.content는 블록 배열([{type:'text',text}...]). entrypoint로
// 'claude-desktop'/CLI 구분, isSidechain=true는 서브에이전트 갈래라 다이제스트에서 제외.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { CcSessionInfo } from '../shared/types'

// 대용량 방어 — 목록은 머리/꼬리 조각만, 다이제스트도 꼬리 N바이트만 읽는다(세션 파일은 수십 MB 가능).
const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 128 * 1024
const DIGEST_TAIL_BYTES = 2 * 1024 * 1024

function ccProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/** CC의 프로젝트 경로 → 폴더 슬러그 규칙(실측): 영숫자 외 전부 '-'. */
export function ccSlugFor(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-')
}

/** 프로젝트가 소유한 CC 세션 폴더들 — 루트 자신 + 그 밑 .claude/worktrees/* (워크트리 세션도 같은 프로젝트 일이다). */
export function ccDirsFor(projectPath: string, root = ccProjectsRoot()): string[] {
  const slug = ccSlugFor(projectPath)
  const wtPrefix = `${slug}--claude-worktrees-`
  let names: string[] = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  return names.filter((n) => n === slug || n.startsWith(wtPrefix)).map((n) => path.join(root, n))
}

function readChunk(file: string, from: 'head' | 'tail', bytes: number): string {
  const size = fs.statSync(file).size
  const len = Math.min(bytes, size)
  const start = from === 'head' ? 0 : size - len
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** 조각에서 줄 단위 JSON 파싱 — 잘린 첫/끝 줄은 자연히 parse 실패로 스킵된다. */
function jsonLines(chunk: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of chunk.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* 조각 경계에서 잘린 줄 — 스킵 */
    }
  }
  return out
}

/** user/assistant 줄에서 사람이 읽을 텍스트를 뽑는다(없으면 ''). */
function textOf(row: Record<string, unknown>): string {
  const msg = row.message as { content?: unknown } | undefined
  const c = msg?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c))
    return c
      .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
  return ''
}

function isChat(row: Record<string, unknown>): boolean {
  return (row.type === 'user' || row.type === 'assistant') && row.isSidechain !== true
}

/** 세션 파일 하나의 메타 — 머리(첫 user·cwd·entrypoint)와 꼬리(custom-title) 조각만 읽는다. */
export function ccSessionMeta(file: string): CcSessionInfo | null {
  try {
    const head = jsonLines(readChunk(file, 'head', HEAD_BYTES))
    const tail = jsonLines(readChunk(file, 'tail', TAIL_BYTES))
    const firstUser = head.find((r) => r.type === 'user' && isChat(r) && textOf(r).trim())
    // custom-title은 이름 변경 시 끝에 append — 꼬리에서 마지막 것을 쓴다. 없으면 첫 user 텍스트 머리.
    const titleRow = [...tail].reverse().find((r) => r.type === 'custom-title' && typeof r.customTitle === 'string')
    const anyChat = firstUser ?? head.find(isChat) ?? tail.find(isChat)
    if (!anyChat && !titleRow) return null // 채팅이 하나도 안 잡히면 빈/비세션 파일로 취급
    const firstText = firstUser ? textOf(firstUser).trim().replace(/\s+/g, ' ') : ''
    const st = fs.statSync(file)
    return {
      id: path.basename(file, '.jsonl'),
      title: (titleRow?.customTitle as string | undefined) ?? (firstText ? firstText.slice(0, 80) : '(제목 없음)'),
      firstUserText: firstText.slice(0, 200),
      lastAt: st.mtimeMs,
      cwd: String((anyChat?.cwd as string | undefined) ?? ''),
      gitBranch: (anyChat?.gitBranch as string | undefined) ?? '',
      entrypoint: String((anyChat?.entrypoint as string | undefined) ?? ''),
    }
  } catch {
    return null
  }
}

/** 프로젝트의 CC 세션 목록 — 최근 수정순. 레인 UI·list_cc_sessions 도구 공용. */
export function listCcSessions(projectPath: string, limit = 20, root = ccProjectsRoot()): CcSessionInfo[] {
  const files: { file: string; mtime: number }[] = []
  for (const dir of ccDirsFor(projectPath, root)) {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const p = path.join(dir, n)
      try {
        files.push({ file: p, mtime: fs.statSync(p).mtimeMs })
      } catch {
        /* 삭제 경합 — 스킵 */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const out: CcSessionInfo[] = []
  for (const f of files) {
    if (out.length >= limit) break
    const meta = ccSessionMeta(f.file)
    if (meta) out.push(meta)
  }
  return out
}

/** 세션 id로 파일 경로를 찾는다(그 프로젝트의 폴더들 안에서만 — 경로 주입 방지). */
export function findCcSessionFile(projectPath: string, sessionId: string, root = ccProjectsRoot()): string | null {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return null // 파일명으로 쓰이므로 형식 강제
  for (const dir of ccDirsFor(projectPath, root)) {
    const p = path.join(dir, `${sessionId}.jsonl`)
    if (fs.existsSync(p)) return p
  }
  return null
}

/** 세션 내용 다이제스트 — 꼬리쪽 user/assistant 텍스트를 최근순으로 최대 maxChars. 판단 없이 원문 발췌만. */
export function ccSessionDigest(projectPath: string, sessionId: string, maxChars = 6000, root = ccProjectsRoot()): string | null {
  const file = findCcSessionFile(projectPath, sessionId, root)
  if (!file) return null
  const rows = jsonLines(readChunk(file, 'tail', DIGEST_TAIL_BYTES)).filter(isChat)
  const parts: string[] = []
  let used = 0
  // 최근 것부터 거꾸로 채우고 마지막에 뒤집는다 — "가장 최근 맥락"이 항상 포함되게.
  for (let i = rows.length - 1; i >= 0 && used < maxChars; i--) {
    const text = textOf(rows[i]).trim()
    if (!text) continue
    const who = rows[i].type === 'user' ? 'User' : 'Claude'
    const line = `[${who}] ${text.length > 800 ? `${text.slice(0, 800)}…` : text}`
    parts.push(line)
    used += line.length
  }
  if (parts.length === 0) return '(텍스트 메시지 없음 — 도구 호출 위주 세션)'
  return parts.reverse().join('\n\n')
}

/** CC 세션 이어받기 명세 생성 — Navi 유한세션 핸드오프(<handoff>) 포맷 재사용 */
export function buildAdoptContent(digest: string, goal: string | undefined, sessionId: string): string {
  const g = goal?.trim() || '아래 Claude Code 세션에서 진행하던 작업을 이어서 완료하라.'
  return [
    '# TASK',
    '## 목표',
    g,
    '',
    `## 컨텍스트 — Claude Code 세션 ${sessionId} 이어받기`,
    '<handoff>',
    digest,
    '</handoff>',
    '',
    '## 완료 조건 (DoD)',
    '- 세션에서 진행 중이던 변경을 완결한다',
    '- 프로젝트 verify 명령이 통과한다',
  ].join('\n')
}
