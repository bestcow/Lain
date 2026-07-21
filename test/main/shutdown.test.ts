// 앱 종료 시퀀스 순수 오케스트레이터(shutdown.ts) 검증.
// 불변식: ① 모든 배경활동 정지 → ③ closeStore는 '가장 마지막'. 격리(한 단계 throw가 나머지·closeStore를
// 스킵하지 않음)·멱등(중복 fire 1회 실행)·순서(closeStore는 항상 모든 stop 뒤).
import { describe, it, expect, vi } from 'vitest'
import { createShutdown } from '../../src/main/shutdown'

// 전 단계 실행을 하나의 로그에 기록해 '전역 순서'를 검증하기 위한 픽스처.
function makeSteps(overrides: { throwOn?: string } = {}) {
  const calls: string[] = []
  const mk = (name: string) => () => {
    calls.push(name)
    if (overrides.throwOn === name) throw new Error(`boom:${name}`)
  }
  const onError = vi.fn()
  const steps = {
    stops: {
      scheduler: mk('scheduler'),
      ccHooks: mk('ccHooks'),
      telegram: mk('telegram'),
      discord: mk('discord'),
      watcher: mk('watcher'),
      overlay: mk('overlay'),
      supertonic: mk('supertonic'),
    },
    closeStore: mk('closeStore'),
    onError,
  }
  const stopNames = Object.keys(steps.stops)
  return { calls, steps, onError, stopNames }
}

describe('createShutdown — 종료 시퀀스', () => {
  it('stopBackground는 모든 stop을 삽입 순서대로 1회씩 실행하고 이름을 반환한다', () => {
    const { calls, steps, stopNames } = makeSteps()
    const s = createShutdown(steps)
    const order = s.stopBackground()
    expect(order).toEqual(stopNames)
    expect(calls).toEqual(stopNames) // closeStore는 아직 안 불림
    expect(s.isStoreClosed()).toBe(false)
  })

  it('closeStore는 항상 모든 배경 정지 뒤 가장 마지막에 실행된다', () => {
    const { calls, steps, stopNames } = makeSteps()
    const s = createShutdown(steps)
    s.stopBackground()
    s.finalize()
    expect(calls).toEqual([...stopNames, 'closeStore'])
    expect(calls[calls.length - 1]).toBe('closeStore')
    expect(s.isStoreClosed()).toBe(true)
  })

  it('한 stop이 throw해도 나머지 stop과 closeStore를 스킵하지 않는다(격리)', () => {
    const { calls, steps, onError, stopNames } = makeSteps({ throwOn: 'telegram' })
    const s = createShutdown(steps)
    s.stopBackground()
    s.finalize()
    // telegram이 터졌어도 그 뒤 discord/watcher/overlay/supertonic + closeStore 모두 실행.
    expect(calls).toEqual([...stopNames, 'closeStore'])
    expect(onError).toHaveBeenCalledWith('stop', 'telegram', expect.any(Error))
  })

  it('closeStore가 throw해도 삼키고(onError) 종료 흐름을 막지 않는다', () => {
    const { steps, onError } = makeSteps({ throwOn: 'closeStore' })
    const s = createShutdown(steps)
    s.stopBackground()
    expect(() => s.finalize()).not.toThrow()
    expect(onError).toHaveBeenCalledWith('finalize', 'closeStore', expect.any(Error))
    expect(s.isStoreClosed()).toBe(true) // 실패해도 닫힘으로 latch(재시도 루프 방지)
  })

  it('중복 fire(before-quit/will-quit 여러 번)에도 각 페이즈는 1회만 실행된다(멱등)', () => {
    const { calls, steps, stopNames } = makeSteps()
    const s = createShutdown(steps)
    s.stopBackground()
    s.stopBackground() // 두 번째는 no-op(빈 배열)
    expect(s.stopBackground()).toEqual([])
    s.finalize()
    s.finalize() // 두 번째 closeStore 없음
    // 각 stop 1회 + closeStore 1회.
    expect(calls).toEqual([...stopNames, 'closeStore'])
  })

  it('stopBackground 없이 finalize가 먼저 와도 배경 정지부터 보장한다(방어)', () => {
    const { calls, steps, stopNames } = makeSteps()
    const s = createShutdown(steps)
    s.finalize() // before-quit을 못 거친 경로
    expect(calls).toEqual([...stopNames, 'closeStore'])
  })

  it('isStoreClosed는 finalize 전 false·후 true (닫힌 DB 쓰기 감지 가드용)', () => {
    const { steps } = makeSteps()
    const s = createShutdown(steps)
    expect(s.isStoreClosed()).toBe(false)
    s.stopBackground()
    expect(s.isStoreClosed()).toBe(false) // 정지만으론 닫히지 않음 — 창 bounds 쓰기가 아직 열린 DB에 닿아야
    s.finalize()
    expect(s.isStoreClosed()).toBe(true)
  })
})
