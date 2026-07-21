// 감시 루프(watcher) 자동 재시작 카운터 회귀 테스트.
// - 크래시 루프 방지: 비정상 종료 5회 초과 시 자동 재시작을 포기한다(무한 스핀 금지).
// - 소진 후 부활: 카운터가 소진된 뒤 외부(감시 토글 등)에서 다시 startWatcher가 불리면
//   '신규 기동'이므로 카운터가 리셋돼, 그 세션은 다시 정상적으로 자동 재시작 회복력을 가져야 한다.
//   (버그: startWatcher가 restartCount를 리셋하지 않아, 소진 후 재기동한 건강한 세션이 단 1번의
//    크래시에도 영구 정지했다.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const { DATA_DIR } = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const ph = require('node:path') as typeof import('node:path')
  const osh = require('node:os') as typeof import('node:os')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(osh.tmpdir(), 'lain-watcher-')) }
})

// spawn 모킹 — 제어 가능한 fake ChildProcess를 반환하고 생성 순서대로 모은다.
const spawned: any[] = []
function makeProc(): any {
  const proc: any = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stdout.setEncoding = () => {}
  proc.stderr = new EventEmitter()
  proc.stderr.setEncoding = () => {}
  proc.kill = () => {}
  return proc
}
vi.mock('node:child_process', () => ({
  spawn: () => {
    const p = makeProc()
    spawned.push(p)
    return p
  },
}))

vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: '',
  CLAUDE_BIN: 'claude',
}))
vi.mock('../../src/main/store', () => ({
  getSettings: () => ({
    monitorPollMs: 1500,
    monitorSensitiveApps: [],
    monitorCooldownSec: 30,
    chattiness: 3,
  }),
}))
vi.mock('../../src/main/quips', () => ({ overlayCooldownScale: () => 1 }))
vi.mock('../../src/main/logfile', () => ({ appendCapped: () => {} }))
vi.mock('electron', () => ({
  powerMonitor: { getSystemIdleTime: () => 0 },
  desktopCapturer: { getSources: async () => [] },
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
}))

import { startWatcher, stopWatcher } from '../../src/main/watcher'

// 마지막 spawn된 자식을 비정상 종료(code=1)시키고, 5초 백오프를 지나 자동 재시작을 유도한다.
function crashOnce(): void {
  const p = spawned[spawned.length - 1]
  p.emit('exit', 1)
  vi.advanceTimersByTime(5000)
}

describe('watcher 자동 재시작 카운터', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopWatcher() // 이전 테스트 잔여 상태 리셋(restartCount=0, psProc=null)
    spawned.length = 0
  })
  afterEach(() => {
    stopWatcher()
    vi.useRealTimers()
  })

  it('비정상 종료 5회 초과 시 자동 재시작을 포기한다(크래시 루프 방지)', () => {
    startWatcher() // spawn #1
    // 6번 크래시: #1→#6까지 재시작(5회 재시작 후 6번째 종료에선 포기).
    for (let i = 0; i < 6; i++) crashOnce()
    expect(spawned.length).toBe(6)
    // 추가 시간이 흘러도 더는 재시작 없음.
    vi.advanceTimersByTime(60_000)
    expect(spawned.length).toBe(6)
  })

  it('카운터 소진 후 외부 재기동은 카운터를 리셋해 회복력을 되살린다', () => {
    startWatcher()
    for (let i = 0; i < 6; i++) crashOnce() // 소진: spawn 6개, restartCount=5
    const afterExhaust = spawned.length
    expect(afterExhaust).toBe(6)

    // 외부(감시 토글/오버레이 재평가)에서 stopWatcher 없이 직접 재기동 — psProc은 null 상태.
    startWatcher()
    const afterExternal = spawned.length
    expect(afterExternal).toBe(afterExhaust + 1) // 즉시 1개 spawn

    // 재기동 직후 단 1회 크래시 → 카운터가 리셋됐다면 다시 자동 재시작(새 spawn)돼야 한다.
    // 리셋되지 않으면(버그) restartCount=5라 이 크래시에서 곧장 포기해 spawn이 늘지 않는다.
    crashOnce()
    expect(spawned.length).toBe(afterExternal + 1)
  })
})
