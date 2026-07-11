import { describe, it, expect } from 'vitest'
import { tokenizeCode, resolveLangKind, type CodeToken } from '../../src/renderer/lib/highlightCode'

function byType(tokens: CodeToken[], type: CodeToken['type']): string[] {
  return tokens.filter((t) => t.type === type).map((t) => t.value)
}

describe('resolveLangKind — 언어 태그 매핑', () => {
  it('ts/js 계열은 ts로 매핑된다', () => {
    expect(resolveLangKind('ts')).toBe('ts')
    expect(resolveLangKind('tsx')).toBe('ts')
    expect(resolveLangKind('js')).toBe('ts')
    expect(resolveLangKind('TypeScript')).toBe('ts')
  })

  it('py는 py로 매핑된다', () => {
    expect(resolveLangKind('py')).toBe('py')
    expect(resolveLangKind('python')).toBe('py')
  })

  it('bash/sh/shell은 bash로 매핑된다', () => {
    expect(resolveLangKind('bash')).toBe('bash')
    expect(resolveLangKind('sh')).toBe('bash')
  })

  it('json은 json으로 매핑된다', () => {
    expect(resolveLangKind('json')).toBe('json')
  })

  it('미지원/빈 언어는 none', () => {
    expect(resolveLangKind('')).toBe('none')
    expect(resolveLangKind('rust')).toBe('none')
  })
})

describe('tokenizeCode — lang 없음/미지원', () => {
  it('lang이 빈 문자열이면 plain 토큰 하나만 반환한다', () => {
    expect(tokenizeCode('const x = 1', '')).toEqual([{ type: 'plain', value: 'const x = 1' }])
  })

  it('빈 코드는 빈 배열', () => {
    expect(tokenizeCode('', 'ts')).toEqual([])
  })
})

describe('tokenizeCode — ts/js', () => {
  it('키워드를 인식한다', () => {
    const kws = byType(tokenizeCode('const x = function() { return 1 }', 'ts'), 'keyword')
    expect(kws).toEqual(['const', 'function', 'return'])
  })

  it('문자열 리터럴(", \', `)을 인식한다', () => {
    const strs = byType(tokenizeCode(`const a = "hi"; const b = 'yo'; const c = \`t\`;`, 'ts'), 'string')
    expect(strs).toEqual(['"hi"', "'yo'", '`t`'])
  })

  it('한 줄 주석(//)을 인식한다', () => {
    const cms = byType(tokenizeCode('const x = 1 // comment here', 'ts'), 'comment')
    expect(cms).toEqual(['// comment here'])
  })

  it('블록 주석(/* */)을 인식한다', () => {
    const cms = byType(tokenizeCode('/* block\ncomment */\nconst x = 1', 'ts'), 'comment')
    expect(cms).toEqual(['/* block\ncomment */'])
  })

  it('문자열 안의 //는 주석으로 오인하지 않는다', () => {
    const tokens = tokenizeCode(`const url = "http://example.com"`, 'ts')
    expect(byType(tokens, 'comment')).toEqual([])
    expect(byType(tokens, 'string')).toEqual(['"http://example.com"'])
  })

  it('식별자 일부인 키워드는 오매칭하지 않는다(constant는 const로 안 잡힘)', () => {
    const kws = byType(tokenizeCode('const constant = 1', 'ts'), 'keyword')
    expect(kws).toEqual(['const'])
  })
})

describe('tokenizeCode — python', () => {
  it('키워드를 인식한다', () => {
    const kws = byType(tokenizeCode('def foo():\n    return None', 'py'), 'keyword')
    expect(kws).toEqual(['def', 'return', 'None'])
  })

  it('# 주석을 인식한다', () => {
    const cms = byType(tokenizeCode('x = 1  # comment', 'python'), 'comment')
    expect(cms).toEqual(['# comment'])
  })

  it('문자열을 인식한다', () => {
    const strs = byType(tokenizeCode(`x = "hello"`, 'py'), 'string')
    expect(strs).toEqual(['"hello"'])
  })
})

describe('tokenizeCode — bash', () => {
  it('키워드를 인식한다', () => {
    const kws = byType(tokenizeCode('if [ -f x ]; then echo hi; fi', 'bash'), 'keyword')
    expect(kws).toEqual(['if', 'then', 'echo', 'fi'])
  })

  it('# 주석을 인식한다', () => {
    const cms = byType(tokenizeCode('echo hi # comment', 'sh'), 'comment')
    expect(cms).toEqual(['# comment'])
  })
})

describe('tokenizeCode — json', () => {
  it('true/false/null을 키워드로 인식한다', () => {
    const kws = byType(tokenizeCode('{"a": true, "b": null, "c": false}', 'json'), 'keyword')
    expect(kws).toEqual(['true', 'null', 'false'])
  })

  it('문자열 키/값을 인식한다', () => {
    const strs = byType(tokenizeCode('{"a": "b"}', 'json'), 'string')
    expect(strs).toEqual(['"a"', '"b"'])
  })

  it('json은 주석을 지원하지 않는다', () => {
    // json엔 //, # 개념이 없음 — # 문자가 등장해도 주석으로 분류하지 않는다.
    const tokens = tokenizeCode('{"a": "#tag"}', 'json')
    expect(byType(tokens, 'comment')).toEqual([])
  })
})

describe('tokenizeCode — 토큰을 이어붙이면 원문과 같다', () => {
  it('ts 샘플', () => {
    const code = 'const x = "a" // c\nfunction f() { return x }'
    const tokens = tokenizeCode(code, 'ts')
    expect(tokens.map((t) => t.value).join('')).toBe(code)
  })

  it('py 샘플', () => {
    const code = 'def f():\n    return "ok"  # done'
    const tokens = tokenizeCode(code, 'py')
    expect(tokens.map((t) => t.value).join('')).toBe(code)
  })
})
