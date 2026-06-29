// Ctrl+K / Ctrl+P 명령 팔레트 — 어디서든(입력창 포커스 중에도) 열려 대상 점프·액션을 한 목록에서 실행.
// 자체 키 핸들러(Esc/Enter/↑↓)로 가로채 App의 전역 Esc·입력창 Enter와 분리(stopPropagation).
import { useEffect, useMemo, useRef, useState } from 'react'

export interface PaletteItem {
  id: string
  label: string
  hint?: string
  group?: string
  run: () => void
}

export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 다중 토큰(공백 분리) AND 매칭 — label/hint/group 소문자 부분일치.
  const filtered = useMemo(() => {
    const tokens = q.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return items
    return items.filter((it) => {
      const hay = `${it.label} ${it.hint ?? ''} ${it.group ?? ''}`.toLowerCase()
      return tokens.every((t) => hay.includes(t))
    })
  }, [q, items])

  // 쿼리 바뀌면 선택을 맨 위로 리셋
  useEffect(() => {
    setSel(0)
  }, [q])

  const clampedSel = filtered.length ? Math.min(sel, filtered.length - 1) : 0

  const run = (it: PaletteItem | undefined) => {
    if (!it) return
    it.run()
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => (filtered.length ? (i + 1) % filtered.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0))
    } else if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return // 한글 IME 조합 확정 Enter는 무시
      e.preventDefault()
      e.stopPropagation()
      run(filtered[clampedSel])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // App 전역 Esc까지 전파 차단 — Esc는 팔레트만 닫는다
      onClose()
    }
  }

  // group별 묶음(첫 등장 순서 유지)
  let lastGroup: string | undefined

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div className="cmdk-window" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="cmdk-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="명령·대상 검색 — ↑↓ 이동 · Enter 실행 · Esc 닫기"
        />
        <div className="cmdk-list">
          {filtered.length === 0 ? (
            <div className="cmdk-empty">일치하는 항목 없음</div>
          ) : (
            filtered.map((it, i) => {
              const header = it.group && it.group !== lastGroup ? it.group : null
              lastGroup = it.group
              return (
                <div key={it.id}>
                  {header && <div className="cmdk-group">{header}</div>}
                  <button
                    className={`cmdk-item${i === clampedSel ? ' cmdk-item-sel' : ''}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => run(it)}
                  >
                    <span>{it.label}</span>
                    {it.hint && <span className="cmdk-hint">{it.hint}</span>}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
