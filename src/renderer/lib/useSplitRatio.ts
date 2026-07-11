import { useCallback, useEffect, useState } from 'react'

export function clampRatio(r: number): number {
  return Math.max(0.2, Math.min(0.8, r))
}

// top-zone이 차지하는 세로 비율(0.2~0.8). 드래그로 조절, localStorage 영속.
export function useSplitRatio(key = 'lain.splitRatio') {
  const [ratio, setRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? clampRatio(v) : 0.5
  })
  useEffect(() => {
    localStorage.setItem(key, String(ratio))
  }, [key, ratio])

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const body = (e.currentTarget as HTMLElement).parentElement
    if (!body) return
    const rect = body.getBoundingClientRect()
    const move = (ev: MouseEvent) => setRatio(clampRatio((ev.clientY - rect.top) / rect.height))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  return { ratio, onDragStart }
}
