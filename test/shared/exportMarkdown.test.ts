import { describe, it, expect } from 'vitest'
import { messagesToMarkdown } from '../../src/shared/exportMarkdown'
import { encodeEditDiffLine, type EditDiffPayload } from '../../src/shared/editdiff'
import type { ChatMessage } from '../../src/shared/types'

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    scope: 'manager',
    role: 'user',
    content: '',
    createdAt: '2026-07-07T00:00:00.000Z',
    ...over,
  }
}

describe('messagesToMarkdown — A16 대화 내보내기 직렬화', () => {
  it('발신자 접두를 붙인다(User/Lain/sys> — 화면 ChatPanel과 동일)', () => {
    const md = messagesToMarkdown([
      msg({ id: 1, role: 'user', content: '안녕' }),
      msg({ id: 2, role: 'assistant', content: '안녕하세요' }),
      msg({ id: 3, role: 'tool', content: 'Read foo.ts' }),
    ])
    expect(md).toContain('**User:** 안녕')
    expect(md).toContain('**Lain:** 안녕하세요')
    expect(md).toContain('**sys>:**') // 화면 표시와 일치하는 단일 출처 SENDER_PREFIX
  })

  it('tool 라인은 인용(>)으로 눈에 덜 띄게 처리한다', () => {
    const md = messagesToMarkdown([msg({ id: 1, role: 'tool', content: 'Bash: ls' })])
    expect(md).toContain('> Bash: ls')
  })

  it('챕터가 있으면 ## 헤딩으로 구간을 연다', () => {
    const md = messagesToMarkdown([
      msg({ id: 1, role: 'user', content: '첫 메시지' }),
      msg({ id: 2, role: 'user', content: '두번째', chapter: '중요 논의' }),
    ])
    expect(md).toContain('## 중요 논의')
    expect(md.indexOf('## 중요 논의')).toBeLessThan(md.indexOf('두번째'))
  })

  it('제목을 넘기면 # 헤딩으로 문서 최상단에 온다', () => {
    const md = messagesToMarkdown([msg({ id: 1, content: '본문' })], '테스트 대화')
    expect(md.startsWith('# 테스트 대화')).toBe(true)
  })

  it('제목 없으면 # 헤딩을 생략한다', () => {
    const md = messagesToMarkdown([msg({ id: 1, content: '본문' })])
    expect(md.startsWith('#')).toBe(false)
  })

  it('빈 배열은 빈 문서(개행만)', () => {
    expect(messagesToMarkdown([])).toBe('\n')
  })

  it('음성 요약 태그(<<say:...>>)는 화면과 동일하게 제거된다', () => {
    const md = messagesToMarkdown([msg({ content: '본문입니다<<say: 요약>>' })])
    expect(md).not.toContain('<<say')
    expect(md).not.toContain('요약')
    expect(md).toContain('본문입니다')
  })

  it('도구 라인 축약+원문 인코딩은 축약(display)만 반영하고 원문은 생략한다', () => {
    const SEP = String.fromCharCode(31)
    const md = messagesToMarkdown([
      msg({ role: 'tool', content: `$ 짧은 표시${SEP}$ git commit -m "매우 긴 원문..."` }),
    ])
    expect(md).toContain('$ 짧은 표시')
    expect(md).not.toContain('매우 긴 원문')
  })

  it('본문 줄 시작의 헤딩/인용/목록 마커를 이스케이프해 문서 구조 오염을 막는다', () => {
    const md = messagesToMarkdown([msg({ content: '# 제목처럼 보이는 줄\n> 인용처럼\n- 목록처럼' })])
    expect(md).toContain('\\# 제목처럼 보이는 줄')
    expect(md).toContain('\\> 인용처럼')
    expect(md).toContain('\\- 목록처럼')
  })

  it('본문 중간의 #, > 등은 이스케이프하지 않는다(줄 시작만)', () => {
    const md = messagesToMarkdown([msg({ content: 'c# 코드와 1 > 2 비교' })])
    expect(md).toContain('c# 코드와 1 > 2 비교')
  })

  it('본문의 코드펜스(```)는 문서 전체 구조를 깨지 않도록 처리된다', () => {
    const md = messagesToMarkdown([msg({ content: '```js\nconsole.log(1)\n```' })])
    // 원본 트리플 백틱이 그대로 줄 단위로 남아있지 않아야 한다(zero-width space 삽입)
    expect(md).not.toMatch(/^```/m)
  })

  it('여러 메시지는 순서대로, 사이에 빈 줄로 구분된다', () => {
    const md = messagesToMarkdown([
      msg({ id: 1, content: '하나' }),
      msg({ id: 2, content: '둘' }),
    ])
    const lines = md.split('\n')
    expect(lines.indexOf('**User:** 하나')).toBeLessThan(lines.indexOf('**User:** 둘'))
  })

  // A4 — TodoWrite 라인(encodeTodoLine)은 화면과 동일하게 진행률+항목 목록으로 풀어 쓰고,
  // JSON 원문이 그대로 노출되면 안 된다.
  it('TodoWrite 라인은 JSON 원문 대신 진행률·항목 목록으로 풀어 쓴다', () => {
    const todos = [
      { content: '파일 읽기', status: 'completed' as const, activeForm: '읽는 중' },
      { content: '수정하기', status: 'pending' as const, activeForm: '수정 중' },
    ]
    const md = messagesToMarkdown([
      msg({ role: 'tool', content: `§todo§${JSON.stringify(todos)}` }),
    ])
    expect(md).not.toContain('§todo§')
    expect(md).not.toContain('{"content"')
    expect(md).toContain('진행 체크리스트 · 1/2')
    expect(md).toContain('파일 읽기')
    expect(md).toContain('수정하기')
  })

  // A6 — Edit/Write diff 라인(encodeEditDiffLine)도 JSON 원문 대신 사람이 읽는 diff 텍스트로 풀어 쓴다.
  it('Edit diff 라인은 JSON 원문 대신 파일경로·diff 라인으로 풀어 쓴다', () => {
    const payload: EditDiffPayload = {
      tool: 'Edit',
      filePath: 'src/foo.ts',
      lines: [
        { kind: 'del', text: 'old' },
        { kind: 'add', text: 'new' },
      ],
      truncated: false,
    }
    const md = messagesToMarkdown([msg({ role: 'tool', content: encodeEditDiffLine(payload) })])
    expect(md).not.toContain('§diff§')
    expect(md).not.toContain('"filePath"')
    expect(md).toContain('src/foo.ts')
    expect(md).toContain('old')
    expect(md).toContain('new')
  })
})
