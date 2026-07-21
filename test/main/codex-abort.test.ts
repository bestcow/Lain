import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

// #3 codex abort 경합 — runCodexNavi가 자식을 spawn한 직후 addEventListener('abort')로 kill을 건다.
// 그런데 그 시점에 signal이 이미 abort 상태면 'abort' 이벤트는 이미 발화가 끝나 late listener가 다시 불리지
// 않아 자식이 고아로 남는다. 이 테스트는 child_process를 목으로 세워 그 고아 상황을 재현한다.

// 자식 프로세스 목 — pid·stdin·stderr·stdout(실스트림)을 갖추고, 다음 틱에 close(0)로 await를 푼다.
const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(() => ({ status: 0, stdout: '' })),
}))
vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }))
// fs.existsSync는 codexStatus(설치·로그인)·codexJs(env 경로)를 항상 통과시키게 true 고정.
vi.mock('node:fs', () => ({ default: { existsSync: () => true }, existsSync: () => true }))
vi.mock('../../src/main/store', () => ({
  addTaskEvent: vi.fn(),
  updateTask: vi.fn(),
  getProject: vi.fn(() => ({ id: 'x', path: 'C:\\x', verifyCmd: null })),
}))
vi.mock('../../src/main/worker', () => ({ parseReport: vi.fn(() => null) }))
vi.mock('../../src/main/conventions', () => ({ conventionsBlock: () => '' }))

import { runCodexNavi } from '../../src/main/codex'
import type { Task } from '../../src/shared/types'

const CHILD_PID = 4242
function makeChild(): any {
  const child: any = new EventEmitter()
  child.pid = CHILD_PID
  child.stdin = { write: vi.fn(), end: vi.fn() }
  child.stderr = new EventEmitter()
  const out = new PassThrough()
  child.stdout = out
  // 스트림을 비우고 종료 → readline은 라인 없이 닫힘, 다음 틱에 close(0)로 await 해제.
  setImmediate(() => {
    out.end()
    child.emit('close', 0)
  })
  return child
}

const task = {
  id: 'cx1',
  projectId: 'x',
  content: '작업',
  branch: 'lain/cx1',
  worktreePath: require('node:os').tmpdir(),
  tokens: 0,
  turns: 0,
  naviSessionId: '',
} as unknown as Task

beforeAll(() => {
  process.env.LAIN_CODEX_JS = 'C:\\fake\\codex.js' // fs.existsSync 목이 true라 codexJs가 이 경로를 반환
})
afterAll(() => {
  delete process.env.LAIN_CODEX_JS
})

describe('runCodexNavi — 이미 abort된 signal의 자식 고아 방지(#3)', () => {
  it('spawn 전 이미 abort된 signal이면 자식을 즉시 트리 종료(taskkill)한다', async () => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeChild())
    spawnSyncMock.mockClear()

    const ac = new AbortController()
    ac.abort() // ★ spawn 이전에 이미 abort — 'abort' 이벤트는 late listener를 부르지 않는다.

    const report = await runCodexNavi(task, () => {}, {}, ac.signal)

    // ★ 자식이 killTree(taskkill /pid <pid> /T /F)로 정리됐다 — 수정 전엔 호출되지 않아 고아로 남는다.
    const killed = spawnSyncMock.mock.calls.some(
      (c) =>
        c[0] === 'taskkill' &&
        Array.isArray(c[1]) &&
        c[1].includes('/pid') &&
        c[1].includes(String(CHILD_PID)),
    )
    expect(killed).toBe(true)
    // abort 경로는 부분 보고로 정상 반환한다(throw 아님).
    expect(report.status).toBe('done')
  })
})
