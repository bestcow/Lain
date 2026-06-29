// Phase 3 트레이 상주 (§12.5b) — 창을 닫아도 트레이에 남아 Navi 동작 지속.
// 툴팁·메뉴에 작업중/blocked/review/승인대기 카운트 표시 (뱃지 대용).
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { listApprovals, listTasks } from './store'
import { runScanOnce } from './scheduler'

// 16x16 CRT 그린 사각 아이콘 (자산 파이프라인 없이 코드에 내장)
const ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQklEQVR4nGO0/C/yn4ECwAIiTrP/JEuz6U92BiYGCgETpQawYHMWPoDuXSZKXcA0agDDIEwHp0lM1oPEC4SSLz4AAGaHC3NoqUDKAAAAAElFTkSuQmCC'
// 위 아이콘 + 우하단 빨간 경보점 합성 (대기건 있을 때)
const ALERT_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQUlEQVR4nGOw/C/ynxLMACJY2HjJwoPUAEJ+HskGaDAwoGCSDEDXDMNEGYBLMwxT3wB0PPAG4DMEHojEYGyaQRgAKQ2V13SYafQAAAAASUVORK5CYII='
// 작업표시줄 오버레이용 빨간 점 (투명 배경)
const OVERLAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAN0lEQVR4nGNgoBUwYmD4j47J1ki0QcRoxmkIKZqxGkKRAeRoRjFk1IDBEI1USYlUyQuEDMKmDgA0i9LijoCGngAAAABJRU5ErkJggg=='

const baseImage = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_B64}`)
const alertImage = nativeImage.createFromDataURL(`data:image/png;base64,${ALERT_ICON_B64}`)
const overlayImage = nativeImage.createFromDataURL(`data:image/png;base64,${OVERLAY_ICON_B64}`)

let tray: Tray | null = null
let quitting = false
let getWin: () => BrowserWindow | null = () => null
let createWin: () => void = () => {}

export function isQuitting(): boolean {
  return quitting
}

function showWindow(): void {
  const win = getWin()
  if (win) {
    win.show()
    win.focus()
  } else {
    createWin()
  }
}

export function setupTray(getWindow: () => BrowserWindow | null, createWindow: () => void): void {
  getWin = getWindow
  createWin = createWindow
  app.on('before-quit', () => {
    quitting = true
  })
  tray = new Tray(baseImage)
  tray.on('click', showWindow)
  refreshTray()
}

/** 작업/승인 상태가 바뀔 때마다 호출 — 툴팁·메뉴 카운트 갱신 */
export function refreshTray(): void {
  if (!tray) return
  const tasks = listTasks()
  const working = tasks.filter((t) => t.state === 'working' || t.state === 'clarifying').length
  const blocked = tasks.filter((t) => t.state === 'blocked').length
  const review = tasks.filter((t) => t.state === 'review').length
  const pending = listApprovals().length // pending만 반환됨
  tray.setToolTip(
    `Lain — 작업중 ${working} · 막힘 ${blocked} · 결재 ${review} · 승인대기 ${pending}`,
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '열기', click: showWindow },
      { type: 'separator' },
      {
        label: `작업중 ${working} / 막힘 ${blocked} / 결재 ${review} / 승인 ${pending}`,
        enabled: false,
      },
      { label: '지금 스캔', click: () => void runScanOnce() },
      { type: 'separator' },
      {
        label: '종료',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  // 뱃지: 대기건(막힘+결재+승인대기) 있으면 경보 아이콘 + 작업표시줄 오버레이
  const attn = blocked + review + pending
  tray.setImage(attn > 0 ? alertImage : baseImage)
  getWin()?.setOverlayIcon(attn > 0 ? overlayImage : null, attn > 0 ? `대기 ${attn}건` : '')
}
