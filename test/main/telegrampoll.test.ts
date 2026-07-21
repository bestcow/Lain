// 텔레그램 폴 루프 순수 헬퍼 — 백오프 계산·재연결 공지 판정을 박제. 네트워크·fetch 없이 순수 함수만 검증.
import { describe, it, expect } from 'vitest'
import {
  nextBackoff,
  shouldAnnounceReconnect,
  buildReconnectMessage,
  RECONNECT_FAIL_THRESHOLD,
} from '../../src/main/telegrampoll'

describe('nextBackoff', () => {
  it('실패마다 2배, 1s에서 시작해 30s 상한', () => {
    let b = 1000
    const seq = [b]
    for (let i = 0; i < 8; i++) {
      b = nextBackoff(b)
      seq.push(b)
    }
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000])
  })
  it('cap을 바꾸면 그 값에서 상한', () => {
    expect(nextBackoff(50000, 60000)).toBe(60000)
    expect(nextBackoff(20000, 60000)).toBe(40000)
  })
})

describe('shouldAnnounceReconnect', () => {
  it('문턱 미만은 침묵(false), 이상이면 공지(true)', () => {
    expect(shouldAnnounceReconnect(0)).toBe(false)
    expect(shouldAnnounceReconnect(RECONNECT_FAIL_THRESHOLD - 1)).toBe(false)
    expect(shouldAnnounceReconnect(RECONNECT_FAIL_THRESHOLD)).toBe(true)
    expect(shouldAnnounceReconnect(RECONNECT_FAIL_THRESHOLD + 5)).toBe(true)
  })
  it('커스텀 문턱', () => {
    expect(shouldAnnounceReconnect(3, 3)).toBe(true)
    expect(shouldAnnounceReconnect(2, 3)).toBe(false)
  })
})

describe('buildReconnectMessage', () => {
  it('끊긴 시간대와 지속 시간을 담는다(초 단위)', () => {
    const first = new Date('2026-07-16T07:23:10').getTime()
    const recovered = new Date('2026-07-16T07:23:55').getTime()
    const msg = buildReconnectMessage(first, recovered)
    expect(msg).toContain('⚡ 봇 재연결')
    expect(msg).toContain('07:23:10~07:23:55')
    expect(msg).toContain('45초')
  })
  it('분 단위 지속 시간', () => {
    const first = new Date('2026-07-16T07:00:00').getTime()
    const recovered = new Date('2026-07-16T07:03:30').getTime()
    const msg = buildReconnectMessage(first, recovered)
    expect(msg).toContain('4분') // round(210s/60) = 4분
  })
  it('시간 단위 지속 시간', () => {
    const first = new Date('2026-07-16T07:00:00').getTime()
    const recovered = new Date('2026-07-16T09:15:00').getTime()
    const msg = buildReconnectMessage(first, recovered)
    expect(msg).toContain('2시간 15분')
  })
})
