import { describe, it, expect } from 'vitest'
import { isManagerStalled } from '../../src/main/manager'

// i8 진전 감지(순수 함수) — 매니저 자동 이어가기에서 '같은 자리 맴돌기'를 막는 결정론 분기.
// 계약: continueRound>0 && assistantSeen===false && (roundSigs 공집합 || roundSigs ⊆ prevSigs) → 정체(true).
const S = (...xs: string[]) => new Set(xs)

describe('isManagerStalled — 매니저 자동 continue 진전 판정', () => {
  it('첫 턴(continueRound=0)은 절대 정체로 보지 않는다', () => {
    expect(isManagerStalled(0, false, S(), S())).toBe(false)
    expect(isManagerStalled(0, false, S('Read a'), S())).toBe(false)
  })

  it('assistant 텍스트가 났으면(assistantSeen=true) 진전으로 본다 — 오탐 방지 1차 게이트', () => {
    // 이어가기 라운드라도, 도구가 하나도 안 새로 불렸어도, 텍스트가 났으면 계속 진행.
    expect(isManagerStalled(1, true, S(), S())).toBe(false)
    expect(isManagerStalled(1, true, S('Read a'), S('Read a'))).toBe(false)
  })

  it('이어가기 라운드에 도구도 안 쓰고 말도 없으면 정체(roundSigs 공집합)', () => {
    expect(isManagerStalled(1, false, S(), S())).toBe(true)
    expect(isManagerStalled(2, false, S(), S('Read a'))).toBe(true)
  })

  it('이번 라운드 도구가 전부 직전 라운드에도 있던 것뿐이면(차집합 공집합) 정체', () => {
    expect(isManagerStalled(1, false, S('Read a'), S('Read a'))).toBe(true)
    expect(isManagerStalled(1, false, S('Read a', 'Edit b'), S('Read a', 'Edit b', 'Grep c'))).toBe(
      true,
    )
  })

  it('새 도구 호출이 하나라도 있으면 진전 — 정체 아님', () => {
    expect(isManagerStalled(1, false, S('Read a', 'Edit new'), S('Read a'))).toBe(false)
    expect(isManagerStalled(2, false, S('$ npm test'), S('Read a'))).toBe(false)
  })

  it('직전 prevSigs가 비어 있고 이번에 도구를 썼으면(전부 새것) 진전', () => {
    expect(isManagerStalled(1, false, S('Read a'), S())).toBe(false)
  })
})
