// B9 — Promise 반환형 확인 다이얼로그 훅. OS 네이티브 alert/confirm(렌더러 블로킹·CRT 테마 이탈)을
// 커스텀 ConfirmWindow(내비 제거에서 쓰던 마크업)로 통일한다. `const ok = await confirm({ title, body,
// danger })` 형태로 어디서든 부른다. 상태 전이(열림→확인/취소)와 옵션 정규화를 순수 함수로 분리해 vitest로
// 고정한다(훅 본체는 React 상태 + resolve ref 배선만).
import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface ConfirmOptions {
  title: string
  body: ReactNode
  /** 부가 설명(작게, ConfirmWindow의 note 슬롯). */
  note?: ReactNode
  /** 확인 버튼 라벨(기본 '확인'). */
  confirmLabel?: string
  /** 위험(비가역) 동작이면 확인 버튼을 위험 스타일로. 기본 false. */
  danger?: boolean
  /** 통지형(취소 불필요) — 취소 버튼을 숨긴다. 기본 false(확인/취소 2버튼). */
  hideCancel?: boolean
}

/** 화면에 뜬 확인창 1개의 정규화된 표시 상태(버튼 라벨·danger 기본값 채움). */
export interface ConfirmState {
  title: string
  body: ReactNode
  note?: ReactNode
  confirmLabel: string
  danger: boolean
  hideCancel: boolean
}

/** 옵션 → 표시 상태 정규화(기본값 채움). 순수. */
export function normalizeConfirm(opts: ConfirmOptions): ConfirmState {
  return {
    title: opts.title,
    body: opts.body,
    note: opts.note,
    confirmLabel: opts.confirmLabel ?? '확인',
    danger: opts.danger ?? false,
    hideCancel: opts.hideCancel ?? false,
  }
}

/**
 * 대기 중 확인 요청을 결과값으로 결착 — resolve를 호출하고 다음 상태(null=닫힘)를 돌려준다. 순수.
 * pending이 없으면 아무 것도 하지 않는다(중복 확인/취소 방어).
 */
export function settleConfirm(
  pending: { resolve: (v: boolean) => void } | null,
  result: boolean,
): null {
  pending?.resolve(result)
  return null
}

export function useConfirm() {
  // pending: 현재 대기 중인 확인 요청(표시 상태 + Promise resolve). null이면 창 닫힘.
  const [pending, setPending] = useState<(ConfirmState & { resolve: (v: boolean) => void }) | null>(
    null,
  )
  // 직전 요청이 미결인 채 새 confirm이 오면 이전 것을 false로 결착(중첩 방지 — 확인창은 동시 1개).
  const pendingRef = useRef<{ resolve: (v: boolean) => void } | null>(null)
  pendingRef.current = pending

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      settleConfirm(pendingRef.current, false) // 이전 미결 요청은 취소로 결착
      setPending({ ...normalizeConfirm(opts), resolve })
    })
  }, [])

  const onConfirm = useCallback(() => {
    setPending((p) => settleConfirm(p, true))
  }, [])
  const onCancel = useCallback(() => {
    setPending((p) => settleConfirm(p, false))
  }, [])

  return { pending, confirm, onConfirm, onCancel }
}
