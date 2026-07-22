// 외부 Codex 세션 열람 — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl을 방어적으로 읽어
// 등록 프로젝트별 목록과 이어받기용 결정론 발췌를 만든다. LLM 호출 없음(PLAN §4, 멀티 엔진 M1).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ObservedSessionInfo } from '../shared/types'

const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 2 * 1024 * 1024
const MAX_FILES = 2_000
const ACTIVE_MS = 2 * 60 * 1000
const RECENT_MS = 24 * 60 * 60 * 1000

function defaultSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions')
}

function norm(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

export function codexSessionMatchesProject(cwd: string, projectPath: string): boolean {
  if (!cwd || !projectPath) return false
  const c = norm(cwd)
  const p = norm(projectPath)
  return c === p || c.startsWith(`${p}/`)
}

export function codexSessionStatus(
  lastAt: number,
  now = Date.now(),
): ObservedSessionInfo['status'] {
  const idle = Math.max(0, now - lastAt)
  if (idle <= ACTIVE_MS) return 'active'
  if (idle <= RECENT_MS) return 'recent'
  return 'ended'
}

function readChunk(file: string, from: 'head' | 'tail', bytes: number): string {
  const size = fs.statSync(file).size
  const len = Math.min(size, bytes)
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

function jsonLines(chunk: string): Record<string, any>[] {
  const rows: Record<string, any>[] = []
  for (const line of chunk.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const row = JSON.parse(t)
      if (row && typeof row === 'object') rows.push(row)
    } catch {
      // head/tail 조각 경계의 잘린 줄 또는 손상 한 줄 — 나머지 세션은 계속 읽는다.
    }
  }
  return rows
}

function rolloutFiles(root: string): string[] {
  const files: string[] = []
  const stack = [root]
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop()!
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) break
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.startsWith('rollout-')) files.push(p)
    }
  }
  return files
}

function messageText(row: Record<string, any>): { role: 'user' | 'assistant'; text: string } | null {
  if (row.type !== 'response_item') return null
  const p = row.payload
  if (!p || p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) return null
  const content = p.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content))
    text = content
      .filter((b) => b && typeof b === 'object')
      .filter((b) => b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .filter(Boolean)
      .join('\n')
  text = text.trim()
  return text ? { role: p.role, text } : null
}

function fallbackEventText(row: Record<string, any>): { role: 'user' | 'assistant'; text: string } | null {
  if (row.type !== 'event_msg' || !row.payload) return null
  const p = row.payload
  const role = p.type === 'user_message' ? 'user' : p.type === 'agent_message' ? 'assistant' : null
  const text = String(p.message ?? p.text ?? '').trim()
  return role && text ? { role, text } : null
}

export function codexSessionMeta(
  file: string,
  now = Date.now(),
): ObservedSessionInfo | null {
  try {
    const rows = jsonLines(readChunk(file, 'head', HEAD_BYTES))
    const meta = rows.find((r) => r.type === 'session_meta' && r.payload && typeof r.payload === 'object')
      ?.payload
    if (!meta?.id || !meta?.cwd) return null
    const first = rows.map(messageText).find((m) => m?.role === 'user' && m.text.trim())
      ?? rows.map(fallbackEventText).find((m) => m?.role === 'user' && m.text.trim())
    const firstText = first?.text.replace(/\s+/g, ' ').trim() ?? ''
    const st = fs.statSync(file)
    return {
      id: String(meta.id),
      title: firstText ? firstText.slice(0, 80) : '(제목 없음)',
      firstUserText: firstText.slice(0, 200),
      lastAt: st.mtimeMs,
      cwd: String(meta.cwd),
      gitBranch: '',
      entrypoint: String(meta.source ?? 'codex'),
      engine: 'codex',
      origin: 'observed',
      status: codexSessionStatus(st.mtimeMs, now),
      provider: meta.model_provider ? String(meta.model_provider) : undefined,
    }
  } catch {
    return null
  }
}

/** 등록 프로젝트 cwd와 일치하는 외부 Codex 세션 목록 — 최근 수정순. */
export function listCodexSessions(
  projectPath: string,
  limit = 20,
  root = defaultSessionsRoot(),
  now = Date.now(),
): ObservedSessionInfo[] {
  const candidates = rolloutFiles(root)
    .map((file) => {
      try {
        return { file, mtime: fs.statSync(file).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { file: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
  const out: ObservedSessionInfo[] = []
  for (const c of candidates) {
    if (out.length >= limit) break
    const meta = codexSessionMeta(c.file, now)
    if (meta && codexSessionMatchesProject(meta.cwd, projectPath)) out.push(meta)
  }
  return out
}

/** 세션 id로 rollout을 찾되, 메타 cwd가 해당 프로젝트 안인지까지 확인해 경로 주입·교차 프로젝트 열람을 막는다. */
export function findCodexSessionFile(
  projectPath: string,
  sessionId: string,
  root = defaultSessionsRoot(),
): string | null {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return null
  for (const file of rolloutFiles(root)) {
    const meta = codexSessionMeta(file)
    if (meta?.id === sessionId && codexSessionMatchesProject(meta.cwd, projectPath)) return file
  }
  return null
}

/** 최근 user/assistant 원문 발췌. response_item이 없을 때만 event_msg를 폴백해 중복 표시를 피한다. */
export function codexSessionDigest(
  projectPath: string,
  sessionId: string,
  maxChars = 6000,
  root = defaultSessionsRoot(),
): string | null {
  const file = findCodexSessionFile(projectPath, sessionId, root)
  if (!file) return null
  const rows = jsonLines(readChunk(file, 'tail', TAIL_BYTES))
  let messages = rows.map(messageText).filter((m): m is NonNullable<ReturnType<typeof messageText>> => !!m)
  if (messages.length === 0)
    messages = rows
      .map(fallbackEventText)
      .filter((m): m is NonNullable<ReturnType<typeof fallbackEventText>> => !!m)
  const parts: string[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0 && used < maxChars; i--) {
    const m = messages[i]
    const who = m.role === 'user' ? 'User' : 'Codex'
    const body = m.text.length > 800 ? `${m.text.slice(0, 800)}…` : m.text
    const line = `[${who}] ${body}`
    parts.push(line)
    used += line.length
  }
  return parts.length ? parts.reverse().join('\n\n') : '(텍스트 메시지 없음 — 도구 호출 위주 세션)'
}
