import { describe, it, expect } from 'vitest'
import { shouldSurfaceUpdate } from '../../src/main/updategate'

// ② Lain 자발 제안 타이밍 — 알림 on + 작업 중 Navi 0개일 때만. 작업 중이면 보류(끼어들지 않음).
describe('shouldSurfaceUpdate — 업데이트 제안 타이밍 게이트', () => {
  it('알림 꺼져 있으면 절대 제안 안 함', () => {
    expect(shouldSurfaceUpdate(0, false)).toBe(false)
    expect(shouldSurfaceUpdate(3, false)).toBe(false)
  })

  it('작업 중인 Navi가 있으면 보류(알림 켜져도)', () => {
    expect(shouldSurfaceUpdate(1, true)).toBe(false)
    expect(shouldSurfaceUpdate(5, true)).toBe(false)
  })

  it('알림 켜짐 + 작업 0개면 제안', () => {
    expect(shouldSurfaceUpdate(0, true)).toBe(true)
    expect(shouldSurfaceUpdate(-1, true)).toBe(true) // 방어적: 음수도 0 이하로 취급
  })
})
