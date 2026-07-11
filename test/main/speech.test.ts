// 음성 요약 태그(<<say: ...>>) 추출/제거 순수 로직 — 화면/텔레그램은 clean, TTS는 say만 읽는다.
import { describe, it, expect } from 'vitest'
import { extractSpeech, spokenText } from '../../src/shared/speech'

describe('extractSpeech — <<say:>> 태그 분리', () => {
  it('태그를 본문에서 떼고 say로 반환한다', () => {
    const r = extractSpeech('현황 보고드립니다.\n급한 작업 3건.\n<<say: 급한 작업 3건이 있습니다.>>')
    expect(r.say).toBe('급한 작업 3건이 있습니다.')
    expect(r.clean).toBe('현황 보고드립니다.\n급한 작업 3건.')
    expect(r.clean).not.toContain('say')
  })
  it('태그 없으면 say는 빈 문자열, 본문은 그대로', () => {
    const r = extractSpeech('처리하실 사항은 없습니다.')
    expect(r.say).toBe('')
    expect(r.clean).toBe('처리하실 사항은 없습니다.')
  })
  it('여러 태그/공백/대소문자/줄바꿈을 견딘다', () => {
    const r = extractSpeech('a <<SAY: 하나>> b\n\n\n<<say:\n둘\n>>')
    expect(r.say).toBe('하나 둘')
    expect(r.clean).not.toMatch(/say/i)
    expect(r.clean).not.toContain('<<')
  })
})

describe('spokenText — TTS로 읽을 텍스트', () => {
  it('say 태그가 있으면 그것만', () => {
    expect(spokenText('아주 긴 본문...\n<<say: 핵심 한 줄.>>')).toBe('핵심 한 줄.')
  })
  it('태그 없는 짧은 응답은 그대로 읽는다', () => {
    expect(spokenText('처리하실 사항은 없습니다.')).toBe('처리하실 사항은 없습니다.')
  })
  it('태그 없는 긴 본문은 첫 문장만 읽는다(완전 무음 방지, B7-1)', () => {
    const r = spokenText('가'.repeat(300))
    expect(r).not.toBe('')
    expect(r.length).toBeLessThanOrEqual(100)
  })
  it('첫 문장이 마침표로 끝나면 그 문장까지만 읽는다', () => {
    expect(spokenText('첫 문장입니다. ' + '나'.repeat(200))).toBe('첫 문장입니다.')
  })
  it('첫 문장 구분자가 줄바꿈이면 그 줄까지만 읽는다', () => {
    expect(spokenText('첫 줄\n' + '다'.repeat(200))).toBe('첫 줄')
  })
  it('종결부호도 줄바꿈도 없는 장문은 100자로 컷한다', () => {
    const r = spokenText('가'.repeat(300))
    expect(r).toBe('가'.repeat(100))
  })
})
