// D7 (P4-4) — 전역 사용량 가드 + 작업별 토큰 예산의 결정론 코어.
// PLAN §9b "Max 한도 근접 시 신규 스폰 억제 + 진행 작업 안전 정지"의 공백을 메운다.
// L0 원칙: 여기엔 LLM 호출이 없다 — 순수 카운터·판정만. 카운터는 인메모리(재시작 시 리셋 허용, DB 안 씀).
import type { ModelTier } from '../shared/types'

// ── 롤링 사용량 창(window) 길이 ──
// 상수로 고정한다(설정 필드로 노출하지 않음): 창 길이는 "구독 사용량이 회복되는 시간 규모"를 뜻하는데
// 사용자가 임의로 줄이면 한도 억제가 무의미해지고, 늘려도 실익이 적다. 한도(usageWindowTokenLimit)만
// 노출해 켜고/끄고 임계만 정하게 하는 편이 UI가 단순하고 오설정 여지가 적다. 필요하면 이 상수만 바꾼다.
export const USAGE_WINDOW_MIN = 60

// ── 작업별 토큰 예산 ──
/** 순수 — 누적 토큰이 예산을 초과했는가. budget<=0이면 항상 false(무제한=off, 기존 동작 불변). */
export function budgetExceeded(tokens: number, budget: number): boolean {
  if (!(budget > 0)) return false
  return tokens >= budget
}

// ── 전역 사용량 가드(티어 강등) ──
/** 순수 — 롤링 창 누적 토큰이 한도 이상인가(=가드 발동). limit<=0이면 항상 false(off). */
export function usageGuardTripped(recentTokens: number, limit: number): boolean {
  if (!(limit > 0)) return false
  return recentTokens >= limit
}

// judge류 저티어 강등 매핑 — tier-up({haiku:'sonnet',sonnet:'opus'})의 역.
// local은 강등하지 않는다: 로컬 llama-server는 크레딧을 소비하지 않으므로 낮출 이유가 없다(§lain-local-model-plan).
// fable/local, 그리고 이미 최하(haiku)는 그대로 둔다(더 내릴 곳 없음).
const TIER_DOWN: Partial<Record<ModelTier, ModelTier>> = { opus: 'sonnet', sonnet: 'haiku' }

/** 순수 — 가드 발동 시 judge 티어를 한 단계 강등. 미발동이면 base 그대로.
 *  local은 예외(강등 무의미). 매핑에 없는 티어(haiku/fable/local)는 그대로 반환. */
export function effectiveJudgeTier(base: ModelTier, tripped: boolean): ModelTier {
  if (!tripped) return base
  if (base === 'local') return base
  return TIER_DOWN[base] ?? base
}

// ── 인메모리 롤링 카운터 ──
// 세션 종료마다 (토큰, 타임스탬프)를 적재하고, 창 밖(now - windowMs) 항목은 합산 시 제거한다.
// 순수 코어(add/prune/sum)는 스토어를 인자로 받아 테스트 가능하게 하고, 모듈 상태는 그 위 얇은 래퍼다.
export interface UsageEntry {
  ts: number
  tokens: number
}

/** 순수 — 창(windowMs) 안의 엔트리만 남긴다(now 기준). 원본을 변형하지 않고 새 배열 반환. */
export function pruneUsage(entries: UsageEntry[], now: number, windowMs: number): UsageEntry[] {
  const cutoff = now - windowMs
  return entries.filter((e) => e.ts > cutoff)
}

/** 순수 — 창 안 엔트리의 토큰 합. */
export function sumUsage(entries: UsageEntry[], now: number, windowMs: number): number {
  return pruneUsage(entries, now, windowMs).reduce((s, e) => s + e.tokens, 0)
}

// 모듈 상태(인메모리) — 재시작 시 리셋(영속 불필요, 근접 억제는 최근 창만 의미 있음).
let entries: UsageEntry[] = []

/** 세션 종료 시 소비 토큰을 창에 적재하고 창 밖 항목을 정리한다. tokens<=0이면 무시. */
export function recordUsage(tokens: number, now: number = Date.now()): void {
  if (!(tokens > 0)) return
  entries.push({ ts: now, tokens })
  entries = pruneUsage(entries, now, USAGE_WINDOW_MIN * 60_000)
}

/** 최근 창(USAGE_WINDOW_MIN) 안의 누적 토큰. 스폰 억제·티어 강등 판정의 단일 출처. */
export function recentUsageTokens(now: number = Date.now()): number {
  return sumUsage(entries, now, USAGE_WINDOW_MIN * 60_000)
}

/** 테스트/복원용 — 카운터 초기화. */
export function resetUsage(): void {
  entries = []
}
