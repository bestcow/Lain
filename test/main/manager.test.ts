import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import type { ChatEvent } from '../../src/shared/types'

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(process.cwd(), 'data'),
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
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

import { sendToManager } from '../../src/main/manager'

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
