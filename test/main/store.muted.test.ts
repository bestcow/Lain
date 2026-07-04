import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 고정(격리).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-muted-')) }
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
  setProjectMuted,
  listProjects,
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
  id: 'tools/mutable',
  path: 'C:\\workspace\\tools\\mutable',
  name: 'mutable',
  stack: 'node',
  isGit: true,
  verifyCmd: null,
  enabled: true,
}

// 핵심 의도: '숨김'(muted)은 제거(hidden)와 달리 목록에 남는다 — 레인이 계속 관리(수집·작업)해야
// 하기 때문. 보드 표시·선제 언급만 걸러진다(렌더러 !muted 필터·briefing 제외).
describe('내비 숨김(muted) — 관리 유지 + 표시/선제언급만 억제', () => {
  it('setProjectMuted: 목록에 남되 muted 플래그만 바뀐다(왕복)', () => {
    upsertProject(proj)
    expect(listProjects().find((p) => p.id === proj.id)?.muted).toBe(false)

    setProjectMuted(proj.id, true)
    const hidden = listProjects().find((p) => p.id === proj.id)
    expect(hidden).toBeDefined() // 제거(hidden)와 달리 목록에 존재 — 레인 관리 계속
    expect(hidden!.muted).toBe(true)
    expect(hidden!.enabled).toBe(true) // 숨김이어도 감시(enabled)는 유지

    setProjectMuted(proj.id, false)
    expect(listProjects().find((p) => p.id === proj.id)?.muted).toBe(false)
  })

  it('upsertProject(스캔 재등록)는 muted를 보존 — 숨긴 내비를 되살리지 않음', () => {
    setProjectMuted(proj.id, true)
    upsertProject(proj) // 주기 스캔이 다시 upsert해도 muted는 보존돼야 함
    expect(listProjects().find((p) => p.id === proj.id)?.muted).toBe(true)
  })
})
