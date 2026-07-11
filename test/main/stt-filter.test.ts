import { describe, it, expect } from 'vitest'
import { isLikelyWhisperHallucination } from '../../src/main/stt-filter'

describe('isLikelyWhisperHallucination', () => {
  it('흔한 Whisper 환청은 거른다', () => {
    expect(isLikelyWhisperHallucination('MBC 뉴스 김성현입니다.')).toBe(true)
    expect(isLikelyWhisperHallucination('KBS 뉴스 이지은입니다')).toBe(true)
    expect(isLikelyWhisperHallucination('구독과 좋아요 부탁드립니다')).toBe(true)
    expect(isLikelyWhisperHallucination('다음 영상에서 만나요')).toBe(true)
    expect(isLikelyWhisperHallucination('시청해 주셔서 감사합니다')).toBe(true)
  })

  it('실제 사용자 발화는 통과시킨다(오탐 방지)', () => {
    expect(isLikelyWhisperHallucination('레인 오늘 작업 상태 알려줘')).toBe(false)
    expect(isLikelyWhisperHallucination('감사합니다')).toBe(false) // 단독은 실제 발화일 수 있음
    expect(isLikelyWhisperHallucination('deploy 했어?')).toBe(false)
    expect(isLikelyWhisperHallucination('')).toBe(false)
    expect(isLikelyWhisperHallucination('뉴스 봤어?')).toBe(false)
  })
})
