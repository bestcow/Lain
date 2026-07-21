import { describe, it, expect, vi } from 'vitest'

// worker.ts를 로드하려면 store가 실제 export를 제공해야 한다(mcp.ts 등이 요구) — worker.test.ts와 동형으로
// resolveApprovalRow만 스파이하고 나머지는 실제 유지(이 순수 헬퍼 테스트는 DB를 건드리지 않는다).
const { resolveApprovalRow } = vi.hoisted(() => ({ resolveApprovalRow: vi.fn() }))
vi.mock('../../src/main/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/store')>()
  return { ...actual, resolveApprovalRow }
})

import { shouldInjectStoredHandoff } from '../../src/main/worker'

// #4 — 핸드오프 스왑(handoffMd 저장·naviSessionId='') 도중 크래시 후 복원되면, resume은 끊겼는데(빈 세션id)
// 스왑 블록도 재개 경계가 아니라 안 타 handoffInject가 비고, 애써 써 둔 handoffMd가 프롬프트에 안 실려
// 맥락이 유실된다. shouldInjectStoredHandoff가 이 복원 갭에서만 true여야(저장 핸드오프 재주입) 한다.
describe('shouldInjectStoredHandoff — 스왑 크래시 복원 시 저장 핸드오프 재주입(#4)', () => {
  it('복원 갭(resume 끊김 + 재개지시 + 신규핸드오프 없음 + 저장핸드오프 있음) → 재주입', () => {
    // resuming=false, hasResumePrompt=true, hasFreshHandoff=false, hasStoredHandoff=true
    expect(shouldInjectStoredHandoff(false, true, false, true)).toBe(true)
  })

  it('브랜뉴 작업(재개지시·저장핸드오프 둘 다 없음)은 재주입하지 않는다', () => {
    expect(shouldInjectStoredHandoff(false, false, false, false)).toBe(false)
  })

  it('정상 resume(세션 살아있음)이면 재주입하지 않는다 — 세션 히스토리에 이미 있다', () => {
    expect(shouldInjectStoredHandoff(true, true, false, true)).toBe(false)
  })

  it('이번에 새 핸드오프를 만든 정상 스왑(freshHandoff)이면 그걸 쓰므로 중복 재주입 안 함', () => {
    expect(shouldInjectStoredHandoff(false, true, true, true)).toBe(false)
  })

  it('저장된 핸드오프가 없으면(주입할 게 없음) 재주입 안 함', () => {
    expect(shouldInjectStoredHandoff(false, true, false, false)).toBe(false)
  })

  it('재개 지시(resumePrompt)가 없으면 재주입 안 함 — 프롬프트 조립상 이어갈 지시가 없다', () => {
    expect(shouldInjectStoredHandoff(false, false, false, true)).toBe(false)
  })
})
