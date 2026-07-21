// A1 — Navi 직접 채팅(navichat) 보안 동등화 회귀 고정:
//   1) query 옵션에 PreToolUse 시크릿 가드(preToolUseGuard(secretDeny))가 실리는지 — acceptEdits
//      auto-allow 경로에선 canUseTool이 아예 호출되지 않아(agentopts.ts 실측) 훅이 유일한 실발동 지점.
//   2) canUseTool의 시크릿 차단이 secretDeny 공용 조각인지 — 파일 도구뿐 아니라 셸 명령 절대경로도.
//   3) outside(작업 디렉터리 밖) 판정이 포워드슬래시 절대경로(C:/...)도 잡는지(백슬래시만 잡으면 우회됨).
// 실제 SDK/DB는 안 쓴다 — 전역 SDK 스텁(test/mocks/sdk.ts)의 query()에서 옵션을 캡처하고,
// store 등 무거운 의존은 전부 모킹(briefing-timeout.test.ts와 동일 패턴).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { SECRET_DENY_MESSAGE } from '../../src/main/safety'

const { waitApprovalMock } = vi.hoisted(() => ({ waitApprovalMock: vi.fn() }))

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(os.tmpdir(), 'lain-navichat-test'),
  CLAUDE_BIN: 'claude',
}))
vi.mock('../../src/main/store', () => ({
  activeTaskForProject: () => null,
  addNaviMessage: vi.fn(),
  bumpLessonInject: vi.fn(),
  conversationSdkSession: () => '',
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
  setConversationSdkSession: vi.fn(),
  setConversationTitleIfEmpty: vi.fn(),
  touchConversation: vi.fn(),
  needsAutoTitle: () => false,
}))
vi.mock('../../src/main/mcp', () => ({ mcpServersFor: () => ({}) }))
vi.mock('../../src/main/logfile', () => ({ appendCapped: vi.fn() }))
vi.mock('../../src/main/taskimages', () => ({ toImageBlocks: () => [] }))
vi.mock('../../src/main/worker', () => ({
  RISKY: [{ kind: 'force_push', re: /push\s+--force/ }],
  sumUsageTokens: () => null,
  waitApproval: (...a: unknown[]) => waitApprovalMock(...a),
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

// sendToNavi 1턴을 돌려 query()에 실린 options를 캡처한다(스트림은 빈 제너레이터 — 즉시 종료).
async function captureOptions(): Promise<any> {
  let captured: any
  vi.mocked(query).mockImplementation(((args: any) => {
    captured = args
    return (async function* () {})()
  }) as any)
  const res = await sendToNavi('p1', '안녕', () => {})
  expect(res.error).toBeUndefined()
  return captured.options
}

beforeEach(() => {
  vi.mocked(query).mockReset()
  waitApprovalMock.mockReset()
})

describe('sendToNavi — PreToolUse 시크릿 가드 배선(A1)', () => {
  it('query 옵션에 preToolUseGuard(secretDeny) 훅이 실린다 — 비밀 파일 deny·정상 파일 통과', async () => {
    const options = await captureOptions()
    const matchers = options.hooks?.PreToolUse
    expect(matchers?.length).toBeGreaterThan(0)
    const cb = matchers[0].hooks[0]
    const call = (toolName: string, input: unknown) =>
      cb(
        {
          hook_event_name: 'PreToolUse',
          session_id: 's',
          transcript_path: 't',
          cwd: 'C:/ws/proj',
          tool_name: toolName,
          tool_input: input,
          tool_use_id: 'tu1',
        },
        'tu1',
        { signal: new AbortController().signal },
      )
    const denied = (await call('Read', { file_path: 'C:/ws/proj/.env' })) as any
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(denied.hookSpecificOutput.permissionDecisionReason).toBe(SECRET_DENY_MESSAGE)
    // 정상 파일은 빈 응답 — 허용 결정을 대신하지 않는다(과차단 방지).
    expect(await call('Read', { file_path: 'C:/ws/proj/README.md' })).toEqual({})
  })

  it('canUseTool 이중 방어도 secretDeny 공용 조각 — 파일 도구·셸 명령 절대경로 모두 deny', async () => {
    const options = await captureOptions()
    expect(await options.canUseTool('Read', { file_path: 'C:/ws/proj/.env' })).toEqual({
      behavior: 'deny',
      message: SECRET_DENY_MESSAGE,
    })
    // 셸 명령에 박힌 프로젝트 .env 절대경로 — 승인 큐가 아니라 결정론 거부(blocksSecretCommand 확대분).
    expect(await options.canUseTool('Bash', { command: 'cat C:\\ws\\proj\\.env' })).toEqual({
      behavior: 'deny',
      message: SECRET_DENY_MESSAGE,
    })
    expect(waitApprovalMock).not.toHaveBeenCalled()
    // 화이트리스트(.env.example)는 계속 통과 — ws 안 경로라 승인 큐도 안 탄다.
    expect(
      await options.canUseTool('Bash', { command: 'type C:\\ws\\proj\\.env.example' }),
    ).toMatchObject({ behavior: 'allow' })
  })
})

describe('sendToNavi — outside 판정 포워드슬래시 우회 봉쇄', () => {
  it('C:/... 절대경로도 워크스페이스 밖이면 승인 큐 → 거절 시 deny', async () => {
    waitApprovalMock.mockResolvedValue({ approved: false })
    const options = await captureOptions()
    const out = await options.canUseTool('Bash', { command: 'cat C:/other/file.txt' })
    expect(waitApprovalMock).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ behavior: 'deny' })
  })

  it('승인되면 allow로 진행', async () => {
    waitApprovalMock.mockResolvedValue({ approved: true })
    const options = await captureOptions()
    const out = await options.canUseTool('Bash', { command: 'cat C:/other/file.txt' })
    expect(waitApprovalMock).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ behavior: 'allow' })
  })

  it('워크스페이스 안 경로(백슬래시)는 승인 없이 allow — 과차단 방지', async () => {
    const options = await captureOptions()
    const out = await options.canUseTool('Bash', { command: 'type C:\\ws\\proj\\notes.md' })
    expect(waitApprovalMock).not.toHaveBeenCalled()
    expect(out).toMatchObject({ behavior: 'allow' })
  })
})
