// 로그인 자동 시작 — Windows는 작업 스케줄러(로그온 트리거), 그 외 OS는 setLoginItemSettings.
//
// Run키+StartupApproved 방식은 폐기(2026-07-16): StartupApproved 02(활성) 레코드를 자가복구해도
// 다음 부팅 전에 매번 다시 사라지는 것이 recovery.log로 실측됐다(레인 시작마다 'restored' 반복 →
// 로그온 시점엔 레코드 부재 → Windows가 Run 항목을 조용히 무시 → 12시간+ 무기동 실사고 2026-07-16).
// 스케줄러 태스크는 StartupApproved의 영향을 받지 않는다. schtasks.exe CLI는 ONLOGON 생성이 권한
// 거부되는 반면 PowerShell ScheduledTasks 모듈은 현재 사용자 로그온 트리거를 비관리자로 생성 가능(실측).
import { app } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { appendCapped } from './logfile'
import { DATA_DIR } from './paths'

const TASK_NAME = 'lain-autostart'

function alog(m: string): void {
  appendCapped(path.join(DATA_DIR, 'recovery.log'), `${new Date().toISOString()} autostart ${m}\n`)
}

function runPs(script: string, cb: (err: Error | null, stdout: string) => void): void {
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 30_000 },
    (err, stdout) => cb(err, String(stdout ?? '')),
  )
}

export function applyAutoStart(enabled: boolean): void {
  if (process.platform !== 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    return
  }
  // Windows — 예전 Run키 등록은 항상 제거(스케줄러와 이중 기동 시 second-instance가 창을 띄우는
  // 팝업 회귀 방지 + Electron의 Run키 재등록이 StartupApproved를 건드리는 변수 자체를 제거).
  try {
    app.setLoginItemSettings({ openAtLogin: false })
  } catch {
    /* 무해 — 레지스트리 접근 실패해도 태스크 경로가 본선 */
  }
  if (!app.isPackaged) return // dev(electron.exe)는 태스크 등록이 무의미
  if (enabled) ensureTask()
  else removeTask()
}

/** 태스크가 없거나 실행 경로가 다르면 (재)등록. 있으면 그대로 — 부팅마다 호출돼도 무해(멱등). */
function ensureTask(): void {
  const exe = process.execPath
  const script =
    `$t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; ` +
    `$cur = if ($t) { ($t.Actions | Select-Object -First 1).Execute } else { '' }; ` +
    `if (-not $t -or $cur -ne '${exe}') { ` +
    `$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '--hidden'; ` +
    `$tr = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; ` +
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $tr -Force | Out-Null; ` +
    `Write-Output 'REGISTERED' } else { Write-Output 'OK' }`
  runPs(script, (err, out) => {
    if (err) alog(`태스크 등록 실패: ${err.message.slice(0, 200)}`)
    else if (out.includes('REGISTERED')) alog(`로그온 태스크 (재)등록 — ${exe}`)
  })
}

function removeTask(): void {
  runPs(
    `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
    (err) => {
      if (err) alog(`태스크 제거 실패: ${err.message.slice(0, 200)}`)
    },
  )
}
