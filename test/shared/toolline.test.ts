import { describe, it, expect } from 'vitest'
import { encodeToolLine, decodeToolLine } from '../../src/shared/toolline'

describe('encodeToolLine/decodeToolLine — A17 도구 라인 축약+원문 왕복', () => {
  it('원문이 축약과 같으면(잘림 없음) 태그 없이 그대로', () => {
    const line = encodeToolLine('Read foo.ts', 'foo.ts')
    expect(line).toBe('Read foo.ts')
    expect(decodeToolLine(line)).toEqual({ display: 'Read foo.ts', raw: null })
  })

  it('원문이 비어 있으면 태그 없이 축약 그대로', () => {
    const line = encodeToolLine('tool', '')
    expect(line).toBe('tool')
    expect(decodeToolLine(line)).toEqual({ display: 'tool', raw: null })
  })

  it('원문이 축약과 다르면(잘림) 인코딩되고 왕복 복원된다', () => {
    const raw = '$ git commit -m "매우 긴 커밋 메시지 원문 보존 테스트"'
    const display = '$ git commit -m "매우 긴...'
    const line = encodeToolLine(display, raw)
    expect(line).not.toBe(display) // 태그가 붙어 원본 축약과 달라짐
    expect(line.startsWith(display)).toBe(true) // 축약이 접두사로 보존
    expect(decodeToolLine(line)).toEqual({ display, raw })
  })

  it('원문은 max자로 잘려 저장된다(기본 512)', () => {
    const raw = 'x'.repeat(1000)
    const line = encodeToolLine('display', raw)
    const { raw: decoded } = decodeToolLine(line)
    expect(decoded).toHaveLength(512)
  })

  it('max 커스텀 지정', () => {
    const raw = 'y'.repeat(100)
    const line = encodeToolLine('display', raw, 10)
    expect(decodeToolLine(line).raw).toHaveLength(10)
  })

  it('원문 앞뒤 공백은 trim 후 비교·저장된다', () => {
    const line = encodeToolLine('display', '  display  ')
    // trim 후 display와 동일 → 태그 생략
    expect(line).toBe('display')
  })

  it('태그 없는 일반 텍스트는 raw=null, display=원문 그대로', () => {
    expect(decodeToolLine('그냥 평범한 메시지')).toEqual({ display: '그냥 평범한 메시지', raw: null })
  })

  it('원문에 개행이 있어도 그대로 보존된다', () => {
    const raw = 'line1\nline2\nline3'
    const line = encodeToolLine('요약', raw)
    expect(decodeToolLine(line).raw).toBe(raw)
  })

  it('display가 도구명 접두사 + 원문 형태(Read/Write 케이스)면 잘림 없음으로 판정해 생략', () => {
    // manager.ts formatToolUse의 Read/Write/Edit — 파일 경로는 자르지 않으므로 원문 저장 불필요.
    const line = encodeToolLine('Write src/main/foo.ts', 'src/main/foo.ts')
    expect(decodeToolLine(line)).toEqual({ display: 'Write src/main/foo.ts', raw: null })
  })

  it('짧은 명령이라도 display에 잘림 표시(슬라이스)가 있으면 원문을 보존한다', () => {
    // Bash 케이스 — display가 `$ ${cmd.slice(0,160)}`라 raw(cmd 원문)를 그대로 포함하지 않는 형태만 아니면 됨.
    // 여기선 명시적으로 display가 raw와 다른 문자열인 경우를 확인.
    const raw = 'echo hello'
    const line = encodeToolLine('$ 다른 표시', raw)
    expect(decodeToolLine(line)).toEqual({ display: '$ 다른 표시', raw })
  })
})
