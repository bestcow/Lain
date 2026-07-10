// vitest용 electron 스텁 — paths.ts가 모듈 평가 시 호출하는 app.* 표면만 채운다.
// 진짜 차단요인은 SDK가 아니라 electron(런타임 밖에선 app === undefined → throw)이다.
// DATA_DIR을 테스트 고유 tmp 디렉터리로 잡으려고 LAIN_TEST_DATA_DIR 환경변수를 우선 본다.
import os from 'node:os'
import path from 'node:path'

const dataDir = process.env.LAIN_TEST_DATA_DIR || path.join(os.tmpdir(), 'lain-vitest')

export const app = {
  isPackaged: false,
  getPath: (_name: string) => dataDir,
  getName: () => 'lain',
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-test',
  on: () => {},
  quit: () => {},
  whenReady: () => Promise.resolve(),
}

// paths.ts는 app만 쓰지만, 다른 모듈이 import 체인에 끌고 올 수 있는 표면을 빈 스텁으로 둔다.
export class BrowserWindow {}
export class Notification {
  show(): void {}
}
export const ipcMain = { handle: () => {}, on: () => {} }
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} }
export const Tray = class {}
export const nativeImage = { createFromPath: () => ({}), createFromDataURL: () => ({}) }
export const clipboard = { readText: () => '', writeText: () => {} }
export const dialog = { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) }
export const shell = { openExternal: () => Promise.resolve(), showItemInFolder: () => {} }

export default { app, BrowserWindow, Notification, ipcMain, Menu, Tray, nativeImage, clipboard, dialog, shell }
