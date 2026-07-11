import { describe, it, expect, vi } from 'vitest'
import { normalizeConfirm, settleConfirm } from '../../src/renderer/lib/useConfirm'

describe('normalizeConfirm — 옵션 기본값 채움', () => {
  it('confirmLabel 기본 확인 / danger 기본 false', () => {
    const s = normalizeConfirm({ title: 'T', body: 'B' })
    expect(s.title).toBe('T')
    expect(s.body).toBe('B')
    expect(s.confirmLabel).toBe('확인')
    expect(s.danger).toBe(false)
    expect(s.note).toBeUndefined()
  })
  it('명시 값은 유지(danger·라벨·note)', () => {
    const s = normalizeConfirm({ title: 'T', body: 'B', note: 'N', confirmLabel: '삭제', danger: true })
    expect(s.confirmLabel).toBe('삭제')
    expect(s.danger).toBe(true)
    expect(s.note).toBe('N')
  })
})

describe('settleConfirm — 상태 전이(열림→확인/취소)', () => {
  it('확인 시 resolve(true) 호출하고 닫힘(null) 반환', () => {
    const resolve = vi.fn()
    const next = settleConfirm({ resolve }, true)
    expect(resolve).toHaveBeenCalledWith(true)
    expect(next).toBeNull()
  })
  it('취소 시 resolve(false) 호출하고 닫힘(null) 반환', () => {
    const resolve = vi.fn()
    const next = settleConfirm({ resolve }, false)
    expect(resolve).toHaveBeenCalledWith(false)
    expect(next).toBeNull()
  })
  it('pending 없으면(null) 아무 것도 안 하고 null', () => {
    // resolve가 없어 throw하지 않아야 함
    expect(settleConfirm(null, true)).toBeNull()
  })
  it('중복 결착 방어 — 한 pending을 두 번 결착해도 각각 resolve만 호출', () => {
    const resolve = vi.fn()
    const pending = { resolve }
    settleConfirm(pending, true)
    settleConfirm(pending, false) // 두 번째 호출도 resolve 자체는 실행되나(멱등은 Promise가 보장)
    expect(resolve).toHaveBeenCalledTimes(2)
    // 실제 훅에서는 setPending(null) 후 pendingRef도 null이 되어 두 번째가 안 온다 — 여기선 순수 함수만 검증
  })
})
