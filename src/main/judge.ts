// src/main/judge.ts — judge 공용 러너(#8). query→assistant 텍스트 누적→60초 abort→maxTurns 2 골격이
// orchestrator(elicit·ask_manager·reflect·reflectFailure)·audit(runAudit)·scheduler(autoPriority·
// consolidateLessons) 7곳에 복사돼 있던 것을 runAuditJudge 기준으로 승격한 단일 출처.
// 실패·타임아웃은 null(무해 폴백 관례 — 호출부는 '판정 불능 = 진행을 막지 않음'으로 처리).
// 재시도·큐잉은 넣지 않는다(과설계 금지). 세션 본체(manager·worker·navichat)는 여길 안 탄다.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CWD, CLAUDE_BIN } from './paths'
import { judgeQueryOptions } from './agentopts'
import { recordUsage } from './usage'
import { sumUsageTokens } from './worker'

export interface RunJudgeOpts {
  timeoutMs?: number // SDK 무응답(네트워크 정체 등) abort 시한 — 초과 시 null
  maxTurns?: number
  stderr?: (data: string) => void // 진단 로그 싱크(scheduler류 옵션)
}

/** judge 1콜 — 도구 없음·짧은 판정. 무응답/타임아웃/throw면 null(호출부 무해 폴백).
 *  텍스트 없이 정상 종료하면 빈 문자열(기존 runAuditJudge 관례 — 파싱 단계에서 자연히 불능 처리). */
export async function runJudge(prompt: string, opts: RunJudgeOpts = {}): Promise<string | null> {
  const { timeoutMs = 60_000, maxTurns = 2, stderr } = opts
  const abort = new AbortController()
  const kill = setTimeout(() => abort.abort(), timeoutMs)
  let last = ''
  try {
    const stream = query({
      prompt,
      options: {
        cwd: AGENT_CWD,
        allowedTools: [],
        maxTurns,
        ...judgeQueryOptions(), // §9b 판정류(local 라우팅 + D7 사용량 가드 강등)
        abortController: abort,
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
        ...(stderr ? { stderr } : {}),
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) last = t
      } else if (msg.type === 'result') {
        // D7(#7 judge 몫) — judge 소비도 전역 롤링 카운터에 적재(worker의 result 적재와 동형).
        // 전역 사용량 가드·티어 강등 판정이 judge 콜의 토큰까지 보게 된다. off여도 적재는 무해(합만 함).
        recordUsage(sumUsageTokens(msg))
      }
    }
  } catch {
    return null
  } finally {
    clearTimeout(kill)
  }
  return last
}

/** 응답 텍스트에서 ```json 블록 한 개를 관대하게 파싱해 guard 통과 시 T로.
 *  블록 없음·JSON 파싱 실패·guard 불통과·null 텍스트(runJudge 실패)는 전부 null. */
export function parseJsonBlock<T>(text: string | null, guard: (x: unknown) => x is T): T | null {
  const m = (text ?? '').match(/```json\s*([\s\S]*?)```/)
  if (!m) return null
  try {
    const j: unknown = JSON.parse(m[1])
    return guard(j) ? j : null
  } catch {
    return null
  }
}

/** 관대 guard — 기존 호출부들의 'JSON.parse 결과에 바로 속성 접근' 관례 유지용(형상 강제 없음, 배열 포함). */
export function isJsonObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}
