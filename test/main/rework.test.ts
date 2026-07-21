import { describe, it, expect } from 'vitest'
// T15(P6) — 순수부는 rework.ts로 분리(orchestrator 직접 import는 SDK 로드·DB 오픈까지 끌고 와 무겁다).
// orchestrator는 이 모듈을 import해 쓰고, 인터페이스(REWORK_MAX/canRework/buildReworkPrompt)는 동일하다.
import { buildReworkPrompt, canRework, REWORK_MAX } from '../../src/main/rework'

describe('rework', () => {
  it('재작업 프롬프트에 지적사항·회차가 담긴다', () => {
    const p = buildReworkPrompt('에러 처리 누락. 로그 남길 것.', 1)
    expect(p).toContain('에러 처리 누락')
    expect(p).toMatch(/재작업|수정/)
    expect(p).toContain('1')
  })
  it('상한 판정', () => {
    expect(canRework(0)).toBe(true)
    expect(canRework(REWORK_MAX)).toBe(false)
  })
  it('상한(2회)에서 정확히 경계를 막는다', () => {
    expect(REWORK_MAX).toBe(2)
    expect(canRework(REWORK_MAX - 1)).toBe(true) // 1회차까진 가능
    expect(canRework(REWORK_MAX + 1)).toBe(false)
  })
})
