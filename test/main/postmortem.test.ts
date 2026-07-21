import { describe, it, expect } from 'vitest'
import { buildPostmortemPrompt, parsePostmortem } from '../../src/main/postmortem'

describe('postmortem', () => {
  it('프롬프트에 실패 종류·핵심 지시가 담긴다', () => {
    const p = buildPostmortemPrompt('로그인 수정', 'verify', 'FAIL src/auth.test.ts')
    expect(p).toContain('verify')
    expect(p).toContain('FAIL src/auth.test.ts')
    expect(p).toMatch(/한 줄|한 문장/)
    expect(p).toContain('NONE')
  })
  it('한 줄 회고를 파싱하고 200자 컷', () => {
    expect(parsePostmortem('  verify 명령이 워크트리 밖 경로를 참조함  ')).toBe('verify 명령이 워크트리 밖 경로를 참조함')
    expect(parsePostmortem('x'.repeat(300))!.length).toBe(200)
  })
  it('NONE/빈 응답은 null', () => {
    expect(parsePostmortem('NONE')).toBeNull()
    expect(parsePostmortem('')).toBeNull()
  })
})
