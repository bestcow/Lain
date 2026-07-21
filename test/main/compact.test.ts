import { describe, it, expect } from 'vitest'
import {
  contextOccupancyTokens,
  shouldCompact,
  occupancyForMaxTurns,
} from '../../src/main/compactgate'
import { contextPercent } from '../../src/shared/gauge'

describe('contextOccupancyTokens — 컨텍스트 점유량(프롬프트 크기), output 제외', () => {
  it('usage 없으면 0', () => {
    expect(contextOccupancyTokens(null)).toBe(0)
    expect(contextOccupancyTokens({})).toBe(0)
    expect(contextOccupancyTokens({ usage: {} })).toBe(0)
  })

  it('input + cache_read + cache_creation 합산, output_tokens는 제외', () => {
    const msg = {
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 200,
        output_tokens: 9_999_999, // 점유량에 들어가면 안 됨(생성분)
      },
    }
    expect(contextOccupancyTokens(msg)).toBe(6200)
  })

  it('일부 필드 누락은 0으로 처리', () => {
    expect(contextOccupancyTokens({ usage: { input_tokens: 7 } })).toBe(7)
    expect(contextOccupancyTokens({ usage: { cache_read_input_tokens: 3 } })).toBe(3)
  })
})

describe('shouldCompact — 임계 판정(0=완전 비활성)', () => {
  it('threshold 0이면 항상 false(오늘과 동일 동작)', () => {
    expect(shouldCompact(0, 0)).toBe(false)
    expect(shouldCompact(999_999_999, 0)).toBe(false)
  })

  it('점유 < 임계면 false', () => {
    expect(shouldCompact(149_999, 150_000)).toBe(false)
    expect(shouldCompact(0, 150_000)).toBe(false)
  })

  it('점유 >= 임계면 true(경계 포함)', () => {
    expect(shouldCompact(150_000, 150_000)).toBe(true)
    expect(shouldCompact(200_000, 150_000)).toBe(true)
  })
})

// max-turns가 result 대신 throw로 끝나면 점유 기록이 누락돼 압축 게이트가 영영 안 걸리던 버그 수정.
// throw 경로에서 기록할 점유값: 스트림에서 본 마지막 점유가 있으면 그 값, 없으면 임계값(보수적·다음 턴 압축 보장),
// 압축 비활성(threshold 0)이면 0(킬스위치 존중).
describe('occupancyForMaxTurns — max-turns throw 경로의 점유 보정', () => {
  it('threshold 0(비활성)이면 0 — 강제 압축 안 함', () => {
    expect(occupancyForMaxTurns(0, 0)).toBe(0)
    expect(occupancyForMaxTurns(999_999, 0)).toBe(0)
  })

  it('마지막 점유를 못 봤으면 임계값으로 보수 기록 → 다음 턴 압축 보장', () => {
    expect(occupancyForMaxTurns(0, 150_000)).toBe(150_000)
    expect(shouldCompact(occupancyForMaxTurns(0, 150_000), 150_000)).toBe(true)
  })

  it('스트림에서 본 실제 점유가 있으면 그 값을 그대로 기록(임계 위/아래 무관)', () => {
    expect(occupancyForMaxTurns(220_000, 150_000)).toBe(220_000)
    expect(occupancyForMaxTurns(50_000, 150_000)).toBe(50_000)
  })

  it('비활성에선 게이트가 계속 false', () => {
    expect(shouldCompact(occupancyForMaxTurns(0, 0), 0)).toBe(false)
  })
})

// A5 — 컨텍스트 게이지(UI) % 계산. threshold<=0(압축 비활성)이면 게이지 자체를 숨겨야 하므로 null.
describe('contextPercent — 컨텍스트 게이지 % (threshold<=0이면 null=숨김)', () => {
  it('threshold 0 또는 음수면 null', () => {
    expect(contextPercent(100_000, 0)).toBeNull()
    expect(contextPercent(0, 0)).toBeNull()
    expect(contextPercent(100, -1)).toBeNull()
  })

  it('정상 비율 계산', () => {
    expect(contextPercent(75_000, 150_000)).toBe(50)
    expect(contextPercent(150_000, 150_000)).toBe(100)
    expect(contextPercent(0, 150_000)).toBe(0)
  })

  it('임계 초과도 그대로(100 초과) — 클램프는 표시 쪽 책임', () => {
    expect(contextPercent(300_000, 150_000)).toBe(200)
  })

  it('음수 토큰은 0으로 보정', () => {
    expect(contextPercent(-50, 150_000)).toBe(0)
  })
})
