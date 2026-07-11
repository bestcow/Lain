import { describe, it, expect } from 'vitest'
import { koreanizeForTTS } from '../../src/main/koreanize'

describe('koreanizeForTTS', () => {
  it('사전 용어는 정확히 음차', () => {
    expect(koreanizeForTTS('deploy')).toBe('디플로이')
    expect(koreanizeForTTS('commit')).toBe('커밋')
    expect(koreanizeForTTS('GitHub')).toBe('깃허브')
    expect(koreanizeForTTS('Lain')).toBe('레인')
  })

  it('약어(대문자 연속)는 글자별', () => {
    expect(koreanizeForTTS('GPT')).toBe('지피티')
    expect(koreanizeForTTS('PR')).toBe('피아르') // 사전 우선
  })

  it('숫자는 한자어 읽기', () => {
    expect(koreanizeForTTS('123')).toBe('백이십삼')
    expect(koreanizeForTTS('2026')).toBe('이천이십육')
    expect(koreanizeForTTS('10')).toBe('십')
    expect(koreanizeForTTS('1,234')).toBe('천이백삼십사')
    expect(koreanizeForTTS('0')).toBe('영')
  })

  it('소수점·선행0은 자릿수 읽기', () => {
    expect(koreanizeForTTS('3.14')).toBe('삼 점 일사')
    expect(koreanizeForTTS('007')).toBe('영영칠')
  })

  it('규칙 폴백(사전 외 단어) — 근사 한글', () => {
    expect(koreanizeForTTS('hello')).toBe('헬로')
    expect(koreanizeForTTS('google')).toBe('구글')
    expect(koreanizeForTTS('info')).toBe('인포')
  })

  it('혼합 문장 — 라틴 문자가 전혀 남지 않는다(핵심 불변식)', () => {
    const inputs = [
      'deploy 끝났고 build 3개 done',
      'GitHub 에서 PR 2개 머지함',
      'error 로그 확인해 줘, status 200',
      'random gibberish xyzzy qwerty',
    ]
    for (const s of inputs) {
      const out = koreanizeForTTS(s)
      expect(out).not.toMatch(/[A-Za-z]/)
    }
  })

  it('순수 한글·문장부호는 불변', () => {
    expect(koreanizeForTTS('안녕하세요, 레인입니다.')).toBe('안녕하세요, 레인입니다.')
    expect(koreanizeForTTS('지금 처리할 작업은 없습니다.')).toBe('지금 처리할 작업은 없습니다.')
  })

  it('빈 문자열·기호', () => {
    expect(koreanizeForTTS('')).toBe('')
    expect(koreanizeForTTS('50%')).toBe('오십 퍼센트')
    expect(koreanizeForTTS('C++')).toBe('씨 플러스 플러스')
  })
})
