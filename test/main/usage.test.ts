import { describe, it, expect, beforeEach } from 'vitest'
import {
  budgetExceeded,
  usageGuardTripped,
  effectiveJudgeTier,
  pruneUsage,
  sumUsage,
  recordUsage,
  recentUsageTokens,
  resetUsage,
  USAGE_WINDOW_MIN,
  type UsageEntry,
} from '../../src/main/usage'
import type { ModelTier } from '../../src/shared/types'

describe('budgetExceeded — 작업별 토큰 예산(순수)', () => {
  it('budget<=0(off)이면 항상 false — 기존 동작 불변', () => {
    expect(budgetExceeded(0, 0)).toBe(false)
    expect(budgetExceeded(9_999_999, 0)).toBe(false)
    expect(budgetExceeded(9_999_999, -5)).toBe(false)
  })
  it('누적이 예산 이상이면 초과(경계 포함)', () => {
    expect(budgetExceeded(100, 100)).toBe(true)
    expect(budgetExceeded(101, 100)).toBe(true)
  })
  it('예산 미만이면 통과', () => {
    expect(budgetExceeded(99, 100)).toBe(false)
    expect(budgetExceeded(0, 100)).toBe(false)
  })
})

describe('usageGuardTripped — 전역 사용량 가드 = 스폰 억제 판정(순수)', () => {
  it('limit<=0(off)이면 항상 false — 스폰/드레인/강등 모두 기존 동작', () => {
    expect(usageGuardTripped(0, 0)).toBe(false)
    expect(usageGuardTripped(5_000_000, 0)).toBe(false)
    expect(usageGuardTripped(5_000_000, -1)).toBe(false)
  })
  it('최근 창 누적이 한도 이상이면 발동(경계 포함)', () => {
    expect(usageGuardTripped(1_000_000, 1_000_000)).toBe(true)
    expect(usageGuardTripped(1_000_001, 1_000_000)).toBe(true)
  })
  it('한도 미만이면 미발동', () => {
    expect(usageGuardTripped(999_999, 1_000_000)).toBe(false)
  })
})

describe('effectiveJudgeTier — 가드 발동 시 judge 티어 강등(순수)', () => {
  const t = (x: ModelTier) => x
  it('미발동이면 base 그대로', () => {
    for (const b of ['opus', 'sonnet', 'haiku', 'fable', 'local'] as ModelTier[]) {
      expect(effectiveJudgeTier(b, false)).toBe(b)
    }
  })
  it('발동 시 opus→sonnet, sonnet→haiku 강등', () => {
    expect(effectiveJudgeTier(t('opus'), true)).toBe('sonnet')
    expect(effectiveJudgeTier(t('sonnet'), true)).toBe('haiku')
  })
  it('haiku는 최하 — 더 내리지 않는다', () => {
    expect(effectiveJudgeTier(t('haiku'), true)).toBe('haiku')
  })
  it('local은 강등 예외 — 로컬은 크레딧 소비가 아니므로 그대로', () => {
    expect(effectiveJudgeTier(t('local'), true)).toBe('local')
  })
  it('매핑에 없는 티어(fable)는 그대로', () => {
    expect(effectiveJudgeTier(t('fable'), true)).toBe('fable')
  })
})

describe('pruneUsage / sumUsage — 롤링 창 순수 코어', () => {
  const WMS = 60 * 60_000 // 1시간
  const now = 1_000_000_000_000
  const entries: UsageEntry[] = [
    { ts: now - 90 * 60_000, tokens: 1000 }, // 90분 전 — 창 밖
    { ts: now - 61 * 60_000, tokens: 2000 }, // 61분 전 — 창 밖(경계 직후)
    { ts: now - 30 * 60_000, tokens: 3000 }, // 30분 전 — 창 안
    { ts: now - 1 * 60_000, tokens: 4000 }, // 1분 전 — 창 안
    { ts: now, tokens: 500 }, // 지금 — 창 안
  ]

  it('pruneUsage — 창(now-windowMs) 밖 항목 제거, 원본 불변', () => {
    const copy = [...entries]
    const kept = pruneUsage(entries, now, WMS)
    expect(kept.map((e) => e.tokens)).toEqual([3000, 4000, 500])
    expect(entries).toEqual(copy) // 원본 불변
  })
  it('sumUsage — 창 안 토큰만 합산', () => {
    expect(sumUsage(entries, now, WMS)).toBe(3000 + 4000 + 500)
  })
  it('경계: 정확히 windowMs 전 항목은 창 밖(>cutoff만 유지)', () => {
    const e = [{ ts: now - WMS, tokens: 100 }, { ts: now - WMS + 1, tokens: 200 }]
    expect(sumUsage(e, now, WMS)).toBe(200)
  })
  it('빈 배열은 0', () => {
    expect(sumUsage([], now, WMS)).toBe(0)
  })
})

describe('recordUsage / recentUsageTokens — 모듈 상태 래퍼', () => {
  beforeEach(() => resetUsage())

  it('기록한 토큰이 최근 창 합에 반영된다', () => {
    const now = 2_000_000_000_000
    recordUsage(1000, now)
    recordUsage(2000, now)
    expect(recentUsageTokens(now)).toBe(3000)
  })
  it('창 밖(윈도우 초과) 기록은 합에서 빠진다', () => {
    const now = 2_000_000_000_000
    recordUsage(5000, now - (USAGE_WINDOW_MIN + 5) * 60_000) // 창 밖
    recordUsage(1000, now) // 창 안
    expect(recentUsageTokens(now)).toBe(1000)
  })
  it('tokens<=0은 무시(음수·0 방어)', () => {
    const now = 2_000_000_000_000
    recordUsage(0, now)
    recordUsage(-100, now)
    expect(recentUsageTokens(now)).toBe(0)
  })
  it('resetUsage로 카운터 초기화(재시작 시맨틱)', () => {
    const now = 2_000_000_000_000
    recordUsage(9999, now)
    resetUsage()
    expect(recentUsageTokens(now)).toBe(0)
  })
})

// 스폰 억제 판정은 usageGuardTripped가 단일 출처 — startTask/drainQueue 양쪽이 이 판정으로 큐 우회/드레인 보류.
describe('스폰 억제 판정 — usageGuardTripped 시나리오', () => {
  beforeEach(() => resetUsage())
  it('한도 off면 아무리 태워도 억제 안 함(기존 동작)', () => {
    const now = 3_000_000_000_000
    recordUsage(10_000_000, now)
    expect(usageGuardTripped(recentUsageTokens(now), 0)).toBe(false)
  })
  it('창 누적이 한도 넘으면 억제(스폰→큐)', () => {
    const now = 3_000_000_000_000
    recordUsage(600_000, now)
    recordUsage(600_000, now)
    expect(usageGuardTripped(recentUsageTokens(now), 1_000_000)).toBe(true)
  })
  it('사용량이 창 밖으로 빠지면 억제 해제(드레인 재개 가능)', () => {
    const base = 3_000_000_000_000
    recordUsage(1_200_000, base) // base 시점 대량 소비 → 억제
    expect(usageGuardTripped(recentUsageTokens(base), 1_000_000)).toBe(true)
    // 창 길이 이후 시점엔 그 기록이 빠져 억제 해제
    const later = base + (USAGE_WINDOW_MIN + 1) * 60_000
    expect(usageGuardTripped(recentUsageTokens(later), 1_000_000)).toBe(false)
  })
})
