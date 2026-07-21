// src/main/postmortem.ts — 실패 회고 한 줄 (L2). 프롬프트/파싱은 순수, LLM 호출은 orchestrator.reflectFailure.
export function buildPostmortemPrompt(taskTitle: string, kind: 'verify' | 'error' | 'blocked', detail: string): string {
  return [
    `작업 "${taskTitle}" 이(가) ${kind} 로 실패했다. 아래는 실패 근거 로그다.`,
    '다음 시도가 같은 이유로 실패하지 않도록, 재사용 가능한 원인·대처를 **한 줄(한 문장)** 로 요약하라.',
    '이 작업에서만 유효한 일회성 사실(특정 파일의 오타 등)이면 NONE 만 출력하라.',
    '출력은 그 한 줄 또는 NONE 뿐이다. 접두사·설명 금지.',
    '', '--- 실패 근거 ---', detail.slice(0, 4000),
  ].join('\n')
}

export function parsePostmortem(text: string): string | null {
  const s = (text || '').trim().split('\n')[0]?.trim() ?? ''
  if (!s || s.toUpperCase() === 'NONE') return null
  return s.slice(0, 200)
}
