import { describe, it, expect } from 'vitest'
import { thinkingOption, managerAgentOptions, tierQueryOptions } from '../../src/main/agentopts'

describe('tierQueryOptions — 티어 → 모델/로컬 라우팅 옵션', () => {
  const s = { localBaseUrl: 'http://127.0.0.1:8080' }

  it('Claude 티어는 고정 ID만 — env 미설정(기존 동작 불변)', () => {
    expect(tierQueryOptions('sonnet', s)).toEqual({ model: 'claude-sonnet-4-6' })
    expect(tierQueryOptions('opus', s).env).toBeUndefined()
    expect(tierQueryOptions('haiku', s)).toEqual({ model: 'claude-haiku-4-5-20251001' })
  })

  it('미지 티어는 sonnet 폴백(modelId와 일관) — env 없음', () => {
    expect(tierQueryOptions('gpt-4', s)).toEqual({ model: 'claude-sonnet-4-6' })
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
})
