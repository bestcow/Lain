// Navi 유한세션 핸드오프 — '무한세션'(침묵 월드모델 압축, Lain 전용 compact.ts)이 아니다.
// 일하던 Navi 세션의 컨텍스트가 한계에 닿으면, Navi 자신이 곧 버릴 세션에서 핸드오프 md를 *직접* 쓰고,
// 새 세션이 그 md를 읽어 이어간다. 명시적 인수인계(요약 압축과 구분). 순수 헬퍼는 단위테스트한다.
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { CLAUDE_BIN } from './paths'
import { getSettings } from './store'
import { tierQueryOptions } from './agentopts'
import type { ChatMessage, TaskEvent } from '../shared/types'

// 핸드오프 직렬화에 필요한 최소 형태 — navichat의 ChatMessage[]도, worker의 변환 결과도 함께 받게(안전 확장).
type DialogueMsg = Pick<ChatMessage, 'role' | 'content'>

const SECTIONS = `## 지금 하던 일\n## 진행 상황(완료·진행중)\n## 다음 단계\n## 핵심 맥락·결정·함정\n## 막힌 점`

const INSTRUCTION = `너는 이 프로젝트에서 작업하던 Navi다. 지금 세션의 컨텍스트가 한계에 가까워, 새 세션이 네 일을 이어받아야 한다.
다음 세션의 네가 *맥락 없이도* 곧장 이어서 작업하도록, 지금까지의 상태를 핸드오프 한 장(한국어 마크다운)으로 남겨라.
**아래 5개 섹션만** 쓰고 다른 서두·설명은 출력하지 마라. 이 프로젝트에 기록 컨벤션(CLAUDE.md 등)이 있으면 그 형식·용어에 맞춰 보강하라.

${SECTIONS}

규칙:
- 구체적으로: 파일 경로·함수명·명령·결정 이유·함정을 실명으로. "잘 진행 중" 같은 공허한 요약 금지.
- 끝난·무의미한 건 버리고, 다음 세션이 실제로 필요한 것만 남겨라.
- 해당 내용이 없는 섹션은 제목만 두고 비워라.`

/** user/assistant 원문만 직렬화(도구 라인 제외), 각 800자 상한. compact.ts serialize와 동형. */
export function serializeNaviDialogue(msgs: DialogueMsg[]): string {
  return msgs
    .filter((mm) => mm.role === 'user' || mm.role === 'assistant')
    .map((mm) => `[${mm.role === 'user' ? '사용자/Lain' : 'Navi'}] ${mm.content.slice(0, 800)}`)
    .join('\n')
}

/** worker task_events → 핸드오프용 대화. worker 발화=assistant, lain/user=user.
 *  실질 텍스트(text) + ask_manager Q&A(speaker 달린 status)만 — 시스템 로그·도구 라인은 뺀다. */
export function taskEventsToDialogue(events: TaskEvent[]): DialogueMsg[] {
  return events
    .filter((e) => e.text.trim() && (e.kind === 'text' || (e.kind === 'status' && !!e.speaker)))
    .map((e) => ({ role: e.speaker === 'worker' ? 'assistant' : 'user', content: e.text }))
}

/** 새 세션 프롬프트에 끼울 핸드오프 블록. md 없으면 빈 문자열(주입 안 함). */
export function handoffBlock(md: string | null | undefined): string {
  const t = md?.trim()
  if (!t) return ''
  return `<handoff>\n이전 세션에서 넘어온 핸드오프 — 여기서 이어서 작업해라(맥락 복원):\n${t}\n</handoff>\n\n`
}

/** Navi가 직접 핸드오프 md 작성(naviModel·프로젝트 cwd). 실패·빈응답이면 null(호출부가 직전 핸드오프 유지). */
export async function summarizeNaviHandoff(
  projectPath: string,
  recentMsgs: DialogueMsg[],
  prevHandoff: string | null,
  mirrorFile: string,
  abortController?: AbortController, // 있으면 인터럽트(abort)로 핸드오프 작성도 즉시 취소 → catch가 null 반환
): Promise<string | null> {
  const convo = serializeNaviDialogue(recentMsgs)
  if (!convo.trim() && !prevHandoff) return null

  const prompt = `${INSTRUCTION}\n\n=== 직전 핸드오프(있으면 갱신) ===\n${
    prevHandoff?.trim() || '(없음)'
  }\n\n=== 최근 대화 ===\n${convo || '(없음)'}\n\n위 규칙대로 핸드오프(5섹션 md)만 출력:`

  // 누적 텍스트를 try 밖에 둔다 — maxTurns 도달 시 SDK가 error_max_turns를 throw하는데(실측: 모델이 한 턴을
  // 더 쓰면 발생, 비결정적), 그래도 이미 받은 핸드오프 텍스트를 버리지 않고 살린다. abort(인터럽트)면 아래서 폐기.
  let last = ''
  try {
    const stream = query({
      prompt,
      options: {
        cwd: projectPath,
        allowedTools: [],
        maxTurns: 6, // 1은 모델의 추가 턴(도구 시도→거부 등)에 error_max_turns로 throw돼 산출물을 버린다(실측). 여유 확보.
        ...tierQueryOptions(getSettings().naviModel, getSettings()), // 당사자 Navi 티어로 작성(judge 아님, local 라우팅 포함)
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리
        abortController, // 인터럽트 시 작성도 즉시 중단(undefined면 무영향)
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) last += t
      }
    }
  } catch {
    /* error_max_turns 등 — 아래에서 누적 텍스트로 처리(있으면 살리고, 없으면 null) */
  }
  // 인터럽트(abort)면 부분 텍스트라도 폐기 → 호출부가 세션을 보존(스왑 안 함). 아니면 누적 텍스트를 쓴다.
  const out = abortController?.signal.aborted ? '' : last.trim()
  if (!out) return null // 작성 실패·빈응답 → 호출부가 직전 핸드오프 유지(맥락 손실 최소화)
  // 사람이 볼 미러 한 장 — best-effort. 실패해도 핸드오프 본류(DB)는 진행.
  try {
    fs.mkdirSync(path.dirname(mirrorFile), { recursive: true })
    fs.writeFileSync(mirrorFile, out, 'utf8')
  } catch {
    /* 미러 실패 무시 */
  }
  return out
}
