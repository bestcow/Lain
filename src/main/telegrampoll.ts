// 텔레그램 폴 루프 순수 헬퍼 — 백오프 계산·재연결 공지 판정을 박제(결정론, 테스트 용이).
// IO(fetch/api/send)는 telegram.ts가 담당하고, 여기는 계산만 한다.

/** 폴 실패 시 다음 대기(ms) — 1s에서 시작해 실패마다 2배, cap(기본 30s)에서 상한. 성공 시 호출자가 1000으로 리셋. */
export function nextBackoff(current: number, cap = 30000): number {
  return Math.min(current * 2, cap)
}

/** 재연결 알림 문턱 — 이 값 미만의 연속 실패(짧은 순단)는 침묵, 이상이면 회복 시 공지. */
export const RECONNECT_FAIL_THRESHOLD = 10

/** 연속 실패 후 회복 시 '재연결' 공지를 보낼지 판정 — 짧은 순단엔 스팸 방지로 침묵. */
export function shouldAnnounceReconnect(
  consecutiveFails: number,
  threshold = RECONNECT_FAIL_THRESHOLD,
): boolean {
  return consecutiveFails >= threshold
}

function fmtClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}초`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}분`
  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

/** 재연결 공지 메시지 — 끊긴 시간대(로컬 시:분:초)와 지속 시간을 사람말로. */
export function buildReconnectMessage(firstFailAt: number, recoveredAt: number): string {
  return `⚡ 봇 재연결 — ${fmtClock(firstFailAt)}~${fmtClock(recoveredAt)} 동안 끊겼었다 (${fmtDuration(
    recoveredAt - firstFailAt,
  )})`
}
