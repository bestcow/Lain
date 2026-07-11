import { describe, it, expect, vi } from 'vitest'

// codex.ts의 순수 부분(mapCodexLine·codexPrompt)만 검증 — 배관 의존은 mock.
vi.mock('../../src/main/store', () => ({
  addTaskEvent: vi.fn(),
  updateTask: vi.fn(),
  getProject: vi.fn(() => ({ id: 'x', path: 'C:\\x', verifyCmd: 'npm test' })),
}))
vi.mock('../../src/main/worker', () => ({ parseReport: vi.fn(() => null) }))
vi.mock('../../src/main/conventions', () => ({ conventionsBlock: () => '' }))

import { mapCodexLine, codexPrompt } from '../../src/main/codex'
import type { Task } from '../../src/shared/types'

// 실측 codex-cli 0.142.5 JSONL (2026-07-05) — 이 라인들이 계약. 버전업으로 깨지면 여기서 감지.
describe('mapCodexLine — codex exec --json 이벤트 매핑', () => {
  it('thread.started → 세션 id(재개용)', () => {
    expect(
      mapCodexLine('{"type":"thread.started","thread_id":"019f2ff9-70cf-75c0-bf20-4bb9066266a5"}'),
    ).toEqual({ kind: 'thread', threadId: '019f2ff9-70cf-75c0-bf20-4bb9066266a5' })
  })

  it('agent_message → text 이벤트(마지막 것이 보고 후보)', () => {
    expect(
      mapCodexLine('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"2"}}'),
    ).toEqual({ kind: 'text', text: '2' })
  })

  // D12 — command_execution은 감사 가시 이벤트(kind:'exec')로. 승인 큐 없는 codex의 유일한 관측창이라
  // generic status와 구분한다. 성공은 '→ OK', 실패는 '→ exit N'(렌더러가 후자를 경고색으로 부각).
  it('command_execution 완료 → exec 감사 이벤트(성공 OK)', () => {
    const m = mapCodexLine(
      '{"type":"item.completed","item":{"id":"item_8","type":"command_execution","command":"powershell -Command cat hello.txt","aggregated_output":"hi\\r\\n","exit_code":0,"status":"completed"}}',
    )
    expect(m).toEqual({ kind: 'exec', text: '$ powershell -Command cat hello.txt → OK' })
  })

  it('command_execution 실패(exit!=0) → exec 감사 이벤트(exit N)', () => {
    const fail = mapCodexLine(
      '{"type":"item.completed","item":{"type":"command_execution","command":"x","exit_code":-1,"status":"failed"}}',
    )
    expect(fail).toEqual({ kind: 'exec', text: '$ x → exit -1' })
  })

  it('file_change → 파일명 상태 라인', () => {
    const m = mapCodexLine(
      '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"C:\\\\wt\\\\hello.txt","kind":"add"}],"status":"completed"}}',
    )
    expect(m).toEqual({ kind: 'status', text: '파일 변경 — add: hello.txt' })
  })

  it('turn.completed → usage 토큰(input+output)', () => {
    expect(
      mapCodexLine(
        '{"type":"turn.completed","usage":{"input_tokens":13257,"cached_input_tokens":4992,"output_tokens":56,"reasoning_output_tokens":49}}',
      ),
    ).toEqual({ kind: 'usage', tokens: 13313 })
  })

  it('item.started·turn.started·비JSON 라인은 무시', () => {
    expect(mapCodexLine('{"type":"turn.started"}')).toBeNull()
    expect(
      mapCodexLine('{"type":"item.started","item":{"type":"command_execution","command":"x","status":"in_progress"}}'),
    ).toBeNull()
    expect(mapCodexLine('Reading additional input from stdin...')).toBeNull()
  })
})

describe('codexPrompt — 보고 계약은 유지, lain MCP 도구는 언급 금지', () => {
  const task = {
    id: 't1',
    projectId: 'x',
    content: '버튼 색을 고쳐라',
    branch: 'lain/t1',
  } as unknown as Task

  it('작업 내용·브랜치·보고 JSON 계약 포함', () => {
    const p = codexPrompt(task)
    expect(p).toContain('버튼 색을 고쳐라')
    expect(p).toContain('lain/t1')
    expect(p).toContain('"status": "done" | "blocked"')
    expect(p).toContain('npm test') // verifyCmd 주입
  })

  it('codex엔 없는 도구(ask_manager 등)를 시키지 않는다', () => {
    const p = codexPrompt(task)
    expect(p).not.toContain('mcp__lain')
    expect(p).not.toContain('ask_manager')
    expect(p).toContain('질문할 수 없다')
  })
})
