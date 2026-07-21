// 학습 계보 그래프 — 병합(consolidation) 계보의 방사형 레이아웃 계산(순수, vitest 검증).
// 중심에 umbrella(통합본), 원둘레에 흡수된 원본을 등간격 배치한다. 렌더(SVG)는 LessonsPanel 담당 —
// 여기는 좌표·접기(collapse) 산술만 둔다(상태·IPC 없음, lessonDerive.ts와 동일 관행).
import type { Lesson } from '../../shared/types'

/** 흡수 원본이 이 수를 넘으면 접는다 — 넘치는 만큼은 '+N' 노드 하나로 묶고 클릭 시 펼침. */
export const LINEAGE_COLLAPSE_THRESHOLD = 8
/** 접힘 상태에서 실제로 보여줄 원본 수 — 남는 한 자리는 '+N' 노드가 차지한다. */
export const LINEAGE_COLLAPSED_VISIBLE = LINEAGE_COLLAPSE_THRESHOLD - 1

const MIN_RADIUS = 88 // 위성이 적어도 라벨이 중심과 안 겹치는 최소 반지름(px)
const ARC_PER_NODE = 66 // 위성 간 최소 호 간격(px) — 라벨 겹침 방지, 개수에 비례해 반지름 확장
const NODE_MARGIN = 62 // 원둘레 밖 여백(px) — 위성 라벨이 SVG 경계에 잘리지 않게

export interface LineageNode {
  kind: 'umbrella' | 'origin' | 'more'
  lessonId: number | null // origin/umbrella=해당 학습 id, more=null(펼침 전용 노드)
  label: string // 노드에 붙는 짧은 라벨(잘림)
  title: string // 툴팁용 전체 본문
  x: number
  y: number
}

export interface LineageEdge {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface LineageLayout {
  width: number
  height: number
  cx: number
  cy: number
  radius: number
  umbrella: LineageNode
  satellites: LineageNode[] // 원본 노드들(접힘이면 마지막에 '+N' 노드)
  edges: LineageEdge[] // 중심→각 위성
  hiddenCount: number // 접혀서 숨은 원본 수(0=모두 표시)
}

/** 노드 라벨용 잘림 — 공백 정규화 후 max 글자 초과분은 '…'로 대체. */
export function truncateLabel(text: string, max = 10): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** 방사형 계보 레이아웃 — 원본이 없으면 null(그래프 미표시). expanded=false고 원본이
 *  LINEAGE_COLLAPSE_THRESHOLD 초과면 앞 LINEAGE_COLLAPSED_VISIBLE건 + '+N' 노드로 접는다.
 *  위성은 12시 방향부터 시계방향 등간격, 반지름은 위성 수에 비례(호 간격 유지). 좌표는 정수 반올림(렌더 안정). */
export function lineageLayout(
  umbrella: Lesson,
  originals: Lesson[],
  expanded: boolean,
): LineageLayout | null {
  if (originals.length === 0) return null
  const collapsed = !expanded && originals.length > LINEAGE_COLLAPSE_THRESHOLD
  const shown = collapsed ? originals.slice(0, LINEAGE_COLLAPSED_VISIBLE) : originals
  const hiddenCount = originals.length - shown.length
  const n = shown.length + (collapsed ? 1 : 0) // 위성 총수('+N' 포함)
  const radius = Math.max(MIN_RADIUS, Math.round((n * ARC_PER_NODE) / (2 * Math.PI)))
  const size = 2 * (radius + NODE_MARGIN)
  const cx = size / 2
  const cy = size / 2
  const posAt = (i: number): { x: number; y: number } => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n // 12시 시작, 시계방향
    return { x: Math.round(cx + radius * Math.cos(a)), y: Math.round(cy + radius * Math.sin(a)) }
  }
  const satellites: LineageNode[] = shown.map((l, i) => ({
    kind: 'origin' as const,
    lessonId: l.id,
    label: truncateLabel(l.lesson),
    title: l.lesson,
    ...posAt(i),
  }))
  if (collapsed)
    satellites.push({
      kind: 'more',
      lessonId: null,
      label: `+${hiddenCount}`,
      title: `숨은 원본 ${hiddenCount}건 — 클릭하면 펼침`,
      ...posAt(n - 1),
    })
  const edges: LineageEdge[] = satellites.map((s) => ({ x1: cx, y1: cy, x2: s.x, y2: s.y }))
  return {
    width: size,
    height: size,
    cx,
    cy,
    radius,
    umbrella: {
      kind: 'umbrella',
      lessonId: umbrella.id,
      label: truncateLabel(umbrella.lesson),
      title: umbrella.lesson,
      x: cx,
      y: cy,
    },
    satellites,
    edges,
    hiddenCount,
  }
}
