// 관찰 세션 → 격리 작업 이어받기(M2). 외부 세션을 네이티브 resume하지 않고, 결정론 발췌를
// judge 공용 러너로 짧게 정리해 새 worktree 작업의 <handoff> 블록으로 전달한다.
import type { TaskEngine } from '../shared/types'
import { runJudge } from './judge'

export function buildObservedAdoptContent(
  handoff: string,
  sourceEngine: TaskEngine,
  sessionId: string,
  goal?: string,
): string {
  const source = sourceEngine === 'codex' ? 'Codex' : 'Claude Code'
  return [
    '# TASK',
    '## 목표',
    goal?.trim() || `아래 ${source} 관찰 세션에서 진행하던 작업을 이어서 완료하라.`,
    '',
    `## 컨텍스트 — ${source} 관찰 세션 ${sessionId} 이어받기`,
    '<handoff>',
    handoff,
    '</handoff>',
    '',
    '## 완료 조건 (DoD)',
    '- 관찰 세션에서 진행 중이던 변경을 격리 worktree에서 완결한다',
    '- 프로젝트 verify 명령이 통과한다',
  ].join('\n')
}

export async function summarizeObservedHandoff(
  digest: string,
  sourceEngine: TaskEngine,
  judge: (prompt: string) => Promise<string | null> = runJudge,
): Promise<string> {
  const source = sourceEngine === 'codex' ? 'Codex' : 'Claude Code'
  const summary = await judge(
    `다음은 ${source} 개발 세션의 최근 대화 발췌다. 새 작업 에이전트가 즉시 이어갈 수 있는 핸드오프를 한국어로 작성하라. 완료한 것, 현재 변경 상태, 남은 일, 검증 결과를 사실만 8줄 이내로 적고 설명·인사 없이 핸드오프 본문만 출력하라.\n\n${digest}`,
  )
  const text = summary?.trim()
  // judge 실패·무응답·빈 출력은 원문 꼬리 폴백. 이어받기가 부가기능 실패로 막히지 않게 한다.
  return text ? text.slice(0, 6000) : digest.slice(-6000)
}
