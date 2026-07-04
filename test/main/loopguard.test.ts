import { describe, it, expect } from 'vitest'
import {
  isIdempotentTool,
  noProgressAction,
  extractToolResults,
  resultExitReason,
} from '../../src/main/worker'

describe('isIdempotentTool — 무진전 판정 대상 화이트리스트', () => {
  it('읽기·부작용 없는 도구만 true', () => {
    expect(isIdempotentTool('Read')).toBe(true)
    expect(isIdempotentTool('Grep')).toBe(true)
    expect(isIdempotentTool('Glob')).toBe(true)
  })
  it('부작용 도구는 false (같은 인자라도 결과가 달라질 수 있음)', () => {
    expect(isIdempotentTool('Edit')).toBe(false)
    expect(isIdempotentTool('Write')).toBe(false)
    expect(isIdempotentTool('Bash')).toBe(false)
    expect(isIdempotentTool('PowerShell')).toBe(false)
    expect(isIdempotentTool('NotebookEdit')).toBe(false)
  })
  it('미지의 도구는 false', () => {
    expect(isIdempotentTool('mcp__lain__ask_manager')).toBe(false)
    expect(isIdempotentTool('')).toBe(false)
  })
})

describe('noProgressAction — 점층 조치 경계(순수)', () => {
  const T = 5
  it('threshold 미만은 allow', () => {
    expect(noProgressAction(1, T)).toBe('allow')
    expect(noProgressAction(2, T)).toBe('allow')
    expect(noProgressAction(3, T)).toBe('allow')
  })
  it('threshold 직전 1회는 warn', () => {
    expect(noProgressAction(4, T)).toBe('warn')
  })
  it('threshold 이상은 deny', () => {
    expect(noProgressAction(5, T)).toBe('deny')
    expect(noProgressAction(6, T)).toBe('deny')
    expect(noProgressAction(99, T)).toBe('deny')
  })
  it('점층 단조성: allow → warn → deny 순서가 깨지지 않는다', () => {
    const seq = [1, 2, 3, 4, 5, 6].map((n) => noProgressAction(n, T))
    expect(seq).toEqual(['allow', 'allow', 'allow', 'warn', 'deny', 'deny'])
  })
  it('threshold=1 경계: warn 없이 바로 deny', () => {
    expect(noProgressAction(0, 1)).toBe('allow')
    expect(noProgressAction(1, 1)).toBe('deny')
    expect(noProgressAction(2, 1)).toBe('deny')
  })
  it('threshold=2: 1회 warn 후 deny', () => {
    expect(noProgressAction(1, 2)).toBe('warn')
    expect(noProgressAction(2, 2)).toBe('deny')
  })
})

describe('extractToolResults — user(tool_result) 스트림 파싱(순수)', () => {
  it('content가 블록배열일 때 tool_result만 골라 tool_use_id·결과 평탄화', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'hello' },
          { type: 'text', text: '무시됨' },
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: [
              { type: 'text', text: 'line A' },
              { type: 'text', text: 'line B' },
            ],
          },
        ],
      },
    }
    expect(extractToolResults(msg)).toEqual([
      { toolUseId: 'tu_1', result: 'hello' },
      { toolUseId: 'tu_2', result: 'line Aline B' },
    ])
  })

  it('같은 입력 → 같은 result 문자열(해시 안정성 전제)', () => {
    const mk = () => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'R' }] },
    })
    expect(extractToolResults(mk())).toEqual(extractToolResults(mk()))
  })

  it('tool_use_id 없는 tool_result는 제외', () => {
    const msg = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'no id' }] },
    }
    expect(extractToolResults(msg)).toEqual([])
  })

  it('content가 문자열·비배열이면 빈 배열(tool_result 없음)', () => {
    expect(extractToolResults({ type: 'user', message: { content: 'just text' } })).toEqual([])
    expect(extractToolResults({ type: 'user', message: {} })).toEqual([])
    expect(extractToolResults({})).toEqual([])
    expect(extractToolResults(null)).toEqual([])
    expect(extractToolResults(undefined)).toEqual([])
  })

  it('객체형 content 블록은 JSON 직렬화로 보존', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu', content: [{ type: 'image', source: { x: 1 } }] },
        ],
      },
    }
    expect(extractToolResults(msg)).toEqual([
      { toolUseId: 'tu', result: JSON.stringify({ type: 'image', source: { x: 1 } }) },
    ])
  })
})

describe('resultExitReason — SDK result subtype → ExitReason(순수)', () => {
  it('success → done', () => {
    expect(resultExitReason('success')).toBe('done')
  })
  it('error_max_turns → max_turns', () => {
    expect(resultExitReason('error_max_turns')).toBe('max_turns')
  })
  it('그 외 error_* → error', () => {
    expect(resultExitReason('error_during_execution')).toBe('error')
    expect(resultExitReason('error_max_budget_usd')).toBe('error')
    expect(resultExitReason('error_max_structured_output_retries')).toBe('error')
    expect(resultExitReason('whatever')).toBe('error')
  })
})
