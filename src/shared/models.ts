// 모델 티어 ↔ 고정 모델 ID (main/renderer 공용)
//
// 별칭('opus'·'sonnet'·'haiku')을 SDK query()에 그대로 넘기면, 세대가 바뀔 때 같은 별칭이
// 다른 모델을 가리켜 "설정에 보이는 것 ≠ 실제 도는 모델"이 된다(별칭은 시간에 따라 표류).
// 명시 ID로 박아 항상 일치시킨다 — 모델 세대가 올라가면 여기 한 곳만 갱신한다(로컬 앱이라 통제 가능).
import type { ModelTier } from './types'

/** 모델 티어 목록 — 설정 UI·검증 공용. */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const

/** 티어 → 고정 모델 ID. */
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
}

/** 티어(또는 미지 문자열)를 고정 모델 ID로 해석. 미지값은 sonnet 폴백(store.asTier와 일관). */
export function modelId(tier: string): string {
  return MODEL_IDS[tier as ModelTier] ?? MODEL_IDS.sonnet
}
