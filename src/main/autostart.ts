// 로그인 자동 시작 — setLoginItemSettings 래퍼 + StartupApproved 자가 복구.
// Win11(빌드 26200)은 StartupApproved\Run에 레코드가 '아예 없는' Run 항목을 로그온 때 조용히 무시한다
// (전통적 "없음=활성"이 아님 — Shell-Core 이벤트 실측). Electron setLoginItemSettings는 Run 키만 쓰고
// StartupApproved는 안 만드는 데다, 재설치/deploy 후 레코드가 사라지는 재발이 확인돼(2026-07-10·07-13)
// 자동 시작을 켤 때마다 레코드를 복구한다.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { appendCapped } from './logfile'
import { DATA_DIR } from './paths'

const APPROVED_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
// Electron이 Run 키에 등록하는 값 이름(electron.app.<name>)과 반드시 일치해야 한다.
const VALUE_NAME = 'electron.app.lain'
const ENABLED_BINARY = '020000000000000000000000' // 첫 바이트 02=활성 (03=사용자가 작업관리자에서 비활성)

export function applyAutoStart(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
  if (enabled && process.platform === 'win32') ensureStartupApproved()
}

// 레코드가 없을 때만 02(활성)를 만든다. 이미 있으면 02든 03이든 손대지 않는다 —
// 03은 사용자가 작업관리자에서 직접 끈 의사라 강제 재활성하면 안 된다.
function ensureStartupApproved(): void {
  execFile('reg.exe', ['query', APPROVED_KEY, '/v', VALUE_NAME], { windowsHide: true }, (err) => {
    if (!err) return // 레코드 존재 — 존중
    execFile(
      'reg.exe',
      ['add', APPROVED_KEY, '/v', VALUE_NAME, '/t', 'REG_BINARY', '/d', ENABLED_BINARY, '/f'],
      { windowsHide: true },
      (addErr) => {
        appendCapped(
          path.join(DATA_DIR, 'recovery.log'),
          `${new Date().toISOString()} startup-approved ${addErr ? `restore failed: ${addErr.message}` : 'record restored (02)'}\n`,
        )
      },
    )
  })
}
