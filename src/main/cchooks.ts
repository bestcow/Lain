// 클로드코드 연동 (개선 #2 Phase 1, CC→레인) — 사용자가 등록 프로젝트에서 레인 밖으로 직접 실행한
// `claude` 세션을 레인이 인지한다. 켜면 레인이 클로드코드 SessionStart/SessionEnd 훅을 유저 전역
// (~/.claude/settings.json)에 멱등 설치한다. 훅 스크립트는 세션의 cwd를 레인 '등록 프로젝트 목록'과
// 대조해, 등록 프로젝트에서의 세션만 이벤트 파일로 inbox에 떨군다 — 비등록 폴더·레인 Navi worktree
// (DATA_DIR/wt 하위라 등록 루트와 불일치)는 무시되어 피드백 루프가 생기지 않는다. 레인은 자기 데이터
// 폴더의 inbox만 감시하므로 전역 파일 감시 없이 안전하다.
//
// 의존: store(설정·프로젝트·이벤트 적재) + notify(능동 보고 → 텔레그램·OS 토스트). manager를 import하지
// 않아 순환참조가 없다(L0 결정론 배관, 판단 없음).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from './paths'
import { getSettings, listProjects, listTasks, addCcEvent } from './store'
import { notifyUser } from './notify'
import { appendCapped } from './logfile'

const LINK_DIR = path.join(DATA_DIR, 'cc-link') // 훅 산출물·이벤트 inbox 루트
const HOOK_SCRIPT = path.join(LINK_DIR, 'lain-cc-hook.cjs')
const PROJECTS_FILE = path.join(LINK_DIR, 'projects.json')
const EVENTS_DIR = path.join(LINK_DIR, 'events')
const STATUS_DIR = path.join(LINK_DIR, 'status') // 레인→CC: 프로젝트별 작업 다이제스트(.md)
const SETTINGS_JSON = path.join(os.homedir(), '.claude', 'settings.json')
const MARKER = 'lain-cc-hook' // 우리 훅 식별자(command 문자열에 포함됨 — 멱등 설치·정확한 제거용)
const HOOK_EVENTS = ['SessionStart', 'SessionEnd']

// 설치되는 훅 스크립트 본문. backtick·${}·역슬래시 리터럴을 피해(여기 템플릿 리터럴 이스케이프 함정 회피)
// 그대로 파일에 쓴다. stdin JSON을 읽어 cwd가 등록 프로젝트면 이벤트를 inbox에 떨구고, 아니면 조용히 종료.
const HOOK_SCRIPT_SOURCE = `// lain-cc-hook.cjs — Claude Code SessionStart/SessionEnd 훅. lain이 자동 설치/갱신(직접 수정 마세요).
const fs = require('fs')
const path = require('path')
const HERE = __dirname
const BS = String.fromCharCode(92)
function norm(s) { return String(s || '').split(BS).join('/').toLowerCase() }
let raw = ''
process.stdin.on('data', function (c) { raw += c })
process.stdin.on('end', function () {
  try {
    const input = JSON.parse(raw || '{}')
    const cwd = norm(input.cwd)
    if (!cwd) { return process.exit(0) }
    let projects = []
    try { projects = JSON.parse(fs.readFileSync(path.join(HERE, 'projects.json'), 'utf8')) }
    catch (e) { return process.exit(0) }
    let match = null
    for (let i = 0; i < projects.length; i++) {
      const root = norm(projects[i].path)
      if (root && (cwd === root || cwd.indexOf(root + '/') === 0)) { match = projects[i]; break }
    }
    if (!match) { return process.exit(0) }
    const ev = {
      projectId: match.id,
      sessionId: String(input.session_id || ''),
      event: String(input.hook_event_name || ''),
      source: String(input.source || ''),
      cwd: input.cwd,
      ts: Date.now(),
    }
    const dir = path.join(HERE, 'events')
    fs.mkdirSync(dir, { recursive: true })
    const name = String(ev.ts) + '-' + Math.floor(Math.random() * 1000000) + '.json'
    fs.writeFileSync(path.join(dir, name), JSON.stringify(ev))
    // 레인→CC(Phase 2): SessionStart면 이 프로젝트의 레인 작업 다이제스트를 additionalContext로 주입한다.
    // stdout은 오직 이 JSON만 — 다른 출력 금지(클로드코드가 stdout을 구조화 출력으로 파싱).
    if (ev.event === 'SessionStart' && match.digest) {
      try {
        const digest = fs.readFileSync(match.digest, 'utf8')
        if (digest && digest.trim()) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: digest },
          }))
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  return process.exit(0)
})
`

let watcher: fs.FSWatcher | null = null
let drainTimer: ReturnType<typeof setTimeout> | null = null

function ensureDirs(): void {
  fs.mkdirSync(EVENTS_DIR, { recursive: true })
  fs.mkdirSync(STATUS_DIR, { recursive: true })
}

const sanitizeId = (id: string): string => String(id).replace(/[^a-zA-Z0-9_-]/g, '_')

/** 레인→CC(Phase 2) — 한 프로젝트에 대한 레인 작업 다이제스트(md). 작업이 없으면 빈 문자열. */
export function buildProjectDigest(projectId: string): string {
  const tasks = listTasks().filter((t) => t.projectId === projectId)
  const active = tasks.filter((t) => !['done', 'cancelled'].includes(t.state))
  const recentDone = tasks.filter((t) => t.state === 'done').slice(0, 3)
  if (!active.length && !recentDone.length) return ''
  const lines: string[] = ['# Lain 작업 현황 (이 프로젝트)', '']
  if (active.length) {
    lines.push('## 진행 중인 Lain 작업')
    for (const t of active)
      lines.push(`- [${t.state}] ${t.title}${t.branch ? ` (브랜치 ${t.branch})` : ''}`)
    lines.push('')
  }
  if (recentDone.length) {
    lines.push('## 최근 완료(Lain)')
    for (const t of recentDone)
      lines.push(`- ${t.title}${t.summary ? ` — ${t.summary.slice(0, 120)}` : ''}`)
    lines.push('')
  }
  lines.push('> 이 프로젝트는 Lain 오케스트레이터가 함께 관리 중입니다. 위 Lain 작업과 충돌하지 않게 진행하세요.')
  return lines.join('\n')
}

/** 등록·활성 프로젝트 목록 + 프로젝트별 다이제스트를 훅이 읽을 파일로 쓴다.
 *  projects.json 각 항목에 digest(절대경로)를 실어, 훅이 SessionStart 때 그 파일을 읽어 주입한다. */
export function writeCcProjects(): void {
  try {
    ensureDirs()
    const entries = listProjects()
      .filter((p) => p.enabled)
      .map((p) => {
        const digestPath = path.join(STATUS_DIR, `${sanitizeId(p.id)}.md`)
        try {
          const d = buildProjectDigest(p.id)
          if (d) fs.writeFileSync(digestPath, d, 'utf8')
          else fs.rmSync(digestPath, { force: true }) // 작업 없으면 다이제스트 제거(빈 주입 방지)
        } catch {
          /* 다이제스트 실패는 무시 — 통지(CC→레인)는 계속 동작 */
        }
        return { id: p.id, path: p.path, digest: digestPath }
      })
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(entries), 'utf8')
  } catch {
    /* 무시 — 다음 갱신/시동에서 재시도 */
  }
}

/** 프로젝트·작업 변경 시(ipc) 호출 — 연동이 켜져 있을 때만 목록+다이제스트 갱신. */
export function refreshCcLinkIfEnabled(): void {
  if (getSettings().ccHooksEnabled) writeCcProjects()
}

function hookCommand(): string {
  return `node "${HOOK_SCRIPT}"`
}

type HookGroup = { hooks?: { type?: string; command?: string }[] }
const isOurs = (g: HookGroup): boolean =>
  (g?.hooks ?? []).some((h) => typeof h?.command === 'string' && h.command.includes(MARKER))

// ── settings.json 병합 로직(순수·부작용 0) — 사용자의 글로벌 설정을 건드리므로 단위테스트로 보호한다.
/** cfg.hooks의 SessionStart/SessionEnd에 우리 훅(command)만 멱등 보장 — 기존·다른 이벤트 훅은 보존. */
export function mergeOurHooks(
  cfg: Record<string, any>,
  command: string,
): Record<string, any> {
  const next = { ...cfg }
  const hooks: Record<string, any> = { ...(next.hooks && typeof next.hooks === 'object' ? next.hooks : {}) }
  for (const ev of HOOK_EVENTS) {
    const arr: HookGroup[] = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const cleaned = arr.filter((g) => !isOurs(g)) // 구버전/중복 우리 항목 제거 후 1개만 추가
    cleaned.push({ hooks: [{ type: 'command', command }] })
    hooks[ev] = cleaned
  }
  next.hooks = hooks
  return next
}
/** cfg에서 우리 훅만 제거 — 다른 훅·키 보존, 빈 배열·빈 hooks는 정리. */
export function stripOurHooks(cfg: Record<string, any>): Record<string, any> {
  const next = { ...cfg }
  if (!next.hooks || typeof next.hooks !== 'object') return next
  const hooks: Record<string, any> = { ...next.hooks }
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue
    hooks[ev] = (hooks[ev] as HookGroup[]).filter((g) => !isOurs(g))
    if (hooks[ev].length === 0) delete hooks[ev]
  }
  if (Object.keys(hooks).length === 0) delete next.hooks
  else next.hooks = hooks
  return next
}

/** ~/.claude/settings.json에 우리 SessionStart/SessionEnd 훅을 멱등 삽입(기존 훅·다른 키 보존). */
function installHooks(): void {
  ensureDirs()
  fs.writeFileSync(HOOK_SCRIPT, HOOK_SCRIPT_SOURCE, 'utf8')
  writeCcProjects()
  let cfg: Record<string, any> = {}
  if (fs.existsSync(SETTINGS_JSON)) {
    // 파일이 존재하는데 읽기/파싱이 실패하면(일시 잠금 EBUSY/EPERM·다른 프로세스가 쓰는 도중) 설치를
    // 건너뛴다 — cfg={}로 밀어 쓰면 사용자의 전역 설정(권한·env·타 훅) 전체가 날아간다. 다음 부팅/토글에서
    // 재시도되므로 훅 설치가 한 번 늦는 쪽이 설정 파괴보다 낫다. 파일 없음(ENOENT)만 새로 만든다.
    try {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'))
      if (parsed && typeof parsed === 'object') cfg = parsed
    } catch (e) {
      appendCapped(
        path.join(LINK_DIR, 'cc-link.log'),
        `${new Date().toISOString()} settings.json 읽기 실패 — 훅 설치 건너뜀(설정 보호): ${e}\n`,
      )
      return
    }
  }
  cfg = mergeOurHooks(cfg, hookCommand())
  fs.mkdirSync(path.dirname(SETTINGS_JSON), { recursive: true })
  // 원자 쓰기 — 쓰는 도중 크래시로 settings.json이 반토막 나지 않게 임시파일 후 rename.
  const tmp = SETTINGS_JSON + '.lain-tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  fs.renameSync(tmp, SETTINGS_JSON)
}

/** ~/.claude/settings.json에서 우리 훅만 제거(다른 훅·키 보존). 파일이 없으면 no-op. */
function uninstallHooks(): void {
  let cfg: Record<string, any>
  try {
    cfg = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'))
  } catch {
    return
  }
  cfg = stripOurHooks(cfg)
  try {
    fs.writeFileSync(SETTINGS_JSON, JSON.stringify(cfg, null, 2), 'utf8')
  } catch {
    /* 무시 */
  }
}

function handleEventFile(file: string): void {
  let ev: any
  try {
    ev = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return
  } finally {
    try {
      fs.rmSync(file, { force: true }) // 멱등 — 파싱 성공/실패 무관하게 한 번만 처리
    } catch {
      /* 무시 */
    }
  }
  if (!ev || !ev.projectId) return
  const verb = String(ev.event) === 'SessionStart' ? '시작' : '종료'
  addCcEvent(String(ev.projectId), String(ev.sessionId ?? ''), String(ev.event ?? ''))
  notifyUser('클로드코드', `${ev.projectId} — 독립 클로드 세션 ${verb}`)
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
  drainEvents() // 연동이 꺼져 있던 동안 쌓인 이벤트 먼저 소화
  try {
    watcher = fs.watch(EVENTS_DIR, () => {
      if (drainTimer) clearTimeout(drainTimer)
      drainTimer = setTimeout(drainEvents, 150) // 디바운스 — 파일 쓰기 완료 후 일괄 처리
    })
  } catch {
    /* 무시 — watch 실패해도 다음 applyCcHooks/시동에서 drain */
  }
}

function stopWatcher(): void {
  try {
    watcher?.close()
  } catch {
    /* 무시 */
  }
  watcher = null
}

/** 시동·설정변경 시 호출 — 토글 상태에 맞춰 훅 설치/제거 + inbox 감시 시작/중지. */
export function applyCcHooks(): void {
  if (getSettings().ccHooksEnabled) {
    installHooks()
    startWatcher()
  } else {
    stopWatcher()
    uninstallHooks()
  }
}
