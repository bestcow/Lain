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

function bottomRight(width: number, height: number): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
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
  win.webContents.on('render-process-gone', (_e, details) => {
    olog(`overlay render-process-gone: ${JSON.stringify(details)}`)
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reload()
      }, 1000)
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
    const { workArea } = screen.getPrimaryDisplay()
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

// 단일 평가 — (어깨너머 ON) && (메인창 비활성)일 때만 오버레이+감시, 아니면 끈다.
export function syncOverlayMode(): void {
  try {
    const enabled = getSettings().overlayMonitoringEnabled
    const main = getMainWin()
    const mainActive = !!(main && !main.isDestroyed() && main.isVisible() && !main.isMinimized())
    olog(
      `sync enabled=${enabled} mainNull=${!main} mainActive=${mainActive} -> ${enabled && !mainActive ? 'SHOW' : 'hide'}`,
    )
    if (enabled && !mainActive) {
      showOverlay()
      startWatcher()
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
