import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  thinkingOption,
  managerAgentOptions,
  tierQueryOptions,
  providerQueryOptions,
  adaptiveEffort,
  secretDeny,
  preToolUseGuard,
} from '../../src/main/agentopts'
import type { PreToolDeny } from '../../src/main/agentopts'

describe('tierQueryOptions — 티어 → 모델/로컬 라우팅 옵션', () => {
  const s = { localBaseUrl: 'http://127.0.0.1:8080', anthropicApiKey: '' }

  it('Claude 티어는 고정 ID만 — env 미설정(기존 동작 불변)', () => {
    expect(tierQueryOptions('sonnet', s)).toEqual({ model: 'claude-sonnet-4-6' })
    expect(tierQueryOptions('opus', s).env).toBeUndefined()
    expect(tierQueryOptions('haiku', s)).toEqual({ model: 'claude-haiku-4-5-20251001' })
  })

  it('미지 티어는 sonnet 폴백(modelId와 일관) — env 없음', () => {
    expect(tierQueryOptions('gpt-4', s)).toEqual({ model: 'claude-sonnet-4-6' })
  })

  it('E5: API 키 설정 시 non-local 티어 env에 ANTHROPIC_API_KEY 주입(baseEnv 스프레드)', () => {
    const keyed = { localBaseUrl: 'http://127.0.0.1:8080', anthropicApiKey: '  sk-ant-user  ' }
    const o = tierQueryOptions('opus', keyed, { PATH: 'C:\\bin' })
    expect(o.model).toBe('claude-opus-4-8')
    expect(o.env).toBeDefined()
    expect(o.env!.ANTHROPIC_API_KEY).toBe('sk-ant-user') // trim 적용
    expect(o.env!.PATH).toBe('C:\\bin') // baseEnv 유지(통째교체 방어)
  })

  it('E5: API 키 비었으면 non-local env 미설정(기존 구독 로그인 동작 불변)', () => {
    expect(tierQueryOptions('sonnet', { localBaseUrl: 'x', anthropicApiKey: '   ' }).env).toBeUndefined()
    expect(tierQueryOptions('opus', s).env).toBeUndefined()
  })

  it('local 티어 — 로컬 모델명 + llama-server 라우팅 env', () => {
    const o = tierQueryOptions('local', s, { PATH: 'C:\\bin', ANTHROPIC_API_KEY: 'sk-ant-real' })
    expect(o.model).toBe('qwen3.6-35b-a3b')
    expect(o.env).toBeDefined()
    expect(o.env!.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8080')
    expect(o.env!.ANTHROPIC_AUTH_TOKEN).toBe('local')
    // env는 통째 교체라 baseEnv 스프레드 필수(PATH 유지) + 실 API 키는 제거(로컬 서버 유출 차단 §9-6)
    expect(o.env!.PATH).toBe('C:\\bin')
    expect(o.env!.ANTHROPIC_API_KEY).toBeUndefined()
    // 로컬 KV 캐시·호환 env — attribution 해제 + beta 헤더 제거 + haiku 재매핑
    expect(o.env!.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
    expect(o.env!.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1')
    expect(o.env!.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qwen3.6-35b-a3b')
  })

  it('localBaseUrl 설정이 그대로 반영된다', () => {
    const o = tierQueryOptions('local', { localBaseUrl: 'http://127.0.0.1:9999' }, {})
    expect(o.env!.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999')
  })
})

describe('providerQueryOptions — worker 전용 프로바이더 라우팅', () => {
  const profiles = [
    {
      id: 'kimi',
      label: 'Kimi K3',
      baseUrl: 'https://api.moonshot.ai/anthropic/',
      authToken: 'kimi-secret',
      modelId: 'kimi-k3[1m]',
    },
  ]

  it('플래그 OFF 또는 미선택이면 null — 기존 Anthropic 경로 불변', () => {
    expect(providerQueryOptions('kimi', { providerSwapEnabled: false, providerProfiles: profiles })).toBeNull()
    expect(providerQueryOptions('', { providerSwapEnabled: true, providerProfiles: profiles })).toBeNull()
  })

  it('선택 프로필의 실제 model/env를 주입하고 기존 API key는 제거한다', () => {
    const out = providerQueryOptions(
      'kimi',
      { providerSwapEnabled: true, providerProfiles: profiles },
      { PATH: 'C:\\bin', ANTHROPIC_API_KEY: 'do-not-leak' },
    )!
    expect(out.model).toBe('kimi-k3[1m]')
    expect(out.env.PATH).toBe('C:\\bin')
    expect(out.env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic')
    expect(out.env.ANTHROPIC_AUTH_TOKEN).toBe('kimi-secret')
    expect(out.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3[1m]')
    expect(out.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k3[1m]')
  })

  it('없는 프로필·토큰 없는 프로필은 조용히 Anthropic으로 새지 않고 실패한다', () => {
    expect(() => providerQueryOptions('missing', { providerSwapEnabled: true, providerProfiles: profiles })).toThrow(
      '프로바이더 프로필 없음',
    )
    expect(() =>
      providerQueryOptions('kimi', {
        providerSwapEnabled: true,
        providerProfiles: [{ ...profiles[0], authToken: '' }],
      }),
    ).toThrow('프로바이더 프로필 미완성')
  })

  it('기존 tier 경로(manager·judge 공용)는 프로바이더 설정이 있어도 바뀌지 않는다', () => {
    const settings = {
      localBaseUrl: 'http://127.0.0.1:8080',
      anthropicApiKey: '',
      providerSwapEnabled: true,
      providerProfiles: profiles,
    }
    expect(tierQueryOptions('sonnet', settings)).toEqual({ model: 'claude-sonnet-4-6' })
  })
})

describe('thinkingOption — 추론 강도 → SDK thinking 옵션 (Navi/task용)', () => {
  it('off → disabled, auto → adaptive, high → enabled(24000), default → {}', () => {
    expect(thinkingOption('off')).toEqual({ thinking: { type: 'disabled' } })
    expect(thinkingOption('auto')).toEqual({ thinking: { type: 'adaptive' } })
    expect(thinkingOption('high')).toEqual({ thinking: { type: 'enabled', budgetTokens: 24000 } })
    expect(thinkingOption('default')).toEqual({})
  })
})

describe('managerAgentOptions — 레인 query 옵션(권한·작업량)', () => {
  it('자동 ON → effort high + adaptive, 선택값 무시', () => {
    const o = managerAgentOptions({
      managerPermissionMode: 'default',
      managerEffort: 'low',
      managerEffortAuto: true,
      managerFastMode: false,
    })
    expect(o.effort).toBe('high')
    expect(o.thinking).toEqual({ type: 'adaptive' })
    expect(o.permissionMode).toBe('default')
    expect(o.settings).toBeUndefined()
  })

  it('수동: 선택 단계 그대로(낮음~최대)', () => {
    const opts = (e: 'low' | 'max') =>
      managerAgentOptions({
        managerPermissionMode: 'acceptEdits',
        managerEffort: e,
        managerEffortAuto: false,
        managerFastMode: false,
      }).effort
    expect(opts('max')).toBe('max')
    expect(opts('low')).toBe('low')
  })

  it('수동 ultracode → effort xhigh + settings.ultracode', () => {
    const o = managerAgentOptions({
      managerPermissionMode: 'acceptEdits',
      managerEffort: 'ultracode',
      managerEffortAuto: false,
      managerFastMode: false,
    })
    expect(o.effort).toBe('xhigh')
    expect(o.settings).toEqual({ ultracode: true })
  })

  it('자동 ON이면 ultracode여도 무시(effort high, workflow 안 켬)', () => {
    const o = managerAgentOptions({
      managerPermissionMode: 'acceptEdits',
      managerEffort: 'ultracode',
      managerEffortAuto: true,
      managerFastMode: false,
    })
    expect(o.effort).toBe('high')
    expect(o.settings).toBeUndefined()
  })

  it('bypass는 SDK acceptEdits, fastMode 반영', () => {
    const o = managerAgentOptions({
      managerPermissionMode: 'bypass',
      managerEffort: 'high',
      managerEffortAuto: false,
      managerFastMode: true,
    })
    expect(o.permissionMode).toBe('acceptEdits')
    expect(o.settings).toEqual({ fastMode: true })
  })

  it('fastMode + ultracode 둘 다 settings에', () => {
    const o = managerAgentOptions({
      managerPermissionMode: 'acceptEdits',
      managerEffort: 'ultracode',
      managerEffortAuto: false,
      managerFastMode: true,
    })
    expect(o.settings).toEqual({ fastMode: true, ultracode: true })
  })

  it('자동 ON + 입력 신호 → adaptiveEffort로 산정(복잡=xhigh, 사소=low)', () => {
    const base = {
      managerPermissionMode: 'default' as const,
      managerEffort: 'low' as const,
      managerEffortAuto: true,
      managerFastMode: false,
    }
    expect(managerAgentOptions(base, { text: '이 함수 성능을 분석하고 리팩터해줘' }).effort).toBe('xhigh')
    expect(managerAgentOptions(base, { text: '고마워' }).effort).toBe('low')
  })

  it('자동 ON + 입력 없음(재개·이어가기) → high 폴백', () => {
    expect(
      managerAgentOptions({
        managerPermissionMode: 'default',
        managerEffort: 'low',
        managerEffortAuto: true,
        managerFastMode: false,
      }).effort,
    ).toBe('high')
  })

  it('수동이면 입력 신호 무시 — 선택값 그대로', () => {
    const o = managerAgentOptions(
      {
        managerPermissionMode: 'default',
        managerEffort: 'low',
        managerEffortAuto: false,
        managerFastMode: false,
      },
      { text: '이 버그 왜 나는지 분석해줘' },
    )
    expect(o.effort).toBe('low')
  })
})

describe('adaptiveEffort — 자동 작업량(이번 입력 신호 → effort)', () => {
  it('인사·단순확인은 low', () => {
    expect(adaptiveEffort('고마워')).toBe('low')
    expect(adaptiveEffort('ㅇㅇ')).toBe('low')
  })

  it('짧고 단순한 지시는 medium', () => {
    expect(adaptiveEffort('버튼 색 바꿔줘')).toBe('medium')
  })

  it('일반 요청은 high — 기존 자동 기본선 유지(회귀 최소)', () => {
    expect(adaptiveEffort('로그인 페이지에 소셜 로그인 버튼을 추가하고 콜백 처리도 해줘')).toBe('high')
  })

  it('복잡 신호(코드블록·복잡키워드·매우 김·첨부 다수)는 xhigh', () => {
    expect(adaptiveEffort('이거 왜 이래\n```\nconst x = 1\n```')).toBe('xhigh') // 코드블록
    expect(adaptiveEffort('이 함수 성능을 분석하고 리팩터해줘')).toBe('xhigh') // 복잡 키워드
    expect(adaptiveEffort('가'.repeat(600))).toBe('xhigh') // 매우 김
    expect(adaptiveEffort('이 스샷들 좀 봐', 2)).toBe('xhigh') // 첨부 2개
  })

  it('첨부 1개는 볼 것이 있어 최소 high', () => {
    expect(adaptiveEffort('이거 봐', 1)).toBe('high')
  })

  it('max·ultracode로는 자동 진입하지 않는다(비용 큰 단계는 수동 전용)', () => {
    expect(adaptiveEffort('가'.repeat(5000))).not.toBe('max')
  })
})

describe('secretDeny / preToolUseGuard — 결정론 차단(PreToolUse)', () => {
  const call = async (toolName: string, input: unknown, onDeny?: (t: string, d: PreToolDeny) => void) => {
    const { hooks } = preToolUseGuard(secretDeny, onDeny)
    const cb = hooks.PreToolUse![0].hooks[0]
    return cb(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: 't',
        cwd: 'C:/proj',
        tool_name: toolName,
        tool_input: input,
        tool_use_id: 'tu1',
      },
      'tu1',
      { signal: new AbortController().signal },
    )
  }

  it('시크릿 파일 도구 호출은 차단', () => {
    expect(secretDeny('Read', { file_path: 'C:/proj/.env' })?.kind).toBe('secret_denied')
    expect(secretDeny('Edit', { file_path: 'C:/proj/id_rsa' })).not.toBeNull()
  })

  it('정상 파일·정상 명령·비대상 도구는 통과(과차단 방지)', () => {
    expect(secretDeny('Read', { file_path: 'C:/proj/src/index.ts' })).toBeNull()
    expect(secretDeny('Bash', { command: 'npm test -- --run' })).toBeNull()
    expect(secretDeny('Glob', { pattern: '**/.env' })).toBeNull() // Glob은 파일명만 반환 — 대상 아님
    expect(secretDeny('Read', { file_path: 'C:/proj/.env.example' })).toBeNull()
    expect(secretDeny('TodoWrite', { todos: [] })).toBeNull()
  })

  it('셸 명령에 박힌 시크릿 디렉터리 절대경로는 차단', () => {
    const ssh = path.join(os.homedir(), '.ssh', 'id_rsa')
    expect(secretDeny('Bash', { command: `type ${ssh}` })).not.toBeNull()
  })

  it('훅은 차단 대상만 permissionDecision:deny로 돌려준다', async () => {
    const denied = (await call('Read', { file_path: 'C:/proj/.env' })) as any
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(String(denied.hookSpecificOutput.permissionDecisionReason)).toContain('비밀 파일')
  })

  it('통과 도구엔 빈 응답 — 허용 결정을 대신하지 않는다(SDK 기본 흐름 유지)', async () => {
    expect(await call('Read', { file_path: 'C:/proj/README.md' })).toEqual({})
    expect(await call('Bash', { command: 'git status' })).toEqual({})
  })

  it('onDeny는 차단 시에만 불리고, 예외를 던져도 차단은 유지된다', async () => {
    const seen: string[] = []
    expect(await call('Bash', { command: 'git status' }, (t) => seen.push(t))).toEqual({})
    expect(seen).toEqual([])
    const out = (await call('Read', { file_path: 'C:/proj/.env' }, () => {
      throw new Error('기록 실패')
    })) as any
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })
})
