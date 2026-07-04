// 렌더러 순수 헬퍼 — App.tsx 컴포넌트 본문에서 분리한 상태 비의존 로직.
// import 부작용 0(window.lain·React 미사용)이라 단위테스트가 쉽다.
import type { ChatMessage } from '../../shared/types'
import type { SlashCmd } from '../components/SlashMenu'

/** Anthropic이 받는 이미지 4종만 이미지로 취급 — bmp/svg/tiff 등은 첨부 시 API 400 방지. */
export function isImageMime(mimeType: string): boolean {
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)
}

/** '/' 슬래시 명령 필터 — 첫 토큰(공백 분리) 접두 매칭, 대소문자 무시. */
export function filterSlash(input: string, commands: SlashCmd[]): SlashCmd[] {
  const first = input.split(/\s+/)[0].toLowerCase()
  return commands.filter((c) => c.cmd.toLowerCase().startsWith(first))
}

/** ChatEvent가 현재 열린 대화에 속하는지 — 레거시(conversationId 없음)·세션 불일치 분기. */
export function isEventForOpenConv(openConv: string | null, eventConvId: string | null | undefined): boolean {
  return !openConv || !eventConvId || eventConvId === openConv
}

/**
 * 이번 앱 실행 시작 시각 스탬프 — DB created_at(store.nowStamp)과 동일한
 * 'YYYY-MM-DD HH:MM:SS'(공백 구분, UTC) 포맷으로 만든다.
 * toISOString()의 'T'/'Z'·ms를 그대로 쓰면 ' '(0x20) < 'T'(0x54)라서 모든 DB 메시지가
 * 항상 더 작다고 판정돼 thisSession이 빈 배열을 반환(매 턴 채팅창이 리셋되는 버그) → 포맷을 맞춘다.
 */
export function sessionStartStamp(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** 이번 실행에서 생긴 메시지만 — created_at >= 세션 시작(동일 포맷 문자열 비교). */
export function filterThisSession<T extends ChatMessage>(rows: T[], sessionStart: string): T[] {
  return rows.filter((m) => m.createdAt >= sessionStart)
}

/** 대화 내 검색 — content substring(대소문자·trim 무시) 매치 메시지 id 목록. */
export function searchHitIds(msgs: ChatMessage[], query: string): number[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return msgs.filter((m) => m.content.toLowerCase().includes(q)).map((m) => m.id)
}

/** 입력 히스토리 회상 시 ` [+N개 첨부]` 꼬리표 제거(앵커$ — 중간 삽입은 보존). */
export function stripAttachSuffix(content: string): string {
  return content.replace(/ \[\+\d+개 첨부\]$/, '')
}

/** 초안/회상 키 — manager는 세션(conv)별, Navi/@all은 대상별. */
export function computeTargetKey(target: string, conv: string | null): string {
  return target === 'manager' ? (conv ?? 'manager') : target
}
