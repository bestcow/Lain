// 모델 티어 ↔ 고정 모델 ID (main/renderer 공용)
//
// 별칭('opus'·'sonnet'·'haiku')을 SDK query()에 그대로 넘기면, 세대가 바뀔 때 같은 별칭이
// 다른 모델을 가리켜 "설정에 보이는 것 ≠ 실제 도는 모델"이 된다(별칭은 시간에 따라 표류).
// 명시 ID로 박아 항상 일치시킨다 — 모델 세대가 올라가면 여기 한 곳만 갱신한다(로컬 앱이라 통제 가능).
import type { ModelTier } from './types'

/** 모델 티어 목록 — 설정 UI·검증 공용. 미출시(fable)·보류(local: CC 하네스 prefill로 34분/턴 실측,
 *  하드웨어 개선이나 직접 fetch 경로 착수 전까지 숨김) 티어는 여기서 제외해 선택 UI·검증에 노출하지
 *  않는다. 재개 시 배열에 다시 넣으면 자동 노출 — 라우팅 배관(agentopts.tierQueryOptions)은 보존. */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const

/** 티어 → 고정 모델 ID. */
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5', // 미출시 — MODEL_TIERS(선택 목록)에서 제외. 출시 시 위 배열에 다시 넣으면 선택·검증에 자동 노출. ID·이름·타입은 미리 보존.
  // 로컬 llama-server(Anthropic /v1/messages 네이티브)로 가는 티어 — 서버는 단일 모델이라 이 이름은
  // 표시·귀속용이고 실제 모델은 서버에 물린 GGUF가 결정한다. 라우팅(env)은 main의 tierQueryOptions가 담당.
  local: 'qwen3.6-35b-a3b',
}

/** 티어(또는 미지 문자열)를 고정 모델 ID로 해석. 미지값은 sonnet 폴백(store.asTier와 일관). */
export function modelId(tier: string): string {
  return MODEL_IDS[tier as ModelTier] ?? MODEL_IDS.sonnet
}

/** 티어 → 사용자 표시 라벨(설정 UI 공용 단일출처). 입력창 바(InputModeBar)·작업 드로어(TaskDrawer)가 공유 —
 *  '설정 표시=실제 일치' 원칙상 별칭이 아니라 세대 고정 표기(위 MODEL_IDS와 짝). */
// 'Claude_' 접두는 뗀다 — 입력창 바가 '모델' 이름표를 값 앞에 병기하므로 브랜드 접두가 중복이고 폭만 먹는다.
// 세대 표기(4.8 등)는 유지 — 별칭 표류를 막는 '설정 표시=실제 일치' 원칙은 그대로다.
export const MODEL_NAME: Record<ModelTier, string> = {
  haiku: 'Haiku 4.5',
  sonnet: 'Sonnet 4.6',
  opus: 'Opus 4.8',
  fable: 'Fable 5',
  local: 'Qwen 로컬(실험적)', // llama-server 필요(환경설정 모델 탭) — 서버 꺼져 있으면 응답 실패
}
