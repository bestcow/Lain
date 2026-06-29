import { describe, it, expect, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'

// summarizeNaviHandoff의 SDK 호출을 모킹 — error_max_turns로 throw돼도 누적 텍스트를 살리는지 검증.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...a: unknown[]) => queryMock(...a) }))
vi.mock('../../src/main/store', () => ({ getSettings: () => ({ naviModel: 'sonnet' }) }))
vi.mock('../../src/main/paths', () => ({ CLAUDE_BIN: 'claude' }))

import {
  serializeNaviDialogue,
  handoffBlock,
  taskEventsToDialogue,
  summarizeNaviHandoff,
} from '../../src/main/handoff'
import type { ChatMessage, TaskEvent } from '../../src/shared/types'

const assistantText = (t: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
function streamOf(msgs: unknown[], throwAfter = false) {
  return (async function* () {
    for (const m of msgs) yield m
    if (throwAfter) throw new Error('Claude Code returned an error result: Reached maximum number of turns (6)')
  })()
}
let mirrorN = 0
const tmpMirror = () => path.join(os.tmpdir(), `handoff-test-${mirrorN++}.md`)

const m = (role: ChatMessage['role'], content: string): ChatMessage =>
  ({ id: 0, role, content, createdAt: '' }) as ChatMessage
const te = (kind: TaskEvent['kind'], text: string, speaker?: TaskEvent['speaker']): TaskEvent =>
  ({ taskId: 't', kind, text, speaker }) as TaskEvent

describe('serializeNaviDialogue — user/assistant 원문만, 800자 상한', () => {
  it('tool 라인 제외, 라벨 부여', () => {
    const out = serializeNaviDialogue([
      m('user', '슬림화 해줘'),
      m('tool', '· Read a.ts'),
      m('assistant', '백엔드부터 봤다'),
    ])
    expect(out).toBe('[사용자/Lain] 슬림화 해줘\n[Navi] 백엔드부터 봤다')
  })
  it('800자 초과는 절단', () => {
    const out = serializeNaviDialogue([m('user', 'x'.repeat(1000))])
    expect(out).toBe('[사용자/Lain] ' + 'x'.repeat(800))
  })
  it('빈 입력은 빈 문자열', () => {
    expect(serializeNaviDialogue([])).toBe('')
  })
})

describe('handoffBlock — 새 세션 주입 블록', () => {
  it('md 없으면 빈 문자열(주입 안 함)', () => {
    expect(handoffBlock(null)).toBe('')
    expect(handoffBlock(undefined)).toBe('')
    expect(handoffBlock('   ')).toBe('')
  })
  it('md 있으면 <handoff> 래핑 + 트레일링 개행', () => {
    const out = handoffBlock('## 지금 하던 일\n슬림화')
    expect(out).toContain('<handoff>')
    expect(out).toContain('## 지금 하던 일\n슬림화')
    expect(out).toContain('</handoff>')
    expect(out.endsWith('\n\n')).toBe(true)
  })
})

describe('taskEventsToDialogue — task_events → 핸드오프 대화(worker A)', () => {
  it('worker text=assistant, lain/user=user, 시스템 status(speaker 없음)·tool 제외', () => {
    const out = taskEventsToDialogue([
      te('text', '백엔드 슬림화 중', 'worker'),
      te('status', '세션 종료: done'), // 시스템 로그 — speaker 없음 → 제외
      te('tool', 'Read a.ts', 'worker'), // 도구 라인 → 제외
      te('status', '질문→Lain: 스키마 바꿔도 돼?', 'worker'), // ask_manager 질문
      te('status', '[사용자] 그렇게 해', 'user'), // 답변
      te('text', '   ', 'worker'), // 공백 → 제외
    ])
    expect(out).toEqual([
      { role: 'assistant', content: '백엔드 슬림화 중' },
      { role: 'assistant', content: '질문→Lain: 스키마 바꿔도 돼?' },
      { role: 'user', content: '[사용자] 그렇게 해' },
    ])
  })
})

describe('summarizeNaviHandoff — error_max_turns 내성 (worker A 스왑 신뢰성)', () => {
  const recent = [{ role: 'user' as const, content: '슬림화 진행 중' }]

  it('스트림이 error_max_turns로 throw돼도 이미 받은 핸드오프 텍스트를 살린다(null로 버리지 않음)', async () => {
    queryMock.mockReturnValue(streamOf([assistantText('## 지금 하던 일\n백엔드 슬림화')], true))
    const out = await summarizeNaviHandoff('/proj', recent, null, tmpMirror())
    expect(out).toContain('## 지금 하던 일')
  })

  it('정상 스트림이면 누적 텍스트를 반환한다', async () => {
    queryMock.mockReturnValue(streamOf([assistantText('## 지금 하던 일\n정상 완료')], false))
    const out = await summarizeNaviHandoff('/proj', recent, null, tmpMirror())
    expect(out).toContain('정상 완료')
  })

  it('abort(인터럽트) 시엔 부분 텍스트가 있어도 null — 호출부가 세션을 보존하게', async () => {
    queryMock.mockReturnValue(streamOf([assistantText('## 지금 하던 일\n부분')], false))
    const ac = new AbortController()
    ac.abort()
    const out = await summarizeNaviHandoff('/proj', recent, null, tmpMirror(), ac)
    expect(out).toBeNull()
  })

  it('빈 응답이면 null', async () => {
    queryMock.mockReturnValue(streamOf([], false))
    const out = await summarizeNaviHandoff('/proj', recent, null, tmpMirror())
    expect(out).toBeNull()
  })
})
