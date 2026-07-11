import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// quips.ts가 store(→paths)를 import하므로 registry.dedup.test와 동일 패턴으로 paths를 tmp로 격리.
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-quips-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import {
  pickQuip,
  initialQuipState,
  overlayCooldownScale,
  emitQuip,
  bindQuipSinks,
  QUIPS,
  type QuipState,
} from '../../src/main/quips'
import { initStore, closeStore, getSettings, saveSettings } from '../../src/main/store'

const T0 = 1_000_000_000 // 임의 기준 시각(ms)
const rand0 = () => 0
const def = (trigger: string) => QUIPS.find((d) => d.trigger === trigger)!

describe('pickQuip — 순수 선택 로직 (now·rand 주입 결정론)', () => {
  it('chattiness 0(묵언)이면 전부 null — 연타 에스컬레이션도 억제', () => {
    const st = initialQuipState()
    expect(pickQuip('monitor_off', {}, 0, st, T0, rand0)).toBeNull()
    expect(pickQuip('monitor_off', {}, 0, st, T0 + 1000, rand0)).toBeNull()
    expect(pickQuip('monitor_off', {}, 0, st, T0 + 2000, rand0)).toBeNull()
    expect(pickQuip('monitor_off', {}, 0, st, T0 + 3000, rand0)).toBeNull()
  })

  it('없는 트리거는 null', () => {
    expect(pickQuip('no_such_trigger', {}, 4, initialQuipState(), T0, rand0)).toBeNull()
  })

  it('레벨1(과묵)은 rare만 발화 — common은 rand=0이어도 억제', () => {
    expect(pickQuip('monitor_off', {}, 1, initialQuipState(), T0, rand0)).toBeNull()
    const hit = pickQuip('backup_export', {}, 1, initialQuipState(), T0, rand0)
    expect(hit).not.toBeNull() // rare p=0.25×0.5=0.125 > rand 0
  })

  it('확률 게이트 — rand가 p 이상이면 null, 미만이면 발화 (레벨2 uncommon p=0.6)', () => {
    expect(pickQuip('busy_week', { count: 6 }, 2, initialQuipState(), T0, () => 0.61)).toBeNull()
    expect(pickQuip('busy_week', { count: 6 }, 2, initialQuipState(), T0, () => 0.59)).not.toBeNull()
  })

  it('전역 쿨다운 — 발화 후 다른 트리거도 창 내에서는 억제 (레벨2 = 120초)', () => {
    const st = initialQuipState()
    expect(pickQuip('backup_export', {}, 2, st, T0, rand0)).not.toBeNull()
    expect(pickQuip('busy_week', { count: 6 }, 2, st, T0 + 119_000, rand0)).toBeNull()
    expect(pickQuip('busy_week', { count: 6 }, 2, st, T0 + 121_000, rand0)).not.toBeNull()
  })

  it('트리거별 쿨다운 — 전역 창을 지나도 같은 트리거는 cooldownSec까지 억제', () => {
    const st = initialQuipState()
    expect(def('monitor_on').cooldownSec).toBe(60)
    expect(pickQuip('monitor_on', {}, 3, st, T0, rand0)).not.toBeNull()
    // +50초: 전역(레벨3 45초)은 지났지만 트리거 쿨다운(60초) 이내 → null
    expect(pickQuip('monitor_on', {}, 3, st, T0 + 50_000, rand0)).toBeNull()
    // +61초: 연타 창(60초) 밖이라 에스컬레이션 오발 없이 일반 발화
    expect(pickQuip('monitor_on', {}, 3, st, T0 + 61_000, rand0)).not.toBeNull()
  })

  it('변주 반복 방지 — 연속 발화는 최근 안 쓴 변주를 우선', () => {
    const st = initialQuipState()
    const pool = def('monitor_on').variants
    const texts: string[] = []
    // 레벨4 common p=0.9×1.5→1.0(cap)이라 항상 발화. 트리거 쿨다운(60초)보다 넉넉히 띄운다.
    for (let i = 0; i < pool.length; i++) {
      const hit = pickQuip('monitor_on', {}, 4, st, T0 + i * 61_000 * 2, rand0)
      expect(hit).not.toBeNull()
      texts.push(hit!.text)
    }
    expect(new Set(texts).size).toBe(pool.length)
  })

  it('에스컬레이션 — 60초 내 3회째 시도(쿨다운에 막힌 시도 포함)는 escalation 풀에서 발화', () => {
    const st = initialQuipState()
    const esc = def('monitor_off').escalation!
    expect(pickQuip('monitor_off', {}, 3, st, T0, rand0)).not.toBeNull() // 1회째 — 일반 발화
    expect(pickQuip('monitor_off', {}, 3, st, T0 + 1000, rand0)).toBeNull() // 2회째 — 쿨다운
    const third = pickQuip('monitor_off', {}, 3, st, T0 + 2000, rand0) // 3회째 — 메타 반응
    expect(third).not.toBeNull()
    expect(esc).toContain(third!.text)
    // 4회째는 정확히 3회째가 아니므로 일반 경로(쿨다운) → null
    expect(pickQuip('monitor_off', {}, 3, st, T0 + 3000, rand0)).toBeNull()
  })

  it('에스컬레이션은 rarity 게이트도 우회 — 레벨1에서 common 트리거 연타', () => {
    const st = initialQuipState()
    expect(pickQuip('monitor_off', {}, 1, st, T0, rand0)).toBeNull()
    expect(pickQuip('monitor_off', {}, 1, st, T0 + 1000, rand0)).toBeNull()
    const third = pickQuip('monitor_off', {}, 1, st, T0 + 2000, rand0)
    expect(third).not.toBeNull()
    expect(def('monitor_off').escalation).toContain(third!.text)
  })

  it('플레이스홀더 치환 — {count}·{userTitle}', () => {
    // recentTexts를 미리 채워 원하는 변주만 fresh로 남긴다(결정론 선택).
    const st1: QuipState = initialQuipState()
    st1.recentTexts = def('busy_week').variants.filter((v) => !v.includes('{count}개예요'))
    const hit1 = pickQuip('busy_week', { count: 7 }, 2, st1, T0, rand0)
    expect(hit1!.text).toBe('일정이 7개예요. 무리하지 마세요.')

    const st2: QuipState = initialQuipState()
    st2.recentTexts = def('late_night').variants.filter((v) => !v.includes('{userTitle}'))
    const hit2 = pickQuip('late_night', { userTitle: '캡틴' }, 2, st2, T0, rand0)
    expect(hit2!.text).toBe('새벽이에요, 캡틴.')
  })

  it('결정론 — 같은 입력·상태·rand 시퀀스는 같은 출력', () => {
    const run = () => {
      const st = initialQuipState()
      const out: (string | null)[] = []
      for (let i = 0; i < 5; i++)
        out.push(pickQuip('monitor_off', {}, 3, st, T0 + i * 1000, rand0)?.text ?? null)
      return out
    }
    expect(run()).toEqual(run())
  })

  it('카탈로그 무결성 — 트리거 유일·변주 비어있지 않음', () => {
    expect(new Set(QUIPS.map((d) => d.trigger)).size).toBe(QUIPS.length)
    for (const d of QUIPS) {
      expect(d.variants.length).toBeGreaterThan(0)
      expect(d.cooldownSec).toBeGreaterThan(0)
    }
  })
})

describe('overlayCooldownScale — 오버레이 선제발화 쿨다운 배수(정책표 단일 출처)', () => {
  it('레벨별 배수 — 0(묵언)은 ∞(반응 자체 차단)', () => {
    expect(overlayCooldownScale(0)).toBe(Number.POSITIVE_INFINITY)
    expect(overlayCooldownScale(1)).toBe(2.0)
    expect(overlayCooldownScale(2)).toBe(1.0)
    expect(overlayCooldownScale(3)).toBe(0.75)
    expect(overlayCooldownScale(4)).toBe(0.5)
  })
  it('범위 밖·NaN 방어 — 클램프(9→4, -2→0), NaN→기본 2', () => {
    expect(overlayCooldownScale(9)).toBe(0.5)
    expect(overlayCooldownScale(-2)).toBe(Number.POSITIVE_INFINITY)
    expect(overlayCooldownScale(Number.NaN)).toBe(1.0)
  })
})

describe('chattiness 설정 + emitQuip 배선 (store 왕복)', () => {
  beforeAll(() => initStore())
  afterAll(() => {
    try {
      closeStore()
    } catch {
      /* 잠금 무시 */
    }
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true })
    } catch {
      /* 무시 */
    }
  })

  it('기본값 2, 0(묵언)도 유효값으로 저장·복원 — `|| 기본` 폴백 버그 가드', () => {
    expect(getSettings().chattiness).toBe(2)
    saveSettings({ chattiness: 0 })
    expect(getSettings().chattiness).toBe(0)
  })

  it('클램프 — 4.9→4, -3→0, NaN→2', () => {
    saveSettings({ chattiness: 4.9 })
    expect(getSettings().chattiness).toBe(4)
    saveSettings({ chattiness: -3 })
    expect(getSettings().chattiness).toBe(0)
    saveSettings({ chattiness: Number.NaN })
    expect(getSettings().chattiness).toBe(2)
  })

  it('emitQuip — 발화 시 말풍선 싱크 + 매니저 버퍼 싱크([UI 반응] 접두) 둘 다 호출', () => {
    saveSettings({ chattiness: 4 }) // 레벨4 common p=1.0 — 확률 비결정성 없이 항상 발화
    const shown: string[] = []
    const toManager: string[] = []
    bindQuipSinks(
      (p) => shown.push(p.text),
      (t) => toManager.push(t),
    )
    emitQuip('monitor_off')
    expect(shown.length).toBe(1)
    expect(def('monitor_off').variants).toContain(shown[0])
    expect(toManager.length).toBe(1)
    expect(toManager[0]).toBe(`[UI 반응] ${shown[0]}`)
  })

  it('emitQuip — chattiness 0이면 어떤 싱크도 호출하지 않는다', () => {
    saveSettings({ chattiness: 0 })
    const shown: string[] = []
    bindQuipSinks(
      (p) => shown.push(p.text),
      () => {},
    )
    emitQuip('monitor_on')
    emitQuip('backup_export')
    expect(shown.length).toBe(0)
  })
})
