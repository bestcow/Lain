// B5 — ask_user 크로스서피스 배관(결정론, LLM 호출 없음).
// manager.ts의 ask_user/Edit·plan 승인 카드가 띄우는 인라인 질문을
//  (1) main 인메모리에 보관해 렌더러 리로드에도 복원(question:pending 조회 IPC),
//  (2) 텔레그램에도 미러(inline_keyboard + callback_data)하고 폰 응답을 되받고,
//  (3) 무응답 타임아웃으로 교착을 원천 차단(만료 시 '(응답 없음)' resolve)
// 하는 데 필요한 순수 상태·인코딩 로직을 여기 모은다(부작용은 setTimeout뿐 — 나머지 순수).
// waitForUserAnswer 단일 resolve 가드가 핵심: 타임아웃 resolve와 실제 답변 도착이 경합해도
// questionId 삭제를 원자적으로 처리해 정확히 한 번만 resolve된다(Phase 1 C1·Phase 2 orphan 방어와 동형).

// main이 보관하는 대기 중 질문 형태는 IPC 계약(shared/types.ts)의 단일 출처를 재사용한다.
import type { PendingQuestion } from '../shared/types'
export type { PendingQuestion }

// ── 텔레그램 callback_data 인코딩 (기존 승인 콜백 'a<id>y'와 같은 결의 짧은 토큰) ──
// 텔레그램 callback_data는 최대 64바이트. 'q|<questionId>|<index>' 형태.
// questionId는 manager가 만드는 'q1'·'edit3'·'plan2' 등(영숫자) → '|' 구분자와 충돌 없음.
const CB_PREFIX = 'q|'

/** questionId + 보기 인덱스를 텔레그램 callback_data 문자열로 인코딩. */
export function encodeQuestionCallback(questionId: string, index: number): string {
  return `${CB_PREFIX}${questionId}|${index}`
}

/** callback_data를 파싱 — 형식·인덱스가 위조·구형이면 null(호출부는 무시). */
export function parseQuestionCallback(data: string): { questionId: string; index: number } | null {
  if (typeof data !== 'string' || !data.startsWith(CB_PREFIX)) return null
  const rest = data.slice(CB_PREFIX.length)
  const sep = rest.lastIndexOf('|')
  if (sep <= 0) return null // 구분자 없음 또는 questionId 비어있음
  const questionId = rest.slice(0, sep)
  const idxStr = rest.slice(sep + 1)
  if (!/^\d+$/.test(idxStr)) return null // 인덱스가 정수가 아니면 위조로 간주
  const index = Number(idxStr)
  if (!Number.isSafeInteger(index) || index < 0) return null
  return { questionId, index }
}

/**
 * 대기 중 인라인 질문 버스 — pendingQuestion 보관 + waiter 단일 resolve 가드 + 타임아웃.
 * 부작용은 setTimeout/clearTimeout뿐(주입 가능)이라 상태전이는 결정론적으로 단위테스트된다.
 */
export class QuestionBus {
  private readonly pending = new Map<string, PendingQuestion>()
  private readonly waiters = new Map<string, (answer: string[]) => void>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    // 타임아웃 만료 시 호출 — main이 PC·폰 카드 소거/만료 표시에 쓴다(부작용은 바깥에서).
    private readonly onTimeout: (q: PendingQuestion) => void = () => {},
    private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  /** 질문 등록 + 답 대기. timeoutMs>0이면 만료 시 '(응답 없음)'으로 resolve. 정확히 한 번만 resolve. */
  wait(q: Omit<PendingQuestion, 'createdAt'>, timeoutMs: number): Promise<string[]> {
    const full: PendingQuestion = { ...q, createdAt: Date.now() }
    this.pending.set(q.questionId, full)
    return new Promise<string[]>((resolve) => {
      this.waiters.set(q.questionId, resolve)
      if (timeoutMs > 0) {
        const t = this.setTimer(() => {
          // 타임아웃 — 아직 살아있으면(=미응답) '(응답 없음)'으로 resolve하고 만료 훅 호출.
          const still = this.pending.get(q.questionId)
          if (this.settle(q.questionId, ['(응답 없음)']) && still) this.onTimeout(still)
        }, timeoutMs)
        this.timers.set(q.questionId, t)
      }
    })
  }

  /**
   * 답변/타임아웃 공통 정착 — questionId를 원자적으로 소거하고 waiter를 resolve한다.
   * 이미 정착된(=삭제된) questionId면 false 반환(재응답 무시 — 단일 resolve 가드).
   */
  private settle(questionId: string, answer: string[]): boolean {
    const w = this.waiters.get(questionId)
    if (!w) return false // 이미 resolve/소거됨 — 경합한 타임아웃·중복 콜백·위조 무시
    this.waiters.delete(questionId)
    this.pending.delete(questionId)
    const t = this.timers.get(questionId)
    if (t !== undefined) {
      this.clearTimer(t)
      this.timers.delete(questionId)
    }
    w(answer)
    return true
  }

  /** 렌더러/텔레그램에서 답이 오면 호출 — 대기 중 턴을 깨운다. 이미 정착됐으면 무시(true=처리됨). */
  answer(questionId: string, answer: string[]): boolean {
    return this.settle(questionId, answer)
  }

  /** 턴 취소(stopManager) 등 — 모든 대기를 빈 선택으로 깨우고 상태를 비운다(유령 카드·누수 방지). */
  clearAll(): void {
    for (const id of [...this.waiters.keys()]) this.settle(id, [])
  }

  /** 리로드 복원용 — 현재 대기 중 질문 스냅샷(question:pending 조회 IPC). */
  list(): PendingQuestion[] {
    return [...this.pending.values()]
  }

  /** 존재하는 pending 질문 조회(텔레그램 콜백이 보기 인덱스→텍스트 변환에 쓴다). */
  get(questionId: string): PendingQuestion | undefined {
    return this.pending.get(questionId)
  }
}
