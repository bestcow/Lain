import { describe, it, expect } from 'vitest'
import { parseBlocks, tokenizeInline, type Block, type InlineToken } from '../../src/renderer/lib/blocks'

describe('parseBlocks — A1 헤딩', () => {
  it('# ~ ###### 레벨을 인식한다', () => {
    expect(parseBlocks('# 제목')).toEqual([{ type: 'heading', level: 1, text: '제목' }])
    expect(parseBlocks('### 소제목')).toEqual([{ type: 'heading', level: 3, text: '소제목' }])
    expect(parseBlocks('###### h6')).toEqual([{ type: 'heading', level: 6, text: 'h6' }])
  })

  it('#뒤 공백이 없으면 헤딩이 아니다(문단으로)', () => {
    expect(parseBlocks('#해시태그')).toEqual([{ type: 'paragraph', text: '#해시태그' }])
  })
})

describe('parseBlocks — A1 수평선', () => {
  it('---, ***, ___ 를 hr로 인식한다', () => {
    expect(parseBlocks('---')).toEqual([{ type: 'hr' }])
    expect(parseBlocks('***')).toEqual([{ type: 'hr' }])
    expect(parseBlocks('___')).toEqual([{ type: 'hr' }])
  })

  it('두 글자 대시는 hr이 아니다', () => {
    expect(parseBlocks('--')).toEqual([{ type: 'paragraph', text: '--' }])
  })
})

describe('parseBlocks — A1 인용', () => {
  it('> 로 시작하는 줄을 인용으로 묶는다', () => {
    expect(parseBlocks('> 인용문')).toEqual([{ type: 'quote', text: '인용문' }])
  })

  it('연속된 > 줄은 하나의 인용 블록으로 병합', () => {
    expect(parseBlocks('> 첫줄\n> 둘째줄')).toEqual([{ type: 'quote', text: '첫줄\n둘째줄' }])
  })
})

describe('parseBlocks — A1 리스트', () => {
  it('비순서 리스트(-, *, +)를 인식한다', () => {
    expect(parseBlocks('- 항목1\n- 항목2')).toEqual([
      { type: 'list', ordered: false, items: ['항목1', '항목2'] },
    ])
    expect(parseBlocks('* a\n* b')).toEqual([{ type: 'list', ordered: false, items: ['a', 'b'] }])
  })

  it('순서 리스트(1. 2.)를 인식한다', () => {
    expect(parseBlocks('1. 하나\n2. 둘')).toEqual([{ type: 'list', ordered: true, items: ['하나', '둘'] }])
  })

  it('순서/비순서가 섞이면 다른 블록으로 분리된다', () => {
    const blocks = parseBlocks('- a\n1. b')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'list', ordered: false, items: ['a'] })
    expect(blocks[1]).toEqual({ type: 'list', ordered: true, items: ['b'] })
  })
})

describe('parseBlocks — A1 표', () => {
  it('헤더+구분줄+행을 table로 파싱한다', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |'
    expect(parseBlocks(md)).toEqual([
      { type: 'table', header: ['a', 'b'], rows: [['1', '2']] },
    ])
  })

  it('정렬 콜론(:---:)이 있어도 구분줄로 인식한다', () => {
    const md = '| a | b |\n|:---:|---:|\n| 1 | 2 |'
    expect(parseBlocks(md)).toEqual([
      { type: 'table', header: ['a', 'b'], rows: [['1', '2']] },
    ])
  })

  it('구분줄 없이 파이프만 있으면 표로 인식하지 않는다(문단)', () => {
    const blocks = parseBlocks('a | b')
    expect(blocks).toEqual([{ type: 'paragraph', text: 'a | b' }])
  })

  it('파이프 줄 다음이 파이프 없는 대시선이면 표가 아니다(오탐 방지 — 대화체 A | B / ---)', () => {
    // GFM 구분줄엔 파이프가 필수 — 채팅에 흔한 강조선(------)이 표로 오인되면 안 된다.
    const blocks = parseBlocks('옵션 A | 옵션 B\n--------')
    expect(blocks.some((b) => b.type === 'table')).toBe(false)
  })
})

describe('parseBlocks — 문단/빈줄', () => {
  it('연속 평문 줄은 하나의 문단으로 병합된다', () => {
    expect(parseBlocks('첫줄\n둘째줄')).toEqual([{ type: 'paragraph', text: '첫줄\n둘째줄' }])
  })

  it('빈 줄로 나뉜 문단은 blank 블록으로 구분된다(개행 보존용)', () => {
    const blocks = parseBlocks('문단1\n\n문단2')
    expect(blocks).toEqual([
      { type: 'paragraph', text: '문단1' },
      { type: 'blank' },
      { type: 'paragraph', text: '문단2' },
    ])
  })

  it('마크다운 요소가 전혀 없는 평범한 메시지는 문단 하나로', () => {
    const blocks = parseBlocks('그냥 평범한 메시지입니다')
    expect(blocks).toEqual([{ type: 'paragraph', text: '그냥 평범한 메시지입니다' }])
  })
})

describe('parseBlocks — 혼합', () => {
  it('헤딩 다음 문단 다음 리스트가 각각 별도 블록으로 나온다', () => {
    const md = '# 제목\n본문입니다\n- 항목1\n- 항목2'
    const blocks = parseBlocks(md)
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list'])
  })
})

function texts(tokens: InlineToken[]): Array<{ type: string; value: string }> {
  return tokens.map((t) => ({ type: t.type, value: t.value }))
}

describe('tokenizeInline — A1 굵게/이탤릭', () => {
  it('**볼드**를 인식한다', () => {
    expect(texts(tokenizeInline('**굵게**'))).toEqual([{ type: 'bold', value: '굵게' }])
  })

  it('*이탤릭*을 인식한다', () => {
    expect(texts(tokenizeInline('*기울임*'))).toEqual([{ type: 'italic', value: '기울임' }])
  })

  it('***볼드+이탤릭***을 인식한다', () => {
    expect(texts(tokenizeInline('***강조***'))).toEqual([{ type: 'bolditalic', value: '강조' }])
  })

  it('언더스코어(__, _)도 동일하게 취급한다', () => {
    expect(texts(tokenizeInline('__굵게__'))).toEqual([{ type: 'bold', value: '굵게' }])
    expect(texts(tokenizeInline('_기울임_'))).toEqual([{ type: 'italic', value: '기울임' }])
  })

  it('평문과 섞인 경우 text 토큰과 함께 분리된다', () => {
    expect(texts(tokenizeInline('앞 **굵게** 뒤'))).toEqual([
      { type: 'text', value: '앞 ' },
      { type: 'bold', value: '굵게' },
      { type: 'text', value: ' 뒤' },
    ])
  })

  it('마크업이 전혀 없으면 text 토큰 하나만 반환', () => {
    expect(texts(tokenizeInline('그냥 텍스트'))).toEqual([{ type: 'text', value: '그냥 텍스트' }])
  })
})
