import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 고정(격리).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-hide-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import {
  initStore,
  closeStore,
  upsertProject,
  insertLesson,
  lessonsForProject,
  hideProject,
  unhideProject,
  listProjects,
  getProject,
} from '../../src/main/store'

beforeAll(() => initStore())
afterAll(() => {
  try {
    closeStore()
  } catch {
    /* 잠금 무시 */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

const proj = {
  id: 'tools/Zenith123',
  path: 'C:\\workspace\\tools\\Zenith123',
  name: 'Zenith123',
  stack: 'node',
  isGit: true,
  verifyCmd: null,
  enabled: true,
}

// 핵심 의도: '제거'는 하드 삭제가 아니라 숨김 — 레인이 쌓은 교훈/대화가 날아가지 않아야 한다.
describe('내비 제거 = 숨김(데이터 보존)', () => {
  it('hideProject: 보드 목록에서만 빠지고 교훈은 보존, unhide로 복원', () => {
    upsertProject(proj)
    insertLesson({
      projectId: proj.id,
      taskId: '',
      scope: 'project',
      trigger: '결제 모듈',
      lesson: '쌓인 교훈 — 사라지면 안 됨',
      origin: 'user',
    })

    // 초기: 목록에 있고 교훈도 있음
    expect(listProjects().some((p) => p.id === proj.id)).toBe(true)
    expect(lessonsForProject(proj.id).some((l) => l.lesson === '쌓인 교훈 — 사라지면 안 됨')).toBe(true)

    // 제거 = 숨김: 목록에서 빠지지만 행은 존재(getProject), 교훈도 보존
    hideProject(proj.id)
    expect(listProjects().some((p) => p.id === proj.id)).toBe(false)
    expect(getProject(proj.id)).not.toBeNull()
    expect(lessonsForProject(proj.id).some((l) => l.lesson === '쌓인 교훈 — 사라지면 안 됨')).toBe(true)

    // 같은 폴더 재추가(숨김 해제) → 목록 복원 + 교훈 그대로
    unhideProject(proj.id)
    expect(listProjects().some((p) => p.id === proj.id)).toBe(true)
    expect(lessonsForProject(proj.id).some((l) => l.lesson === '쌓인 교훈 — 사라지면 안 됨')).toBe(true)
  })

  it('upsertProject(스캔 재등록)는 hidden을 보존 — 숨긴 내비를 되살리지 않음', () => {
    upsertProject(proj) // 기준 정렬: 다시 보이게(위 테스트가 unhide로 끝남)
    hideProject(proj.id)
    expect(listProjects().some((p) => p.id === proj.id)).toBe(false)
    upsertProject(proj) // 주기 스캔이 다시 upsert해도 hidden은 보존돼야 함
    expect(listProjects().some((p) => p.id === proj.id)).toBe(false)
  })
})
