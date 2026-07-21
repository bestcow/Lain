// TTS 스트리밍 문장 분할(splitForTts) — 첫 청크는 첫 문장 하나(빠른 재생 시작), 이후 병합 규칙 고정.
import { describe, it, expect } from 'vitest'
import { splitForTts } from '../../src/main/tts'

describe('splitForTts — 문장 단위 분할·병합', () => {
  it('빈/공백 입력은 빈 배열', () => {
    expect(splitForTts('')).toEqual([])
    expect(splitForTts('   \n  ')).toEqual([])
  })

  it('한 문장은 청크 하나', () => {
    expect(splitForTts('안녕, 나 레인이야.')).toEqual(['안녕, 나 레인이야.'])
  })

  it('첫 청크는 첫 문장 홀로 — 이후 문장은 병합된다', () => {
    const out = splitForTts('첫 문장이다. 둘째 문장. 셋째 문장.')
    expect(out[0]).toBe('첫 문장이다.')
    expect(out.length).toBe(2)
    expect(out[1]).toBe('둘째 문장. 셋째 문장.')
  })

  it('mergeLen을 넘으면 새 청크로 나뉜다', () => {
    const s2 = 'a'.repeat(150) + '.'
    const s3 = 'b'.repeat(150) + '.'
    const out = splitForTts(`머리. ${s2} ${s3}`, 200)
    expect(out).toEqual(['머리.', s2, s3])
  })

  it('줄바꿈도 문장 경계다', () => {
    const out = splitForTts('첫 줄\n둘째 줄\n셋째 줄')
    expect(out[0]).toBe('첫 줄')
  })

  it('구분자 없는 초장문은 hardLen 근처 공백에서 강제 분할된다', () => {
    const words = Array.from({ length: 100 }, (_, i) => `단어${i}`).join(' ') // 종결부호 없음
    const out = splitForTts(words, 200, 300)
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) expect(c.length).toBeLessThanOrEqual(300)
    // 재조합하면 원문과 동일(공백 정규화 기준) — 내용 유실 없음
    expect(out.join(' ')).toBe(words)
  })

  it('물음표·말줄임표 종결도 문장 경계', () => {
    const out = splitForTts('진짜야? 그럴 리가… 알겠어.')
    expect(out[0]).toBe('진짜야?')
  })
})
