// T15(P6) — 리뷰 수정요청(rework) 순수부. 결재의 네 번째 선택지: 반려 대신 지적사항을 담아 같은
// worktree를 재작업시킨다. orchestrator가 import해 resolveReview에서 쓴다(무한루프 방지 상한 포함).
// 순수 함수만 둔다(부수효과·DB·SDK 없음) — vitest에서 orchestrator 전체를 끌지 않고 단위 테스트하려는 분리.

/** 재작업 상한(회). 이 횟수에 도달하면 더는 rework 불가 — 병합/보류/폐기로 결정해야 한다(발산 차단). */
export const REWORK_MAX = 2

/** 현재까지 재작업한 횟수(count)로 추가 재작업이 가능한지. count < REWORK_MAX 이면 가능. */
export function canRework(count: number): boolean {
  return count < REWORK_MAX
}

/** 재작업 재개 프롬프트 — 지적사항(comment)과 회차(round)를 담아 같은 Navi 세션에 주입한다.
 *  finishWork 재진입(verify→audit→review)이 자연스럽게 다시 돌게 완료 보고 형식을 유지하도록 지시한다. */
export function buildReworkPrompt(comment: string, round: number): string {
  return [
    `결재에서 수정 요청이 왔다 (재작업 ${round}회차, 최대 ${REWORK_MAX}회).`,
    '--- 지적사항 ---',
    comment,
    '--- 지시 ---',
    '지적사항 각각을 해소하라. 해소 불가능한 항목은 이유를 보고에 명시하라. 완료 후 동일 JSON 형식으로 다시 보고하라.',
  ].join('\n')
}
