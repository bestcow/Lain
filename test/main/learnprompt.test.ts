import { describe, it, expect } from 'vitest'
import { buildLearnPrompt } from '../../src/main/learnprompt'

describe('buildLearnPrompt — /learn 스킬 저작 지시문(순수)', () => {
  it('요청 본문을 learn-request 블록에 그대로 담는다', () => {
    const p = buildLearnPrompt('https://example.com/docs 배포 절차')
    expect(p).toContain('<learn-request>')
    expect(p).toContain('https://example.com/docs 배포 절차')
  })

  it('빈 요청이면 "방금 이 대화" 폴백 안내', () => {
    const p = buildLearnPrompt('')
    expect(p).toContain('방금 이 대화에서 함께 한 작업')
  })

  it('저작 표준을 포함한다 — 발명 금지·kebab name·60자 설명·섹션 순서·skill_save', () => {
    const p = buildLearnPrompt('아무거나')
    expect(p).toContain('발명 금지')
    expect(p).toContain('kebab-case')
    expect(p).toContain('60자')
    expect(p).toContain('## 절차')
    expect(p).toContain('mcp__lain__skill_save')
    expect(p).toContain('skill_view')
    expect(p).toContain('시크릿')
  })
})
