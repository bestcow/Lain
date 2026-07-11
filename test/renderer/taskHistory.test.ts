import { describe, it, expect } from 'vitest'
import {
  TASK_STATE_LABEL,
  isFinished,
  taskDuration,
  sortTasksForHistory,
} from '../../src/renderer/lib/taskHistory'
import type { Task } from '../../src/shared/types'

// 최소 Task 스텁 — 파생 함수가 쓰는 필드만 채운다.
function mkTask(over: Partial<Task>): Task {
  return {
    id: 't1',
    projectId: 'p',
    title: 'x',
    state: 'done',
    mode: 'interactive',
    engine: 'claude',
    permissionMode: 'default',
    thinkingLevel: 'default',
    disallowedTools: [],
    content: '',
    questions: [],
    branch: null,
    worktreePath: null,
    naviSessionId: null,
    contextTokens: 0,
    handoffMd: null,
    summary: null,
    diffStat: null,
    verifyResult: null,
    costUsd: 0,
    tokens: 0,
    turns: 0,
    error: null,
    autoRetryCount: 0,
    skills: null,
    images: [],
    fastMode: false,
    modelOverride: '',
    todos: null,
    createdAt: '2026-07-07T10:00:00',
    updatedAt: '2026-07-07T10:00:00',
    ...over,
  }
}

describe('isFinished', () => {
  it('done/cancelled/error는 종결', () => {
    expect(isFinished('done')).toBe(true)
    expect(isFinished('cancelled')).toBe(true)
    expect(isFinished('error')).toBe(true)
  })
  it('진행/대기 상태는 종결 아님', () => {
    expect(isFinished('working')).toBe(false)
    expect(isFinished('review')).toBe(false)
    expect(isFinished('blocked')).toBe(false)
    expect(isFinished('ready')).toBe(false)
    expect(isFinished('clarifying')).toBe(false)
  })
})

describe('TASK_STATE_LABEL', () => {
  it('모든 상태에 라벨이 있다', () => {
    for (const s of [
      'clarifying',
      'blocked',
      'ready',
      'working',
      'review',
      'done',
      'error',
      'cancelled',
    ] as const) {
      expect(TASK_STATE_LABEL[s]).toBeTruthy()
    }
  })
})

describe('taskDuration — created→updated 경과', () => {
  it('초 단위', () => {
    expect(
      taskDuration({ createdAt: '2026-07-07T10:00:00', updatedAt: '2026-07-07T10:00:45' }),
    ).toBe('45초')
  })
  it('분 단위', () => {
    expect(
      taskDuration({ createdAt: '2026-07-07T10:00:00', updatedAt: '2026-07-07T10:12:00' }),
    ).toBe('12분')
  })
  it('시간 단위', () => {
    expect(
      taskDuration({ createdAt: '2026-07-07T10:00:00', updatedAt: '2026-07-07T13:00:00' }),
    ).toBe('3시간')
  })
  it('일 단위', () => {
    expect(
      taskDuration({ createdAt: '2026-07-06T10:00:00', updatedAt: '2026-07-08T10:00:00' }),
    ).toBe('2일')
  })
  it('updated<created(역전)면 빈 문자열', () => {
    expect(
      taskDuration({ createdAt: '2026-07-07T10:00:00', updatedAt: '2026-07-07T09:00:00' }),
    ).toBe('')
  })
  it('파싱 불가면 빈 문자열', () => {
    expect(taskDuration({ createdAt: 'nope', updatedAt: 'nope' })).toBe('')
  })
})

describe('sortTasksForHistory — created_at 역순', () => {
  it('최신이 먼저', () => {
    const tasks = [
      mkTask({ id: 'old', createdAt: '2026-07-01T10:00:00' }),
      mkTask({ id: 'new', createdAt: '2026-07-07T10:00:00' }),
      mkTask({ id: 'mid', createdAt: '2026-07-04T10:00:00' }),
    ]
    expect(sortTasksForHistory(tasks).map((t) => t.id)).toEqual(['new', 'mid', 'old'])
  })
  it('원본 배열을 변형하지 않는다(순수)', () => {
    const tasks = [
      mkTask({ id: 'a', createdAt: '2026-07-01T10:00:00' }),
      mkTask({ id: 'b', createdAt: '2026-07-07T10:00:00' }),
    ]
    const before = tasks.map((t) => t.id)
    sortTasksForHistory(tasks)
    expect(tasks.map((t) => t.id)).toEqual(before)
  })
})
