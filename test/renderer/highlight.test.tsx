import { describe, it, expect } from 'vitest'
import { isValidElement, type ReactNode } from 'react'
import { highlight } from '../../src/renderer/components/highlight'

// ReactNode 트리에서 <mark>로 감싼 매치 텍스트만 모아 반환(구조 검사용 — DOM 불필요).
function marks(node: ReactNode): string[] {
  if (!Array.isArray(node)) return []
  const out: string[] = []
  for (const n of node) {
    if (isValidElement(n) && n.type === 'mark') {
      out.push(String((n.props as { children?: unknown }).children))
    }
  }
  return out
}

describe('highlight — 검색 하이라이트', () => {
  it('빈 쿼리 → 원문 문자열 그대로(분할 안 함)', () => {
    expect(highlight('hello world', '')).toBe('hello world')
    expect(highlight('hello world', '   ')).toBe('hello world')
  })

  it('단순 매치 → 매치 부분만 <mark>', () => {
    expect(marks(highlight('hello world', 'world'))).toEqual(['world'])
  })

  it('대소문자 무시(ig) — 원문 케이스 보존', () => {
    expect(marks(highlight('Hello HELLO hello', 'hello'))).toEqual(['Hello', 'HELLO', 'hello'])
  })

  it('정규식 특수문자 이스케이프 — 리터럴 매치', () => {
    expect(marks(highlight('a.b a.b', 'a.b'))).toEqual(['a.b', 'a.b'])
    // '.'가 정규식이면 'axb'도 매치되겠지만 이스케이프되어 매치 안 됨
    expect(marks(highlight('axb', 'a.b'))).toEqual([])
    expect(marks(highlight('f(x) call', '(x)'))).toEqual(['(x)'])
  })

  it('다중 매치', () => {
    expect(marks(highlight('aXaXa', 'X'))).toEqual(['X', 'X'])
  })

  it('매치 없으면 mark 0개', () => {
    expect(marks(highlight('hello', 'zzz'))).toEqual([])
  })
})
