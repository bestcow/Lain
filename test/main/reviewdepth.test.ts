import { describe, it, expect } from 'vitest'
import { combineVerdicts, AUDIT_LENSES } from '../../src/main/audit'

describe('combineVerdicts', () => {
  it('과반 fail이면 fail, issues 합집합', () => {
    const v = combineVerdicts([
      { pass: false, issues: ['A'] }, { pass: false, issues: ['B'] }, { pass: true, issues: [] },
    ])
    expect(v.pass).toBe(false)
    expect(v.issues).toEqual(['A', 'B'])
  })
  it('과반 pass면 pass', () => {
    expect(combineVerdicts([{ pass: true, issues: [] }, { pass: true, issues: [] }, { pass: false, issues: ['x'] }]).pass).toBe(true)
  })
  it('렌즈는 3종', () => { expect(AUDIT_LENSES.length).toBe(3) })
})
