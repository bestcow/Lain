import { describe, it, expect } from 'vitest'
import { buildOverlayPrompt } from '../../src/main/overlayprompt'

describe('buildOverlayPrompt', () => {
  const p = buildOverlayPrompt('IDE(VS Code) — 개발 맥락')
  it('개발 신호 목록과 침묵 기본값을 담는다', () => {
    expect(p).toContain('<<SILENT>>')
    expect(p).toMatch(/에러|스택트레이스/)
    expect(p).toMatch(/빌드 실패|테스트 실패/)
  })
  it('작업 위임 제안 규칙을 담는다', () => {
    expect(p).toMatch(/맡을까요|위임/)
  })
  it('appHint가 주입된다', () => {
    expect(p).toContain('IDE(VS Code)')
  })
  it('연구 에스컬레이션 규칙 유지', () => {
    expect(p).toContain('<<RESEARCH>>')
  })
})
