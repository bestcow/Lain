// 채팅 메시지 우클릭 컨텍스트 메뉴 — 커서 위치에 뜨고, 바깥 클릭·Esc·스크롤 시 닫힌다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface CtxItem {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  rounded,
  openUp,
}: {
  x: number
  y: number
  items: CtxItem[]
  onClose: () => void
  rounded?: boolean // 둥근 모서리 변형(플러스 메뉴 전용)
  openUp?: boolean // (x,y) 위쪽으로 펼침 — 앵커 상단 기준 (플러스 메뉴 전용)
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // 화면 밖으로 넘치면 안쪽으로 당겨 클램프. openUp이면 (x,y) 위쪽으로 펼친다(앵커 상단 기준).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const gap = 6
    setPos({
      x: x + r.width > window.innerWidth ? Math.max(4, window.innerWidth - r.width - 4) : x,
      y: openUp
        ? Math.max(4, y - r.height - gap)
        : y + r.height > window.innerHeight
          ? Math.max(4, window.innerHeight - r.height - 4)
          : y,
    })
  }, [x, y, openUp])

  // 열리면 첫 항목에 포커스 — Tab 없이도 바로 ↑↓로 탐색 가능하게.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('.ctx-item:not(:disabled)')?.focus()
  }, [])

  // 바깥 클릭·Esc·스크롤·창 이동 → 닫기. ↑↓는 메뉴 항목 간 포커스 이동(우클릭 메뉴 키보드 완결).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const el = ref.current
      if (!el) return
      const opts = Array.from(el.querySelectorAll<HTMLButtonElement>('.ctx-item:not(:disabled)'))
      if (opts.length === 0) return
      e.preventDefault()
      const cur = opts.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        e.key === 'ArrowDown'
          ? opts[(cur + 1) % opts.length]
          : opts[(cur - 1 + opts.length) % opts.length]
      next.focus()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className={`ctx-menu${rounded ? ' ctx-menu-round' : ''}`}
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()} // 메뉴 내부 클릭은 '바깥 클릭' 닫기에서 제외
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <button
          key={i}
          className={`ctx-item${it.danger ? ' ctx-danger' : ''}`}
          disabled={it.disabled}
          onClick={() => {
            it.onClick()
            onClose()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
