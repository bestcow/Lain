// 메인 창 bounds 저장/복원 (B8) — 순수 로직만 분리해 electron 없이 테스트한다.
// 저장은 index.ts가 getSetting/setSetting(JSON 직렬화, 저널 영속)으로 수행.
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayLike {
  workArea: { x: number; y: number; width: number; height: number }
}

export const DEFAULT_WINDOW_BOUNDS: Omit<WindowBounds, 'x' | 'y'> = {
  width: 1280,
  height: 840,
}

/** 저장된 bounds 문자열을 안전하게 파싱. 손상/누락이면 null. */
export function parseWindowBounds(raw: string | null): WindowBounds | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (
      v &&
      typeof v.x === 'number' &&
      typeof v.y === 'number' &&
      typeof v.width === 'number' &&
      typeof v.height === 'number'
    ) {
      return { x: v.x, y: v.y, width: v.width, height: v.height }
    }
    return null
  } catch {
    return null
  }
}

/** 저장된 bounds가 주어진 디스플레이의 workArea와 최소한으로라도 겹치는지 확인.
 *  모니터 해제(노트북 도킹 해제 등)로 좌표가 화면 밖에 남으면 창이 안 보이는 상태가 되므로,
 *  타이틀바가 걸쳐 보일 최소 폭(MIN_VISIBLE)만큼도 안 겹치면 화면 밖으로 판정한다. */
const MIN_VISIBLE = 40

export function isBoundsOnScreen(bounds: WindowBounds, display: DisplayLike): boolean {
  const wa = display.workArea
  const overlapW = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x)
  const overlapH = Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y)
  return overlapW >= MIN_VISIBLE && overlapH >= MIN_VISIBLE
}

/** 복원 시 최종 사용할 bounds 결정. 저장값이 없거나 화면 밖이면 기본값(폭·높이만, 위치는 OS 기본). */
export function resolveWindowBounds(
  raw: string | null,
  matchingDisplay: DisplayLike | null,
): WindowBounds | null {
  const saved = parseWindowBounds(raw)
  if (!saved) return null
  if (!matchingDisplay) return null
  return isBoundsOnScreen(saved, matchingDisplay) ? saved : null
}
