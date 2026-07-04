// 일시적 상류(Anthropic API) 에러 식별 + 백오프 — manager/worker가 자동 재시도에 쓴다.
// 529 overloaded_error·5xx는 서버측 일시 장애라 재시도 대상(claude-api 에러 분류). 짧은 과부하 blip에
// 작업이 죽고 에러가 폰에 도배되는 걸 막는다. 사용자 입력·인증·요청 오류(4xx)는 재시도해도 의미 없어 제외.
// 429(rate limit)도 제외 — 자체 부하라 백오프보다 동시성 조정이 맞고, SDK/CLI가 이미 자체 재시도한다.
//
// 전송계층 네트워크 끊김(2026-06-25 실측): SDK가 소켓 끊김을 "401 Failed to authenticate ... The socket
// connection was closed unexpectedly"로 감싸 던지는 경우가 있다 — 이건 자격증명 문제가 아니라 한 번의
// 네트워크 blip이라 재시도가 맞다. "401" 같은 상태코드가 아니라 전송계층 문구로만 매칭해, 진짜 인증
// 오류(401 authentication_error / invalid x-api-key 등 소켓 문구 없는)는 그대로 비일시적으로 둔다.

export function isTransientApiError(msg: string): boolean {
  const s = (msg ?? '').toLowerCase()
  if (!s) return false
  return (
    s.includes('overloaded') || // overloaded_error / "529 Overloaded"
    s.includes('service unavailable') ||
    s.includes('internal server error') ||
    s.includes('bad gateway') ||
    s.includes('gateway timeout') ||
    /\b(529|500|502|503|504)\b/.test(s) || // 5xx 서버 에러(501 not_implemented은 제외)
    // 전송계층 네트워크 끊김 — 자격증명/4xx 문구로 감싸여 와도 일시적 blip이므로 재시도
    s.includes('socket connection was closed') ||
    s.includes('socket hang up') ||
    s.includes('fetch failed') ||
    s.includes('econnreset') ||
    s.includes('etimedout') ||
    s.includes('econnrefused') ||
    s.includes('eai_again') // DNS 일시 실패
  )
}

// 지수 백오프(0부터): 1s · 2s · 4s · 8s(상한). 결정론(지터 없음)이라 테스트 가능.
export function transientBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 8000)
}

// 재시도 상한 — 7분급 지속 장애는 로컬로 못 막으니 무한 재시도 금지. 짧은 blip 흡수가 목적.
export const MAX_TRANSIENT_RETRIES = 3
