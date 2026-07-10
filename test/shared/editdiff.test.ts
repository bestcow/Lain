import { describe, it, expect } from 'vitest'
import {
  buildEditDiffLines,
  buildWriteDiffLines,
  foldDiffLines,
  encodeEditDiffLine,
  decodeEditDiffLine,
  renderEditDiffText,
  DIFF_FOLD_LINES,
  type EditDiffPayload,
} from '../../src/shared/editdiff'

describe('buildEditDiffLines — old_string/new_string → 표시용 라인 diff', () => {
  it('한 줄 변경은 문맥 없이 del/add 한 줄씩', () => {
    expect(buildEditDiffLines('foo', 'bar')).toEqual([
      { kind: 'del', text: 'foo' },
      { kind: 'add', text: 'bar' },
    ])
  })

  it('공통 앞부분은 문맥(ctx)으로 남기고 달라진 부분만 del/add', () => {
    const oldStr = 'line1\nline2\nOLD\nline4'
    const newStr = 'line1\nline2\nNEW\nline4'
    expect(buildEditDiffLines(oldStr, newStr)).toEqual([
      { kind: 'ctx', text: 'line1' },
      { kind: 'ctx', text: 'line2' },
      { kind: 'del', text: 'OLD' },
      { kind: 'add', text: 'NEW' },
      { kind: 'ctx', text: 'line4' },
    ])
  })

  it('먼 공통 문맥은 앞뒤 2줄까지만 남긴다', () => {
    const oldStr = 'a\nb\nc\nd\nOLD\ne\nf\ng\nh'
    const newStr = 'a\nb\nc\nd\nNEW\ne\nf\ng\nh'
    const lines = buildEditDiffLines(oldStr, newStr)
    expect(lines).toEqual([
      { kind: 'ctx', text: 'c' },
      { kind: 'ctx', text: 'd' },
      { kind: 'del', text: 'OLD' },
      { kind: 'add', text: 'NEW' },
      { kind: 'ctx', text: 'e' },
      { kind: 'ctx', text: 'f' },
    ])
  })

  it('완전히 새 내용으로 교체되면 전부 del 다음 전부 add', () => {
    expect(buildEditDiffLines('x\ny', 'p\nq\nr')).toEqual([
      { kind: 'del', text: 'x' },
      { kind: 'del', text: 'y' },
      { kind: 'add', text: 'p' },
      { kind: 'add', text: 'q' },
      { kind: 'add', text: 'r' },
    ])
  })

  it('동일 문자열이면 del/add 없이 문맥 한 줄만(변경 없음)', () => {
    expect(buildEditDiffLines('same', 'same')).toEqual([{ kind: 'ctx', text: 'same' }])
  })

  it('300자 넘는 긴 줄은 말줄임으로 잘린다', () => {
    const longLine = 'x'.repeat(400)
    const lines = buildEditDiffLines(longLine, 'short')
    expect(lines[0].text.length).toBe(301) // 300 + '…'
    expect(lines[0].text.endsWith('…')).toBe(true)
  })
})

describe('buildWriteDiffLines — Write content 전체를 add로', () => {
  it('여러 줄 content를 모두 add 라인으로', () => {
    expect(buildWriteDiffLines('a\nb\nc')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
      { kind: 'add', text: 'c' },
    ])
  })

  it('빈 content는 빈 줄 하나(add)', () => {
    expect(buildWriteDiffLines('')).toEqual([{ kind: 'add', text: '' }])
  })
})

describe('foldDiffLines — 큰 diff 자르기', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'add' as const, text: `L${i}` }))

  it('상한 이하는 그대로, truncated=false', () => {
    const lines = mk(10)
    expect(foldDiffLines(lines, 40)).toEqual({ lines, truncated: false })
  })

  it('상한을 넘으면 앞부분만 남기고 truncated=true', () => {
    const lines = mk(50)
    const result = foldDiffLines(lines, 40)
    expect(result.truncated).toBe(true)
    expect(result.lines).toHaveLength(40)
    expect(result.lines).toEqual(lines.slice(0, 40))
  })

  it('정확히 상한과 같으면 자르지 않는다(경계값)', () => {
    const lines = mk(DIFF_FOLD_LINES)
    expect(foldDiffLines(lines).truncated).toBe(false)
  })
})

describe('encodeEditDiffLine/decodeEditDiffLine — 왕복 인코딩', () => {
  const sample: EditDiffPayload = {
    tool: 'Edit',
    filePath: 'C:/repo/src/foo.ts',
    lines: [
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
    ],
    truncated: false,
  }

  it('인코딩·디코딩하면 원본과 같다', () => {
    const line = encodeEditDiffLine(sample)
    expect(decodeEditDiffLine(line)).toEqual(sample)
  })

  it('Write payload도 왕복된다', () => {
    const write: EditDiffPayload = { tool: 'Write', filePath: 'x.ts', lines: [], truncated: true }
    expect(decodeEditDiffLine(encodeEditDiffLine(write))).toEqual(write)
  })

  it('diff 인코딩이 아닌 일반 텍스트는 null', () => {
    expect(decodeEditDiffLine('그냥 평범한 메시지')).toBeNull()
    expect(decodeEditDiffLine('Edit foo.ts')).toBeNull()
  })

  it('접두사는 있지만 JSON이 깨졌으면 null', () => {
    expect(decodeEditDiffLine('§diff§{broken')).toBeNull()
  })

  it('tool 필드가 규격 밖이면 null', () => {
    expect(decodeEditDiffLine(JSON.stringify({ tool: 'Bash', filePath: 'x', lines: [] }))).toBeNull()
  })
})

describe('renderEditDiffText — 승인 카드용 plain 텍스트 조립', () => {
  it('Edit는 수정 문구 + 파일경로 + +/- 접두사 라인', () => {
    const payload: EditDiffPayload = {
      tool: 'Edit',
      filePath: 'src/foo.ts',
      lines: [
        { kind: 'ctx', text: 'a' },
        { kind: 'del', text: 'b' },
        { kind: 'add', text: 'c' },
      ],
      truncated: false,
    }
    const text = renderEditDiffText(payload)
    expect(text).toContain('Edit 수정: src/foo.ts')
    expect(text).toContain('  a')
    expect(text).toContain('- b')
    expect(text).toContain('+ c')
    expect(text).not.toContain('생략')
  })

  it('Write는 새로 씀 문구', () => {
    const payload: EditDiffPayload = { tool: 'Write', filePath: 'x.ts', lines: [], truncated: false }
    expect(renderEditDiffText(payload)).toContain('Write 새로 씀: x.ts')
  })

  it('truncated면 생략 안내를 덧붙인다', () => {
    const payload: EditDiffPayload = { tool: 'Edit', filePath: 'x.ts', lines: [], truncated: true }
    expect(renderEditDiffText(payload)).toContain('생략')
  })
})

// 재리뷰 #4 — un-revert 카드는 도구/경로 대신 사람이 읽는 라벨을 헤더에 쓴다. 왕복 보존 확인.
describe('EditDiffPayload.label — 카드 헤더 라벨(#4)', () => {
  it('label이 인코딩/디코딩을 왕복한다', () => {
    const p: EditDiffPayload = {
      tool: 'Write',
      filePath: '2개 파일',
      label: '↩ 복원 직전 상태 (2개 파일)',
      lines: [{ kind: 'ctx', text: 'a.txt' }],
      truncated: false,
      turnId: 'r123',
    }
    const decoded = decodeEditDiffLine(encodeEditDiffLine(p))
    expect(decoded?.label).toBe('↩ 복원 직전 상태 (2개 파일)')
    expect(decoded?.turnId).toBe('r123')
  })
  it('label 없는 구 카드는 undefined로 디코딩(하위 호환)', () => {
    const p: EditDiffPayload = { tool: 'Edit', filePath: 'x.ts', lines: [], truncated: false }
    expect(decodeEditDiffLine(encodeEditDiffLine(p))?.label).toBeUndefined()
  })
})
