// 대화 제목 자동 요약 (L1) — 첫 user+assistant 교환 직후 judge 티어 query()로 20~30자 제목 1회 생성.
// manager.ts / workerchat.ts가 fire-and-forget로 호출. 실패는 무시(기존 절단 제목 유지).
// needsAutoTitle(0/NULL 가드) → setAutoTitle(원자적 title_auto=0 가드)로 한 대화 1회만 실제 반영.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CWD, CLAUDE_BIN } from './paths'
import { getSettings, needsAutoTitle, setAutoTitle } from './store'
import { tierQueryOptions } from './agentopts'

// 제목 갱신 알림 콜백 — ipc.ts가 startup에 바인딩(conversations:updated broadcast). manager·workerchat 공용.
let titleRefresh: ((target: string) => void) | null = null
export function bindTitleRefresh(fn: (target: string) => void): void {
  titleRefresh = fn
}

// 첫 교환 직후 호출 — 가드 통과 시 짧은 query()로 제목 생성·적용 후 target 새로고침 신호.
// firstUserText: 첫 user 원문(앞 500자만 투입, 첨부/다이제스트 제외). target: 'manager' | projectId.
export async function summarizeConversationTitle(
  conversationId: string,
  firstUserText: string,
  target: string,
): Promise<void> {
  if (!needsAutoTitle(conversationId)) return
  const seed = firstUserText.trim().slice(0, 500)
  if (!seed) return
  try {
    let last = ''
    const stream = query({
      prompt: `다음 대화 첫 메시지를 한국어 20~30자 제목 한 줄로 요약. 따옴표·마침표·접두어 없이 제목만 출력.\n\n${seed}`,
      options: {
        cwd: AGENT_CWD,
        allowedTools: [],
        maxTurns: 1,
        ...tierQueryOptions(getSettings().judgeModel, getSettings()), // §9b — 짧은 판정류(local 라우팅 포함)
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) last = t
      }
    }
    if (setAutoTitle(conversationId, last)) titleRefresh?.(target)
  } catch {
    /* 요약 실패 → 기존 절단 제목 유지 */
  }
}
