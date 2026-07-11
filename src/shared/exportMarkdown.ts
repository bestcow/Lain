// A16 — 대화 내보내기(.md) 직렬화. 우클릭 '여기까지 복사'(구간)와 헤더 '대화 내보내기'(전체)가 공유하는
// 순수 함수. ChatPanel.tsx의 PREFIX(발신자 접두)·화면 표시 규칙을 그대로 따라 화면에서 보던 것과
// 일치하는 문서를 만든다(음성 태그 제거·도구 라인 축약은 extractSpeech/decodeToolLine 재사용).
import type { ChatMessage } from './types'
import { extractSpeech } from './speech'
import { decodeToolLine } from './toolline'
import { decodeTodoLine, todoProgress, TODO_STATUS_ICON } from './todoline'
import { decodeEditDiffLine, renderEditDiffText } from './editdiff'

// 발신자 접두 — 화면(ChatPanel)과 내보내기 문서가 공유하는 단일 출처(드리프트 방지).
// ChatPanel도 이 상수를 import해 화면에 그대로 표시한다("화면에서 보던 것과 일치" 원칙).
export const SENDER_PREFIX: Record<ChatMessage['role'], string> = {
  user: 'User',
  assistant: 'Lain',
  tool: 'sys>',
}

/** markdown에서 의미를 갖는 문자를 이스케이프 — 본문이 우연히 헤딩(#)·인용(>)·목록(-/*)으로
 * 해석되는 것을 막는다. 코드펜스(```)는 별도로 이스케이프해 문서 전체 구조가 깨지지 않게 한다. */
function escapeMarkdown(text: string): string {
  return text
    .replace(/```/g, '​```') // 코드펜스 — zero-width space를 끼워 펜스로 해석되지 않게
    .split('\n')
    .map((line) => line.replace(/^(\s*)([#>*+-]|\d+\.)(\s)/, '$1\\$2$3')) // 줄 시작의 헤딩/인용/목록 마커만
    .join('\n')
}

/** tool(system) 라인 — 축약(display)만 쓰고 원문(raw) 전개는 생략(문서 내보내기는 화면 요약 수준이면 충분,
 * 원문은 필요 시 화면에서 '전개' 토글로 확인). 인용(>) 처리해 본문과 시각적으로 구분한다.
 * A4 — TodoWrite 라인(encodeTodoLine)은 화면에서 위젯(체크리스트 칩)으로 보이므로, decodeToolLine을
 * 태우면 JSON 원문이 그대로 노출된다 — 화면과 동일하게 진행률 요약 + 항목 목록으로 풀어 쓴다.
 * A6 — Edit/Write diff 라인(encodeEditDiffLine)도 같은 이유로 renderEditDiffText로 풀어 쓴다. */
function formatBody(m: ChatMessage): string {
  const { clean } = extractSpeech(m.content) // <<say:...>> 음성 태그 제거(화면과 동일)
  const todos = decodeTodoLine(clean)
  if (todos) {
    const { done, total } = todoProgress(todos)
    const lines = [
      `진행 체크리스트 · ${done}/${total}`,
      ...todos.map((t) => `${TODO_STATUS_ICON[t.status]} ${t.content}`),
    ]
    return lines.map((l) => `> ${l}`).join('\n')
  }
  const editDiff = decodeEditDiffLine(clean)
  if (editDiff) {
    return renderEditDiffText(editDiff)
      .split('\n')
      .map((l) => `> ${escapeMarkdown(l)}`)
      .join('\n')
  }
  const { display } = decodeToolLine(clean)
  const escaped = escapeMarkdown(display)
  if (m.role === 'tool') return escaped.split('\n').map((l) => `> ${l}`).join('\n')
  return escaped
}

/** ChatMessage 목록 → markdown 문서. 챕터(m.chapter)가 있으면 ## 헤딩으로 구간을 나눈다. */
export function messagesToMarkdown(messages: ChatMessage[], title?: string): string {
  const lines: string[] = []
  if (title) lines.push(`# ${escapeMarkdown(title)}`, '')
  for (const m of messages) {
    if (m.chapter) lines.push(`## ${escapeMarkdown(m.chapter)}`, '')
    lines.push(`**${SENDER_PREFIX[m.role]}:** ${formatBody(m)}`, '')
  }
  return lines.join('\n').trimEnd() + '\n'
}
