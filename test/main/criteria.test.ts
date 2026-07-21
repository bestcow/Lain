import { describe, it, expect } from 'vitest'
import { criteriaBlock } from '../../src/main/worker'

describe('criteriaBlock', () => {
  it('체크리스트 블록을 만든다', () => {
    const b = criteriaBlock(['테스트 통과', '버튼 동작'])
    expect(b).toContain('## 완료 조건 체크리스트')
    expect(b).toContain('- [ ] 테스트 통과')
    expect(b).toMatch(/항목별로|모두 충족/)
  })
  it('없으면 빈 문자열', () => {
    expect(criteriaBlock(undefined)).toBe('')
    expect(criteriaBlock([])).toBe('')
  })
})
