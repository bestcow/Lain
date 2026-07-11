// 공용 확인 다이얼로그 — App.tsx의 내비 제거 확인창(pendingRemove)에서 쓰던 modal-backdrop/confirm-window
// 마크업을 일반화. 비가역 동작(내비 제거·작업 폐기 등) 클릭 시 재사용.
import type { ReactNode } from 'react'

interface Props {
  title: string
  message: ReactNode
  note?: ReactNode
  confirmLabel: string
  // 비가역·위험 동작이면 확인 버튼을 위험(핫핑크) 스타일로. 기본 true — 기존 호출부(내비 제거·작업 폐기)는
  // 모두 위험이라 명시 없이도 그대로 붉게 유지되고, useConfirm이 danger=false(예: 세션 리셋)면 평범하게.
  danger?: boolean
  // 통지형(취소 불필요) — 취소 버튼을 숨긴다. 기본 false(확인/취소 2버튼).
  hideCancel?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmWindow({
  title,
  message,
  note,
  confirmLabel,
  danger = true,
  hideCancel = false,
  onCancel,
  onConfirm,
}: Props) {
  return (
    // 키 이벤트 전파 차단 — 이 창이 inbox-row 등 자체 onKeyDown(단축키)을 가진 요소 안에 뜰 수 있어,
    // 여기서 Enter로 취소/확인을 누른 입력이 부모로 버블링돼 다른 동작(예: 병합)을 오발동하지 않게 막는다.
    <div className="modal-backdrop" onClick={onCancel} onKeyDown={(e) => e.stopPropagation()}>
      <div className="confirm-window" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">{title}</div>
        <div className="confirm-msg">{message}</div>
        {note && <div className="confirm-note">{note}</div>}
        <div className="confirm-actions">
          {!hideCancel && (
            <button autoFocus onClick={onCancel}>
              취소
            </button>
          )}
          <button
            className={danger ? 'btn-danger' : undefined}
            autoFocus={hideCancel}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
