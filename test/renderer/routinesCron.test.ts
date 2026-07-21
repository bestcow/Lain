import { describe, it, expect } from 'vitest'
import { buildCron } from '../../src/renderer/components/RoutinesPanel'

// 시간별 루틴 분(minute) 회귀 방지 — hourly는 분 인자가 그대로 hourly:MM에 반영돼야 한다.
// (과거: submit()이 time state에서 분을 유도해 항상 hourly:0으로 저장되던 버그)
describe('buildCron — hourly', () => {
  it('분 인자를 그대로 hourly:MM에 반영', () => {
    expect(buildCron('hourly', 0, 30, 1, 30)).toBe('hourly:30')
    expect(buildCron('hourly', 9, 15, 1, 30)).toBe('hourly:15')
  })
  it('범위 밖 분(0~59 아님)은 null', () => {
    expect(buildCron('hourly', 0, 60, 1, 30)).toBeNull()
    expect(buildCron('hourly', 0, -1, 1, 30)).toBeNull()
  })
})

describe('buildCron — interval', () => {
  it('경과분 그대로 interval:N', () => {
    expect(buildCron('interval', 0, 0, 0, 45)).toBe('interval:45')
  })
})
