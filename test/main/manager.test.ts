import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import type { ChatEvent } from '../../src/shared/types'

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(process.cwd(), 'data'),
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
  SELF_SRC_DIR: null,
}))

// store를 부분 모킹 — addMessage가 DB 손상처럼 throw하게 만들어 sendToManager의 크래시 안전성을 검증한다.
// (과거 버그: 이 DB 쓰기가 try 밖이라 throw 시 busy 영구 고착 + 종료 이벤트 미발신 → 채팅 "응답 중" 고착)
vi.mock('../../src/main/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/store')>()
  return {
    ...actual,
    ensureActiveConversation: vi.fn(() => 'conv-test'),
    addMessage: vi.fn(() => {
      throw new Error('database disk image is malformed')
    }),
    setConversationTitleIfEmpty: vi.fn(),
    touchConversation: vi.fn(),
    listProjects: vi.fn(() => []),
    needsAutoTitle: vi.fn(() => false),
  }
})

import { sendToManager, buildDigest, fastChatVerdict, summarizeToolError } from '../../src/main/manager'
import type { ProjectView, Task } from '../../src/shared/types'

// 빠른 대화 레인(②③) 판정 — 경량 응답이 답인지 vs 본체 승격인지.
describe('fastChatVerdict — 빠른 대화 답/승격 판정', () => {
  it('평범한 대화 답은 그대로 answered(escalate=false, 트림된 텍스트)', () => {
    expect(fastChatVerdict('  응, 지금 상태는 안정적이야.  ')).toEqual({
      escalate: false,
      text: '응, 지금 상태는 안정적이야.',
    })
  })
  it('<<ACT>> 포함이면 승격(행동/작업)', () => {
    expect(fastChatVerdict('<<ACT>>').escalate).toBe(true)
    expect(fastChatVerdict('그건 파일을 봐야 해 <<ACT>>').escalate).toBe(true)
  })
  it('<<CONFIRM>> 포함이면 승격(파괴적)', () => {
    expect(fastChatVerdict('<<CONFIRM>>').escalate).toBe(true)
  })
  it('빈 응답이면 승격(안전 폴백)', () => {
    expect(fastChatVerdict('   ').escalate).toBe(true)
    expect(fastChatVerdict('').escalate).toBe(true)
  })
})

describe('sendToManager — DB 손상 시 채팅이 "응답 중"에 고착되지 않는다', () => {
  it('addMessage가 throw해도 종료 이벤트(error)를 발신하고 busy를 해제한다', async () => {
    const ev1: ChatEvent[] = []
    await sendToManager('첫 메시지', (e) => ev1.push(e))
    // 종료 이벤트(error)가 나가야 렌더러가 managerBusy를 해제한다.
    expect(ev1.some((e) => e.kind === 'error')).toBe(true)

    // busy가 풀렸어야 한다 — 두 번째 호출이 'Lain이 이전 메시지를 처리 중이다' 거부에 걸리면 안 된다.
    const ev2: ChatEvent[] = []
    await sendToManager('둘째 메시지', (e) => ev2.push(e))
    const busyRejected = ev2.some(
      (e) => e.kind === 'error' && /이전 메시지를 처리 중/.test((e as { message?: string }).message ?? ''),
    )
    expect(busyRejected).toBe(false)
    // 둘째 호출도 여전히 종료 이벤트(에러)를 받아야 한다.
    expect(ev2.some((e) => e.kind === 'error')).toBe(true)
  })
})

// '숨김'(muted) 내비는 다이제스트에 [숨김] 태그로 표시 — SYSTEM_PROMPT의 '먼저 언급 금지' 규칙과 짝.
describe('buildDigest — muted [숨김] 태그', () => {
  const mkProject = (id: string, muted: boolean): ProjectView => ({
    id,
    path: `C:\\workspace\\${id}`,
    name: id,
    stack: 'node',
    isGit: true,
    verifyCmd: null,
    enabled: true,
    muted,
    status: null,
  })

  it('muted 프로젝트 줄에만 [숨김]이 붙는다(상태 미수집 포함)', () => {
    const digest = buildDigest([mkProject('visible', false), mkProject('tucked', true)])
    expect(digest).toContain('visible | 상태 미수집')
    expect(digest).toContain('tucked [숨김] | 상태 미수집')
    expect(digest).not.toContain('visible [숨김]')
  })

  // D6 — 진행 중(working) 작업이 있으면 그 turns·diffStat로 '진행중: …' 조각을 붙인다.
  const mkTask = (projectId: string, state: string, turns: number, diffStat: string | null) =>
    ({ id: `t-${projectId}`, projectId, state, turns, diffStat }) as unknown as Task

  it('working 작업의 진행 조각(진행중: N턴 · +X/-Y)을 프로젝트 줄에 붙인다', () => {
    const digest = buildDigest(
      [mkProject('visible', false)],
      [mkTask('visible', 'working', 12, ' 2 files changed, 240 insertions(+), 31 deletions(-)')],
    )
    expect(digest).toContain('진행중: 12턴 · +240/-31')
  })
  it('working 작업이 없으면 진행 조각을 붙이지 않는다', () => {
    const digest = buildDigest([mkProject('visible', false)], [mkTask('visible', 'done', 5, 'x')])
    expect(digest).not.toContain('진행중')
  })
  it('diffStat이 비면 diff 없음(이상징후 힌트)', () => {
    const digest = buildDigest([mkProject('visible', false)], [mkTask('visible', 'working', 3, null)])
    expect(digest).toContain('진행중: 3턴 · diff 없음')
  })
  it('projectId당 첫 working 작업만(중복 방지)', () => {
    const digest = buildDigest(
      [mkProject('visible', false)],
      [
        mkTask('visible', 'working', 7, ' 1 file changed, 10 insertions(+)'),
        mkTask('visible', 'working', 99, ' 1 file changed, 999 insertions(+)'),
      ],
    )
    expect(digest).toContain('진행중: 7턴 · +10/-0')
    expect(digest).not.toContain('99턴')
  })
})

// A7 — 도구 실패(tool_result is_error) 요약. 채팅 한 줄(→ ✗ ...)에 실릴 텍스트라 개행 제거·길이 상한이 핵심.
describe('summarizeToolError — 도구 실패 메시지 한 줄 축약', () => {
  it('짧은 메시지는 그대로', () => {
    expect(summarizeToolError('File not found: foo.txt')).toBe('File not found: foo.txt')
  })
  it('앞뒤 공백 트림', () => {
    expect(summarizeToolError('  boom  ')).toBe('boom')
  })
  it('개행·연속 공백을 단일 공백으로 접어 한 줄 유지', () => {
    expect(summarizeToolError('line1\nline2\n\n  line3')).toBe('line1 line2 line3')
  })
  it('200자 초과분은 잘라 말줄임(…)', () => {
    const long = 'x'.repeat(250)
    const out = summarizeToolError(long)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(201) // 200자 + '…'
  })
  it('빈 문자열/공백만 있으면 대체 문구', () => {
    expect(summarizeToolError('')).toBe('(오류 메시지 없음)')
    expect(summarizeToolError('   ')).toBe('(오류 메시지 없음)')
  })
})
