import { describe, it, expect } from 'vitest'
import { extractCriteria, buildAuditPrompt, parseAuditVerdict } from '../../src/main/audit'

describe('audit 순수부', () => {
  it('합격 기준 불릿을 뽑는다', () => {
    const c = extractCriteria('# TASK\n## 목표\nx\n## 합격 기준 (lain elicitation §21.3)\n- 테스트 통과\n- 버튼 동작\n\n## 기타')
    expect(c).toEqual(['테스트 통과', '버튼 동작'])
  })
  it('완료 조건 (DoD) 섹션도 지원', () => {
    expect(extractCriteria('## 완료 조건 (DoD)\n- A\n- B')).toEqual(['A', 'B'])
  })
  it('기준 없으면 빈 배열', () => {
    expect(extractCriteria('# TASK\n그냥 산문')).toEqual([])
  })
  it('프롬프트에 기준·diff·자기보고가 담긴다', () => {
    const p = buildAuditPrompt('스펙', ['A'], ' src/x.ts | 5 +', '다 했습니다')
    expect(p).toContain('A')
    expect(p).toContain('src/x.ts')
    expect(p).toContain('다 했습니다')
    expect(p).toMatch(/자기 보고를 신뢰하지/)
  })
  it('판정 JSON 파싱', () => {
    expect(parseAuditVerdict('```json\n{"pass":false,"issues":["버튼 미구현"]}\n```')).toEqual({ pass: false, issues: ['버튼 미구현'] })
    expect(parseAuditVerdict('잡담')).toBeNull()
  })
})
