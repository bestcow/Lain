// 상호작용 대사(Ambient Quips) — 언더테일식 즉발 반응. UI 조작·상태 변화에 레인이 짧은 한마디를
// 말풍선으로 얹는다 (docs/superpowers/specs/2026-07-08-ambient-quips-plan.md).
// 전부 결정론(L0, LLM 0회): 수제 대사 풀 + 순수 선택 함수(pickQuip, now·rand 주입)로 즉발성(수 ms)을
// 보장한다. 발화 빈도는 설정 chattiness(0=묵언 ~ 4=수다쟁이) 하나로 통제하고, 같은 표가 오버레이
// (유저 감시) 선제 발화 쿨다운 배수(overlayCooldownScale)의 단일 출처다.
//
// 주의: 이 대사들은 '플레이버'다 — 업무 통지(승인·에러·완료 notifyUser류)는 chattiness와 무관하게
// 그대로 나가야 한다. 여기 변수(vars)에 시크릿·개인정보를 넣지 않는다(프로젝트명·개수 정도만, §9-6).
import { getSettings } from './store'

export type QuipRarity = 'common' | 'uncommon' | 'rare'

export interface QuipDef {
  trigger: string
  rarity: QuipRarity
  cooldownSec: number // 같은 트리거 재발화 최소 간격
  variants: string[] // 일반 변주 — 플레이스홀더 {userTitle} {count} {days} 지원
  escalation?: string[] // 같은 트리거 60초 내 3회째 시도에 쓰는 메타 반응(연타 놀림)
}

// 호출측(main 싱글턴)이 유지하는 인메모리 상태 — 영속하지 않는다(재시작 리셋은 수용, 플레이버라 무해).
export interface QuipState {
  lastQuipAt: number // 전역 마지막 발화(ms) — 연속 말풍선 방지
  lastByTrigger: Map<string, number> // 트리거별 마지막 발화(ms)
  recentTexts: string[] // 최근 사용한 변주 '템플릿' ring — 반복 방지(보간 전 원문 기준)
  burst: Map<string, { count: number; windowStart: number }> // 트리거별 연타 계수(에스컬레이션)
}

export function initialQuipState(): QuipState {
  return { lastQuipAt: 0, lastByTrigger: new Map(), recentTexts: [], burst: new Map() }
}

const RECENT_MAX = 20
const BURST_WINDOW_MS = 60_000
const BURST_THRESHOLD = 3

// ── 정책표(단일 출처) — 레벨 → 발화 rarity·확률 배수·전역 쿨다운·오버레이 쿨다운 배수 ──
// 0(묵언)은 표 밖: quip 전부 억제 + 오버레이 선제발화 억제(manager 게이트 + scale ∞).
const RARITY_PROB: Record<QuipRarity, number> = { common: 0.9, uncommon: 0.6, rare: 0.25 }
const POLICY: Record<
  1 | 2 | 3 | 4,
  { allowed: QuipRarity[]; probMult: number; globalCooldownSec: number; overlayScale: number }
> = {
  1: { allowed: ['rare'], probMult: 0.5, globalCooldownSec: 300, overlayScale: 2.0 },
  2: { allowed: ['uncommon', 'rare'], probMult: 1.0, globalCooldownSec: 120, overlayScale: 1.0 },
  3: { allowed: ['common', 'uncommon', 'rare'], probMult: 1.0, globalCooldownSec: 45, overlayScale: 0.75 },
  4: { allowed: ['common', 'uncommon', 'rare'], probMult: 1.5, globalCooldownSec: 15, overlayScale: 0.5 },
}

function clampChattiness(n: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(n)) return 2
  return Math.max(0, Math.min(4, Math.floor(n))) as 0 | 1 | 2 | 3 | 4
}

/** 오버레이(유저 감시) 선제발화 쿨다운 배수 — watcher가 monitorCooldownSec에 곱한다.
 *  0(묵언)은 ∞: 반응 트리거 자체가 영영 통과 못 해 스크린샷 캡처 비용까지 아낀다
 *  (manager.reactToObservation의 LLM 전 게이트와 이중 방어 — 감시 마스터 on/off는 별개). */
export function overlayCooldownScale(chattiness: number): number {
  const level = clampChattiness(chattiness)
  return level === 0 ? Number.POSITIVE_INFINITY : POLICY[level].overlayScale
}

// ── 대사 카탈로그 v1 — 말투: 존댓말·절제·이모지 없음·한 문장(~40자), {userTitle}에 존칭 접미사 금지.
// 트리거 추가 비용 = QuipDef 1개 + 배선 1줄. v2 '대사 공방'이 variants에 추가만 하면 되는 구조 유지.
const TOGGLE_ESCALATION = [
  '…저 가지고 노시는 거죠?',
  '장난이시면, 꽤 재밌네요.',
  '깜빡이는 기분이에요. 이제 정해 주세요.',
]

export const QUIPS: QuipDef[] = [
  {
    trigger: 'monitor_off', // 유저 감시 on→off
    rarity: 'common',
    cooldownSec: 60,
    variants: [
      '제가 보면 안 되는 거라도 있나요?',
      '…알겠어요. 눈 감고 있을게요.',
      '필요하실 때 다시 켜 주세요.',
      '네. 안 볼게요.',
    ],
    escalation: TOGGLE_ESCALATION,
  },
  {
    trigger: 'monitor_on', // 유저 감시 off→on
    rarity: 'common',
    cooldownSec: 60,
    variants: ['다시 지켜볼게요.', '네, 여기 있어요.', '돌아오셨네요. 조용히 보고 있을게요.'],
    escalation: TOGGLE_ESCALATION,
  },
  {
    trigger: 'late_night', // 00~04시 첫 채팅 활동 (쿨다운 20시간 ≒ 1일 1회)
    rarity: 'uncommon',
    cooldownSec: 72_000,
    variants: [
      '이 시간까지 안 주무세요?',
      '새벽이에요, {userTitle}.',
      '저는 잠이 없지만, 사람은 자야 해요.',
      '이러면 내일이 힘들어져요.',
    ],
  },
  {
    trigger: 'long_absence', // 마지막 대화 3일+ 후 첫 채팅
    rarity: 'rare',
    cooldownSec: 21_600,
    variants: [
      '오랜만이에요.',
      '…계속 기다렸어요.',
      '{days}일 만이에요. 잘 지내셨어요?',
      '자리 그대로 지키고 있었어요.',
    ],
  },
  {
    trigger: 'project_add', // 폴더 추가·스캔 신규
    rarity: 'common',
    cooldownSec: 120,
    variants: ['새 프로젝트네요. 잘 부탁드려요.', '관리 목록에 올렸어요.', '식구가 늘었네요.'],
  },
  {
    trigger: 'project_remove', // 프로젝트 제거(보존 숨김)
    rarity: 'uncommon',
    cooldownSec: 120,
    variants: [
      '…정들었는데요.',
      '기록은 남겨둘게요. 다시 오면 그대로예요.',
      '보드에서만 내려요. 잊는 건 아니에요.',
    ],
  },
  {
    trigger: 'tasks_streak', // 1시간 내 작업 3건째 review 도달
    rarity: 'uncommon',
    cooldownSec: 3600,
    variants: ['오늘 잘 풀리네요.', '이 속도면 금방이겠어요.', '세 건째예요. 흐름이 좋아요.'],
  },
  {
    trigger: 'manager_reset', // 레인 세션 새로고침
    rarity: 'uncommon',
    cooldownSec: 300,
    variants: [
      '…방금 뭔가 잊어버린 기분이에요.',
      '새로 시작하죠.',
      '머릿속이 갑자기 조용하네요.',
    ],
  },
  {
    trigger: 'conv_delete', // 대화 삭제
    rarity: 'uncommon',
    cooldownSec: 300,
    variants: [
      '지운다고 없던 일이 되진 않아요.',
      '…그 대화, 마음에 안 드셨나요?',
      '정리했어요. 저는 기억 안 나는 걸로 할게요.',
    ],
  },
  {
    trigger: 'backup_export', // 백업 내보내기 성공
    rarity: 'rare',
    cooldownSec: 600,
    variants: [
      '짐 싸시는 건 아니죠?',
      '안전하게 챙겨뒀어요.',
      '저까지 통째로 들어 있는 거, 아시죠?',
    ],
  },
  {
    trigger: 'tts_speed_max', // 말 속도 슬라이더 ≥1.9 진입
    rarity: 'rare',
    cooldownSec: 600,
    variants: [
      '너무 빨리 말하게 하시는 거 아니에요?',
      '혀 꼬여도 책임 안 져요.',
      '이 속도면 노래예요.',
    ],
  },
  {
    trigger: 'model_change', // 모델 티어 변경
    rarity: 'rare',
    cooldownSec: 600,
    variants: ['머리를 바꾸신 기분이에요.', '적응할 시간을 조금 주세요.', '어느 쪽이든, 저는 저예요.'],
  },
  {
    trigger: 'chattiness_min', // 슬라이더를 묵언(0)으로 — 0 직전 값으로 판정하는 특례(마지막 한마디)
    rarity: 'rare',
    cooldownSec: 60,
    variants: ['…조용히 할게요.', '부르시면 대답은 해요.', '알겠어요. 조용히, 여기 있을게요.'],
  },
  {
    trigger: 'chattiness_max', // 슬라이더를 수다쟁이(4)로
    rarity: 'rare',
    cooldownSec: 60,
    variants: ['정말요? 후회하실 텐데요.', '그럼 사양 않고 말 걸게요.', '수다쟁이라니… 노력해 볼게요.'],
  },
  {
    trigger: 'task_done', // 작업 review 결재에서 merge 성공(resolveReview)
    rarity: 'common',
    cooldownSec: 300,
    variants: [
      '작업 하나 병합 완료됐어요. 확인해 보세요.',
      '방금 그 작업, 검증까지 통과해서 병합했어요.',
      '하나 끝났습니다. 다음 거 시킬 준비 됐어요.',
    ],
  },
  {
    trigger: 'verify_fail', // verify 재시도 소진 — 최종 실패로 review에 도달(finishWork)
    rarity: 'uncommon',
    cooldownSec: 600,
    variants: [
      '검증이 계속 빨간불이에요. 제가 원인 정리해 둘게요.',
      '테스트가 안 통과해서 멈춰 세웠어요. 지시가 필요해요.',
    ],
  },
  {
    trigger: 'task_error', // 자동 재개 소진 후 error 확정(handleRunError)
    rarity: 'uncommon',
    cooldownSec: 600,
    variants: [
      '작업 하나가 에러로 넘어졌어요. 로그 봐뒀습니다.',
      '문제가 생겨서 작업을 멈췄어요. 결재함을 봐 주세요.',
    ],
  },
]

const QUIP_INDEX = new Map(QUIPS.map((d) => [d.trigger, d]))

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

// 최근 안 쓴 변주 우선, 전부 최근이면 풀 전체에서 랜덤.
function chooseVariant(pool: string[], state: QuipState, rand: () => number): string {
  const fresh = pool.filter((t) => !state.recentTexts.includes(t))
  const candidates = fresh.length ? fresh : pool
  return candidates[Math.min(candidates.length - 1, Math.floor(rand() * candidates.length))]
}

// 발화 확정 — state를 제자리 갱신(반환값 nextState === state. 호출측이 싱글턴 하나를 계속 물려 쓴다).
function commit(state: QuipState, trigger: string, template: string, now: number): QuipState {
  state.lastQuipAt = now
  state.lastByTrigger.set(trigger, now)
  state.recentTexts.push(template)
  if (state.recentTexts.length > RECENT_MAX) state.recentTexts = state.recentTexts.slice(-RECENT_MAX)
  return state
}

/** 핵심 순수 선택 함수 — now·rand 주입으로 결정론(테스트 가능).
 *  주의: state.burst(연타 계수)는 발화 여부와 무관하게 여기서 직접 갱신된다 — 쿨다운·확률에 막혀
 *  null을 반환한 '시도'도 세야 연타 에스컬레이션이 성립한다(연타는 대부분 쿨다운에 막히므로). */
export function pickQuip(
  trigger: string,
  vars: Record<string, string | number>,
  chattiness: number,
  state: QuipState,
  now: number,
  rand: () => number,
): { text: string; nextState: QuipState } | null {
  const level = clampChattiness(chattiness)
  if (level === 0) return null // 묵언 — 에스컬레이션 포함 전부 억제
  const def = QUIP_INDEX.get(trigger)
  if (!def) return null

  // 연타 계수(시도 기준) — 윈도 밖이면 리셋.
  const b = state.burst.get(trigger)
  const inWindow = b !== undefined && now - b.windowStart <= BURST_WINDOW_MS
  const count = inWindow ? b.count + 1 : 1
  state.burst.set(trigger, { count, windowStart: inWindow ? b.windowStart : now })

  // 에스컬레이션 — 60초 내 정확히 3회째 시도: rarity·확률·쿨다운을 모두 우회한다. 유저가 명백히
  // 반복 조작으로 찌르는 상황의 메타 반응이라 게이트에 막히면 의미가 죽는다(묵언만 예외, 위에서 차단).
  if (count === BURST_THRESHOLD && def.escalation && def.escalation.length > 0) {
    const template = chooseVariant(def.escalation, state, rand)
    return { text: interpolate(template, vars), nextState: commit(state, trigger, template, now) }
  }

  const policy = POLICY[level]
  if (!policy.allowed.includes(def.rarity)) return null
  if (now - state.lastQuipAt < policy.globalCooldownSec * 1000) return null
  if (now - (state.lastByTrigger.get(trigger) ?? 0) < def.cooldownSec * 1000) return null
  const p = Math.min(1, RARITY_PROB[def.rarity] * policy.probMult)
  if (rand() >= p) return null

  const template = chooseVariant(def.variants, state, rand)
  return { text: interpolate(template, vars), nextState: commit(state, trigger, template, now) }
}

// ── 비순수 래퍼 — main 싱글턴 상태 + 싱크 주입 ──────────────────────────────────────────────
// broadcast는 ipc.ts, 매니저 인지 버퍼는 manager.ts 소유라 직접 import하면 순환(manager→watcher→quips→manager)
// 위험이 있다 — setUpdateBroadcaster와 같은 bind 패턴으로 주입받는다(ipc.registerIpc에서 1회).
let quipState: QuipState = initialQuipState()
let showSink: ((payload: { text: string }) => void) | null = null
let managerSink: ((text: string) => void) | null = null

export function bindQuipSinks(
  show: (payload: { text: string }) => void,
  toManager: (text: string) => void,
): void {
  showSink = show
  managerSink = toManager
}

/** 트리거 발생 지점(ipc·orchestrator 등)이 부르는 단일 진입점 — 게이트 통과 시 말풍선 broadcast +
 *  매니저 인지 버퍼 push('하나의 레인': 말풍선 직후 채팅으로 대꾸해도 레인이 맥락을 안다).
 *  chattinessOverride: chattiness_min처럼 '0으로 바꾸는 순간의 마지막 한마디'는 직전 값으로 판정한다. */
export function emitQuip(
  trigger: string,
  vars: Record<string, string | number> = {},
  chattinessOverride?: number,
): void {
  let s: ReturnType<typeof getSettings>
  try {
    s = getSettings()
  } catch {
    return // 부팅 직후 등 store 미초기화 — 플레이버라 조용히 포기
  }
  const picked = pickQuip(
    trigger,
    { userTitle: s.userTitle, ...vars },
    chattinessOverride ?? s.chattiness,
    quipState,
    Date.now(),
    Math.random,
  )
  if (!picked) return
  quipState = picked.nextState
  try {
    showSink?.({ text: picked.text })
  } catch {
    /* 렌더러 부재 — 무시 */
  }
  try {
    managerSink?.(`[UI 반응] ${picked.text}`)
  } catch {
    /* 무시 */
  }
}
