import { describe, it, expect } from 'vitest'
import { SHORTCUTS, groupedShortcuts, paletteHotkeys } from '../../src/renderer/lib/shortcuts'

describe('SHORTCUTS — 실제 구현된 단축키 목록(코드-라벨 일치 고정)', () => {
  it('전역/대화/인박스 핵심 단축키가 정확히 나열됨', () => {
    const byKeys = new Map(SHORTCUTS.map((s) => [s.keys, s]))
    // App.tsx keydown 핸들러에 실제 구현된 것들
    expect(byKeys.has('Ctrl+K')).toBe(true)
    expect(byKeys.has('?')).toBe(true)
    expect(byKeys.has('Esc')).toBe(true)
    expect(byKeys.has('Ctrl+F')).toBe(true)
    expect(byKeys.has('↑ / ↓')).toBe(true)
    // AttentionInbox 행 단축키
    expect(byKeys.get('y / Enter')?.group).toBe('인박스')
    expect(byKeys.get('n')?.group).toBe('인박스')
    expect(byKeys.get('m / Enter')?.group).toBe('인박스')
    expect(byKeys.get('b')?.group).toBe('인박스')
  })

  it('날조 방지 — Ctrl+S 등 미구현 단축키는 없어야 함', () => {
    const keys = SHORTCUTS.map((s) => s.keys)
    expect(keys).not.toContain('Ctrl+S')
    expect(keys).not.toContain('Ctrl+Z')
    expect(keys).not.toContain('Ctrl+Enter')
  })

  it('모든 항목은 keys·desc·group을 갖는다', () => {
    for (const s of SHORTCUTS) {
      expect(s.keys).toBeTruthy()
      expect(s.desc).toBeTruthy()
      expect(s.group).toBeTruthy()
    }
  })
})

describe('groupedShortcuts — 그룹 순서 보존 묶음', () => {
  it('첫 등장 순으로 그룹화(전역→대화→인박스)', () => {
    const groups = groupedShortcuts()
    expect(groups.map((g) => g.group)).toEqual(['전역', '대화', '인박스'])
  })

  it('각 그룹 items 합계 = 전체 개수', () => {
    const groups = groupedShortcuts()
    const total = groups.reduce((n, g) => n + g.items.length, 0)
    expect(total).toBe(SHORTCUTS.length)
  })

  it('커스텀 목록도 그룹화된다', () => {
    const groups = groupedShortcuts([
      { keys: 'a', desc: 'A', group: 'G1' },
      { keys: 'b', desc: 'B', group: 'G2' },
      { keys: 'c', desc: 'C', group: 'G1' },
    ])
    expect(groups.map((g) => g.group)).toEqual(['G1', 'G2'])
    expect(groups[0].items.map((i) => i.keys)).toEqual(['a', 'c'])
  })
})

describe('paletteHotkeys — 팔레트 항목 뱃지 매핑', () => {
  it('paletteId 있는 항목만 매핑', () => {
    const map = paletteHotkeys()
    expect(map['act:shortcuts']).toBe('?')
    // paletteId 없는 항목은 제외
    expect(Object.keys(map).length).toBe(SHORTCUTS.filter((s) => s.paletteId).length)
  })
})
