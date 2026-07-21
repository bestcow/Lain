import { describe, it, expect } from 'vitest'
import {
  lineageLayout,
  truncateLabel,
  LINEAGE_COLLAPSE_THRESHOLD,
  LINEAGE_COLLAPSED_VISIBLE,
} from '../../src/renderer/lib/lessonGraph'
import type { Lesson } from '../../src/shared/types'

// 학습 계보 그래프 — 방사형 레이아웃 순수 산술 고정(좌표·접기·라벨). 렌더(SVG)는 LessonsPanel이
// 이 좌표를 그대로 그리므로, 여기서 산술이 맞으면 DOM 구조도 결정된다(lessonDerive.test.ts 관행).

function mkLesson(over: Partial<Lesson>): Lesson {
  return {
    id: 1,
    projectId: 'p',
    taskId: 't',
    scope: 'project',
    trigger: '',
    lesson: 'x',
    reuseCount: 0,
    createdAt: '2026-07-07T10:00:00',
    status: 'active',
    lastUsedAt: null,
    pinned: false,
    origin: 'agent',
    absorbedInto: null,
    consolidationBatch: null,
    injectCount: 0,
    ...over,
  }
}

const umbrella = mkLesson({ id: 100, taskId: 'curator', lesson: '통합본' })
const originals = (n: number): Lesson[] =>
  Array.from({ length: n }, (_, i) => mkLesson({ id: i + 1, lesson: `원본-${i + 1}`, absorbedInto: 100 }))

describe('truncateLabel — 노드 라벨 잘림', () => {
  it('max 이하는 그대로', () => {
    expect(truncateLabel('짧은 라벨')).toBe('짧은 라벨')
  })
  it('max 초과는 잘라서 … 부착', () => {
    expect(truncateLabel('가나다라마바사아자차카타파하', 10)).toBe('가나다라마바사아자차…')
  })
  it('연속 공백·개행은 한 칸으로 정규화', () => {
    expect(truncateLabel('앞  뒤\n줄', 20)).toBe('앞 뒤 줄')
  })
})

describe('lineageLayout — 기본 방사형 배치', () => {
  it('원본 0건이면 null(그래프 미표시)', () => {
    expect(lineageLayout(umbrella, [], false)).toBeNull()
  })

  it('umbrella는 정중앙, 위성은 원본 수만큼', () => {
    const lay = lineageLayout(umbrella, originals(3), false)!
    expect(lay.umbrella.kind).toBe('umbrella')
    expect(lay.umbrella.lessonId).toBe(100)
    expect(lay.umbrella.x).toBe(lay.cx)
    expect(lay.umbrella.y).toBe(lay.cy)
    expect(lay.satellites).toHaveLength(3)
    expect(lay.satellites.every((s) => s.kind === 'origin')).toBe(true)
    expect(lay.hiddenCount).toBe(0)
  })

  it('첫 위성은 12시 방향(x=cx, y=cy-radius)', () => {
    const lay = lineageLayout(umbrella, originals(4), false)!
    expect(lay.satellites[0].x).toBe(lay.cx)
    expect(lay.satellites[0].y).toBe(lay.cy - lay.radius)
  })

  it('위성 좌표는 서로 겹치지 않고 모두 캔버스 안', () => {
    const lay = lineageLayout(umbrella, originals(8), false)!
    const keys = lay.satellites.map((s) => `${s.x},${s.y}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const s of lay.satellites) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(lay.width)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThanOrEqual(lay.height)
    }
  })

  it('간선은 위성 수와 같고 전부 중심에서 시작', () => {
    const lay = lineageLayout(umbrella, originals(5), false)!
    expect(lay.edges).toHaveLength(5)
    for (const [i, e] of lay.edges.entries()) {
      expect(e.x1).toBe(lay.cx)
      expect(e.y1).toBe(lay.cy)
      expect(e.x2).toBe(lay.satellites[i].x)
      expect(e.y2).toBe(lay.satellites[i].y)
    }
  })

  it('위성이 많아지면 반지름이 커진다(호 간격 유지)', () => {
    const small = lineageLayout(umbrella, originals(3), false)!
    const big = lineageLayout(umbrella, originals(20), true)!
    expect(big.radius).toBeGreaterThan(small.radius)
    expect(big.width).toBeGreaterThan(small.width)
  })

  it('노드 라벨은 잘리고 title엔 전체 본문 유지', () => {
    const long = mkLesson({ id: 7, lesson: '아주 길게 쓴 학습 본문이라 라벨에 다 안 들어간다' })
    const lay = lineageLayout(umbrella, [long], false)!
    expect(lay.satellites[0].label.length).toBeLessThanOrEqual(11) // 10자 + '…'
    expect(lay.satellites[0].label.endsWith('…')).toBe(true)
    expect(lay.satellites[0].title).toBe(long.lesson)
  })
})

describe('lineageLayout — 접기(collapse)', () => {
  it('임계 이하(정확히 8건)는 접지 않는다', () => {
    const lay = lineageLayout(umbrella, originals(LINEAGE_COLLAPSE_THRESHOLD), false)!
    expect(lay.satellites).toHaveLength(LINEAGE_COLLAPSE_THRESHOLD)
    expect(lay.satellites.some((s) => s.kind === 'more')).toBe(false)
    expect(lay.hiddenCount).toBe(0)
  })

  it('임계 초과면 앞 7건 + "+N" 노드로 접는다', () => {
    const lay = lineageLayout(umbrella, originals(12), false)!
    expect(lay.satellites).toHaveLength(LINEAGE_COLLAPSE_THRESHOLD) // 7 origin + 1 more
    const more = lay.satellites[lay.satellites.length - 1]
    expect(more.kind).toBe('more')
    expect(more.lessonId).toBeNull()
    expect(lay.hiddenCount).toBe(12 - LINEAGE_COLLAPSED_VISIBLE)
    expect(more.label).toBe(`+${12 - LINEAGE_COLLAPSED_VISIBLE}`)
    // 보이는 원본은 입력 순서 앞쪽 그대로
    expect(lay.satellites.slice(0, LINEAGE_COLLAPSED_VISIBLE).map((s) => s.lessonId)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ])
  })

  it('expanded=true면 전부 펼친다("+N" 노드 없음)', () => {
    const lay = lineageLayout(umbrella, originals(12), true)!
    expect(lay.satellites).toHaveLength(12)
    expect(lay.satellites.some((s) => s.kind === 'more')).toBe(false)
    expect(lay.hiddenCount).toBe(0)
  })
})
