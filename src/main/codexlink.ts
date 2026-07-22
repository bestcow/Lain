// 외부 Codex 연동(M1) — Codex CLI notify 신호를 등록 프로젝트 inbox로 전달한다.
// 전부 결정론 배관이며, 실제 ~/.codex/config.toml은 사용자가 토글을 켠 뒤에만 접근한다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from './paths'
import { addCcEvent, getSettings, listProjects } from './store'
import { notifyUser } from './notify'
import { appendCapped } from './logfile'

const LINK_DIR = path.join(DATA_DIR, 'codex-link')
const EVENTS_DIR = path.join(LINK_DIR, 'events')
const DEFAULT_CONFIG = path.join(os.homedir(), '.codex', 'config.toml')
const BEGIN = '# lain-codex-link begin'
const END = '# lain-codex-link end'

export const CODEX_NOTIFY_SCRIPT_SOURCE = `// lain-codex-notify.cjs — Codex agent-turn-complete notify. lain이 자동 설치/갱신(직접 수정 마세요).
const fs = require('fs')
const path = require('path')
const HERE = __dirname
const BS = String.fromCharCode(92)
function norm(s) {
  let out = String(s || '').split(BS).join('/').toLowerCase()
  while (out.endsWith('/')) { out = out.slice(0, -1) }
  return out
}
try {
  const input = JSON.parse(process.argv[2] || '{}')
  const cwd = norm(input.cwd)
  if (!cwd) { process.exit(0) }
  let projects = []
  try { projects = JSON.parse(fs.readFileSync(path.join(HERE, 'projects.json'), 'utf8')) }
  catch (e) { process.exit(0) }
  let match = null
  let matchLen = -1
  for (let i = 0; i < projects.length; i++) {
    const root = norm(projects[i].path)
    if (root && root.length > matchLen && (cwd === root || cwd.indexOf(root + '/') === 0)) {
      match = projects[i]
      matchLen = root.length
    }
  }
  if (!match) { process.exit(0) }
  const ev = {
    projectId: String(match.id),
    sessionId: String(input['thread-id'] || ''),
    event: String(input.type || 'agent-turn-complete'),
    ts: Date.now(),
  }
  const dir = path.join(HERE, 'events')
  fs.mkdirSync(dir, { recursive: true })
  const name = String(ev.ts) + '-' + Math.floor(Math.random() * 1000000) + '.json'
  fs.writeFileSync(path.join(dir, name), JSON.stringify(ev))
} catch (e) { /* notify는 Codex 본 작업을 절대 깨지 않는다 */ }
process.exit(0)
`

export type CodexLinkResult = { ok: boolean; error?: string }

function markerBlock(scriptPath: string): string {
  return [BEGIN, `notify = ["node", ${JSON.stringify(scriptPath)}]`, END].join('\n')
}

function markerRe(): RegExp {
  return /^# lain-codex-link begin\r?\n[\s\S]*?^# lain-codex-link end(?:\r?\n)?/gm
}

export function stripCodexNotifyConfig(input: string): string {
  return input.replace(markerRe(), '')
}

/** 기존 사용자 notify를 발견하면 덮지 않고 실패한다. 우리 블록은 제거 후 최신 경로로 1개만 재삽입. */
export function mergeCodexNotifyConfig(
  input: string,
  scriptPath: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const clean = stripCodexNotifyConfig(input.replace(/^\uFEFF/, ''))
  if (/^\s*notify\s*=/m.test(clean))
    return {
      ok: false,
      error: 'Codex 연동 설치 거부 — config.toml에 기존 notify 설정이 있다',
    }
  return { ok: true, text: `${markerBlock(scriptPath)}\n${clean}` }
}

function logCodexLink(message: string): void {
  try {
    fs.mkdirSync(LINK_DIR, { recursive: true })
    appendCapped(path.join(LINK_DIR, 'codex-link.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 진단 로그 실패는 연동 흐름을 막지 않는다.
  }
}

function ensureDirs(linkDir = LINK_DIR): void {
  fs.mkdirSync(path.join(linkDir, 'events'), { recursive: true })
}

function writeProjects(linkDir = LINK_DIR): void {
  ensureDirs(linkDir)
  const entries = listProjects().map((p) => ({ id: p.id, path: p.path }))
  atomicWrite(path.join(linkDir, 'projects.json'), JSON.stringify(entries))
}

export function refreshCodexLinkIfEnabled(): void {
  if (!getSettings().codexLinkEnabled) return
  try {
    writeProjects()
  } catch (e) {
    logCodexLink(`프로젝트 목록 갱신 실패: ${e}`)
  }
}

function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.lain-tmp`
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    throw e
  }
}

/** 테스트용 경로 주입이 가능한 설치기. 실제 호출은 기본 ~/.codex/config.toml + DATA_DIR/codex-link. */
export function installCodexLink(
  configPath = DEFAULT_CONFIG,
  linkDir = LINK_DIR,
): CodexLinkResult {
  try {
    ensureDirs(linkDir)
    const script = path.join(linkDir, 'lain-codex-notify.cjs')
    fs.writeFileSync(script, CODEX_NOTIFY_SCRIPT_SOURCE, 'utf8')
    if (linkDir === LINK_DIR) writeProjects(linkDir)
    const exists = fs.existsSync(configPath)
    const before = exists ? fs.readFileSync(configPath, 'utf8') : ''
    const merged = mergeCodexNotifyConfig(before, script)
    if (!merged.ok) return merged
    if (exists) {
      const backup = `${configPath}.lain-bak`
      if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup)
    }
    atomicWrite(configPath, merged.text)
    return { ok: true }
  } catch (e) {
    logCodexLink(`설치 실패: ${e}`)
    return { ok: false, error: 'Codex 연동 설치 실패 — ~/.codex/config.toml 확인' }
  }
}

export function uninstallCodexLink(configPath = DEFAULT_CONFIG): CodexLinkResult {
  if (!fs.existsSync(configPath)) return { ok: true }
  try {
    const before = fs.readFileSync(configPath, 'utf8')
    const after = stripCodexNotifyConfig(before)
    if (after !== before) atomicWrite(configPath, after)
    return { ok: true }
  } catch (e) {
    logCodexLink(`제거 실패: ${e}`)
    return { ok: false, error: 'Codex 연동 제거 실패 — ~/.codex/config.toml 확인' }
  }
}

let watcher: fs.FSWatcher | null = null
let drainTimer: ReturnType<typeof setTimeout> | null = null

function handleEventFile(file: string): void {
  let ev: any
  try {
    ev = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return
  } finally {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // ignore
    }
  }
  if (!ev?.projectId) return
  addCcEvent(
    String(ev.projectId),
    String(ev.sessionId ?? ''),
    String(ev.event ?? 'agent-turn-complete'),
    'codex',
  )
  notifyUser('Codex', `${ev.projectId} — 외부 Codex 세션 활동`)
}

function drainEvents(): void {
  let files: string[] = []
  try {
    files = fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return
  }
  for (const f of files) handleEventFile(path.join(EVENTS_DIR, f))
}

function startWatcher(): void {
  if (watcher) return
  ensureDirs()
  drainEvents()
  try {
    watcher = fs.watch(EVENTS_DIR, () => {
      if (drainTimer) clearTimeout(drainTimer)
      drainTimer = setTimeout(drainEvents, 150)
    })
  } catch {
    // 다음 apply/부팅에서 재시도한다.
  }
}

export function stopCodexLink(): void {
  try {
    watcher?.close()
  } catch {
    // ignore
  }
  watcher = null
  if (drainTimer) clearTimeout(drainTimer)
  drainTimer = null
}

/**
 * 부팅에서는 removeWhenDisabled=false로 호출해 토글 OFF일 때 ~/.codex를 전혀 읽지 않는다.
 * 설정 토글을 OFF로 바꾼 순간에만 true로 호출해 우리 마커를 제거한다.
 */
export function applyCodexLink(removeWhenDisabled = false): CodexLinkResult {
  if (getSettings().codexLinkEnabled) {
    const result = installCodexLink()
    if (result.ok) startWatcher()
    else stopCodexLink()
    return result
  }
  if (removeWhenDisabled) {
    const result = uninstallCodexLink()
    if (result.ok) stopCodexLink()
    return result
  }
  stopCodexLink()
  return { ok: true }
}
