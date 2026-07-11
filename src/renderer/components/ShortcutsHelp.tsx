// B10 — 키보드 단축키 도움말 오버레이 1장. '?' 키(입력창 밖) 또는 팔레트의 '단축키 도움말' 항목으로 연다.
// 나열 내용은 lib/shortcuts의 단일 출처(실제 구현된 것만 — 테스트로 코드-라벨 일치 고정). CommandPalette와
// 동형으로 자체 Esc/배경클릭 닫기를 갖되, App 전역 Esc 체인에도 편입돼(오버레이 최우선) 둘 다 동작한다.
import { useEffect } from 'react'
import { groupedShortcuts } from '../lib/shortcuts'
import { Icon } from './icons'

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  // 배경/자체 요소 어디에 포커스가 있든 Esc로 닫히게 — App 전역 핸들러와 별개로 여기서도 잡는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const groups = groupedShortcuts()

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="shortcuts-window" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <span className="shortcuts-title">[ 키보드 단축키 ]</span>
          <button className="modal-close" onClick={onClose} aria-label="닫기">
            <Icon name="x-circle" size={18} />
          </button>
        </div>
        <div className="shortcuts-body">
          {groups.map((g) => (
            <div key={g.group} className="shortcuts-group">
              <div className="shortcuts-group-title">{g.group}</div>
              {g.items.map((s) => (
                <div key={s.keys + s.desc} className="shortcuts-row">
                  <kbd className="shortcuts-key">{s.keys}</kbd>
                  <span className="shortcuts-desc">{s.desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="shortcuts-foot dim">Esc · ? 또는 배경 클릭으로 닫기</div>
      </div>
    </div>
  )
}
