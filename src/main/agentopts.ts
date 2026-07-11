// 에이전트 query() 공용 옵션 조립 — worker(Navi)와 manager(레인)가 공유.
import type { ThinkingConfig, PermissionMode, EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import type { ThinkingLevel, LainSettings } from '../shared/types'
import { modelId } from '../shared/models'
import { getSettings } from './store'
import { effectiveJudgeTier, recentUsageTokens, usageGuardTripped } from './usage'

/**
 * 티어 → query() 모델/라우팅 옵션 (로컬 모델 지원, 2026-07 조사 [[lain-local-model-plan]]).
 * 'local' 티어면 모델명 + env 오버라이드로 로컬 llama-server(Anthropic /v1/messages 네이티브)로 보낸다.
 * 그 외 티어는 기존과 동일(env 미설정 = Anthropic API + 구독 로그인).
 *
 * env 주의(실측 근거):
 * - SDK options.env는 서브프로세스 환경을 병합이 아니라 '통째로 교체' → baseEnv 스프레드 필수(PATH 등).
 * - ANTHROPIC_AUTH_TOKEN: 로컬 서버는 값 무관(Bearer로 전달됨). ANTHROPIC_API_KEY는 undefined로
 *   제거 — 실 키가 로컬 서버로 새는 것 차단(§9-6).
 * - CLAUDE_CODE_ATTRIBUTION_HEADER=0: 매 요청 변하는 attribution 블록이 로컬 KV 프리픽스 캐시를
 *   전멸시키는 것 방지(최대 ~90% 감속). Anthropic API 캐싱엔 영향 없는 공식 env.
 * - CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1: 로컬 서버가 anthropic-beta 헤더/beta tool 필드를
 *   거부하는 문제 회피(표준 필드는 보존).
 * - ANTHROPIC_DEFAULT_HAIKU_MODEL: CC가 백그라운드로 띄우는 haiku 호출이 미지 모델명으로 로컬
 *   서버에 실패하지 않게 로컬 모델명으로 재매핑.
 * 순수(baseEnv 주입 가능) — 테스트 용이.
 */
export function tierQueryOptions(
  tier: string,
  s: Pick<LainSettings, 'localBaseUrl' | 'anthropicApiKey'>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { model: string; env?: Record<string, string | undefined> } {
  if (tier !== 'local') {
    // E5 — 앱에 API 키가 설정돼 있으면 spawn env에 ANTHROPIC_API_KEY로 주입(구독 로그인 대안).
    // SDK env는 서브프로세스 환경을 통째 교체하므로 baseEnv 스프레드 필수(PATH 등). 비었으면 env
    // 미설정 = 기존 동작(구독 OAuth 자격증명 사용).
    const key = s.anthropicApiKey?.trim()
    return key
      ? { model: modelId(tier), env: { ...baseEnv, ANTHROPIC_API_KEY: key } }
      : { model: modelId(tier) }
  }
  const local = modelId('local')
  return {
    model: local,
    env: {
      ...baseEnv,
      ANTHROPIC_BASE_URL: s.localBaseUrl,
      ANTHROPIC_AUTH_TOKEN: 'local',
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: local,
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
  }
}

// D7 (§9b) — judge류 짧은 판정 query의 티어/라우팅 옵션. 전역 사용량 가드가 발동(최근 창 누적이
// usageWindowTokenLimit 이상)이면 judge 티어를 한 단계 강등(opus→sonnet→haiku, local 예외)해 크레딧을
// 아낀다. 미발동·off(limit=0)면 설정 judgeModel 그대로 → 기존 동작 불변. elicit·ask_manager·reflect·
// verify tier-up·autoPriority·consolidateLessons 6개 호출부의 단일 출처(중복 제거·정책 일관).
export function judgeQueryOptions(): { model: string; env?: Record<string, string | undefined> } {
  const s = getSettings()
  const tripped = usageGuardTripped(recentUsageTokens(), s.usageWindowTokenLimit)
  return tierQueryOptions(effectiveJudgeTier(s.judgeModel, tripped), s)
}

// 추론 강도(thinkingLevel)를 SDK thinking 옵션으로. default는 {}(옵션 미설정=현행 유지).
export function thinkingOption(level: ThinkingLevel): { thinking?: ThinkingConfig } {
  switch (level) {
    case 'off':
      return { thinking: { type: 'disabled' } }
    case 'auto':
      return { thinking: { type: 'adaptive' } }
    case 'high':
      return { thinking: { type: 'enabled', budgetTokens: 24000 } }
    default:
      return {}
  }
}

// 레인(manager) 채팅 query에 적용할 옵션 — 권한/작업량/빠른모드. getSettings()는 매 턴 라이브.
// bypass는 SDK엔 acceptEdits로 준다(승인 프롬프트만 건너뛰고 시크릿 차단은 canUseTool에서 유지).
// plan은 SDK plan 직결 — 계획 제시(ExitPlanMode)는 canUseTool에서 사용자 승인까지 블록한다.
// 작업량: 항상 adaptive thinking(모델이 효율을 스스로 조절) + effort로 깊이 가이드(Opus 4.8 권장).
//  - 자동 ON: effort 'high'(아끼지 않는 기본). 수동: 선택 단계(낮음~최대). ultracode = xhigh + 워크플로 상시.
export function managerAgentOptions(
  s: Pick<LainSettings, 'managerPermissionMode' | 'managerEffort' | 'managerEffortAuto' | 'managerFastMode'>,
): {
  permissionMode: PermissionMode
  effort: EffortLevel
  thinking: { type: 'adaptive' }
  settings?: { fastMode?: true; ultracode?: true }
} {
  const permissionMode: PermissionMode =
    s.managerPermissionMode === 'bypass' ? 'acceptEdits' : s.managerPermissionMode
  const ultracode = !s.managerEffortAuto && s.managerEffort === 'ultracode'
  const effort: EffortLevel = s.managerEffortAuto
    ? 'high'
    : s.managerEffort === 'ultracode'
      ? 'xhigh'
      : s.managerEffort
  const settings: { fastMode?: true; ultracode?: true } = {
    ...(s.managerFastMode ? { fastMode: true as const } : {}),
    ...(ultracode ? { ultracode: true as const } : {}),
  }
  return {
    permissionMode,
    effort,
    thinking: { type: 'adaptive' },
    ...(Object.keys(settings).length ? { settings } : {}),
  }
}
