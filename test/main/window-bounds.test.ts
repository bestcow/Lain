// B8 — 창 bounds 화면 밖 보정 순수 로직 검증.
import { describe, it, expect } from 'vitest'
import {
  parseWindowBounds,
  isBoundsOnScreen,
  resolveWindowBounds,
  type DisplayLike,
} from '../../src/main/window-bounds'

const display: DisplayLike = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }

describe('parseWindowBounds', () => {
  it('정상 JSON을 파싱한다', () => {
    expect(parseWindowBounds('{"x":10,"y":20,"width":800,"height":600}')).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    })
  })

  it('null/빈 값은 null', () => {
    expect(parseWindowBounds(null)).toBeNull()
  })

  it('손상된 JSON은 null', () => {
    expect(parseWindowBounds('{broken')).toBeNull()
  })

  it('필드 누락/타입 불일치는 null', () => {
    expect(parseWindowBounds('{"x":10,"y":20}')).toBeNull()
    expect(parseWindowBounds('{"x":"10","y":20,"width":800,"height":600}')).toBeNull()
  })
})

describe('isBoundsOnScreen', () => {
  it('화면 안에 완전히 있으면 true', () => {
    expect(isBoundsOnScreen({ x: 100, y: 100, width: 800, height: 600 }, display)).toBe(true)
  })

  it('화면과 충분히 겹치면(일부만 벗어나도) true', () => {
    expect(isBoundsOnScreen({ x: -50, y: 100, width: 800, height: 600 }, display)).toBe(true)
  })

  it('완전히 화면 밖(해제된 모니터 좌표)이면 false', () => {
    expect(isBoundsOnScreen({ x: 2000, y: 100, width: 800, height: 600 }, display)).toBe(false)
    expect(isBoundsOnScreen({ x: -2000, y: 100, width: 800, height: 600 }, display)).toBe(false)
    expect(isBoundsOnScreen({ x: 100, y: -2000, width: 800, height: 600 }, display)).toBe(false)
  })

  it('경계에 겨우 걸친(최소 가시폭 미만) 경우 false', () => {
    expect(isBoundsOnScreen({ x: 1919, y: 100, width: 800, height: 600 }, display)).toBe(false)
  })
})

describe('resolveWindowBounds', () => {
  it('저장값이 없으면 null(기본값 사용)', () => {
    expect(resolveWindowBounds(null, display)).toBeNull()
  })

  it('디스플레이 조회 실패 시 null(기본값 사용)', () => {
    expect(resolveWindowBounds('{"x":10,"y":20,"width":800,"height":600}', null)).toBeNull()
  })

  it('화면 안이면 저장값을 그대로 복원', () => {
    const saved = { x: 10, y: 20, width: 800, height: 600 }
    expect(resolveWindowBounds(JSON.stringify(saved), display)).toEqual(saved)
  })

  it('화면 밖이면 null로 보정(기본값 폴백)', () => {
    const saved = { x: 5000, y: 5000, width: 800, height: 600 }
    expect(resolveWindowBounds(JSON.stringify(saved), display)).toBeNull()
  })
})
