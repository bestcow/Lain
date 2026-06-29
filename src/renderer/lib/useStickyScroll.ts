// 대화 로그 자동 바닥 스크롤 훅 — 바닥 근처(80px 이내)일 때만 따라 내려가고,
// 위로 올라가 읽는 중 새 메시지가 오면 showJump=true로 ↓점프 버튼을 띄운다.
// ChatPanel/NaviChatPanel 공용. 외부 의존 0(React만).
// bottomRef는 로그 맨 끝의 sentinel <div>에 붙인다(스크롤 컨테이너는 그 부모).
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const NEAR_BOTTOM = 80 // 바닥에서 이 px 이내면 '바닥에 붙어있음'으로 간주

export interface StickyScroll {
  /** 로그 맨 끝 sentinel <div>에 붙일 ref. */
  bottomRef: RefObject<HTMLDivElement | null>
  /** 바닥을 벗어난 채 새 메시지가 쌓였는지 — ↓점프 버튼 노출용. */
  showJump: boolean
  /** 맨 아래로 즉시 스크롤하고 showJump를 끈다. */
  jumpToBottom: () => void
}

interface Options {
  /** 검색 등으로 자동 추종을 멈출 때 true(이때 showJump도 올리지 않음). */
  paused?: boolean
  /** 검색 활성 히트 id — 바뀌면 그 요소가 이미 가시영역이라 자동 추종을 보류. */
  activeHitId?: number | null
}

/**
 * @param deps  메시지/승인 개수 등(늘어날 때 바닥 추종/새글 감지 트리거)
 * @param opts  paused/activeHitId
 */
export function useStickyScroll(
  deps: (number | boolean)[],
  opts: Options = {},
): StickyScroll {
  const { paused = false, activeHitId = null } = opts
  const bottomRef = useRef<HTMLDivElement>(null)
  const [showJump, setShowJump] = useState(false)

  const scrollParent = useCallback((): HTMLElement | null => {
    return (bottomRef.current?.parentElement as HTMLElement | null) ?? null
  }, [])

  const atBottom = useCallback((): boolean => {
    const el = scrollParent()
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM
  }, [scrollParent])

  const jumpToBottom = useCallback(() => {
    const el = scrollParent()
    if (el) el.scrollTop = el.scrollHeight
    setShowJump(false)
  }, [scrollParent])

  // 메시지 길이/일시정지 등이 바뀔 때 바닥 추종 또는 새글 배지
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (paused) return
    if (atBottom()) {
      const el = scrollParent()
      if (el) el.scrollTop = el.scrollHeight
      setShowJump(false)
    } else {
      setShowJump(true) // 위에서 읽는 중 새 메시지 도착
    }
    // deps는 spread — 길이/busy 등이 바뀔 때만 트리거
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, paused, activeHitId, atBottom, scrollParent])

  // 사용자가 다시 바닥으로 스크롤하면 새글 배지 해제
  useEffect(() => {
    const el = scrollParent()
    if (!el) return
    const onScroll = (): void => {
      if (atBottom()) setShowJump(false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [atBottom, scrollParent])

  return { bottomRef, showJump, jumpToBottom }
}
