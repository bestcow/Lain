// '/' 슬래시 명령 팝업 — 매니저 입력창에 '/' 입력 시 입력창 위에 뜨는 필터형 세로 명령 목록.
// 명령 본문은 텔레그램 슬래시 명령(telegram.ts handleCommand)과 대응. 키 처리는 App.tsx onKeyDown,
// 여기선 hover/click만(ctx-menu 톤). insert는 명령 텍스트를 입력창에 채우고, run은 즉시 실행.
import type { ReactNode } from 'react'

export interface SlashCmd {
  cmd: string // '/scan' 등 — 입력 매칭·표시용 슬러그
  label: string // 사람이 읽을 짧은 설명
  arg?: string // 인자 힌트(있으면 명령에 공백+커서, 없으면 즉시 실행 가능)
}

// 텔레그램 슬래시 명령 원본(telegram.ts handleCommand)과 대응하는 8개.
export const SLASH_COMMANDS: SlashCmd[] = [
  { cmd: '/scan', label: '프로젝트 재스캔' },
  { cmd: '/refresh', label: '현황 새로고침' },
  { cmd: '/projects', label: '프로젝트 목록' },
  { cmd: '/tasks', label: '진행 중 작업' },
  { cmd: '/approvals', label: '대기 항목(인박스) 열기' },
  { cmd: '/go', label: 'TASK.md로 작업 시작', arg: '<프로젝트id>' },
  { cmd: '/verify', label: '검증 실행', arg: '<프로젝트id>' },
  { cmd: '/cancel', label: '작업 취소', arg: '<taskId>' },
  { cmd: '/learn', label: '절차를 스킬로 학습·저장', arg: '<주제·URL·경로·"방금 한 작업">' },
]

interface Props {
  items: SlashCmd[]
  activeIndex: number
  onPick: (c: SlashCmd) => void
  onHover: (i: number) => void
}

export function SlashMenu({ items, activeIndex, onPick, onHover }: Props): ReactNode {
  if (items.length === 0) return null
  return (
    <div className="slash-menu" role="listbox">
      {items.map((c, i) => (
        <button
          key={c.cmd}
          className={`slash-item${i === activeIndex ? ' slash-item-sel' : ''}`}
          role="option"
          aria-selected={i === activeIndex}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // mousedown으로 잡아 textarea blur 전에 선택 — 입력 포커스 유지
            e.preventDefault()
            onPick(c)
          }}
        >
          <span className="slash-cmd">{c.cmd}</span>
          {c.arg && <span className="slash-arg">{c.arg}</span>}
          <span className="slash-label">{c.label}</span>
        </button>
      ))}
    </div>
  )
}
