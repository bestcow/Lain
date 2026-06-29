// 에이전트 query() 공용 옵션 조립 — worker(Navi)와 manager(레인)가 공유.
import type { ThinkingConfig, PermissionMode, EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import type { ThinkingLevel, LainSettings } from '../shared/types'

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
