// STT(Whisper) 환청 필터 — 무음/잡음/극단적 짧은 입력에서 whisper-large-v3는 학습 데이터의 흔한 문구를
// 지어낸다(특히 한국어=뉴스 방송 다수 → "○○ 뉴스 ○○입니다", "구독과 좋아요" 등). 그 가짜 전사를 거른다.
// 주의: "감사합니다"처럼 사용자가 실제로 말할 법한 짧은 문구는 거르지 않는다(오탐 방지) — 고신뢰 시그니처만.
// 순수 함수(테스트 가능). STT 경로(PC voice·discord·telegram)에서 공통 적용.

const PATTERNS: RegExp[] = [
  /(MBC|KBS|SBS|YTN|JTBC|연합뉴스|채널\s?A|TV\s?조선)\s*뉴스/, // 방송사 뉴스 사인오프
  /뉴스\s*\S{1,8}\s*입니다\.?$/, // "뉴스 ○○입니다"
  /시청\s*해?\s*주셔서?\s*감사/, // "시청해 주셔서 감사합니다"(단독 '감사합니다'는 제외)
  /구독[^\n]{0,8}좋아요/, // "구독과 좋아요"
  /좋아요[^\n]{0,8}구독/,
  /다음\s*(영상|시간)에/, // "다음 영상에서…"
  /자막\s*(제공|by|:)/i,
  /(이|본)\s*영상은[^\n]{0,20}(제작|지원)/,
]

export function isLikelyWhisperHallucination(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  return PATTERNS.some((re) => re.test(t))
}
