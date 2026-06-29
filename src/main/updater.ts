// 자동 업데이트 (electron-updater + GitHub Releases) — 사용자용 배포 채널.
// 감지/다운로드/설치는 결정론(L0). ② Lain '제안 타이밍'만 updategate(순수)로 판정한다.
// 엔진은 패키징본에서만 동작(dev는 'disabled'). ① CLI 업데이트는 미채용(GUI 앱이라 부자연).
// ③ 자동설치 안 함 — autoInstallOnAppQuit=false. 다운로드까지만, 설치(재시작)는 항상 사용자 트리거(업무 중 강제 금지).
import { app } from 'electron'
import path from 'node:path'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types'
import { getSettings, listTasks } from './store'
import { notifyUser } from './notify'
import { shouldSurfaceUpdate } from './updategate'
import { appendCapped } from './logfile'
import { DATA_DIR } from './paths'

const { autoUpdater } = electronUpdater

const ulog = (m: string): void => {
  try {
    appendCapped(path.join(DATA_DIR, 'updater.log'), `${new Date().toISOString()} ${m}\n`)
  } catch {
    /* 로그 실패 무시 */
  }
}

let broadcaster: ((s: UpdateStatus) => void) | null = null
/** 렌더러로 상태를 흘려보낼 broadcaster 주입(ipc.registerIpc에서 설정). */
export function setUpdateBroadcaster(fn: (s: UpdateStatus) => void): void {
  broadcaster = fn
}

let status: UpdateStatus = { state: 'idle', currentVersion: '0.0.0' }
let enabled = false
let wired = false
let pendingVersion: string | null = null // 감지됐으나 아직 제안 안 띄운 버전
let suggestedVersion: string | null = null // 이미 제안 띄운 버전(중복 방지)
let suggestTimer: ReturnType<typeof setInterval> | null = null

function emit(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  try {
    broadcaster?.(status)
  } catch {
    /* 렌더러 reload 찰나 무시 */
  }
}

function workingCount(): number {
  try {
    return listTasks().filter((t) => t.state === 'working' || t.state === 'clarifying').length
  } catch {
    return 0
  }
}

function stopSuggestTimer(): void {
  if (suggestTimer) {
    clearInterval(suggestTimer)
    suggestTimer = null
  }
}

// 작업이 끝나(idle) 제안할 만한 때가 되면 한 번 띄운다. pending 있고 아직 안 띄운 버전일 때만.
function maybeSuggest(): void {
  if (!pendingVersion || suggestedVersion === pendingVersion) {
    stopSuggestTimer()
    return
  }
  if (!shouldSurfaceUpdate(workingCount(), getSettings().updateNotify)) return
  suggestedVersion = pendingVersion
  stopSuggestTimer()
  emit({ suggested: true })
  ulog(`suggest ${pendingVersion}`)
  try {
    notifyUser('업데이트 있음', `새 버전 ${pendingVersion} 나왔어 — 지금 받을까?`)
  } catch {
    /* 통지 실패 무시 */
  }
}

// 작업 중이라 보류했으면, 한가해질 때까지 주기적으로 재평가(가벼움 — 작업 수만 셈, LLM/네트워크 없음).
function armSuggestTimer(): void {
  if (suggestTimer) return
  suggestTimer = setInterval(maybeSuggest, 120_000)
  ;(suggestTimer as { unref?: () => void }).unref?.()
}

/** 설정(자동 다운로드) 변경을 엔진에 반영 — ipc settings:set 부수효과에서 호출. */
export function applyUpdaterSettings(): void {
  if (!enabled) return
  autoUpdater.autoDownload = getSettings().updateAutoDownload
}

export function initUpdater(): void {
  const currentVersion = app.getVersion()
  status = { state: app.isPackaged ? 'idle' : 'disabled', currentVersion }
  // dev(electron .)는 electron-updater가 못 돈다(릴리스 메타 없음) — 'disabled'로 두고 no-op.
  if (!app.isPackaged || wired) return
  wired = true
  enabled = true

  autoUpdater.autoDownload = getSettings().updateAutoDownload // ③ 켜면 백그라운드 다운로드만
  autoUpdater.autoInstallOnAppQuit = false // 설치는 항상 사용자 트리거
  ;(autoUpdater as { logger: unknown }).logger = null // 자체 로그 끔(우리 updater.log 사용)

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version
    emit({ state: 'available', version: info.version, suggested: false })
    ulog(`available ${info.version}`)
    maybeSuggest()
    armSuggestTimer()
  })
  autoUpdater.on('update-not-available', () => {
    pendingVersion = null
    stopSuggestTimer()
    emit({ state: 'not-available', suggested: false })
  })
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'downloaded', version: info.version })
    ulog(`downloaded ${info.version}`)
  })
  autoUpdater.on('error', (err) => {
    emit({ state: 'error', error: String((err as Error)?.message ?? err) })
    ulog(`error ${err}`)
  })

  setTimeout(() => void checkForUpdates(), 8000) // 부팅 직후 1회
  const t = setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000) // 6시간마다
  ;(t as { unref?: () => void }).unref?.()
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!enabled) return status
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    emit({ state: 'error', error: String(e) })
    ulog(`check fail ${e}`)
  }
  return status
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!enabled) return status
  try {
    emit({ state: 'downloading', percent: 0 })
    await autoUpdater.downloadUpdate()
  } catch (e) {
    emit({ state: 'error', error: String(e) })
    ulog(`download fail ${e}`)
  }
  return status
}

/** 다운로드 완료분을 설치(앱 종료 후 설치·재실행). 사용자가 명시 트리거할 때만. */
export function installUpdate(): void {
  if (!enabled) return
  try {
    autoUpdater.quitAndInstall()
  } catch (e) {
    ulog(`install fail ${e}`)
  }
}
