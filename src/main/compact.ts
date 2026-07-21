// 컨텍스트 자동 압축('무한세션') 본체 — 매니저(Lain) 대화가 임계 점유에 닿으면, 직전 월드모델 + 최근
// 원문을 judge 티어 1-shot query()로 구조화 4필드 월드모델(md)로 병합한다(title.ts 패턴 미러).
// 그 뒤 manager가 resume(SDK 세션)을 끊고 새 세션을 열되 이 월드모델을 재주입 → 트랜스크립트는 리셋되지만
// 맥락(방침·진행 스레드·열린 결정)은 유지된다. 순수 판정은 compactgate.ts. (L0 컨벤션: 판단만 LLM, 부작용 없음)
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_CWD, CLAUDE_BIN, DATA_DIR } from './paths'
import { judgeQueryOptions } from './agentopts'
import type { ChatMessage } from '../shared/types'

const FIELDS = `## 방침\n## 진행 스레드\n## 열린 결정\n## 최근 완료`

const INSTRUCTION = `너는 오케스트레이터 'Lain'의 영속 월드모델을 갱신한다. 아래 "직전 월드모델"과 "최근 대화"를 병합해,
**아래 4개 섹션만** 가진 한국어 마크다운 한 장으로 출력하라. 섹션 제목·순서를 정확히 지키고, 다른 텍스트(서두·설명)는 출력하지 마라.

${FIELDS}

규칙:
- 방침: 사용자가 정한 규칙·선호·원칙(재질문 금지용). 한번 정해지면 명시 철회 전까지 유지.
- 진행 스레드: 프로젝트별 열린 작업·맥락 한 줄씩(예: "webapp: 백엔드 슬림화 후 프론트 개편 중").
- 열린 결정: 사용자 입력/결재를 기다리는 것.
- 최근 완료: 방금 끝났거나 합의된 것(참고용, 오래되면 폐기).
- 끝난·무의미·중복 항목은 **버려라**(요약을 부풀리지 마라). 새 사실은 기존 항목을 갱신·대체한다.
- 해당 내용이 없는 섹션은 제목만 두고 비워라.`

/** 직전 월드모델 + 최근 메시지를 4필드 월드모델로 병합. 실패·빈응답이면 null(호출부가 직전 것 유지). */
export async function summarizeWorldState(
  prevWorldState: string | null,
  recentMsgs: ChatMessage[],
): Promise<string | null> {
  // user/assistant 원문만 직렬화(도구 라인 제외), 각 8백자 상한으로 프롬프트 비대화 방지.
  const convo = recentMsgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `[${m.role === 'user' ? '사용자' : 'Lain'}] ${m.content.slice(0, 800)}`)
    .join('\n')
  if (!convo.trim() && !prevWorldState) return null

  const prompt = `${INSTRUCTION}\n\n=== 직전 월드모델 ===\n${
    prevWorldState?.trim() || '(없음 — 처음 생성)'
  }\n\n=== 최근 대화 ===\n${convo || '(없음)'}\n\n위 규칙대로 갱신된 월드모델(4섹션 md)만 출력:`

  // 누적 텍스트를 try 밖에 둔다 — maxTurns 도달 시 SDK가 error_max_turns를 throw해도(handoff.ts와 동형 실측),
  // 이미 받은 월드모델 텍스트를 버리지 않고 살린다(무한세션 맥락의 유일 캐리어라 silent-loss가 치명적).
  let last = ''
  try {
    const stream = query({
      prompt,
      options: {
        cwd: AGENT_CWD,
        allowedTools: [],
        maxTurns: 6, // 1은 모델의 추가 턴(도구 시도→거부 등)에 error_max_turns로 throw돼 산출물을 버린다(실측). 여유 확보.
        ...judgeQueryOptions(), // §9b — 판정/요약류(local 라우팅 + D7 사용량 가드 강등)
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) last += t // 길어질 수 있어 누적(title.ts는 덮어쓰기)
      }
    }
  } catch {
    /* error_max_turns 등 — 아래에서 누적 텍스트로 처리(있으면 살리고, 없으면 null) */
  }
  const out = last.trim()
  if (!out) return null // 압축 실패·빈응답 → 호출부가 직전 월드모델 유지(맥락 손실 최소화)
  // world.md 미러(best-effort) — 사람이 들여다볼 한 장. 실패해도 압축 본류는 진행.
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'world.md'), out, 'utf8')
  } catch {
    /* 미러 실패 무시 */
  }
  return out
}
