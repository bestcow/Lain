import { describe, it, expect } from 'vitest'
import {
  parseTodoWriteInput,
  todoProgress,
  currentTodo,
  encodeTodoLine,
  decodeTodoLine,
  TODO_STATUS_ICON,
  type TodoItem,
} from '../../src/shared/todoline'

const sample: TodoItem[] = [
  { content: '파일 읽기', status: 'completed', activeForm: '파일 읽는 중' },
  { content: '수정하기', status: 'in_progress', activeForm: '수정하는 중' },
  { content: '테스트 실행', status: 'pending', activeForm: '테스트 실행하는 중' },
]

describe('parseTodoWriteInput — A4 TodoWrite input 파싱', () => {
  it('규격에 맞는 todos 배열을 그대로 파싱한다', () => {
    const input = { todos: sample }
    expect(parseTodoWriteInput(input)).toEqual(sample)
  })

  it('todos가 없거나 배열이 아니면 null', () => {
    expect(parseTodoWriteInput({})).toBeNull()
    expect(parseTodoWriteInput({ todos: 'nope' })).toBeNull()
    expect(parseTodoWriteInput(null)).toBeNull()
    expect(parseTodoWriteInput(undefined)).toBeNull()
  })

  it('빈 배열은 빈 배열로(null 아님)', () => {
    expect(parseTodoWriteInput({ todos: [] })).toEqual([])
  })

  it('status가 규격 밖 값이면 해당 항목만 제외한다', () => {
    const input = {
      todos: [
        { content: 'ok', status: 'pending', activeForm: 'ok중' },
        { content: 'bad', status: 'unknown', activeForm: 'x' },
      ],
    }
    expect(parseTodoWriteInput(input)).toEqual([{ content: 'ok', status: 'pending', activeForm: 'ok중' }])
  })

  it('content가 문자열이 아니면 해당 항목 제외', () => {
    const input = { todos: [{ content: 123, status: 'pending', activeForm: 'x' }] }
    expect(parseTodoWriteInput(input)).toEqual([])
  })

  it('activeForm 누락 시 빈 문자열로 채운다', () => {
    const input = { todos: [{ content: 'ok', status: 'pending' }] }
    expect(parseTodoWriteInput(input)).toEqual([{ content: 'ok', status: 'pending', activeForm: '' }])
  })
})

describe('todoProgress — 진행률 n/m 계산', () => {
  it('completed 개수/전체 개수를 센다', () => {
    expect(todoProgress(sample)).toEqual({ done: 1, total: 3 })
  })

  it('빈 배열은 0/0', () => {
    expect(todoProgress([])).toEqual({ done: 0, total: 0 })
  })

  it('전부 완료면 total과 done이 같다', () => {
    const all = sample.map((t) => ({ ...t, status: 'completed' as const }))
    expect(todoProgress(all)).toEqual({ done: 3, total: 3 })
  })
})

describe('currentTodo — 진행 중 항목', () => {
  it('in_progress 항목을 찾는다', () => {
    expect(currentTodo(sample)).toEqual(sample[1])
  })

  it('in_progress가 없으면 null', () => {
    const noProgress = sample.filter((t) => t.status !== 'in_progress')
    expect(currentTodo(noProgress)).toBeNull()
  })
})

describe('TODO_STATUS_ICON — 상태별 아이콘', () => {
  it('브리프 지정 아이콘(완료✓/진행▸/대기○)', () => {
    expect(TODO_STATUS_ICON.completed).toBe('✓')
    expect(TODO_STATUS_ICON.in_progress).toBe('▸')
    expect(TODO_STATUS_ICON.pending).toBe('○')
  })
})

describe('encodeTodoLine/decodeTodoLine — 왕복 인코딩', () => {
  it('todos를 인코딩·디코딩하면 원본과 같다', () => {
    const line = encodeTodoLine(sample)
    expect(decodeTodoLine(line)).toEqual(sample)
  })

  it('빈 배열도 왕복된다', () => {
    const line = encodeTodoLine([])
    expect(decodeTodoLine(line)).toEqual([])
  })

  it('todo 인코딩이 아닌 일반 텍스트는 null', () => {
    expect(decodeTodoLine('그냥 평범한 메시지')).toBeNull()
    expect(decodeTodoLine('TodoWrite: {}')).toBeNull()
  })

  it('접두사는 있지만 JSON이 깨졌으면 null', () => {
    expect(decodeTodoLine('§todo§{broken')).toBeNull()
  })
})
