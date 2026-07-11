// '@' 파일 자동완성 팝업(A12) — SlashMenu와 같은 자리(입력창 위)에 뜨는 필터형 세로 목록.
// '/' 슬래시 팝업과 상호 배타(App.tsx가 트리거 문자로 분기해 동시에 열지 않음)라 CSS는 slash-menu를
// 그대로 재사용(새 스타일 남발 방지) — 항목 모양만 파일 경로 전용으로 다르다.
import type { ReactNode } from 'react'

interface Props {
  items: string[] // 상대경로(레인=projectId/상대경로, Navi=상대경로) 목록 — 이미 fuzzy 필터·정렬된 상태로 받음
  activeIndex: number
  onPick: (path: string) => void
  onHover: (i: number) => void
}

export function AtFileMenu({ items, activeIndex, onPick, onHover }: Props): ReactNode {
  if (items.length === 0) return null
  return (
    <div className="slash-menu" role="listbox">
      {items.map((p, i) => (
        <button
          key={p}
          className={`slash-item${i === activeIndex ? ' slash-item-sel' : ''}`}
          role="option"
          aria-selected={i === activeIndex}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // mousedown으로 잡아 textarea blur 전에 선택 — 입력 포커스 유지
            e.preventDefault()
            onPick(p)
          }}
        >
          <span className="slash-cmd">{p}</span>
        </button>
      ))}
    </div>
  )
}
