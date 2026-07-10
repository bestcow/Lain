import { describe, it, expect } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { shouldFoldCode, CODE_FOLD_LINES, MessageBody } from '../../src/renderer/lib/markdown'

// ReactNode 트리를 DOM 없이 구조 검사하는 헬퍼 — highlight.test.tsx와 동일한 패턴.
// MessageBody는 최상위에서 hooks를 쓰지 않으므로 일반 함수로 직접 호출 가능(CodeBlock 등
// 내부 hooks 컴포넌트는 React.createElement로 생성만 되고 실행되지 않으므로 안전).
function callMessageBody(content: string, query = ''): ReactNode {
  return (MessageBody as unknown as (props: { content: string; query?: string }) => ReactNode)({
    content,
    query,
  })
}

/** 트리에서 특정 태그(문자열 타입 또는 함수 컴포넌트 이름)를 가진 엘리먼트를 전부 수집. */
function findAll(node: ReactNode, predicate: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, predicate, out)
    return out
  }
  if (isValidElement(node)) {
    if (predicate(node)) out.push(node)
    const children = (node.props as { children?: ReactNode }).children
    if (children !== undefined) findAll(children, predicate, out)
  }
  return out
}

function tagName(el: ReactElement): string {
  if (typeof el.type === 'string') return el.type
  if (typeof el.type === 'function') return el.type.name
  return String(el.type)
}

function className(el: ReactElement): string {
  return (el.props as { className?: string }).className ?? ''
}

/** 트리를 순회하며 순수 텍스트(문자열/숫자) 노드만 이어붙여 반환 — 렌더된 "화면 텍스트"에 대응. */
function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children
    return flattenText(children)
  }
  return ''
}

describe('shouldFoldCode — A17 긴 코드블록 접기 임계', () => {
  it(`${CODE_FOLD_LINES}줄 이하는 접지 않는다`, () => {
    const code = Array.from({ length: CODE_FOLD_LINES }, (_, i) => `line ${i}`).join('\n')
    expect(shouldFoldCode(code)).toBe(false)
  })

  it(`${CODE_FOLD_LINES + 1}줄부터 접는다`, () => {
    const code = Array.from({ length: CODE_FOLD_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    expect(shouldFoldCode(code)).toBe(true)
  })

  it('짧은 한 줄 코드는 접지 않는다', () => {
    expect(shouldFoldCode('const x = 1')).toBe(false)
  })

  it('빈 문자열은 접지 않는다(1줄 취급)', () => {
    expect(shouldFoldCode('')).toBe(false)
  })

  it('커스텀 임계값을 넘겨줄 수 있다', () => {
    const code = Array.from({ length: 5 }, (_, i) => `l${i}`).join('\n')
    expect(shouldFoldCode(code, 3)).toBe(true)
    expect(shouldFoldCode(code, 10)).toBe(false)
  })
})

describe('MessageBody — A1 블록 렌더', () => {
  it('헤딩(#)이 msg-heading 클래스의 h1~h6로 렌더된다', () => {
    const tree = callMessageBody('# 제목')
    const headings = findAll(tree, (el) => tagName(el) === 'h1')
    expect(headings).toHaveLength(1)
    expect(className(headings[0])).toBe('msg-heading')
    expect(flattenText(headings[0])).toBe('제목')
  })

  it('볼드(**)가 msg-bold span으로 렌더된다', () => {
    const tree = callMessageBody('이것은 **굵게** 입니다')
    const bolds = findAll(tree, (el) => className(el) === 'msg-bold')
    expect(bolds).toHaveLength(1)
    expect(flattenText(bolds[0])).toBe('굵게')
  })

  it('이탤릭(*)이 msg-italic span으로 렌더된다', () => {
    const tree = callMessageBody('이것은 *기울임* 입니다')
    const italics = findAll(tree, (el) => className(el) === 'msg-italic')
    expect(italics).toHaveLength(1)
    expect(flattenText(italics[0])).toBe('기울임')
  })

  it('비순서 리스트가 ul>li로 렌더된다', () => {
    const tree = callMessageBody('- 항목1\n- 항목2')
    const uls = findAll(tree, (el) => tagName(el) === 'ul')
    expect(uls).toHaveLength(1)
    const lis = findAll(tree, (el) => tagName(el) === 'li')
    expect(lis.map(flattenText)).toEqual(['항목1', '항목2'])
  })

  it('순서 리스트가 ol>li로 렌더된다', () => {
    const tree = callMessageBody('1. 하나\n2. 둘')
    expect(findAll(tree, (el) => tagName(el) === 'ol')).toHaveLength(1)
  })

  it('인용(>)이 msg-quote div로 렌더된다', () => {
    const tree = callMessageBody('> 인용문')
    const quotes = findAll(tree, (el) => className(el) === 'msg-quote')
    expect(quotes).toHaveLength(1)
    expect(flattenText(quotes[0])).toBe('인용문')
  })

  it('수평선(---)이 msg-hr hr로 렌더된다', () => {
    const tree = callMessageBody('위\n\n---\n\n아래')
    expect(findAll(tree, (el) => tagName(el) === 'hr')).toHaveLength(1)
  })

  it('표가 msg-table로 렌더된다(헤더+행)', () => {
    const tree = callMessageBody('| a | b |\n|---|---|\n| 1 | 2 |')
    const tables = findAll(tree, (el) => className(el) === 'msg-table')
    expect(tables).toHaveLength(1)
    expect(findAll(tree, (el) => tagName(el) === 'th').map(flattenText)).toEqual(['a', 'b'])
    expect(findAll(tree, (el) => tagName(el) === 'td').map(flattenText)).toEqual(['1', '2'])
  })

  it('코드펜스 안의 마크다운 기호는 파싱되지 않는다(평문 그대로)', () => {
    const tree = callMessageBody('```\n# 이건 헤딩 아님\n**이것도 굵게 아님**\n```')
    expect(findAll(tree, (el) => tagName(el) === 'h1')).toHaveLength(0)
    expect(findAll(tree, (el) => className(el) === 'msg-bold')).toHaveLength(0)
    // CodeBlock 컴포넌트(함수형 엘리먼트)로만 들어가 있어야 한다.
    expect(findAll(tree, (el) => tagName(el) === 'CodeBlock')).toHaveLength(1)
  })

  it('일반 대화문(마크다운 요소 없음)은 문단 하나로 평문 렌더 — 기존 동작 보존', () => {
    const tree = callMessageBody('그냥 평범한 메시지입니다')
    expect(flattenText(tree)).toBe('그냥 평범한 메시지입니다')
  })
})

describe('MessageBody — A1 블록과 기존 기능(링크·검색 하이라이트) 공존', () => {
  it('볼드 안에 URL이 있어도 링크 토큰으로 분리된다', () => {
    const tree = callMessageBody('**https://example.com/foo 참고**')
    const links = findAll(tree, (el) => tagName(el) === 'UrlLink')
    expect(links).toHaveLength(1)
    expect((links[0].props as { url: string }).url).toBe('https://example.com/foo')
  })

  it('리스트 항목 안 검색어가 mark로 하이라이트된다', () => {
    const tree = callMessageBody('- 사과\n- 바나나', '바나나')
    const marks = findAll(tree, (el) => tagName(el) === 'mark')
    expect(marks.map(flattenText)).toEqual(['바나나'])
  })

  it('헤딩 안 검색어도 하이라이트된다', () => {
    const tree = callMessageBody('# 바나나 제목', '바나나')
    const marks = findAll(tree, (el) => tagName(el) === 'mark')
    expect(marks.map(flattenText)).toEqual(['바나나'])
  })

  it('인라인 코드는 여전히 msg-inline-code로(볼드 파싱 대상 아님)', () => {
    const tree = callMessageBody('`**not bold**` 그리고 **bold**')
    const codes = findAll(tree, (el) => className(el).includes('msg-inline-code'))
    expect(codes).toHaveLength(1)
    expect(flattenText(codes[0])).toBe('**not bold**')
    const bolds = findAll(tree, (el) => className(el) === 'msg-bold')
    expect(bolds).toHaveLength(1)
    expect(flattenText(bolds[0])).toBe('bold')
  })
})

describe('MessageBody — A8 코드블록 구문강조', () => {
  it('언어 태그(ts)가 CodeBlock에 lang prop으로 전달된다', () => {
    const tree = callMessageBody('```ts\nconst x = 1\n```')
    const blocks = findAll(tree, (el) => tagName(el) === 'CodeBlock')
    expect(blocks).toHaveLength(1)
    expect((blocks[0].props as { lang?: string; code: string }).lang).toBe('ts')
    expect((blocks[0].props as { code: string }).code).toBe('const x = 1')
  })

  it('언어 태그 없는 펜스는 lang 빈 문자열', () => {
    const tree = callMessageBody('```\nplain\n```')
    const blocks = findAll(tree, (el) => tagName(el) === 'CodeBlock')
    expect((blocks[0].props as { lang?: string }).lang).toBe('')
  })
})
