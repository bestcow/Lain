import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// collectors.verifyInDir의 spawn 재작성 검증 — 실제 프로세스는 절대 스폰하지 않고 child_process를 목으로.
// ① 정상/실패 종료 시 반환 계약({pass, tail}) 보존, ② 타임아웃 시 prockill.killTree가 taskkill /pid /T /F로
//    트리 전체를 종료(직속 셸 자식만이 아니라 손자 고아까지)하는지.
const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  // prockill.killTree(win32)가 쓰는 taskkill. 반환 shape은 spawnSync 계약만 흉내내면 충분.
  spawnSyncMock: vi.fn(() => ({ status: 0, stdout: '' })),
}))
// execFile은 collectors 모듈 로드시 promisify(execFile)로 감싸지므로 함수여야 한다(git 헬퍼용, 이 테스트선 미호출).
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
  execFile: vi.fn(),
}))
vi.mock('../../src/main/store', () => ({ saveStatus: vi.fn() }))

import { verifyInDir } from '../../src/main/collectors'

const PID = 9999
function makeChild(): any {
  const child: any = new EventEmitter()
  child.pid = PID
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

afterEach(() => {
  vi.useRealTimers()
  spawnMock.mockReset()
  spawnSyncMock.mockClear()
})

describe('verifyInDir — spawn 기반, 반환 계약 보존', () => {
  it('정상 종료(exit 0) → pass=true, tail은 stdout 먼저+stderr', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const p = verifyInDir('npm test', 'C:\\proj')
    child.stdout.emit('data', Buffer.from('OUT-'))
    child.stderr.emit('data', Buffer.from('ERR-'))
    child.emit('close', 0)
    const r = await p

    expect(r.pass).toBe(true)
    expect(r.tail).toBe('OUT-ERR-') // (stdout + stderr) 순서 유지
    // shell:true로 명령 문자열을 셸에 넘긴다(구 exec와 동일 해석).
    expect(spawnMock).toHaveBeenCalledWith('npm test', expect.objectContaining({ shell: true, cwd: 'C:\\proj' }))
  })

  it('실패 종료(exit 1) → pass=false, 출력이 있으면 그 꼬리', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const p = verifyInDir('npm test', 'C:\\proj')
    child.stdout.emit('data', Buffer.from('boom'))
    child.emit('close', 1)
    const r = await p

    expect(r.pass).toBe(false)
    expect(r.tail).toBe('boom')
  })

  it('실패 종료 + 출력 없음 → 사유 문자열로 폴백', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const p = verifyInDir('badcmd', 'C:\\proj')
    child.emit('close', 1)
    const r = await p

    expect(r.pass).toBe(false)
    expect(r.tail).toBe('exit 1')
  })

  it('스폰 에러(error 이벤트) → pass=false', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const p = verifyInDir('npm test', 'C:\\proj')
    child.emit('error', new Error('ENOENT'))
    const r = await p

    expect(r.pass).toBe(false)
    expect(r.tail).toContain('ENOENT')
  })
})

describe('verifyInDir — 타임아웃 시 프로세스 트리 종료(고아 방지)', () => {
  it('타임아웃되면 killTree가 taskkill /pid <pid> /T /F로 호출되고 pass=false', async () => {
    vi.useFakeTimers()
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const p = verifyInDir('npm test', 'C:\\proj')
    // 종료 이벤트 없이 5분 경과 → 타임아웃 브랜치 진입.
    vi.advanceTimersByTime(5 * 60_000)
    const r = await p

    // ★ 직속 셸 자식만이 아니라 /T로 자손(node/vitest 손자)까지 강제 종료.
    const killed = spawnSyncMock.mock.calls.some(
      (c) =>
        c[0] === 'taskkill' &&
        Array.isArray(c[1]) &&
        c[1].includes('/pid') &&
        c[1].includes(String(PID)) &&
        c[1].includes('/T') &&
        c[1].includes('/F'),
    )
    expect(killed).toBe(true)
    expect(r.pass).toBe(false)
    expect(r.tail).toContain('타임아웃')
  })
})
