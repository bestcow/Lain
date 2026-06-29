// 신호기반 background review (L1, §자기개선 M) — verify 루프 *밖*에서의 학습.
//
// 1차 슬라이스: 트리거 1종만 — 매니저 채팅 한 턴이 끝난 직후(sendToManager 루프 밖), 직전 user
// 메시지가 '교정/선호 표명'일 때만 격리 judge를 1회 불러 0~1건 교훈을 뽑는다. 그 외(질문·잡담·
// 작업 지시)는 결정론 정규식 게이트(isCorrectionSignal)에서 걸러져 judge 자체를 부르지 않는다.
//
// 회귀 0 불변식(전부 selfimprove 내부에서 자기게이트):
//   - settings.signalReview(기본 false) off면 즉시 return — 호출돼도 아무 일도 안 일어난다(휴면).
//   - 격리 judge는 reflect/title과 동일: allowedTools:[], maxTurns:2, judgeModel, 60s abort,
//     executable:'node'+CLAUDE_BIN, try/catch로 모든 실패 무해(채팅·메인에 영향 0).
//   - 과정-트레이스(도구반복·인터럽트)에서의 교훈은 1차에서 제외(self-imposed constraint 누적 위험).
//   - judge 프롬프트에 anti-capture rubric을 명시 — 환경의존 실패·도구 부정주장·일회성 서사를 버리게.
//
// 입력은 addMessage 히스토리(listConversationMessages). 출력 교훈은 insertLesson(origin:'agent').
import { query } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CWD, CLAUDE_BIN } from './paths'
import { ensureActiveConversation, getSettings, insertLesson, listConversationMessages } from './store'
import { modelId } from '../shared/models'
import { redactSecrets, scanLessonInjection } from './safety'
import type { ChatMessage } from '../shared/types'

// manager-chat 교훈은 특정 프로젝트에 매이지 않는다(scope는 대개 global). lessons.project_id는
// NOT NULL이라 sentinel이 필요하고, lessonsForProject는 scope='global'을 project_id와 무관하게
// 고르므로 이 값은 선택에 영향 없다(글래스박스 추적용 식별자일 뿐).
const LAIN_SCOPE_PROJECT = '__lain__'
const JUDGE_TIMEOUT_MS = 60_000

// ── 결정론 게이트(순수·테스트 용이) ─────────────────────────────────────────────
// 직전 user 메시지가 '교정/선호 표명'으로 보이면 true → judge 호출 후보. 아니면 false → judge 미호출.
// 보수적: 명백한 교정/선호/기억 요청 신호만 잡는다(질문·단순 지시·잡담은 흘려보낸다).
const CORRECTION_RE: RegExp[] = [
  // 기억/선호 명시 — "기억해", "앞으로 ~해/하지마", "항상/늘/매번 ~", "~하지 마(라)"
  /기억해|기억해\s*둬|기억해\s*두/,
  /앞으로(?:는)?\s*[^]*?(?:해|하지|쓰지|마|줘|말아|말라)/,
  /항상|늘|매번|언제나/,
  /(?:하지|쓰지|넣지|건드리지|만들지)\s*마/,
  // 선호 표명 — "~하는 게 좋아/낫다", "~선호", "~말고 ~로"
  /(?:이|가|은|는)?\s*(?:더\s*)?(?:좋아|낫|나아|선호|편해)/,
  /말고\s*[^]*?(?:로|으로|를|을)/,
  // 교정 — "아니야/아니라/아니 ", "틀렸", "그게 아니라", "다시 해", "잘못", "~하지 말랬"
  // (한글은 \b가 안 먹으므로 어미/공백/종단을 명시 매칭)
  /아니(?:야|라|었어?|(?=\s|$))|틀렸|잘못(?:됐|했|이)|그게\s*아니|다시\s*해|말랬|말했잖/,
  // 영어 동치 — remember / always / never / don't / instead / not …, … but
  /\bremember\b|\balways\b|\bnever\b|\bdon'?t\b|\binstead\b|\bprefer\b|\bnot\b\s+[^]*?\bbut\b/i,
]

/**
 * 직전 user 메시지가 '교정/선호 표명' 신호를 담는지 결정론으로 판정. 순수·LLM 없음.
 * true면 reviewManagerTurn이 격리 judge를 부른다. 보수적 — 확실한 신호만 통과시켜 judge 호출을 아낀다.
 */
export function isCorrectionSignal(text: string): boolean {
  if (!text) return false
  const t = text.trim()
  if (t.length < 2) return false
  return CORRECTION_RE.some((re) => re.test(t))
}

// 히스토리에서 '마지막 user 발화'와 그 직후 '마지막 assistant 발화'를 뽑는다(judge 컨텍스트).
function lastExchange(msgs: ChatMessage[]): { user: ChatMessage | null; assistant: ChatMessage | null } {
  let user: ChatMessage | null = null
  let assistant: ChatMessage | null = null
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && !assistant && !user) assistant = m
    if (m.role === 'user') {
      user = m
      break
    }
  }
  return { user, assistant }
}

/**
 * §signal review — 매니저 채팅 한 턴 종료 직후 호출(sendToManager 루프 밖). signalReview opt-in.
 * 직전 user 메시지가 교정/선호 표명이면 격리 judge로 0~1건 교훈을 뽑아 insertLesson(origin:'agent').
 * 반환 없음·실패 무해(off거나 게이트 미통과거나 judge 실패면 조용히 종료 — 회귀 0).
 *
 * @param conversationId (옵션) 방금 턴이 끝난 manager 대화 id. 미지정 시 활성 manager 대화로 해석
 *                       (sendToManager는 활성 대화를 바꾸지 않으므로 턴 종료 직후엔 그 대화가 곧 직전 대화다).
 * @param emitChat       (옵션) 교훈을 학습했음을 채팅에 알리는 콜백 — 호출부가 주입(selfimprove는 채널 안 만듦).
 */
export async function reviewManagerTurn(
  conversationId?: string,
  emitChat?: (text: string) => void,
): Promise<void> {
  try {
    if (!getSettings().signalReview) return // off면 휴면 — 어떤 부수효과도 없음
    const convId = conversationId || ensureActiveConversation('manager')
    if (!convId) return

    const msgs = listConversationMessages(convId, 12)
    const { user, assistant } = lastExchange(msgs)
    if (!user) return
    // 결정론 게이트 — 교정/선호 신호가 아니면 judge 자체를 부르지 않는다(비용·소음 차단).
    if (!isCorrectionSignal(user.content)) return

    // judge 입력은 시크릿 마스킹 1패스(§9-6) — 채팅 본문에 토큰/키가 섞였어도 모델로 안 샌다.
    const userText = redactSecrets(user.content).slice(0, 1200)
    const assistantText = assistant ? redactSecrets(assistant.content).slice(0, 1200) : ''

    const prompt = `너는 lain의 '시그널 리뷰' 담당이다. 방금 사용자가 관리자(Lain)에게 보낸 **교정/선호 표명**에서, **앞으로의 모든 작업에 재사용할 수 있는 사용자 선호·규칙**을 0~1건만 뽑아라.

여기서 다루는 건 검증 루프(테스트) 밖의 학습이다. 사용자의 명시적 교정("아니 그렇게 말고", "앞으로는 ~해", "항상 ~", "기억해")이나 선호 표명에서, 영속적 행동 규칙이 될 만한 것만 남긴다.

<user-correction>
${userText}
</user-correction>
<lain-reply>
${assistantText}
</lain-reply>

규칙(anti-capture — 어기면 빈 배열을 내라):
- 환경의존·일회성 실패에서 교훈을 만들지 마라(이 머신·이 순간에만 맞는 사실).
- 도구가 무엇을 했다/못 했다는 부정확한 주장으로 교훈을 만들지 마라(과정-트레이스 금지).
- 이 대화 한정 서사·맥락("아까 그 파일")을 일반 규칙으로 격상하지 마라.
- 진짜 사용자 선호/규칙이 아니면(단순 질문·지시·잡담) 빈 배열.
- 확신이 없으면 빈 배열. 1건을 초과해 뽑지 마라.

JSON 한 블록만 출력:
\`\`\`json
{"lessons": [{"scope": "global|project", "trigger": "<언제 적용되나, 키워드>", "lesson": "<재사용 가능한 사용자 선호/규칙 한두 문장>"}]}
\`\`\`
- 대부분 사용자 선호는 프로젝트 무관이므로 scope는 보통 global.`

    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), JUDGE_TIMEOUT_MS)
    let last = ''
    try {
      const stream = query({
        prompt,
        options: {
          cwd: AGENT_CWD,
          allowedTools: [],
          maxTurns: 2,
          model: modelId(getSettings().judgeModel), // 짧은 판정류 — judge 티어
          executable: 'node',
          pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로
          abortController: abort,
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
    } finally {
      clearTimeout(timer)
    }

    const m = last.match(/```json\s*([\s\S]*?)```/)
    if (!m) return
    let obj: any
    try {
      obj = JSON.parse(m[1])
    } catch {
      return
    }
    const lessons = Array.isArray(obj.lessons) ? obj.lessons : []
    let saved = 0
    for (const l of lessons) {
      if (saved >= 1) break // 1차 슬라이스: 턴당 최대 1건
      const body = String(l?.lesson ?? '').trim()
      if (!body) continue
      // 주입 인젝션 방어 — judge 출력이 프롬프트 탈취 형상을 띠면 저장하지 않는다(소비처 게이트와 동형).
      if (scanLessonInjection(body).blocked) continue
      insertLesson({
        projectId: LAIN_SCOPE_PROJECT,
        taskId: 'signal-review',
        scope: l?.scope === 'project' ? 'project' : 'global',
        trigger: String(l?.trigger ?? ''),
        lesson: body,
        origin: 'agent',
      })
      saved++
    }
    if (saved > 0) emitChat?.(`[시그널] 사용자 선호 ${saved}건 학습했다.`)
  } catch {
    /* 모든 실패 무해 — 시그널 리뷰는 best-effort, 채팅·메인에 영향 0 */
  }
}
