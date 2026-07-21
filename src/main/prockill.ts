// 프로세스 트리 강제 종료 — 공용 헬퍼.
// Windows에서 셸(cmd.exe)이나 npm 셔틀을 자식으로 띄우면 실제 작업(node/vitest 등)은 손자로 붙는다.
// 직속 자식만 SIGTERM/kill하면 손자가 고아로 잔존하므로, win32는 `taskkill /T`로 트리 전체를 잡는다.
// codex.ts(codex.js→네이티브 codex.exe)와 collectors.ts(verify 셸 명령)가 같은 문제를 공유해 한 곳으로 모았다.
import { spawnSync } from 'node:child_process'

/** child의 pid로 프로세스 트리를 강제 종료한다.
 *  - win32: `taskkill /PID <pid> /T /F` — 자손 포함 트리 전체 종료(셸/셔틀 손자 고아 방지).
 *  - 그 외: 표준 `process.kill(pid, signal)`(직속 프로세스만; 기존 동작 유지).
 *  이미 죽었거나 권한 오류면 조용히 무시한다. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true })
    } catch {
      /* 이미 죽었으면 무시 */
    }
    return
  }
  try {
    process.kill(pid, signal)
  } catch {
    /* 이미 죽었으면 무시 */
  }
}
