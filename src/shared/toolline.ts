// A17 — 도구 라인(tool 메시지) 표시용 축약과 원문을 함께 나른다.
// main(manager.ts·navichat.ts)에서 도구 호출을 한 줄로 축약해 저장할 때, 잘려나간 원문(명령 전체·긴 패턴 등)이
// DB 어디에도 남지 않아 복구 불가능한 문제(감사 A17)를 고친다. 스키마 변경 없이 content 문자열 하나에
// '축약원문'으로 함께 인코딩 — main/renderer 공용 순수 함수(speech.ts와 동일한 공유 모듈 패턴).
// U+001F(Unit Separator)는 표시 축약문(우리가 만드는 짧은 문자열)엔 절대 나오지 않고, 명령/경로 등
// 원문에도 사실상 나타나지 않는 제어문자라 안전한 구분자로 쓴다. indexOf 최초 1회 분리라 원문 안에
// 같은 문자가 또 있어도(사실상 불가능하지만) display 쪽만 순수하면 안전.
const SEP = String.fromCharCode(31) // U+001F(Unit Separator) — 리터럴로 안 쓰고 명시적으로 생성(에디터·grep 안전)

/** 원문(최대 max자)을 축약 라인 뒤에 붙여 하나의 content 문자열로 합친다.
 * 원문이 비었거나, display 안에 원문이 그대로(잘리지 않고) 들어있으면 태그를 생략(용량 낭비 방지) —
 * display가 'Read foo.ts'·raw가 'foo.ts'인 경우처럼 접두사(도구명 등)만 붙는 케이스도 잘림이 아니므로 포함. */
export function encodeToolLine(display: string, raw: string, max = 512): string {
  const trimmedRaw = raw.trim()
  if (!trimmedRaw || display.includes(trimmedRaw)) return display
  return `${display}${SEP}${trimmedRaw.slice(0, max)}`
}

/** encodeToolLine 결과를 다시 표시용/원문으로 분리. 원문이 없으면(구분자 없음) raw는 null. */
export function decodeToolLine(content: string): { display: string; raw: string | null } {
  const i = content.indexOf(SEP)
  if (i === -1) return { display: content, raw: null }
  return { display: content.slice(0, i), raw: content.slice(i + 1) }
}
