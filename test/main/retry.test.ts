import { describe, it, expect } from 'vitest'
import { isTransientApiError, transientBackoffMs } from '../../src/main/retry'

describe('isTransientApiError — 일시적 상류 에러만 자동 재시도 대상', () => {
  it('529 overloaded는 재시도 대상', () => {
    expect(isTransientApiError('API Error: 529 Overloaded. This is a server-side issue')).toBe(true)
    expect(isTransientApiError('Claude Code returned an error result: API Error: 529 Overloaded')).toBe(true)
    expect(isTransientApiError('overloaded_error')).toBe(true)
  })

  it('503·5xx·service unavailable도 재시도 대상', () => {
    expect(isTransientApiError('503 Service Unavailable')).toBe(true)
    expect(isTransientApiError('API Error: 500 Internal server error')).toBe(true)
    expect(isTransientApiError('502 Bad Gateway')).toBe(true)
    expect(isTransientApiError('504 Gateway Timeout')).toBe(true)
  })

  it('전송계층 네트워크 끊김은 일시적 — 인증(401) 문구로 감싸여 와도 재시도', () => {
    // 실제 사례(2026-06-25): SDK가 소켓 끊김을 401 인증 실패로 감싸 던졌다.
    expect(
      isTransientApiError(
        'Claude Code returned an error result: Failed to authenticate. API Error: 401 The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()',
      ),
    ).toBe(true)
    expect(isTransientApiError('TypeError: fetch failed')).toBe(true)
    expect(isTransientApiError('Error: socket hang up')).toBe(true)
    expect(isTransientApiError('read ECONNRESET')).toBe(true)
    expect(isTransientApiError('connect ETIMEDOUT 160.79.104.10:443')).toBe(true)
  })

  it('진짜 인증/요청 오류는 소켓·네트워크 문구 없으면 그대로 비일시적', () => {
    // line 23(기존)과 함께 — 자격증명 4xx는 소켓 끊김 문구가 없어 재시도 제외 유지.
    expect(isTransientApiError('Failed to authenticate. API Error: 401 invalid x-api-key')).toBe(false)
    expect(isTransientApiError('API Error: 403 permission_error')).toBe(false)
  })

  it('비일시적(설정·요청·인증·턴한도·중단)은 재시도 안 함', () => {
    expect(isTransientApiError('No conversation found with session ID abc')).toBe(false)
    expect(isTransientApiError('maximum number of turns')).toBe(false)
    expect(isTransientApiError('aborted by user')).toBe(false)
    expect(isTransientApiError('400 invalid_request_error: messages')).toBe(false)
    expect(isTransientApiError('401 authentication_error')).toBe(false)
    expect(isTransientApiError('404 not_found_error')).toBe(false)
    expect(isTransientApiError('')).toBe(false)
  })
})

describe('transientBackoffMs — 지수 백오프(0부터), 8s 상한', () => {
  it('1s → 2s → 4s → 8s(상한)', () => {
    expect(transientBackoffMs(0)).toBe(1000)
    expect(transientBackoffMs(1)).toBe(2000)
    expect(transientBackoffMs(2)).toBe(4000)
    expect(transientBackoffMs(3)).toBe(8000)
    expect(transientBackoffMs(10)).toBe(8000)
  })
})
