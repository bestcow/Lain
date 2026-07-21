// #12 — sendToNavi transient 자동 재시도 회귀 고정: manager sendToManager의
// transient && !assistantSeen && attempt<MAX 백오프 패턴 이식 검증.
//   1) 529 blip 한 번이면 백오프 후 같은 세션(resume 유지)으로 재시도해 성공 — 세션 폐기 없음.
//   2) 비일시 에러는 재시도 없이 기존 동작(세션 폐기 + error)을 보존.
//   3) assistant 텍스트가 이미 나갔으면 재시도하지 않는다(중복 응답 방지).
// #7 — 성공 result에서 recordUsage로 전역 롤링 사용량(usage.ts)에 적재되는지도 고정(워커챗 소비 커버).
// 전역 SDK 스텁(query)에서 시도별 스트림을 스크립트하고, store 등은 전부 모킹(navichat.test.ts 동형).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { NaviChatEvent } from '../../src/shared/types'

const { setSdkSessionMock, sdkSession } = vi.hoisted(() => ({
  setSdkSessionMock: vi.fn(),
  sdkSession: { v: '' },
}))

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(os.tmpdir(), 'lain-navichat-retry-test'),
  CLAUDE_BIN: 'claude',
}))
vi.mock('../../src/main/store', () => ({
  activeTaskForProject: () => null,
  addNaviMessage: vi.fn(),
  bumpLessonInject: vi.fn(),
  conversationSdkSession: () => sdkSession.v,
  ensureActiveConversation: () => 'c1',
  getConversationContextTokens: () => 0,
  getConversationHandoff: () => '',
  getProject: (id: string) => ({ id, path: 'C:\\ws\\proj', name: 'proj' }),
  getSettings: () => ({
    naviModel: 'sonnet',
    naviHandoffThreshold: 0,
    concurrencyCap: 1,
    skillsEnabled: false,
    curatedPlugins: [],
    localBaseUrl: '',
    anthropicApiKey: '',
  }),
  insertApproval: () => 'ap1',
  lessonsForProject: () => [],
  listConversationDialogue: () => [],
  listProjects: () => [],
  resetConversationContextTokens: vi.fn(),
  setConversationContextTokens: vi.fn(),
  setConversationHandoff: vi.fn(),
  setConversationSdkSession: setSdkSessionMock,
  setConversationTitleIfEmpty: vi.fn(),
  touchConversation: vi.fn(),
  needsAutoTitle: () => false,
}))
vi.mock('../../src/main/mcp', () => ({ mcpServersFor: () => ({}) }))
vi.mock('../../src/main/logfile', () => ({ appendCapped: vi.fn() }))
vi.mock('../../src/main/taskimages', () => ({ toImageBlocks: () => [] }))
vi.mock('../../src/main/worker', () => ({
  RISKY: [{ kind: 'force_push', re: /push\s+--force/ }],
  // 실제 합산과 동형의 얇은 구현 — result usage에서 토큰 수를 계산(#7 recordUsage 검증용).
  sumUsageTokens: (msg: unknown) => {
    const u = (msg as { usage?: Record<string, number> })?.usage
    return u ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) : 0
  },
  waitApproval: vi.fn(),
}))
vi.mock('../../src/main/registry', () => ({ workspaceRoot: () => 'C:\\ws' }))
vi.mock('../../src/main/orchestrator', () => ({
  answerClarify: vi.fn(),
  interruptTask: () => false,
}))
vi.mock('../../src/main/notify', () => ({ notifyUser: vi.fn() }))
vi.mock('../../src/main/sysrisk', () => ({ classifySystemDestructive: () => null }))
vi.mock('../../src/main/compactgate', () => ({
  shouldCompact: () => false,
  contextOccupancyTokens: () => 0,
}))
vi.mock('../../src/main/handoff', () => ({ summarizeNaviHandoff: vi.fn(), handoffBlock: () => '' }))
vi.mock('../../src/main/skills', () => ({ skillOptions: () => ({}) }))
vi.mock('../../src/main/navisender', () => ({
  frameMessage: (_f: string, t: string) => t,
  NAVI_SENDER_LEGEND: '',
}))
vi.mock('../../src/main/conventions', () => ({ conventionsBlock: () => '' }))
vi.mock('../../src/main/lessoninject', () => ({
  NAVI_CHAT_LESSON_LIMIT: 3,
  naviChatLessonsBlock: () => '',
  shouldInjectNaviChatLessons: () => false,
}))
vi.mock('../../src/main/title', () => ({ summarizeConversationTitle: vi.fn() }))

import { sendToNavi } from '../../src/main/navichat'
import { resetUsage, recentUsageTokens } from '../../src/main/usage'

const TRANSIENT = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'

beforeEach(() => {
  vi.mocked(query).mockReset()
  setSdkSessionMock.mockReset()
  sdkSession.v = 'sess-live'
  resetUsage()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sendToNavi — transient 자동 재시도(#12)·세션 보존·recordUsage(#7)', () => {
  it('529 blip 1회면 백오프 후 같은 세션으로 재시도해 성공 — 세션 폐기 없음', async () => {
    vi.useFakeTimers()
    const captured: any[] = []
    let call = 0
    vi.mocked(query).mockImplementation(((args: any) => {
      captured.push(args)
      call++
      if (call === 1) {
        return (async function* () {
          throw new Error(TRANSIENT)
        })()
      }
      return (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '복구됨' }] },
        }
        yield {
          type: 'result',
          session_id: 'sess-live',
          usage: { input_tokens: 100, output_tokens: 23 },
          total_cost_usd: 0,
        }
      })()
    }) as any)

    const events: NaviChatEvent[] = []
    const p = sendToNavi('p1', '안녕', (e) => events.push(e))
    await vi.advanceTimersByTimeAsync(1000) // transientBackoffMs(0)
    const res = await p

    expect(res.error).toBeUndefined()
    expect(vi.mocked(query)).toHaveBeenCalledTimes(2)
    // 재시도도 같은 세션 resume — 대화 연속성 보존
    expect(captured[1].options.resume).toBe('sess-live')
    // 재시도 경로에선 세션을 절대 폐기하지 않는다(''로 초기화 없음)
    expect(setSdkSessionMock).not.toHaveBeenCalledWith('c1', '')
    // 재시도 안내 tool 이벤트 + 복구된 assistant 응답
    expect(events.some((e) => e.kind === 'tool' && /자동 재시도/.test(e.text))).toBe(true)
    expect(events.some((e) => e.kind === 'assistant' && e.text === '복구됨')).toBe(true)
    // #7 — 성공 result의 소비 토큰이 전역 롤링 사용량에 적재된다(123 = 100+23)
    expect(recentUsageTokens()).toBe(123)
  })

  it('비일시 에러는 재시도하지 않고 기존 동작(세션 폐기 + error) 보존', async () => {
    vi.mocked(query).mockImplementation((() =>
      (async function* () {
        throw new Error('Invalid authentication credentials')
      })()) as any)
    const res = await sendToNavi('p1', '안녕', () => {})
    expect(res.error).toMatch(/Invalid authentication/)
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1)
    expect(setSdkSessionMock).toHaveBeenCalledWith('c1', '')
  })

  it('assistant 텍스트가 이미 나갔으면 transient라도 재시도하지 않는다(중복 방지)', async () => {
    vi.mocked(query).mockImplementation((() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '부분 응답' }] },
        }
        throw new Error(TRANSIENT)
      })()) as any)
    const res = await sendToNavi('p1', '안녕', () => {})
    expect(res.error).toBeTruthy()
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1)
  })
})
