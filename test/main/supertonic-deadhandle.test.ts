// test/main/supertonic-deadhandle.test.ts
// 외부 IO 행/복구 버그 사냥 — Supertonic 사이드카 프로세스가 죽지 않고(exit 이벤트 없음) 그저 응답을
// 멈추면(hung), child.killed는 우리가 kill()을 부른 적 없으므로 계속 false다. ensureSupertonic()의
// "if (child && !child.killed) return PORT" 가드만 믿으면 이후 모든 TTS 호출이 죽은 핸들의 포트로
// fetch를 시도해 매번 타임아웃/hang → 사이드카가 영원히 재기동되지 않는다(dead handle). 실제 프로세스는
// 절대 안 띄우고 spawn/fetch를 전부 모킹해 재현한다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type FakeChild = EventEmitter & { stderr: EventEmitter; killed: boolean; kill: ReturnType<typeof vi.fn> }
function fakeChildProcess(): FakeChild {
  const ee = new EventEmitter() as FakeChild
  ee.stderr = new EventEmitter()
  ee.killed = false
  ee.kill = vi.fn(() => {
    ee.killed = true
    // 실제 kill()은 프로세스를 종료시키고 이후 'exit'이 오지만, dead-handle 시나리오 재현이 목적이라
    // (원래 문제는 exit이 안 오는 경우) 여기서도 exit을 쏘지 않는다 — 코드가 exit 이벤트에 의존하지 않고
    // 헬스체크만으로 dead handle을 판정하는지가 이 테스트의 핵심.
  })
  return ee
}

const spawnMock = vi.fn(() => fakeChildProcess())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

let tmpRoot: string
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-supertonic-'))
  // sidecarDir()의 fast-fail 가드(§E3, 이전 감사에서 이미 수정됨)를 통과시키려면 server.js·node_modules가
  // 실재해야 한다 — 이 테스트의 관심사(dead handle)와 무관하니 최소 골격만 만든다.
  const dir = path.join(tmpRoot, 'sidecar', 'supertonic')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.js'), '// fixture')
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
})
afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.resetModules()
})

function mockPathsAndFetch(): ReturnType<typeof vi.fn> {
  vi.doMock('../../src/main/paths', () => ({
    DATA_DIR: tmpRoot,
    PROJECT_ROOT: tmpRoot,
    AGENT_CWD: tmpRoot,
    BENCH_DIR: path.join(tmpRoot, 'bench'),
    CLAUDE_BIN: 'claude',
  }))
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('ensureSupertonic — dead handle(핸들은 안 죽었는데 응답 없는 프로세스) 복구', () => {
  it('건강한 기존 핸들은 재기동하지 않고, 무응답 핸들은 정리 후 재기동한다', async () => {
    const fetchMock = mockPathsAndFetch()
    // #1 최초 호출 — 기존 서버 없음(헬스체크 실패) → 새로 spawn.
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    // #2 두 번째 호출 — 방금 띄운 프로세스가 정상 응답(healthy) → 재사용, respawn 없음.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true }) } as any)
    // #3 세 번째 호출 — 같은 핸들이지만 이제 응답이 없음(hang) → dead handle로 판정돼야 함.
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    // #4 respawn 분기 자체의 "기존 인스턴스 재사용?" 체크 — 여전히 무응답이므로 새로 spawn.
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const { ensureSupertonic } = await import('../../src/main/supertonic-proc')

    await ensureSupertonic()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const firstChild = spawnMock.mock.results[0]!.value as FakeChild

    await ensureSupertonic() // 건강함 — 재기동 없어야 함
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(firstChild.kill).not.toHaveBeenCalled()

    // 여기서부터가 재현 지점 — 프로세스는 안 죽었지만(killed=false, exit 미발생) 응답이 없다.
    await ensureSupertonic()
    expect(firstChild.kill).toHaveBeenCalledTimes(1) // dead handle 감지 → 정리
    expect(spawnMock).toHaveBeenCalledTimes(2) // 재기동됨(버그였다면 계속 1)
  })
})
