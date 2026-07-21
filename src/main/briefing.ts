// 레인 독 보고(B) — 현황을 Claude(매니저와 동일 SDK)로 1~2문장 한국어 prose로 요약.
// 결정론 요약(렌더러) 위에 얹는 '사람 같은' 한 줄. 실패하면 null(렌더러는 결정론 요약만).
// Claude로 통일(2026-06-26) — 진입 첫 줄도 Lain 본체와 같은 모델·말투. judge 티어 1회 query(title.ts 동형).
import fs from 'node:fs'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  getSettings,
  listProjects,
  listTasks,
  listApprovals,
  getActiveConversation,
  listConversationDialogue,
  getConversationWorldState,
  loopStats,
} from './store'
import { judgeQueryOptions } from './agentopts'
import { AGENT_CWD, CLAUDE_BIN, DATA_DIR } from './paths'
import { formatLoopStatsLine } from '../shared/loopstats'

// 진단 — 브리핑이 왜 비는지 침묵 실패를 파일에 남긴다(DATA_DIR/briefing-debug.log). 원인 확정 후 제거.
function blog(m: string): void {
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'briefing-debug.log'), `${new Date().toISOString()} ${m}\n`)
  } catch {
    /* 무해 */
  }
}

/** 현재 현황 → Claude prose 보고. 실패 시 null(렌더러는 결정론 요약만 표시).
 *  includePrior=true(시작 브리핑 전용)면 직전 맥락(world-state·최근 문답)을 얹어 재시작 연속성을 준다.
 *  주기 갱신(활동 중)은 false — '최근 대화'가 현재 세션이라 '종료 전' 프레이밍이 틀리므로 현황만. */
export async function generateBriefing(opts: { includePrior?: boolean } = {}): Promise<string | null> {
  // muted(숨김) 제외 — 브리핑은 레인의 선제 발화라, 유저가 먼저 언급하기 전엔 숨김 내비를 꺼내지 않는다.
  const projects = listProjects().filter((p) => !p.muted)
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
    formatLoopStatsLine(loopStats(7)), // L6 — 최근 7일 루프 성적표(집계할 게 없으면 빈 문자열 → filter(Boolean)로 제외)
  ].filter(Boolean)

  // 직전 맥락(재시작 연속성) — 레인은 단일 연속 대화(무한세션)라 '지난 세션'이 아니라 '종료 전 이어지던 대화'다.
  // 활성 레인 대화의 world-state(누적 요약) + 최근 문답을 얹어, 브리핑이 '종료 전 무엇을 진행 중이었고 무엇을
  // 지시하셨는지'까지 이어 말하게 한다. 없으면(첫 실행 등) 생략. 도구 로그 배제(user/assistant 원문만) — 사용자
  // 본인에게 돌려주는 요약이라 누출 무관. 주기 갱신(활동 중)은 생략 — 그땐 '최근 대화'가 현재 진행분이라 '종료 전'이 틀림.
  let priorBlock = ''
  if (opts.includePrior) {
    try {
      const conv = getActiveConversation('manager')
      if (conv) {
        const world = getConversationWorldState(conv)
        const recent = listConversationDialogue(conv, 8)
          .map((m) => `${m.role === 'user' ? '사용자' : '레인'}: ${m.content.replace(/\s+/g, ' ').slice(0, 280)}`)
          .join('\n')
        const parts = [world ? `누적 맥락:\n${world}` : '', recent ? `최근 대화:\n${recent}` : ''].filter(Boolean)
        if (parts.length) priorBlock = `\n<직전-맥락>\n${parts.join('\n\n')}\n</직전-맥락>\n`
      }
    } catch {
      /* 대화 없음/DB 문제 — 지난 맥락 없이 상태만으로 브리핑 */
    }
  }

  const uTitle = getSettings().userTitle || '유저' // 레인이 사용자를 부르는 호칭(설정)
  const prompt = `너는 '레인(Lain)'이다. 사용자의 여러 프로젝트를 총괄하는 오케스트레이터. 아래 <직전-맥락>(있으면)과 <현황>을 보고, 사용자에게 존댓말로 2~3문장, 짧고 정확하게 전한다. 제목·접두어·인용부호 없이 본문만 출력한다.
- 문장 끝은 '~습니다/~입니다'. 반말('~어/~야')과 문어체 평서('~다/~한다')는 금지. (예: "처리하실 사항은 없습니다." "작업 중인 프로젝트는 없습니다.")
- <직전-맥락>이 있으면: 종료 전 무엇을 진행하시던 중이었는지·무엇을 지시하셨는지 먼저 한 줄로 상기시킨 뒤(예: "종료 전 …를 진행하시던 중이었고, …를 지시하셨습니다." 또는 "마지막으로 …하셨습니다."), 이어서 현재 처리하실 사항을 전한다. 없으면 현황만 전한다. ⚠️ 너는 단일 연속 대화라 '지난 세션'·'이전 세션' 같은 '세션' 표현은 절대 쓰지 마라 — 시점은 '종료 전'·'마지막으로'로만 짚는다. 직전 대화를 통째로 옮기지 말고 핵심만 요약한다.
- 가장 신경 쓸 것(질문·결재·에러·승인 대기) 먼저. 처리할 게 있으면 어느 프로젝트인지 콕 집어서.
- 정중하고 절제된 톤. 사용자를 직접 칭할 땐 '${uTitle}'(으)로 부르고 높임(–시–). 농담·위트·과장·감탄·이모지·인사·미사여구·'우리'류 동질감 표현 금지.
${idle ? '- 현황상 지금은 처리할 게 없습니다. 직전 맥락 상기 외에는 담백하게.' : '- 지금은 처리할 게 있습니다. 핵심만.'}
${priorBlock}
<현황>
${status.join('\n')}
</현황>`

  // Claude judge 티어 1회 query(title.ts 동형) — 도구 없이 텍스트만. 매니저 무한세션과 분리된 일회성 세션.
  // 누적은 try 밖 변수로(maxTurns 초과 throw에도 받은 텍스트 보존), maxTurns 여유로 error_max_turns 회피.
  let text = ''
  // 판정 SDK 무응답(네트워크 정체 등)에 60초 abort — 없으면 브리핑 생성이 영원히 안 끝난다(부팅 시
  // fire-and-forget으로 호출돼 앱 자체는 안 막히지만, 좀비 Promise가 남고 브리핑도 영영 안 나온다).
  const ac = new AbortController()
  const killTimer = setTimeout(() => ac.abort(), 60_000)
  try {
    const stream = query({
      prompt,
      options: {
        cwd: AGENT_CWD,
        allowedTools: [],
        maxTurns: 2,
        ...judgeQueryOptions(), // §9b 판정/요약류(local 라우팅 + D7 사용량 가드 강등)
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
        abortController: ac,
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
  } finally {
    clearTimeout(killTimer)
  }
  const out = text.trim()
  if (!out) {
    blog('empty briefing text')
    return null
  }
  return out
}
