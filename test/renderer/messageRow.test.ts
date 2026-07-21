import { describe, it, expect } from 'vitest'
import {
  sameMessageRenderFields,
  chatRowPropsEqual,
  type ChatRowCompareProps,
} from '../../src/renderer/lib/messageRow'
import type { ChatMessage } from '../../src/shared/types'

// B4 — 메시지 행 memo 비교 함수의 순수 로직 고정. 목적: '참조 안정성에 기댄 스킵'이 실제로 성립하고
// (같은 참조/동일 내용 → true=스킵), 렌더에 영향 주는 필드가 하나라도 바뀌면 리렌더(false)되는지 회귀 방지.

const base: ChatMessage = {
  id: 1,
  scope: 'manager',
  role: 'assistant',
  content: '안녕',
  createdAt: '2026-07-07 10:00:00',
}

const chatProps = (over: Partial<ChatRowCompareProps> = {}): ChatRowCompareProps => ({
  m: base,
  query: '',
  isActiveHit: false,
  queued: false,
  sameSpeaker: false,
  onMessageContext: undefined,
  onCancelQueued: undefined,
  ...over,
})

describe('sameMessageRenderFields — 메시지 객체 렌더 동등', () => {
  it('같은 참조는 즉시 true', () => {
    expect(sameMessageRenderFields(base, base)).toBe(true)
  })

  it('참조는 다르지만 렌더 필드가 모두 같으면 true(스킵 가능)', () => {
    expect(sameMessageRenderFields(base, { ...base })).toBe(true)
  })

  it('content가 바뀌면 false(스트리밍 델타로 이어붙은 그 행만 리렌더)', () => {
    expect(sameMessageRenderFields(base, { ...base, content: '안녕하세요' })).toBe(false)
  })

  it.each([
    ['id', { id: 2 }],
    ['role', { role: 'user' as const }],
    ['chapter', { chapter: '챕터' }],
    ['origin', { origin: 'telegram' as const }],
    ['createdAt', { createdAt: '2026-07-07 11:00:00' }],
    ['scope', { scope: 'worker' as const }],
    ['projectId', { projectId: 'proj' }],
  ])('%s가 바뀌면 false', (_label, patch) => {
    expect(sameMessageRenderFields(base, { ...base, ...patch })).toBe(false)
  })

  it('첨부 개수가 다르면 false', () => {
    const withAtt = { ...base, attachments: [{ name: 'a.txt', mimeType: 'text/plain', data: 'x', isImage: false }] }
    expect(sameMessageRenderFields(base, withAtt)).toBe(false)
  })

  it('첨부 내용(name/isImage/data)이 같으면 true, 다르면 false', () => {
    const att = [{ name: 'a.txt', mimeType: 'text/plain', data: 'x', isImage: false }]
    const a = { ...base, attachments: att }
    const b = { ...base, attachments: [{ ...att[0] }] } // 다른 참조, 같은 값
    const c = { ...base, attachments: [{ ...att[0], data: 'y' }] } // data 변경
    expect(sameMessageRenderFields(a, b)).toBe(true)
    expect(sameMessageRenderFields(a, c)).toBe(false)
  })

  it('양쪽 첨부 없음(undefined)이면 true', () => {
    expect(sameMessageRenderFields({ ...base }, { ...base })).toBe(true)
  })
})

describe('chatRowPropsEqual — ChatPanel 행 memo', () => {
  it('모든 prop 동일하면 true(리렌더 스킵)', () => {
    expect(chatRowPropsEqual(chatProps(), chatProps())).toBe(true)
  })

  it.each([
    ['query', { query: '검색' }],
    ['isActiveHit', { isActiveHit: true }],
    ['queued', { queued: true }],
    ['sameSpeaker', { sameSpeaker: true }],
  ])('%s가 바뀌면 false(리렌더)', (_label, patch) => {
    expect(chatRowPropsEqual(chatProps(), chatProps(patch))).toBe(false)
  })

  it('메시지 content가 바뀌면 false', () => {
    expect(chatRowPropsEqual(chatProps(), chatProps({ m: { ...base, content: '다름' } }))).toBe(false)
  })

  it('콜백 참조가 바뀌면 false(안정화 안 되면 memo 무력임을 고정)', () => {
    const cb1 = () => {}
    const cb2 = () => {}
    expect(chatRowPropsEqual(chatProps({ onMessageContext: cb1 }), chatProps({ onMessageContext: cb1 }))).toBe(true)
    expect(chatRowPropsEqual(chatProps({ onMessageContext: cb1 }), chatProps({ onMessageContext: cb2 }))).toBe(false)
    expect(chatRowPropsEqual(chatProps({ onCancelQueued: cb1 }), chatProps({ onCancelQueued: cb2 }))).toBe(false)
  })

  it('참조가 다른 동일 메시지 객체는 스킵(스트리밍 시 안 바뀐 행)', () => {
    expect(chatRowPropsEqual(chatProps(), chatProps({ m: { ...base } }))).toBe(true)
  })

  it('projectId가 바뀌면 false(NaviChatPanel worker-avatar 색 반영)', () => {
    expect(chatRowPropsEqual(chatProps(), chatProps({ m: { ...base, projectId: 'p2' } }))).toBe(false)
  })
})
