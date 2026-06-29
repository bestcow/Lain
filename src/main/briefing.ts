// 레인 독 보고(B) — 현황을 Claude(매니저와 동일 SDK)로 1~2문장 한국어 prose로 요약.
// 결정론 요약(렌더러) 위에 얹는 '사람 같은' 한 줄. 실패하면 null(렌더러는 결정론 요약만).
// Claude로 통일(2026-06-26) — 진입 첫 줄도 Lain 본체와 같은 모델·말투. judge 티어 1회 query(title.ts 동형).
import fs from 'node:fs'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { getSettings, listProjects, listTasks, listApprovals } from './store'
import { modelId } from '../shared/models'
import { AGENT_CWD, CLAUDE_BIN, DATA_DIR } from './paths'

// 진단 — 브리핑이 왜 비는지 침묵 실패를 파일에 남긴다(DATA_DIR/briefing-debug.log). 원인 확정 후 제거.
function blog(m: string): void {
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'briefing-debug.log'), `${new Date().toISOString()} ${m}\n`)
  } catch {
    /* 무해 */
  }
}

/** 현재 현황 → Claude prose 보고. 실패 시 null(렌더러는 결정론 요약만 표시). */
export async function generateBriefing(): Promise<string | null> {
  const projects = listProjects().filter((p) => p.enabled)
  const tasks = listTasks()
  const approvals = listApprovals()
  const working = tasks.filter((t) => t.state === 'working' || t.state === 'clarifying')
  const blocked = tasks.filter((t) => t.state === 'blocked')
  const review = tasks.filter((t) => t.state === 'review')
  const error = tasks.filter((t) => t.state === 'error')
  const dirty = projects.filter((p) => (p.status?.dirtyFiles ?? 0) > 0)
  const fail = projects.filter((p) => p.status?.testState === 'fail')
  const attn = blocked.length + review.length + error.length + approvals.length + fail.length
  const idle = attn === 0 && working.length === 0

  const nameList = (arr: { name: string }[], n = 4) =>
    arr.map((x) => x.name).slice(0, n).join(', ') + (arr.length > n ? ` 외 ${arr.length - n}` : '')

  const status = [
    `감시 프로젝트 ${projects.length}곳`,
    working.length ? `작업 중: ${nameList(working.map((t) => ({ name: t.projectId })))}` : '작업 중인 것 없음',
    blocked.length ? `질문 대기: ${nameList(blocked.map((t) => ({ name: t.projectId })))}` : '',
    review.length ? `결재 대기: ${nameList(review.map((t) => ({ name: t.projectId })))}` : '',
    error.length ? `에러: ${nameList(error.map((t) => ({ name: t.projectId })))}` : '',
    approvals.length ? `승인 대기 ${approvals.length}건` : '',
    fail.length ? `검증 실패: ${nameList(fail)}` : '',
    dirty.length ? `미커밋 변경: ${nameList(dirty)}` : '미커밋 없음',
  ].filter(Boolean)

  const prompt = `너는 '레인(Lain)'이다. 사용자의 여러 프로젝트를 총괄하는 오케스트레이터. 아래 현황을 사용자에게 존댓말로 1~2문장, 짧고 정확하게 전한다. 제목·접두어·인용부호 없이 본문만 출력한다.
- 문장 끝은 '~습니다/~입니다'. 반말('~어/~야')과 문어체 평서('~다/~한다')는 금지. (예: "처리하실 사항은 없습니다." "작업 중인 프로젝트는 없습니다.")
- 가장 신경 쓸 것(질문·결재·에러·승인 대기) 먼저. 처리할 게 있으면 어느 프로젝트인지 콕 집어서.
- 정중하고 절제된 톤. 사용자는 '사용자'로 칭하고 높임(–시–). 농담·위트·과장·감탄·이모지·인사·미사여구·'우리'류 동질감 표현 금지.
${idle ? '- 지금은 처리할 게 없습니다. 그 사실만 담백하게.' : '- 지금은 처리할 게 있습니다. 핵심만.'}

<현황>
${status.join('\n')}
</현황>`

  // Claude judge 티어 1회 query(title.ts 동형) — 도구 없이 텍스트만. 매니저 무한세션과 분리된 일회성 세션.
  // 누적은 try 밖 변수로(maxTurns 초과 throw에도 받은 텍스트 보존), maxTurns 여유로 error_max_turns 회피.
  let text = ''
  try {
    const stream = query({
      prompt,
      options: {
        cwd: AGENT_CWD,
        allowedTools: [],
        maxTurns: 2,
        model: modelId(getSettings().judgeModel),
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
        if (t) text = t
      }
    }
  } catch (e) {
    blog(`query throw: ${(e as Error)?.message ?? e}`)
  }
  const out = text.trim()
  if (!out) {
    blog('empty briefing text')
    return null
  }
  return out
}
