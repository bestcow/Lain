import { describe, it, expect } from 'vitest'
import { buildAdoptContent } from '../../src/main/ccsessions'

describe('buildAdoptContent', () => {
  it('TASK 골격 + handoff 블록 + 세션 id를 담는다', () => {
    const c = buildAdoptContent('유저: 버그 고쳐줘\n어시: 원인은 X', '남은 수정 완결', 'abc123def456')
    expect(c).toContain('# TASK')
    expect(c).toContain('## 목표')
    expect(c).toContain('남은 수정 완결')
    expect(c).toContain('<handoff>')
    expect(c).toContain('abc123def456')
    expect(c).toContain('## 완료 조건')
  })
  it('goal 없으면 기본 목표 문구', () => {
    expect(buildAdoptContent('d', undefined, 's1')).toMatch(/이어서 완료/)
  })
})
