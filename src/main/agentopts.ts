// 에이전트 query() 공용 옵션 조립 — worker(Navi)와 manager(레인)가 공유.
import path from 'node:path'
import type {
  ThinkingConfig,
  PermissionMode,
  EffortLevel,
  HookCallbackMatcher,
  HookEvent,
} from '@anthropic-ai/claude-agent-sdk'
import type { ThinkingLevel, LainSettings } from '../shared/types'
import { modelId } from '../shared/models'
import { getSettings } from './store'
import { effectiveJudgeTier, recentUsageTokens, usageGuardTripped } from './usage'
import {
  blocksSecretFile,
  blocksSecretCommand,
  blocksSecretPath,
  toolFilePath,
  SECRET_DENY_MESSAGE,
} from './safety'

/**
 * 티어 → query() 모델/라우팅 옵션 (로컬 모델 지원, 2026-07 조사).
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

// 자동 작업량(managerEffortAuto) — 이번 사용자 입력의 신호로 effort를 산정하는 순수함수.
// 기존 'high' 고정을 대체: high를 기본선으로 두고, 사소한 입력은 아끼고(low/medium) 복잡한 입력엔
// 더 쓴다(xhigh). max·ultracode는 과금이 커 자동 진입하지 않는다(수동 전용). 결정론이라 테스트 용이.
const COMPLEX_RE =
  /왜|원인|디버그|버그|분석|조사|검토|비교|최적화|리팩터|리팩토링|설계|아키텍처|why|debug|\bbug\b|analyze|investigate|refactor|optimize|architecture|\bdesign\b|review|audit/i
const GREET_RE = /^(고마+워?|고마|고맙|ㄱㅅ|ㅇㅇ|ㅇㅋ|ok|okay|오케이|오키|넵|넹|응|그래|알겠|굿|good|완벽)/i

export function adaptiveEffort(text: string, attachments = 0): EffortLevel {
  const t = (text ?? '').trim()
  // 복잡 신호 → xhigh (코드블록·복잡키워드·매우 김·첨부 다수)
  if (t.includes('```') || COMPLEX_RE.test(t) || t.length > 500 || attachments >= 2) return 'xhigh'
  // 첨부가 있으면 볼 것이 있어 최소 high
  if (attachments >= 1) return 'high'
  // 사소한 확인·인사 → low
  if (t.length <= 6 && GREET_RE.test(t)) return 'low'
  // 짧고 단순한 지시 → medium
  if (t.length < 20) return 'medium'
  // 일반 → high (기존 자동 기본선)
  return 'high'
}

// 레인(manager) 채팅 query에 적용할 옵션 — 권한/작업량/빠른모드. getSettings()는 매 턴 라이브.
// bypass는 SDK엔 acceptEdits로 준다(승인 프롬프트만 건너뛰고 시크릿 차단은 canUseTool에서 유지).
// plan은 SDK plan 직결 — 계획 제시(ExitPlanMode)는 canUseTool에서 사용자 승인까지 블록한다.
// 작업량: 항상 adaptive thinking(모델이 효율을 스스로 조절) + effort로 깊이 가이드(Opus 4.8 권장).
//  - 자동 ON: 이번 입력 신호로 effort 산정(adaptiveEffort) — 입력 없으면(재개·이어가기) 'high' 폴백.
//    수동: 선택 단계(낮음~최대). ultracode = xhigh + 워크플로 상시.
export function managerAgentOptions(
  s: Pick<LainSettings, 'managerPermissionMode' | 'managerEffort' | 'managerEffortAuto' | 'managerFastMode'>,
  input?: { text?: string; attachments?: number },
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
    ? input?.text
      ? adaptiveEffort(input.text, input.attachments ?? 0)
      : 'high'
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

// ─────────────────────────────────────────────────────────────────────────────
// PreToolUse 훅 — 결정론 차단이 실제로 발동하는 지점(§안전).
// canUseTool은 SDK가 '사람에게 물어야 하는' 호출에만 부른다 — rule/permissionMode/classifier로
// auto-allow된 도구(기본 허용 Read, acceptEdits의 Edit/Write 등)는 canUseTool을 아예 거치지 않아
// 시크릿 차단·spec-gaming 차단이 런타임에 무력했다(실측). PreToolUse 훅은 auto-allow 여부와
// 무관하게 모든 도구 호출을 통과한다(sdk.d.ts HookCallbackMatcher). 그래서 역할을 나눈다:
// '기계적 거부'는 여기, '사람 판단'(승인 큐·RISKY·편집/계획 승인)은 canUseTool. 둘 다 통과해야 실행.

/** 결정론 차단 1건 — kind/detail은 기록용, message는 모델에게 돌려줄 사유. */
export type PreToolDeny = { kind: string; detail: string; message: string }
export type PreToolDenyCheck = (toolName: string, input: unknown) => PreToolDeny | null

/** 시크릿(파일 도구 경로·셸 명령·경로 인자) 결정론 차단 판정. 막을 것이 없으면 null. */
export function secretDeny(toolName: string, input: unknown): PreToolDeny | null {
  if (blocksSecretFile(toolName, input)) {
    return {
      kind: 'secret_denied',
      detail: `비밀 파일 접근 (${path.basename(toolFilePath(input))})`,
      message: SECRET_DENY_MESSAGE,
    }
  }
  // 셸 명령/경로 인자에 박힌 절대경로(§3 i15s) — 명령문은 blocksSecretCommand가 토큰화해 판정한다.
  const cmd = String((input as { command?: unknown } | null)?.command ?? '')
  if (blocksSecretCommand(cmd) || blocksSecretPath(toolFilePath(input))) {
    return {
      kind: 'secret_denied',
      detail: `명령/경로에 비밀 파일 참조 (${toolName})`,
      message: SECRET_DENY_MESSAGE,
    }
  }
  return null
}

/**
 * check가 거부를 돌려준 도구만 PreToolUse에서 deny하는 훅 옵션 조각 — `...preToolUseGuard(...)`로
 * query options에 편다. onDeny는 기록(로그·exitReason)용 부수효과 훅이고, 판정은 순수 check가 한다.
 * 과차단 방지: check가 null이면 빈 응답만 돌려 SDK 기본 흐름을 그대로 둔다(허용 결정 안 함).
 */
export function preToolUseGuard(
  check: PreToolDenyCheck,
  onDeny?: (toolName: string, deny: PreToolDeny) => void,
): { hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> } {
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name !== 'PreToolUse') return {}
              const deny = check(input.tool_name, input.tool_input)
              if (!deny) return {}
              try {
                onDeny?.(input.tool_name, deny)
              } catch {
                // 기록 실패가 차단을 무르지 않게 삼킨다.
              }
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: deny.message,
                },
              }
            },
          ],
        },
      ],
    },
  }
}
