import { describe, it, expect } from 'vitest'
import { thinkingOption, managerAgentOptions } from '../../src/main/agentopts'

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
