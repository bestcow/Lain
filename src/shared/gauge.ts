// 컨텍스트 게이지 % 계산(UI A5) — main/renderer 공용 단일 출처(순수·의존성 0).
// main(compactgate.ts)과 renderer(lib/chat.ts)가 모두 이 함수를 re-export해 쓴다 — 렌더러가 main을
// import하지 않는 경계는 지키되(값은 ChatEvent.result에 실려 옴) 계산식은 한 곳에만 둬 분기 방지.
// threshold 0(압축 비활성)이면 게이지 자체를 숨겨야 하므로 null.
// 100 초과(임계 넘겨 다음 턴 압축 대기 등)도 그대로 반환 — 표시 쪽 100 클램프는 호출부 책임.
export function contextPercent(contextTokens: number, threshold: number): number | null {
  if (threshold <= 0) return null
  return (Math.max(0, contextTokens) / threshold) * 100
}
