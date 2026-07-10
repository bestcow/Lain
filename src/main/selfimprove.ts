// 채팅 턴 자기개선 리뷰 (학습루프 T3, hermes background_review 대응 — 메커니즘만 lain 고유 재구현).
// 현 reflect는 작업(A) 완료 시만 배운다 — 채팅에서의 교정("그게 아니라…")·반복 선호를 여기서 배운다.
// 매니저 채팅 한 턴이 끝난 직후(sendToManager 루프 밖) fire-and-forget으로 격리 judge를 1회 불러,
// 최근 대화 다이제스트에서 0~2건 교훈(+ 스킬 후보 힌트)을 뽑는다.
//
// 회귀 0 불변식(전부 selfimprove 내부에서 자기게이트):
//   - settings.turnReviewEnabled(기본 on) off면 즉시 return — 호출돼도 아무 일도 안 일어난다(휴면).
//   - 결정론 스킵 게이트(shouldSkipTurnReview): 원문 6턴 미만(단 교정 신호는 통과)/직전 리뷰 후 무변화/
//     도구만 쓴 중간 턴(마지막이 assistant 아님). 작업(working) 중에도 스킵(consolidate 패턴).
//   - 격리 judge는 reflect/title과 동일: allowedTools:[], judgeModel, 60s abort, 실패 전부 무해.
//     출력 누적은 try 밖 변수 + 여유 maxTurns([[lain-sdk-maxturns-error-max-turns]]).
//   - judge 프롬프트에 anti-capture rubric 명시 — 환경의존 실패·도구 부정주장·일회성 서사를 버리게.
//   - 리뷰 워터마크는 judge 호출 *전에* 전진(curator 해시가드 동형) — 실패 반복 호출 차단.
//
// 입력은 listConversationDialogue(user/assistant 원문 — tool 라인은 계수·입력 모두 제외해 재귀 방지).
// 출력 교훈은 insertLesson(origin:'agent') + 💾 채팅 라인(emitChat — 호출부가 채널 주입).
import { query } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_CWD, CLAUDE_BIN } from './paths'
import {
  ensureActiveConversation,
  getSettings,
  getSetting,
  setSetting,
  insertLesson,
  listConversationDialogue,
  listAgentSkills,
  lessonsForProject,
} from './store'
import { hasActiveWork } from './orchestrator'
import { judgeQueryOptions } from './agentopts'
import { redactSecrets, scanLessonInjection } from './safety'
import { buildSkillsIndex } from './agentskills'
import type { ChatMessage } from '../shared/types'

// manager-chat 교훈은 특정 프로젝트에 매이지 않는다(scope는 대개 global). lessons.project_id는
// NOT NULL이라 sentinel이 필요하고, lessonsForProject는 scope='global'을 project_id와 무관하게
// 고르므로 이 값은 선택에 영향 없다(글래스박스 추적용 식별자일 뿐).
const LAIN_SCOPE_PROJECT = '__lain__'
const JUDGE_TIMEOUT_MS = 60_000
const MIN_DIALOGUE = 6 // 원문(user/assistant) 이만큼 쌓이기 전 젊은 대화는 스킵 — 교정 신호는 예외
const MAX_LESSONS_PER_REVIEW = 2

// ── 결정론 게이트(순수·테스트 용이) ─────────────────────────────────────────────
// 직전 user 메시지가 '교정/선호 표명'으로 보이면 true — 젊은 대화 스킵(MIN_DIALOGUE)의 예외 신호.
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
 * true면 젊은 대화 스킵 게이트를 우회한다(교정은 대화 초반에도 고가치 신호).
 */
export function isCorrectionSignal(text: string): boolean {
  if (!text) return false
  const t = text.trim()
  if (t.length < 2) return false
  return CORRECTION_RE.some((re) => re.test(t))
}

/**
 * 턴 리뷰 스킵 게이트(순수·결정론) — dialogue는 user/assistant 원문(오래된→최신).
 * 스킵: ①무변화(직전 리뷰 워터마크 이후 새 원문 없음) ②도구만 쓴 중간 턴(마지막이 assistant 아님)
 * ③젊은 대화(원문 MIN_DIALOGUE 미만 — 단 마지막 user 발화가 교정/선호 신호면 통과).
 */
export function shouldSkipTurnReview(
  dialogue: ChatMessage[],
  lastReviewedId: number,
): { skip: boolean; reason?: string } {
  if (dialogue.length === 0) return { skip: true, reason: 'empty' }
  const newest = dialogue[dialogue.length - 1]
  if (newest.id <= lastReviewedId) return { skip: true, reason: 'unchanged' }
  if (newest.role !== 'assistant') return { skip: true, reason: 'tool-only' }
  if (dialogue.length < MIN_DIALOGUE) {
    const lastUser = [...dialogue].reverse().find((m) => m.role === 'user')
    if (!lastUser || !isCorrectionSignal(lastUser.content)) return { skip: true, reason: 'young' }
  }
  return { skip: false }
}

// judge 출력 파싱(순수·테스트 용이) — 교훈 0~MAX건 + 스킬 후보 0~1건. json 블록 없음/파싱 실패면 null.
// 스킬 name은 ascii kebab 검증, reason은 인젝션 스캔(blocked면 reason만 비움 — name은 정규식으로 안전).
export interface TurnReviewParsed {
  lessons: { scope: 'global' | 'project'; trigger: string; lesson: string }[]
  suggestion: { name: string; reason: string } | null
}
export function parseTurnReview(raw: string): TurnReviewParsed | null {
  const m = raw.match(/```json\s*([\s\S]*?)```/)
  if (!m) return null
  let obj: any
  try {
    obj = JSON.parse(m[1])
  } catch {
    return null
  }
  const lessons = (Array.isArray(obj.lessons) ? obj.lessons : [])
    .map((l: any) => ({
      scope: l?.scope === 'project' ? ('project' as const) : ('global' as const),
      trigger: String(l?.trigger ?? ''),
      lesson: String(l?.lesson ?? '').trim(),
    }))
    .filter((l: { lesson: string }) => l.lesson)
    .slice(0, MAX_LESSONS_PER_REVIEW)
  const sug = obj.skill_suggestion
  let suggestion: TurnReviewParsed['suggestion'] = null
  if (sug && typeof sug.name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(sug.name)) {
    let reason = String(sug.reason ?? '').replace(/\s+/g, ' ').slice(0, 100)
    if (scanLessonInjection(reason).blocked) reason = '' // 판정 출력이 프롬프트로 재주입되는 면 — 형상 불량이면 사유만 버림
    suggestion = { name: sug.name, reason }
  }
  return { lessons, suggestion }
}

/**
 * 학습루프 T3 — 매니저 채팅 한 턴 종료 직후 호출(sendToManager 루프 밖, fire-and-forget).
 * turnReviewEnabled(기본 on) off면 휴면. 최근 대화 다이제스트 + 기존 교훈/스킬 인덱스를 격리 judge에
 * 줘 0~2건 교훈을 뽑아 insertLesson(origin:'agent')하고, 💾 라인을 emitChat으로 알린다(자동 저장 = 알림 필수).
 * 스킬 후보는 저장하지 않고 💡 힌트 라인 + onSkillSuggestion 콜백만 — 호출부(manager)가 다음 턴에
 * 레인에게 1회 힌트로 주입해 레인이 사용자에게 "저장할까요?"라고 먼저 제안할 수 있게 한다(선제 /learn).
 * 반환 없음·실패 무해(off거나 게이트 미통과거나 judge 실패면 조용히 종료 — 회귀 0).
 *
 * @param conversationId    (옵션) 방금 턴이 끝난 manager 대화 id. 미지정 시 활성 manager 대화로 해석.
 * @param emitChat          (옵션) 학습 알림 콜백 — 호출부가 채널 주입(selfimprove는 채널 안 만듦).
 * @param onSkillSuggestion (옵션) 스킬 후보 콜백 — 호출부가 다음 레인 턴 힌트로 브리지(중복 억제도 호출부).
 */
export async function reviewManagerTurn(
  conversationId?: string,
  emitChat?: (text: string) => void,
  onSkillSuggestion?: (s: { name: string; reason: string }) => void,
): Promise<void> {
  try {
    if (!getSettings().turnReviewEnabled) return // off면 휴면 — 어떤 부수효과도 없음
    if (hasActiveWork()) return // 작업 중엔 미룬다(consolidate 패턴) — C1: held만 있으면 활성 아님 → 턴리뷰 허용
    const convId = conversationId || ensureActiveConversation('manager')
    if (!convId) return

    const dialogue = listConversationDialogue(convId, 10)
    const watermarkKey = `turn_review_last:${convId}`
    const lastReviewedId = Number(getSetting(watermarkKey) ?? 0) || 0
    if (shouldSkipTurnReview(dialogue, lastReviewedId).skip) return
    // 워터마크를 judge 호출 *전에* 전진 — 실패해도 같은 대화 상태로 반복 호출하지 않는다(curator 해시가드 동형).
    setSetting(watermarkKey, String(dialogue[dialogue.length - 1].id))

    // judge 입력은 시크릿 마스킹 1패스(§9-6) — 채팅 본문에 토큰/키가 섞였어도 모델로 안 샌다.
    const digest = dialogue
      .map((m) => `[${m.role}] ${redactSecrets(m.content).slice(0, 800)}`)
      .join('\n')
    const existingLessons = lessonsForProject(LAIN_SCOPE_PROJECT, 10)
      .map((l) => `- ${l.trigger ? l.trigger + ' → ' : ''}${l.lesson}`)
      .join('\n')
    const skillsIdx = buildSkillsIndex(listAgentSkills(), 15)

    const prompt = `너는 lain의 '턴 리뷰' 담당이다. 방금 끝난 사용자↔관리자(Lain) 대화에서, **앞으로의 모든 작업에 재사용할 수 있는 사용자 선호·규칙**을 0~${MAX_LESSONS_PER_REVIEW}건 뽑고, 여러 단계 절차가 반복될 낌새면 스킬 후보를 1건까지 제안해라.

여기서 다루는 건 검증 루프(테스트) 밖의 학습이다. 사용자의 명시적 교정("아니 그렇게 말고", "앞으로는 ~해", "항상 ~", "기억해")·선호 표명·반복 지시 패턴에서, 영속적 행동 규칙이 될 만한 것만 남긴다.

<recent-dialogue>
${digest}
</recent-dialogue>

이미 저장된 교훈(중복이면 새로 만들지 마라):
<existing-lessons>
${existingLessons || '(없음)'}
</existing-lessons>

이미 저장된 스킬(같은 주제면 skill_suggestion을 내지 마라):
<existing-skills>
${skillsIdx || '(없음)'}
</existing-skills>

규칙(anti-capture — 어기면 빈 배열을 내라):
- 환경의존·일회성 실패에서 교훈을 만들지 마라(이 머신·이 순간에만 맞는 사실).
- 도구가 무엇을 했다/못 했다는 부정확한 주장으로 교훈을 만들지 마라(과정-트레이스 금지).
- 이 대화 한정 서사·맥락("아까 그 파일")을 일반 규칙으로 격상하지 마라.
- **사실 진술과 행동 지시를 구분해라**: 사용자가 무언가를 알려준 것(정보)은 규칙이 아니다. 사용자가 명시적으로 지시·교정한 것만 규칙이 된다.
- **사용자 정체 정보(이름·신원·직업·소속 등)는 교훈으로 만들지 마라** — 그건 프로필(user_profile) 영역이다. 특히 사용자가 이름을 밝혔다고 "그 이름으로 호칭하라"는 규칙으로 격상하지 마라 — 호칭은 "나를 OO라고 불러"라는 명시 지시가 있을 때만, 그것도 교훈이 아니라 set_user_title의 몫이다.
- 진짜 사용자 선호/규칙이 아니면(단순 질문·지시·잡담) 빈 배열. 기존 교훈과 중복이어도 빈 배열.
- 확신이 없으면 빈 배열. ${MAX_LESSONS_PER_REVIEW}건을 초과해 뽑지 마라.
- skill_suggestion은 '여러 단계 절차'가 대화에 실제로 등장했고 재사용 가치가 분명할 때만. name은 ascii kebab.

JSON 한 블록만 출력:
\`\`\`json
{"lessons": [{"scope": "global|project", "trigger": "<언제 적용되나, 키워드>", "lesson": "<재사용 가능한 사용자 선호/규칙 한두 문장>"}], "skill_suggestion": {"name": "<kebab-name>", "reason": "<왜 스킬감인지 한 줄>"}}
\`\`\`
- 스킬 후보가 없으면 "skill_suggestion": null. 대부분 사용자 선호는 프로젝트 무관이므로 scope는 보통 global.`

    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), JUDGE_TIMEOUT_MS)
    let last = '' // try 밖 누적 — maxTurns throw여도 스트리밍 텍스트를 살린다
    try {
      const stream = query({
        prompt,
        options: {
          cwd: AGENT_CWD,
          allowedTools: [],
          maxTurns: 3,
          ...judgeQueryOptions(), // 짧은 판정류 — judge 티어(local 라우팅 + D7 사용량 가드 강등)
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

    const parsed = parseTurnReview(last)
    if (!parsed) return
    const savedLines: string[] = []
    for (const l of parsed.lessons) {
      // 주입 인젝션 방어 — judge 출력이 프롬프트 탈취 형상을 띠면 저장하지 않는다(소비처 게이트와 동형).
      if (scanLessonInjection(l.lesson).blocked) continue
      insertLesson({
        projectId: LAIN_SCOPE_PROJECT,
        taskId: 'turn-review',
        scope: l.scope,
        trigger: l.trigger,
        lesson: l.lesson,
        origin: 'agent',
      })
      savedLines.push(l.lesson.replace(/\s+/g, ' '))
    }
    if (savedLines.length > 0)
      emitChat?.(`💾 교훈 저장 — ${savedLines.join(' / ')}`)
    if (parsed.suggestion) {
      const { name, reason } = parsed.suggestion
      emitChat?.(`💡 스킬 후보 — ${name}${reason ? `: ${reason}` : ''} (저장하려면 "/learn ${name}" 또는 레인에게 지시)`)
      onSkillSuggestion?.(parsed.suggestion) // 다음 레인 턴에 힌트 주입 → 레인이 먼저 "저장할까요?" 제안
    }
  } catch {
    /* 모든 실패 무해 — 턴 리뷰는 best-effort, 채팅·메인에 영향 0 */
  }
}
