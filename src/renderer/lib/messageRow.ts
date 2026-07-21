// B4 — 메시지 행 memo 비교(순수 함수). ChatPanel·NaviChatPanel의 React.memo된 행 컴포넌트가 쓰는
// 얕은 동등 비교를 여기 분리해 vitest로 고정한다(외부 의존 0). 핵심: 델타 스트리밍(assistant_delta)은
// 바뀐 메시지 1개만 새 객체로 교체하고 나머지는 같은 참조를 유지하므로(App.tsx setMessages map),
// 아래 비교가 참조 동등(m===m)으로 나머지 행의 리렌더(마크다운 재파싱 포함)를 통째로 스킵한다.
//
// activeHitId·queuedIds 같은 '전체 배열 대상' 상태는 raw로 넘기지 않고 행별 프리미티브(isActiveHit·queued)로
// 분해해 넘긴다 — 그래야 히트/대기 상태가 바뀌어도 실제로 값이 달라진 행만 리렌더된다.
import type { ChatMessage } from '../../shared/types'

/** 메시지 객체 자체의 렌더 결과에 영향을 주는 필드가 같은지 — 참조가 다르더라도 내용 동등이면 스킵 가능.
 * 대부분의 경우 참조 동등(a===b)으로 즉시 통과하지만, 방어적으로 렌더에 쓰이는 필드를 비교한다. */
export function sameMessageRenderFields(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.content === b.content &&
    a.chapter === b.chapter &&
    a.origin === b.origin &&
    a.createdAt === b.createdAt &&
    a.scope === b.scope &&
    a.projectId === b.projectId &&
    sameAttachments(a.attachments, b.attachments)
  )
}

/** 첨부 배열 얕은 동등 — 이미지/파일 미리보기 렌더에만 쓰이므로 name·isImage·data 참조 비교로 충분. */
function sameAttachments(
  a: ChatMessage['attachments'],
  b: ChatMessage['attachments'],
): boolean {
  const la = a?.length ?? 0
  const lb = b?.length ?? 0
  if (la !== lb) return false
  if (la === 0) return true
  for (let i = 0; i < la; i++) {
    const x = a![i]
    const y = b![i]
    if (x === y) continue
    if (x.name !== y.name || x.isImage !== y.isImage || x.data !== y.data) return false
  }
  return true
}

/** ChatPanel(레인)·NaviChatPanel 공용 행 memo prop 형태 — 렌더에 실제로 쓰이는 값만.
 * 콜백은 App에서 useCallback으로 안정화됨. (Navi는 sameSpeaker 계산 입력만 다르고 비교 자체는 동일.) */
export interface ChatRowCompareProps {
  m: ChatMessage
  query: string
  isActiveHit: boolean
  queued: boolean
  sameSpeaker: boolean
  onMessageContext?: unknown
  onCancelQueued?: unknown
}

/** true면 리렌더 스킵. React.memo의 areEqual과 동일 규약(같으면 true). */
export function chatRowPropsEqual(prev: ChatRowCompareProps, next: ChatRowCompareProps): boolean {
  return (
    prev.query === next.query &&
    prev.isActiveHit === next.isActiveHit &&
    prev.queued === next.queued &&
    prev.sameSpeaker === next.sameSpeaker &&
    prev.onMessageContext === next.onMessageContext &&
    prev.onCancelQueued === next.onCancelQueued &&
    sameMessageRenderFields(prev.m, next.m)
  )
}
