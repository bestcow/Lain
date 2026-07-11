// 회전(rotation) 있는 append 로그 — 진단/stderr 로그가 상한 없이 무한 성장하던 문제(디스크 잠식) 차단.
// 파일이 maxBytes를 넘으면 .1로 한 번 회전(이전 .1은 덮어씀)하고 새로 쓴다. 모든 실패는 무해히 삼킨다.
import fs from 'node:fs'

const DEFAULT_MAX = 5 * 1024 * 1024 // 5MB

export function appendCapped(file: string, text: string, maxBytes = DEFAULT_MAX): void {
  try {
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      /* 파일 없음 = size 0 */
    }
    if (size > maxBytes) {
      try {
        fs.renameSync(file, file + '.1') // 직전 .1 덮어씀(2세대 유지)
      } catch {
        // rename 실패(잠금 등) — 잘라쓰기로 폴백
        try {
          fs.truncateSync(file, 0)
        } catch {
          /* 무시 */
        }
      }
    }
    fs.appendFileSync(file, text)
  } catch {
    /* 로그 실패는 절대 호출자를 깨지 않는다 */
  }
}
