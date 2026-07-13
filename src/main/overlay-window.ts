// 어깨너머 오버레이 창 — 우하단 프레임리스·투명·상주 창.
// 메인창을 안 볼 때(숨김/최소화)만 표시하고, 표시될 때만 감시 루프를 돌린다(syncOverlayMode).
import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { getSettings } from './store'
import { startWatcher, stopWatcher } from './watcher'
import { DATA_DIR } from './paths'
import { appendCapped } from './logfile'

const OVERLAY_W = 360
const OVERLAY_H = 120 // 초기 높이 — 렌더러가 내용에 맞춰 resizeOverlay로 조정
const MARGIN = 16

// 진단 로그 — 어깨너머 표시 경로를 추적(silent catch가 원인을 숨기던 문제).
function olog(m: string): void {
  appendCapped(path.join(DATA_DIR, 'overlay.log'), `${new Date().toISOString()} ${m}\n`)
}

let overlayWin: BrowserWindow | null = null
let getMainWin: () => BrowserWindow | null = () => null

export function setMainWindowGetter(fn: () => BrowserWindow | null): void {
  getMainWin = fn
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWin
}

// 커서가 있는 디스플레이 기준 — 보조 모니터에서 작업 중이면 그쪽에 뜬다(주모니터 고정 방지, B8).
function cursorDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

function bottomRight(width: number, height: number): { x: number; y: number } {
  const { workArea } = cursorDisplay()
  return {
    x: workArea.x + workArea.width - width - MARGIN,
    y: workArea.y + workArea.height - height - MARGIN,
  }
}

export function createOverlayWindow(): BrowserWindow {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  const win = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false, // 포커스 안 뺏음 — 작업 흐름 방해 금지
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })
  // 전체화면 앱(예: FL스튜디오 풀스크린) 위에도 보이도록 z 순서를 올린다.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  olog('overlay window created')
  overlayWin = win
  win.on('closed', () => {
    if (overlayWin === win) overlayWin = null
  })
  // 오버레이 렌더러가 죽으면(GPU 등) 빈 창으로 남지 않게 자동 reload (메인창과 동일 정책).
  // 반복 크래시엔 지수 백오프(1s→60s 상한), 5분 생존 시 카운터 리셋 — 메인창과 동일.
  let crashCount = 0
  let lastCrashAt = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    olog(`overlay render-process-gone: ${JSON.stringify(details)}`)
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
      const now = Date.now()
      if (now - lastCrashAt > 5 * 60_000) crashCount = 0
      lastCrashAt = now
      crashCount++
      const delay = Math.min(1000 * 2 ** (crashCount - 1), 60_000)
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reload()
      }, delay)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/overlay/index.html'))
  }
  return win
}

export function showOverlay(): void {
  try {
    const win = createOverlayWindow()
    const { x, y } = bottomRight(win.getBounds().width, win.getBounds().height)
    win.setPosition(x, y)
    if (!win.isVisible()) win.showInactive() // 포커스 없이 표시
    olog(`showOverlay ok visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`)
  } catch (e) {
    olog(`showOverlay ERROR: ${e instanceof Error ? e.stack || e.message : e}`)
    throw e
  }
}

export function hideOverlay(): void {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) overlayWin.hide()
}

export function destroyOverlayWindow(): void {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy()
  overlayWin = null
}

// 렌더러(overlay.tsx)가 내용 높이를 알려오면 우하단 앵커를 유지하며 창 높이를 맞춘다(스크롤 없이 한눈에).
export function resizeOverlay(height: number): void {
  const win = overlayWin
  if (!win || win.isDestroyed()) return
  try {
    // showOverlay가 잡은 커서 모니터를 리사이즈에서도 유지 — primary 고정이면 표시 후 첫 리사이즈에
    // 창이 다시 주모니터로 튀는 회귀가 생긴다.
    const { workArea } = cursorDisplay()
    const h = Math.max(40, Math.min(Math.floor(height) || OVERLAY_H, workArea.height - 2 * MARGIN))
    const x = workArea.x + workArea.width - OVERLAY_W - MARGIN
    const y = workArea.y + workArea.height - h - MARGIN
    win.setBounds({ x, y, width: OVERLAY_W, height: h })
  } catch {
    /* 디스플레이 조회 실패 — 위치 유지 */
  }
}

// 메인창을 다시 띄운다(오버레이 클릭 시). 포커스까지.
export function openMainWindow(): void {
  const main = getMainWin()
  if (!main || main.isDestroyed()) return
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
}

// 단일 평가 — (유저 감시 ON && 메인창 비활성)이면 '감시'만 돌린다(화면 관찰). 오버레이는 평소 숨김 —
// Lain이 먼저 말을 걸 때(proactive 반응)만 setOverlayVisible로 잠깐 떴다 사라진다(상시 표시 안 함).
export function syncOverlayMode(): void {
  try {
    const enabled = getSettings().overlayMonitoringEnabled
    const main = getMainWin()
    const mainActive = !!(main && !main.isDestroyed() && main.isVisible() && !main.isMinimized())
    olog(`sync enabled=${enabled} mainActive=${mainActive} -> ${enabled && !mainActive ? 'WATCH' : 'off'}`)
    if (enabled && !mainActive) {
      startWatcher() // 감시만 — 오버레이는 반응 시에만 표시
    } else {
      hideOverlay()
      stopWatcher()
    }
  } catch (e) {
    // 설정 읽기/표시 실패 — 원인을 로그로 남기고 안전하게 끈다.
    olog(`sync ERROR: ${e instanceof Error ? e.stack || e.message : e}`)
    hideOverlay()
    stopWatcher()
  }
}

// 렌더러(overlay.tsx)가 proactive 반응 시 표시를 요청 — (유저 감시 ON && 메인 비활성)일 때만 띄운다. 숨김은 항상 허용.
export function setOverlayVisible(visible: boolean): void {
  try {
    if (!visible) {
      hideOverlay()
      return
    }
    const enabled = getSettings().overlayMonitoringEnabled
    const main = getMainWin()
    const mainActive = !!(main && !main.isDestroyed() && main.isVisible() && !main.isMinimized())
    if (enabled && !mainActive) showOverlay()
  } catch (e) {
    olog(`setOverlayVisible ERROR: ${e instanceof Error ? e.stack || e.message : e}`)
  }
}
