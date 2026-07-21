// 컨텍스트 자동 압축('무한세션') 게이트 — 순수 판정(의존성·부작용 0, vitest 단위테스트 가능).
// 무거운 압축 본체(LLM query·world.md 미러)는 compact.ts. 이 파일은 manager와 테스트가 공유한다.

// 컨텍스트 점유량 = 이번 요청에서 모델에 들어간 프롬프트 크기(input + 캐시). output_tokens는 생성분이라
// 다음 컨텍스트엔 누적 결과로만 반영되므로 점유량에서 제외한다(sumUsageTokens는 output까지 더해 다름).
export function contextOccupancyTokens(msg: unknown): number {
  const u = (msg as { usage?: Record<string, number> })?.usage
  if (!u) return 0
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

// 압축 트리거 판정 — threshold 0이면 완전 비활성(오늘과 100% 동일 동작 = 킬스위치). 경계(같음) 포함.
export function shouldCompact(contextTokens: number, threshold: number): boolean {
  return threshold > 0 && contextTokens >= threshold
}

// max-turns가 result 메시지 대신 throw로 끝나면(SDK error_max_turns 던짐) result 분기의 점유 기록이
// 누락돼 무한세션 압축 게이트가 영영 안 걸리던 버그 보정. throw 경로에서 기록할 점유값을 정한다:
//  - threshold 0(압축 비활성): 0 — 강제하지 않음(킬스위치 존중)
//  - 스트림에서 본 마지막 점유(lastSeenOccupancy)가 있으면 그 값(정확)
//  - 못 봤으면 임계값으로 보수 기록 → 다음 새 턴에 압축이 확실히 걸림(max-turns=대개 큰 트랜스크립트)
export function occupancyForMaxTurns(lastSeenOccupancy: number, threshold: number): number {
  if (threshold <= 0) return 0
  return lastSeenOccupancy > 0 ? lastSeenOccupancy : threshold
}
