// 음성 요약 태그 — 레인이 응답 끝에 `<<say: 한 줄 요지>>`로 붙인다.
// 화면/텔레그램/디스코드 텍스트에선 이 태그를 떼고(누출 방지), 음성(TTS)은 이 한 줄만 읽는다.
// 본문이 길어도 사용자가 핵심만 빠르게 듣게 하기 위함(전문 낭독 = 너무 김). main/renderer 공용(순수 함수).

// 모듈 스코프 상수 — 매 호출 재컴파일 방지(extractSpeech는 메시지 렌더·응답 음성 경로에서 자주 불린다).
const SAY_RE = /<<\s*say\s*:\s*([\s\S]*?)>>/gi
const TRAIL_WS = /[ \t]+\n/g
const MULTI_NL = /\n{3,}/g

/** 텍스트에서 say 태그를 떼낸 표시용 clean과 합쳐진 say(음성용)를 반환. */
export function extractSpeech(text: string): { clean: string; say: string } {
  if (!text) return { clean: text ?? '', say: '' }
  const says: string[] = []
  // '<<'가 없으면 say 태그도 없다 — SAY_RE 스캔을 건너뛴다(대부분의 메시지). 공백 정리는 동일하게 적용.
  const stripped = text.includes('<<')
    ? text.replace(SAY_RE, (_m, p1) => {
        const s = String(p1).trim()
        if (s) says.push(s)
        return ''
      })
    : text
  const clean = stripped.replace(TRAIL_WS, '\n').replace(MULTI_NL, '\n\n').trim()
  return { clean, say: says.join(' ').trim() }
}

// 첫 문장 추출 — 마침표/물음표/느낌표/줄바꿈 중 가장 먼저 나오는 지점까지, 없으면 100자 컷.
// say 태그를 빼먹은 장문 응답이 완전 무음으로 스킵되는 것을 막기 위한 폴백(B7-1).
function firstSentence(text: string): string {
  const m = text.match(/^[\s\S]*?[.!?。！？\n]/) // 첫 종결부호(마침표류) 또는 줄바꿈까지
  const cut = (m ? m[0] : text.slice(0, 100)).trim()
  return cut.length <= 100 ? cut : cut.slice(0, 100).trim()
}

/** TTS로 읽을 텍스트 — say 태그가 있으면 그것만. 없으면: 짧은 응답은 그대로, 긴 본문은
 * 첫 문장(~100자)만 읽는다(B7-1: say 태그 누락 시 완전 무음 방지). */
export function spokenText(text: string): string {
  const { clean, say } = extractSpeech(text)
  if (say) return say
  if (clean.length <= 100) return clean
  return firstSentence(clean)
}
