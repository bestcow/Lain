import { describe, it, expect } from 'vitest'
import { wakeJudge, isIdleAt, type WakeSnapshot } from '../../src/main/scheduler'

// 헬퍼 — 한 프로젝트 스냅샷을 부분 지정으로 만든다(나머지는 '조용한' 기본값).
function snap(
  pid: string,
  s: Partial<WakeSnapshot[string]> = {},
): WakeSnapshot {
  return {
    [pid]: {
      test: s.test ?? 'pass',
      hasTaskMd: s.hasTaskMd ?? false,
      dirty: s.dirty ?? 0,
      pendingApprovals: s.pendingApprovals ?? 0,
    },
  }
}

describe('wakeJudge — 결정론 wake 게이트(i4)', () => {
  it('변화 없음 → 깨우지 않는다', () => {
    const prev = snap('p', { test: 'pass', dirty: 3 })
    const next = snap('p', { test: 'pass', dirty: 3 })
    expect(wakeJudge(prev, next)).toBe(false)
  })

  it('dirty 1줄·타임스탬프류 잡변동(임계 미만)은 깨우지 않는다', () => {
    const prev = snap('p', { dirty: 1 })
    const next = snap('p', { dirty: 2 })
    expect(wakeJudge(prev, next)).toBe(false)
  })

  it('테스트 회귀 pass→fail → 깨운다', () => {
    expect(wakeJudge(snap('p', { test: 'pass' }), snap('p', { test: 'fail' }))).toBe(true)
  })

  it('테스트 회귀 unknown→fail → 깨운다', () => {
    expect(wakeJudge(snap('p', { test: 'unknown' }), snap('p', { test: 'fail' }))).toBe(true)
  })

  it('fail→pass(회복)은 깨우지 않는다(회귀만 신호)', () => {
    expect(wakeJudge(snap('p', { test: 'fail' }), snap('p', { test: 'pass' }))).toBe(false)
  })

  it('running→fail은 깨우지 않는다(pass/unknown 전이만)', () => {
    expect(wakeJudge(snap('p', { test: 'running' }), snap('p', { test: 'fail' }))).toBe(false)
  })

  it('새 TASK.md(false→true) → 깨운다', () => {
    expect(wakeJudge(snap('p', { hasTaskMd: false }), snap('p', { hasTaskMd: true }))).toBe(true)
  })

  it('TASK.md 사라짐(true→false)은 깨우지 않는다', () => {
    expect(wakeJudge(snap('p', { hasTaskMd: true }), snap('p', { hasTaskMd: false }))).toBe(false)
  })

  it('신규 pending 승인(증가) → 깨운다', () => {
    expect(
      wakeJudge(snap('p', { pendingApprovals: 0 }), snap('p', { pendingApprovals: 1 })),
    ).toBe(true)
  })

  it('pending 승인 감소(해소)는 깨우지 않는다', () => {
    expect(
      wakeJudge(snap('p', { pendingApprovals: 2 }), snap('p', { pendingApprovals: 1 })),
    ).toBe(false)
  })

  it('dirty 장기 방치 임계(20) 교차 → 깨운다', () => {
    expect(wakeJudge(snap('p', { dirty: 19 }), snap('p', { dirty: 20 }))).toBe(true)
  })

  it('이미 임계 이상에서 더 늘어도(20→25) 다시 깨우지 않는다(교차만 신호)', () => {
    expect(wakeJudge(snap('p', { dirty: 20 }), snap('p', { dirty: 25 }))).toBe(false)
  })

  it('신규 프로젝트가 깨끗하면(pass·TASK.md 없음·결재 없음) 깨우지 않는다', () => {
    const prev: WakeSnapshot = {}
    const next = snap('p', { test: 'pass', hasTaskMd: false, pendingApprovals: 0 })
    expect(wakeJudge(prev, next)).toBe(false)
  })

  it('신규 프로젝트가 이미 fail이면 깨운다', () => {
    expect(wakeJudge({}, snap('p', { test: 'fail' }))).toBe(true)
  })

  it('신규 프로젝트가 이미 TASK.md/결재를 가지면 깨운다', () => {
    expect(wakeJudge({}, snap('p', { hasTaskMd: true }))).toBe(true)
    expect(wakeJudge({}, snap('p', { pendingApprovals: 1 }))).toBe(true)
  })

  it('빈 next는 깨우지 않는다(프로젝트 0개)', () => {
    expect(wakeJudge(snap('p'), {})).toBe(false)
  })

  it('여러 프로젝트 중 하나라도 신호면 깨운다', () => {
    const prev = { ...snap('a', { test: 'pass' }), ...snap('b', { test: 'pass' }) }
    const next = { ...snap('a', { test: 'pass' }), ...snap('b', { test: 'fail' }) }
    expect(wakeJudge(prev, next)).toBe(true)
  })
})

describe('isIdleAt — idle 가드 순수 판정(i14)', () => {
  const now = Date.parse('2026-06-21T12:00:00.000Z')
  const min = (m: number) => new Date(now - m * 60_000).toISOString()

  it('working 작업이 있으면 idle 아님(시간 무관)', () => {
    expect(isIdleAt(min(60), true, now, 3)).toBe(false)
  })

  it('working 없음 + 마지막 활동 idleMin분 경과 → idle', () => {
    expect(isIdleAt(min(3), false, now, 3)).toBe(true)
    expect(isIdleAt(min(10), false, now, 3)).toBe(true)
  })

  it('working 없음 + 아직 idleMin 미경과 → idle 아님(끼어듦 차단)', () => {
    expect(isIdleAt(min(2), false, now, 3)).toBe(false)
    expect(isIdleAt(min(0), false, now, 3)).toBe(false)
  })

  it('정확히 임계 경계(= idleMin분)는 idle로 본다', () => {
    expect(isIdleAt(min(3), false, now, 3)).toBe(true)
  })

  it('채팅 이력 없음(null) → idle(끼어들 대화 없음)', () => {
    expect(isIdleAt(null, false, now, 3)).toBe(true)
  })

  it('파싱 불가 타임스탬프 → 보수적으로 idle 취급', () => {
    expect(isIdleAt('not-a-date', false, now, 3)).toBe(true)
  })

  it('idleMin이 0 이하라도 최소 1분으로 클램프', () => {
    // 30초 전 활동 + idleMin=0 → 1분 미경과라 idle 아님
    expect(isIdleAt(new Date(now - 30_000).toISOString(), false, now, 0)).toBe(false)
    // 2분 전 활동 + idleMin=0 → 1분 경과라 idle
    expect(isIdleAt(min(2), false, now, 0)).toBe(true)
  })
})
