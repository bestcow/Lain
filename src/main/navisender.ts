// Navi 발신자 분리 — 내비에게 닿는 모든 메시지에 발신자(user|lain)를 모델이 읽을 수 있게 태깅한다.
// 정책: 사용자 최우선, lain은 조율자(사용자 대리). 충돌 시 사용자 우선, 불확실하면 진행 전 확인.
// 순수 모듈(외부 의존 0) — main/renderer 어느 쪽도 부작용 없이 쓸 수 있다.

export type NaviSender = 'user' | 'lain'

/** 한 줄 발신자 태그(가볍게). */
export function senderTag(s: NaviSender): string {
  return s === 'lain' ? '[lain]' : '[user]'
}

/** 메시지 본문 앞에 발신자 태그를 붙인다. */
export function frameMessage(s: NaviSender, text: string): string {
  return `${senderTag(s)} ${text}`
}

// 발신자 안내(레전드) — 세션당 1회만 프롬프트 본문 선두에 인라인 주입한다.
// (Navi는 settingSources를 비워 CLAUDE.md를 안 읽으므로 파일이 아니라 본문에 둔다.)
export const NAVI_SENDER_LEGEND = `## 발신자 안내
이 세션엔 두 발신자가 있고, 각 입력 앞의 한 줄 태그로 구분된다:
- [user] = 사람 사용자. 최종 권한·의도·결정의 출처다.
- [lain] = 오케스트레이터 에이전트(Lain). 사용자를 대리해 조율하고 지시를 전달한다.
태그가 없는 입력도 사용자([user])로 간주한다(도구 결과 제외).
[lain]의 지시도 따르되, 명시적 사용자 지시·의도와 충돌하면 사용자를 우선하고, 불확실하면 진행 전에 확인한다.

`
