// #12 — collectStatus 예외 격리 회귀 고정: 호출부 4곳(index/ipc/scheduler/telegram)이 전부
// Promise.all로 일괄 수집하므로, 한 프로젝트의 예외(saveStatus DB 오류 등)가 reject로 새면
// 스캔 사이클 전체(자동착수·알림 포함)가 통째로 죽는다 — 함수 안에서 흡수하는지 검증.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'
import type { Project } from '../../src/shared/types'

const { saveStatusMock } = vi.hoisted(() => ({ saveStatusMock: vi.fn() }))
vi.mock('../../src/main/store', () => ({ saveStatus: saveStatusMock }))

import { collectStatus } from '../../src/main/collectors'

// 비git 프로젝트 — git 서브프로세스 없이 순수 경로로 saveStatus까지 도달(결정론).
const proj = (id: string): Project => ({
  id,
  path: os.tmpdir(),
  name: id,
  stack: null,
  isGit: false,
  verifyCmd: null,
})

beforeEach(() => {
  saveStatusMock.mockReset()
})

describe('collectStatus — 개별 프로젝트 예외 격리(#12)', () => {
  it('saveStatus가 throw해도 reject하지 않는다(fail-fast 차단)', async () => {
    saveStatusMock.mockImplementation(() => {
      throw new Error('database disk image is malformed')
    })
    await expect(collectStatus(proj('p1'))).resolves.toBeUndefined()
  })

  it('한 프로젝트 실패가 Promise.all 일괄 수집을 죽이지 않는다 — 나머지는 저장 완료', async () => {
    saveStatusMock.mockImplementationOnce(() => {
      throw new Error('DB 오류')
    })
    await expect(
      Promise.all([collectStatus(proj('p1')), collectStatus(proj('p2'))]),
    ).resolves.toBeDefined()
    expect(saveStatusMock).toHaveBeenCalledTimes(2) // 둘 다 saveStatus까지 도달(첫 건만 실패)
  })

  it('정상 경로는 기존 계약 그대로 저장한다(비git 기본값 패치)', async () => {
    await collectStatus(proj('p3'))
    expect(saveStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p3', gitBranch: null, dirtyFiles: 0, todoCount: 0 }),
    )
  })
})
