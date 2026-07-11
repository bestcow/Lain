// 어깨너머 감시 루프 (L0 결정론, LLM 없음 — PLAN.md §4).
// 포그라운드 앱/제목·유휴를 싸게 폴링하고, 트리거(유휴 진입·앱 전환·제목 변화) + 쿨다운 통과 시
// 관찰 꾸러미를 onObserve로 넘긴다. 판단(말할지/무엇을)은 L1(manager.reactToObservation)이 한다.
//
// 포그라운드 감지: Windows 내장 API가 Electron에 없어 PowerShell(Win32) '단일 상주 프로세스'로 폴링한다
// (틱마다 spawn하면 Add-Type 재컴파일 비용이 커서 1개를 띄워 stdout 라인을 읽는다). 네이티브 npm 모듈 회피.
import { powerMonitor, desktopCapturer, screen } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getSettings } from './store'
import { overlayCooldownScale } from './quips'
import { DATA_DIR } from './paths'
import { appendCapped } from './logfile'

export type ObservationReason = 'idle' | 'app-switch' | 'title-change'
export type Observation = {
  app: string // 프로세스 이름 (예: WINWORD, Code, FL64)
  title: string // 창 제목 (시크릿일 수 있어 로그엔 남기지 않는다 §9-6)
  idleSec: number
  reason: ObservationReason
  contentText?: string // 제목에서 절대경로가 잡히면 그 파일 직독(정확·저렴)
  screenshot?: { base64: string; mimeType: 'image/png' } // 다운스케일 화면 캡처(GUI·FL스튜디오 등 '본다')
}

const IDLE_TRIGGER_SEC = 4 // 타이핑하다 이만큼 멈추면 '유휴 진입' 트리거
const AWAY_SEC = 300 // 이보다 오래 자리 비우면 굳이 말 안 함(부재중)
const SELF_APPS = ['electron', 'lain'] // 우리 창은 감시 대상에서 제외

let psProc: ChildProcessWithoutNullStreams | null = null
let onObserve: ((obs: Observation) => void) | null = null
let lastApp = ''
let lastTitle = ''
let lastReactionAt = 0
let wasIdle = false
let stdoutBuf = ''
let capturing = false // 캡처 in-flight — 중첩 desktopCapturer 호출 방지(직렬화)
let intentionalStop = false // stopWatcher로 끈 것인지 — 비정상 종료만 자동 재시작
let restartCount = 0 // 연속 비정상 재시작 횟수(살아있는 출력 받으면 0으로 리셋, 5회 초과 시 포기)

export function setObserveHandler(fn: ((obs: Observation) => void) | null): void {
  onObserve = fn
}

function log(line: string): void {
  // 앱명·사유·유휴만 — 창 제목/내용은 남기지 않는다(§9-6). 회전 있는 append(무한 성장 방지).
  try {
    appendCapped(path.join(DATA_DIR, 'watcher.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 로그 실패 무시 */
  }
}

function isSensitive(app: string, title: string, blacklist: string[]): boolean {
  const hay = `${app}\n${title}`.toLowerCase()
  return blacklist.some((b) => b && hay.includes(b.toLowerCase()))
}

// 단일 상주 PowerShell 스크립트 — Add-Type 1회 후 루프하며 "프로세스명\t제목"을 interval마다 출력.
function buildPsScript(pollMs: number): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class LainFg {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);',
    '}',
    '"@',
    'while ($true) {',
    '  $h = [LainFg]::GetForegroundWindow()',
    '  $sb = New-Object System.Text.StringBuilder 512',
    '  [LainFg]::GetWindowText($h, $sb, 512) | Out-Null',
    '  $procId = 0',
    '  [LainFg]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null',
    '  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue',
    "  $name = if ($p) { $p.ProcessName } else { '' }",
    '  Write-Output ($name + [char]9 + $sb.ToString())',
    '  [Console]::Out.Flush()',
    `  Start-Sleep -Milliseconds ${pollMs}`,
    '}',
  ].join('\n')
}

function handleLine(raw: string): void {
  const line = raw.replace(/\r$/, '')
  if (!line) return
  if (restartCount) restartCount = 0 // 살아있는 출력 = 건강 → 자동 재시작 카운터 리셋
  const tab = line.indexOf('\t')
  const app = (tab >= 0 ? line.slice(0, tab) : line).trim()
  const title = tab >= 0 ? line.slice(tab + 1).trim() : ''
  if (!app || SELF_APPS.includes(app.toLowerCase())) {
    lastApp = app
    lastTitle = title
    return
  }

  let s: ReturnType<typeof getSettings>
  try {
    s = getSettings()
  } catch {
    return
  }
  // 민감 앱이 포그라운드면 콘텐츠·반응 일절 스킵 (상태만 갱신)
  if (isSensitive(app, title, s.monitorSensitiveApps)) {
    lastApp = app
    lastTitle = title
    wasIdle = false
    return
  }

  const idleSec = Math.round(powerMonitor.getSystemIdleTime())
  const appChanged = app !== lastApp && lastApp !== ''
  const titleChanged = title !== lastTitle && lastTitle !== ''
  const justWentIdle = idleSec >= IDLE_TRIGGER_SEC && !wasIdle && idleSec < AWAY_SEC
  wasIdle = idleSec >= IDLE_TRIGGER_SEC

  let reason: ObservationReason | null = null
  if (appChanged) reason = 'app-switch'
  else if (justWentIdle) reason = 'idle'
  else if (titleChanged) reason = 'title-change'

  lastApp = app
  lastTitle = title
  if (!reason) return

  const now = Date.now()
  // 말수(chattiness) 배수 — 정책표 단일 출처(quips). 0(묵언)은 ∞라 반응 트리거가 아예 통과하지 못해
  // 스크린샷 캡처·LLM 비용이 발생하지 않는다(manager.reactToObservation의 게이트와 이중 방어).
  const cooldownMs = Math.max(5, s.monitorCooldownSec) * 1000 * overlayCooldownScale(s.chattiness)
  if (now - lastReactionAt < cooldownMs) return
  if (capturing) return // 직전 캡처가 아직 진행 중 — 이번 트리거는 건너뜀(중첩 방지)
  lastReactionAt = now

  log(`observe reason=${reason} app=${app} idle=${idleSec}`)
  void emitObservation({ app, title, idleSec, reason })
}

// 제목에 절대경로(C:\...\name.ext)가 보이고 실제 존재하면 그 파일을 직독한다(존재할 때만 — 오판 안전).
function tryReadFileFromTitle(title: string): string | undefined {
  const m = title.match(/[A-Za-z]:\\[^\t\r\n"<>|?*]+\.[A-Za-z0-9]{1,8}/)
  if (!m) return undefined
  const p = m[0]
  try {
    const st = fs.statSync(p)
    if (st.isFile() && st.size < 1_000_000) return fs.readFileSync(p, 'utf8').slice(0, 6000)
  } catch {
    /* 없거나 못 읽음 — 스크린샷으로 대체 */
  }
  return undefined
}

const CAPTURE_LONG_EDGE = 1568 // Anthropic 비전 실효 최대(장변) — 이보다 크면 API가 어차피 축소해 이득이 없다

// 포그라운드 '창'을 우선 창 단위로 캡처 — 전체 화면 축소보다 같은 토큰에 훨씬 선명해
// 채팅 글씨·공유 이미지까지 판독된다. 제목 매칭 실패(UWP·보호 창 등)면 주 디스플레이 전체로 폴백.
async function captureScreen(fgTitle?: string): Promise<string | undefined> {
  try {
    if (fgTitle) {
      const wins = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: CAPTURE_LONG_EDGE, height: CAPTURE_LONG_EDGE },
      })
      const hit = wins.find((w) => w.name === fgTitle) ?? wins.find((w) => w.name.includes(fgTitle))
      if (hit && !hit.thumbnail.isEmpty()) return hit.thumbnail.toPNG().toString('base64')
    }
    const { width, height } = screen.getPrimaryDisplay().size
    const scale = Math.min(1, CAPTURE_LONG_EDGE / Math.max(1, width, height))
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
    })
    const src = sources[0]
    if (!src || src.thumbnail.isEmpty()) return undefined
    return src.thumbnail.toPNG().toString('base64')
  } catch (e) {
    log(`capture failed: ${e}`)
    return undefined
  }
}

// 가장 싼·정확한 소스를 모아 L1로 넘긴다: 파일 직독(되면) + 스크린샷(항상, 본다). 라인 루프를 막지 않게 비동기.
async function emitObservation(base: Observation): Promise<void> {
  capturing = true
  try {
    const contentText = tryReadFileFromTitle(base.title)
    const b64 = await captureScreen(base.title)
    const obs: Observation = {
      ...base,
      contentText,
      screenshot: b64 ? { base64: b64, mimeType: 'image/png' } : undefined,
    }
    onObserve?.(obs)
  } catch (e) {
    log(`emitObservation error: ${e}`)
  } finally {
    capturing = false
  }
}

export function startWatcher(): void {
  if (psProc) return
  let pollMs = 1500
  try {
    pollMs = Math.max(500, getSettings().monitorPollMs)
  } catch {
    /* 설정 실패 — 기본 1500ms */
  }
  lastApp = ''
  lastTitle = ''
  wasIdle = false
  stdoutBuf = ''
  intentionalStop = false
  try {
    // 스크립트를 파일로 떨구고 -File로 실행 — 여기-스트링/Add-Type 인용 문제를 피한다.
    const scriptPath = path.join(DATA_DIR, 'foreground-watch.ps1')
    fs.writeFileSync(scriptPath, buildPsScript(pollMs), 'utf8')
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    )
    psProc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        handleLine(line)
      }
      // 개행 없는 비정상 폭주 출력에서 버퍼 무한 성장 방지(라인은 ~512자라 실무상 미발동).
      if (stdoutBuf.length > 8192) stdoutBuf = ''
    })
    // stderr를 소비하지 않으면 OS 파이프 버퍼(~64KB)가 차는 순간 자식이 write에서 블록돼 폴링이 멎는다 — drain.
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', () => {})
    proc.on('error', (e) => {
      log(`powershell spawn error: ${e}`)
      if (psProc === proc) psProc = null
    })
    proc.on('exit', (code) => {
      log(`powershell exited code=${code}`)
      if (psProc === proc) psProc = null
      // 비정상 종료(의도된 stop 아님)면 짧은 backoff 후 자동 재시작 — 단 연속 5회 초과 시 포기(크래시 루프 방지).
      // 살아있는 출력을 받으면 handleLine이 restartCount를 0으로 리셋한다.
      if (!intentionalStop && restartCount < 5) {
        restartCount++
        log(`watcher auto-restart #${restartCount} in 5s`)
        setTimeout(() => {
          if (!psProc && !intentionalStop) startWatcher()
        }, 5000)
      }
    })
    log(`watcher started pollMs=${pollMs}`)
  } catch (e) {
    log(`startWatcher failed: ${e}`)
    psProc = null
  }
}

export function stopWatcher(): void {
  const proc = psProc
  psProc = null
  intentionalStop = true // 자동 재시작 억제
  restartCount = 0
  if (proc) {
    try {
      proc.kill()
    } catch {
      /* 종료 실패 무시 */
    }
    log('watcher stopped')
  }
}

export function isWatcherRunning(): boolean {
  return psProc != null
}

// 본체 레인 채팅 주입용 — 사용자가 지금 보고 있는 앱/창. 민감 앱은 노출 안 함(§9-6), watcher 꺼짐·자기 창이면 null.
export function getForeground(): { app: string; title: string } | null {
  if (!psProc || !lastApp) return null
  if (SELF_APPS.includes(lastApp.toLowerCase())) return null
  try {
    if (isSensitive(lastApp, lastTitle, getSettings().monitorSensitiveApps)) return null
  } catch {
    return null
  }
  return { app: lastApp, title: lastTitle }
}
