import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProjectView } from '../../src/shared/types'

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(process.cwd(), 'data'),
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
  SELF_SRC_DIR: null,
}))

// 첫 실행 온보딩 테스트는 DB를 건드리지 않는다 — 다이제스트가 쓰는 조회만 비워둔다(전부 try/catch라 무해).
vi.mock('../../src/main/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/store')>()
  return { ...actual, listProjects: vi.fn(() => []), listTasks: vi.fn(() => []) }
})

import { buildDigest, validateWorkspaceRoot } from '../../src/main/manager'

const mkProject = (id: string): ProjectView => ({
  id,
  path: `C:\\workspace\\apps\\${id}`,
  name: id,
  stack: 'node',
  isGit: true,
  verifyCmd: null,
  muted: false,
  status: null,
})

// 신규 사용자(프로젝트 0개)면 레인이 먼저 워크스페이스 위치를 묻도록 지시문을 다이제스트에 얹는다.
describe('buildDigest — 첫 실행 온보딩 지시', () => {
  it('프로젝트 0개면 기존 문구 + 온보딩 지시(도구·하위폴더·환경설정)를 함께 낸다', () => {
    const digest = buildDigest([])
    expect(digest).toContain('(등록된 프로젝트 없음 — 스캔 필요)')
    expect(digest).toContain('set_workspace_root')
    expect(digest).toContain('apps/games/tools')
    expect(digest).toContain('환경설정')
  })

  // 다이제스트는 텔레그램 /status로 사용자에게 그대로 전송된다 — 레인용 지시문이 새어나가면 안 된다.
  it('onboarding:false면 프로젝트 0개여도 지시문 없이 기존 문구만 낸다', () => {
    const digest = buildDigest([], undefined, { onboarding: false })
    expect(digest).toContain('(등록된 프로젝트 없음 — 스캔 필요)')
    expect(digest).not.toContain('set_workspace_root')
    expect(digest).not.toContain('첫 실행 안내')
  })

  it('프로젝트가 하나라도 있으면 온보딩 지시가 사라진다', () => {
    const digest = buildDigest([mkProject('webapp')])
    expect(digest).toContain('webapp')
    expect(digest).not.toContain('set_workspace_root')
    expect(digest).not.toContain('첫 실행 안내')
  })
})

// 저장 전 경로 검증 — 없는 경로·파일 경로를 설정에 밀어넣지 않는다(빈 워크스페이스 재발 방지).
describe('validateWorkspaceRoot — 워크스페이스 루트 경로 검증', () => {
  it('존재하는 디렉터리는 통과하고 절대경로로 정규화한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-ws-'))
    const r = validateWorkspaceRoot(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.root).toBe(path.resolve(dir))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('따옴표로 감싼 경로·앞뒤 공백도 받아준다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-ws-'))
    const r = validateWorkspaceRoot(`  "${dir}"  `)
    expect(r.ok).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('없는 경로는 거부한다', () => {
    const r = validateWorkspaceRoot(path.join(os.tmpdir(), 'lain-no-such-dir-12345'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('존재')
  })

  it('파일 경로는 거부한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-ws-'))
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'x')
    const r = validateWorkspaceRoot(file)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('디렉터리')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('빈 경로는 거부한다', () => {
    expect(validateWorkspaceRoot('   ').ok).toBe(false)
  })

  it('상대경로는 거부한다 — 앱 cwd 기준으로 풀려 엉뚱한 루트가 저장되는 것 방지', () => {
    const r = validateWorkspaceRoot('workspace')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('절대경로')
  })
})
