import { describe, it, expect } from 'vitest'
import { tokenizeLinks, type LinkToken } from '../../src/renderer/lib/linkify'

function urls(tokens: LinkToken[]): string[] {
  return tokens.filter((t): t is Extract<LinkToken, { type: 'url' }> => t.type === 'url').map((t) => t.value)
}
function paths(tokens: LinkToken[]): Array<{ value: string; line: number | null }> {
  return tokens
    .filter((t): t is Extract<LinkToken, { type: 'path' }> => t.type === 'path')
    .map((t) => ({ value: t.value, line: t.line }))
}
function texts(tokens: LinkToken[]): string[] {
  return tokens.filter((t): t is Extract<LinkToken, { type: 'text' }> => t.type === 'text').map((t) => t.value)
}

describe('tokenizeLinks — URL 감지', () => {
  it('단순 URL 하나', () => {
    expect(urls(tokenizeLinks('참고: https://example.com/foo 링크임'))).toEqual([
      'https://example.com/foo',
    ])
  })

  it('http/https 둘 다 인식', () => {
    expect(urls(tokenizeLinks('http://a.com https://b.com'))).toEqual(['http://a.com', 'https://b.com'])
  })

  it('문장 끝 구두점은 URL에서 제거', () => {
    expect(urls(tokenizeLinks('가 봐라. https://example.com/foo.'))).toEqual(['https://example.com/foo'])
    expect(urls(tokenizeLinks('(https://example.com/foo)'))).toEqual(['https://example.com/foo'])
  })

  it('한글 바로 뒤에서 URL 경계 종료', () => {
    expect(urls(tokenizeLinks('https://example.com/foo그다음'))).toEqual(['https://example.com/foo'])
  })

  it('file:/javascript: 스킴은 URL 토큰으로 안 뽑힘(화이트리스트 http/https만)', () => {
    expect(urls(tokenizeLinks('file:///etc/passwd 랑 javascript:alert(1)'))).toEqual([])
  })

  it('평문은 text 토큰으로 보존', () => {
    const t = tokenizeLinks('그냥 평문')
    expect(texts(t)).toEqual(['그냥 평문'])
  })
})

describe('tokenizeLinks — 파일 경로 감지', () => {
  it('윈도우 절대경로', () => {
    expect(paths(tokenizeLinks('C:\\lain\\src\\main\\ipc.ts 확인'))).toEqual([
      { value: 'C:\\lain\\src\\main\\ipc.ts', line: null },
    ])
  })

  it('경로:줄번호 분리', () => {
    expect(paths(tokenizeLinks('src/main/ipc.ts:120 봐'))).toEqual([
      { value: 'src/main/ipc.ts', line: 120 },
    ])
  })

  it('경로:줄:컬럼도 줄번호만 추출', () => {
    expect(paths(tokenizeLinks('src/main/ipc.ts:120:5 봐'))).toEqual([
      { value: 'src/main/ipc.ts', line: 120 },
    ])
  })

  it('한글 문장 속 상대경로', () => {
    expect(paths(tokenizeLinks('이 파일은 src/renderer/lib/markdown.tsx 에 있다'))).toEqual([
      { value: 'src/renderer/lib/markdown.tsx', line: null },
    ])
  })

  it('괄호로 감싼 경로는 괄호 제거', () => {
    expect(paths(tokenizeLinks('(src/main/ipc.ts:120) 참고'))).toEqual([
      { value: 'src/main/ipc.ts', line: 120 },
    ])
  })

  it('구두점 꼬리 제거 — 문장 끝 마침표', () => {
    expect(paths(tokenizeLinks('경로는 src/main/ipc.ts 이다.'))).toEqual([
      { value: 'src/main/ipc.ts', line: null },
    ])
  })

  it('슬래시 없는 단순 파일명은 경로로 취급 안 함', () => {
    expect(paths(tokenizeLinks('README.md 파일 열어봐'))).toEqual([])
  })

  it('POSIX 스타일 절대경로', () => {
    expect(paths(tokenizeLinks('/etc/hosts 파일'))).toEqual([{ value: '/etc/hosts', line: null }])
  })

  it('URL과 경로가 섞여도 각각 올바르게 분리', () => {
    const t = tokenizeLinks('참고 https://example.com/doc 그리고 src/main/ipc.ts:10 봐')
    expect(urls(t)).toEqual(['https://example.com/doc'])
    expect(paths(t)).toEqual([{ value: 'src/main/ipc.ts', line: 10 }])
  })
})
