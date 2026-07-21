// Navi 직접 채팅(§5.6) 학습 주입 — 새 세션 preamble에 넣을 <lessons> 블록 합성(순수, vitest 검증).
// 선별은 store.lessonsForProject(기존 랭킹 — pin > 관련도 > 재사용) 재사용, 여기는 주입 여부·포맷·cap만 담당.
// 포맷은 manager.ts(sendToManager)의 <lessons> 주입과 동형, cap도 manager와 동일 기준(상위 6건, 본문 원문 그대로).
import type { Lesson } from '../shared/types'

/** 개수 cap — manager(sendToManager)의 lessonsForProject limit(6)와 동일 기준(토큰 폭증 방지). */
export const NAVI_CHAT_LESSON_LIMIT = 6

/** 주입 여부(결정론) — 새 세션(resume 없음)일 때만 주입한다. resume 세션은 히스토리에
 *  이미 들어 있으므로 재주입하지 않는다(NAVI_SENDER_LEGEND·conventionsBlock과 동일 규칙). */
export function shouldInjectNaviChatLessons(resume: string | undefined): boolean {
  return !resume
}

/** 학습 블록 — manager의 <lessons> 포맷과 동형(`- trigger → lesson` 불릿). 비면 ''(주입 0).
 *  개수는 NAVI_CHAT_LESSON_LIMIT로 방어적 재컷. 다른 preamble 블록(conventionsBlock·handoffBlock)과
 *  같은 trailing \n\n 규약으로 뒤 블록과 이어붙는다. */
export function naviChatLessonsBlock(lessons: Lesson[]): string {
  const top = lessons.slice(0, NAVI_CHAT_LESSON_LIMIT)
  if (top.length === 0) return ''
  return `<lessons>\n이 프로젝트의 과거 대화·작업에서 학습한 내용 (참고하되 맹신 말 것):\n${top
    .map((l) => `- ${l.trigger ? l.trigger + ' → ' : ''}${l.lesson}`)
    .join('\n')}\n</lessons>\n\n`
}
