import { describe, it, expect, vi } from 'vitest'
import {
  encodeQuestionCallback,
  parseQuestionCallback,
  QuestionBus,
} from '../../src/main/questionbus'

// B5 — ask_user 크로스서피스 순수 로직: 텔레그램 callback_data 인코딩/파싱 + waitForUserAnswer 단일 resolve 가드 + pendingQuestion 상태전이.

describe('encodeQuestionCallback / parseQuestionCallback — 텔레그램 콜백 round-trip', () => {
  it('questionId + 인덱스 round-trip', () => {
    for (const [qid, idx] of [['q1', 0], ['edit3', 2], ['plan12', 7]] as const) {
      const data = encodeQuestionCallback(qid, idx)
      expect(parseQuestionCallback(data)).toEqual({ questionId: qid, index: idx })
    }
  })

  it('64바이트(텔레그램 상한) 이내 — 긴 questionId도 인덱스만 실어 안전', () => {
    const data = encodeQuestionCallback('question123456', 99)
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
  })

  it('위조·구형·형식오류는 null(호출부 무시)', () => {
    expect(parseQuestionCallback('a5y')).toBeNull() // 승인 콜백(다른 접두)
    expect(parseQuestionCallback('r|merge|t1')).toBeNull() // 결재 콜백
    expect(parseQuestionCallback('q|')).toBeNull() // questionId·인덱스 없음
    expect(parseQuestionCallback('q|q1')).toBeNull() // 인덱스 구분자 없음
    expect(parseQuestionCallback('q|q1|')).toBeNull() // 인덱스 비어있음
    expect(parseQuestionCallback('q|q1|abc')).toBeNull() // 인덱스가 정수 아님
    expect(parseQuestionCallback('q|q1|-1')).toBeNull() // 음수 인덱스
    expect(parseQuestionCallback('q|q1|1.5')).toBeNull() // 소수
    expect(parseQuestionCallback('')).toBeNull()
    expect(parseQuestionCallback('garbage')).toBeNull()
  })

  it('questionId에 |가 없어야 하지만, lastIndexOf로 마지막 |만 인덱스 구분 — 견고성', () => {
    // 정상 questionId(q·edit·plan+숫자)엔 |가 없다. 방어적으로 마지막 | 뒤만 인덱스로 취급.
    expect(parseQuestionCallback('q|q1|3')).toEqual({ questionId: 'q1', index: 3 })
  })
})

// QuestionBus — pendingQuestion 보관 + 단일 resolve 가드 + 타임아웃. 타이머는 주입해 결정론 검증.
function makeBus() {
  const timedOut: string[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const setTimer = (fn: () => void) => {
    const id = nextTimer++
    timers.set(id, fn)
    return id as unknown as ReturnType<typeof setTimeout>
  }
  const clearTimer = (t: ReturnType<typeof setTimeout>) => {
    timers.delete(t as unknown as number)
  }
  const bus = new QuestionBus((q) => timedOut.push(q.questionId), setTimer, clearTimer)
  // 등록된 타이머를 수동으로 발화(만료 시뮬레이션). 이미 clear됐으면 no-op.
  const fireTimer = (id: number) => timers.get(id)?.()
  return { bus, timedOut, timers, fireTimer }
}

const baseQ = { question: '진행할까?', options: ['예', '아니오'], multi: false, conversationId: 'conv1' }

describe('QuestionBus — pendingQuestion 상태전이', () => {
  it('생성 → list에 나타남 → 답변 소거', async () => {
    const { bus } = makeBus()
    const p = bus.wait({ questionId: 'q1', ...baseQ }, 1000)
    expect(bus.list().map((q) => q.questionId)).toEqual(['q1'])
    expect(bus.get('q1')?.options).toEqual(['예', '아니오'])

    expect(bus.answer('q1', ['예'])).toBe(true)
    await expect(p).resolves.toEqual(['예'])
    expect(bus.list()).toEqual([]) // 소거됨(유령 카드 방지)
    expect(bus.get('q1')).toBeUndefined()
  })

  it('생성 → 타임아웃 소거 + onTimeout 훅 + (응답 없음) resolve', async () => {
    const { bus, timedOut, fireTimer } = makeBus()
    const p = bus.wait({ questionId: 'q1', ...baseQ }, 1000)
    fireTimer(1) // 만료
    await expect(p).resolves.toEqual(['(응답 없음)'])
    expect(bus.list()).toEqual([]) // 소거
    expect(timedOut).toEqual(['q1']) // 만료 훅 호출(PC·폰 카드 소거용)
  })

  it('clearAll(턴 취소) → 모든 대기를 빈 선택으로 깨우고 상태 비움', async () => {
    const { bus } = makeBus()
    const p1 = bus.wait({ questionId: 'q1', ...baseQ }, 1000)
    const p2 = bus.wait({ questionId: 'q2', ...baseQ }, 1000)
    expect(bus.list()).toHaveLength(2) // 동시 다중 보관
    bus.clearAll()
    await expect(p1).resolves.toEqual([])
    await expect(p2).resolves.toEqual([])
    expect(bus.list()).toEqual([])
  })
})

describe('QuestionBus — 단일 resolve 가드(타임아웃 레이스)', () => {
  it('답변 후 타임아웃 발화는 무시(이미 소거된 questionId 재응답 무시)', async () => {
    const { bus, timedOut, fireTimer } = makeBus()
    const p = bus.wait({ questionId: 'q1', ...baseQ }, 1000)
    expect(bus.answer('q1', ['예'])).toBe(true)
    await expect(p).resolves.toEqual(['예'])
    // 뒤늦게 타이머가 발화해도 — 이미 정착됨 → onTimeout 미호출, resolve 재발생 없음.
    fireTimer(1)
    expect(timedOut).toEqual([])
  })

  it('타임아웃 후 답변은 무시(만료로 이미 resolve됨)', async () => {
    const { bus, fireTimer } = makeBus()
    const p = bus.wait({ questionId: 'q1', ...baseQ }, 1000)
    fireTimer(1) // 만료 → '(응답 없음)'
    await expect(p).resolves.toEqual(['(응답 없음)'])
    // 뒤늦은 폰/PC 답변은 정착된 questionId라 false(무시).
    expect(bus.answer('q1', ['예'])).toBe(false)
  })

  it('중복 답변은 두 번째부터 false(정확히 한 번만 resolve)', async () => {
    const { bus } = makeBus()
    const p = bus.wait({ questionId: 'q1', ...baseQ }, 1000)
    expect(bus.answer('q1', ['예'])).toBe(true)
    expect(bus.answer('q1', ['아니오'])).toBe(false) // 경합·중복 콜백 무시
    await expect(p).resolves.toEqual(['예']) // 첫 답으로 고정
  })

  it('존재하지 않는(위조·구형) questionId 답변은 false', () => {
    const { bus } = makeBus()
    expect(bus.answer('ghost', ['예'])).toBe(false)
  })

  it('timeoutMs<=0이면 타이머 미등록(무한 대기) — 답변으로만 resolve', async () => {
    const { bus, timers } = makeBus()
    const p = bus.wait({ questionId: 'q1', ...baseQ }, 0)
    expect(timers.size).toBe(0)
    bus.answer('q1', ['예'])
    await expect(p).resolves.toEqual(['예'])
  })

  it('답변 시 타이머를 clear해 좀비 타이머·중복 만료를 막는다', async () => {
    const cleared: number[] = []
    const timers = new Map<number, () => void>()
    let nextTimer = 1
    const setTimer = (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id as unknown as ReturnType<typeof setTimeout> }
    const clearTimer = (t: ReturnType<typeof setTimeout>) => { cleared.push(t as unknown as number); timers.delete(t as unknown as number) }
    const onTimeout = vi.fn()
    const bus = new QuestionBus(onTimeout, setTimer, clearTimer)
    const p = bus.wait({ questionId: 'q1', ...baseQ }, 1000)
    bus.answer('q1', ['예'])
    await p
    expect(cleared).toEqual([1]) // 답변이 타이머를 clear
  })
})
