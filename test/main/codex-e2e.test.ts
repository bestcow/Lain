// Codex 엔진 배관 e2e — 가짜 codex(test/fixtures/fake-codex.js)를 LAIN_CODEX_JS 심으로 물려
// 진짜 spawn/stdin/JSONL 스트리밍/종료코드/트리 종료를 전 구간 관통시킨다.
// 기존 codex.test.ts는 순수 매퍼만, codex-abort.test.ts는 목 자식만 본다 — 배관 자체(resume 인자가
// 실제로 전달되는지, 스트림이 이벤트로 흘러나오는지, abort가 자식을 실제로 죽이는지)는 여기서 검증한다.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../src/main/store', () => ({
  addTaskEvent: vi.fn(),
  updateTask: vi.fn(),
  getProject: vi.fn(() => ({ id: 'x', path: 'C:\\x', verifyCmd: 'npm test' })),
}))
vi.mock('../../src/main/worker', () => ({ parseReport: vi.fn(() => null) }))
vi.mock('../../src/main/conventions', () => ({ conventionsBlock: () => '' }))

import { runCodexNavi, codexStatus } from '../../src/main/codex'
import { updateTask } from '../../src/main/store'
import { parseReport } from '../../src/main/worker'
import type { Task, TaskEvent } from '../../src/shared/types'

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-codex.js')
let dir = '' // worktree cwd 겸 산출물 보관소
let OUT = '' // 가짜 codex가 받은 argv/stdin 덤프
let DONE = '' // 'hang' 모드가 살아남았을 때의 마커(= abort 정리 실패)
let AUTH = ''

type Dump = { argv: string[]; stdin: string; cwd: string }
function readDump(): Dump {
  return JSON.parse(fs.readFileSync(OUT, 'utf8')) as Dump
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'cx-e2e',
    projectId: 'x',
    content: '버튼 색을 고쳐라',
    branch: 'lain/cx-e2e',
    worktreePath: dir,
    tokens: 0,
    turns: 0,
    naviSessionId: '',
    ...over,
  } as unknown as Task
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-codex-e2e-'))
  OUT = path.join(dir, 'argv.json')
  DONE = path.join(dir, 'alive.marker')
  AUTH = path.join(dir, 'auth.json')
  fs.writeFileSync(AUTH, '{}', 'utf8')
  process.env.LAIN_CODEX_JS = FAKE
  process.env.LAIN_CODEX_AUTH = AUTH
  process.env.LAIN_FAKE_CODEX_OUT = OUT
  process.env.LAIN_FAKE_CODEX_DONE = DONE
})

afterAll(() => {
  delete process.env.LAIN_CODEX_JS
  delete process.env.LAIN_CODEX_AUTH
  delete process.env.LAIN_FAKE_CODEX_OUT
  delete process.env.LAIN_FAKE_CODEX_DONE
  delete process.env.LAIN_FAKE_CODEX_MODE
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(OUT, { force: true })
  fs.rmSync(DONE, { force: true })
  delete process.env.LAIN_FAKE_CODEX_MODE
  vi.mocked(updateTask).mockClear()
  vi.mocked(parseReport).mockClear()
})

describe('codexStatus — auth 경로 env 오버라이드', () => {
  it('LAIN_CODEX_AUTH가 가리키는 파일이 있으면 ok', () => {
    expect(codexStatus()).toEqual({ ok: true })
  })

  it('그 파일이 없으면 미로그인으로 막는다', () => {
    process.env.LAIN_CODEX_AUTH = path.join(dir, 'nope.json')
    const st = codexStatus()
    process.env.LAIN_CODEX_AUTH = AUTH
    expect(st.ok).toBe(false)
    expect(st.reason).toContain('codex login')
  })

  it('env 미설정이면 기존대로 홈(~/.codex/auth.json)을 본다', () => {
    delete process.env.LAIN_CODEX_AUTH
    const st = codexStatus()
    process.env.LAIN_CODEX_AUTH = AUTH
    expect(st.ok).toBe(fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json')))
  })
})

describe('runCodexNavi — 새 세션 전 구간', () => {
  it('exec 인자·stdin 프롬프트·JSONL 스트리밍·usage 누적이 전부 이어진다', async () => {
    const evs: TaskEvent[] = []
    const report = await runCodexNavi(makeTask(), (e) => evs.push(e), {}, new AbortController().signal)

    const d = readDump()
    expect(d.argv[0]).toBe('exec')
    expect(d.argv).not.toContain('resume')
    expect(d.argv).toContain('--json')
    expect(d.argv).toContain('--skip-git-repo-check')
    expect(d.argv).toContain('sandbox_mode="workspace-write"')
    expect(d.argv[d.argv.length - 1]).toBe('-') // 프롬프트는 stdin으로만
    // 자식 cwd가 worktree다(다른 경로에서 돌면 격리가 깨진다).
    expect(path.basename(d.cwd.replace(/[\\/]+$/, '')).toLowerCase()).toBe(path.basename(dir).toLowerCase())

    // stdin으로 실제 프롬프트가 들어갔다(인자 이스케이프 경로 아님).
    expect(d.stdin).toContain('버튼 색을 고쳐라')
    expect(d.stdin).toContain('lain/cx-e2e')
    expect(d.stdin).toContain('npm test')

    // thread.started → 재개용 세션 id 저장, turn.completed → 토큰·턴 누적.
    expect(vi.mocked(updateTask).mock.calls).toContainEqual(['cx-e2e', { naviSessionId: 'th-0001' }])
    expect(vi.mocked(updateTask).mock.calls).toContainEqual(['cx-e2e', { tokens: 105, turns: 1 }])

    // 스트리밍이 이벤트로 흘러나왔다 — 텍스트 2개·명령 감사 1개·파일 변경 1개.
    expect(evs.filter((e) => e.kind === 'text').map((e) => e.text)).toEqual(['먼저 살펴봤다', '끝났다'])
    expect(evs.filter((e) => e.kind === 'exec').map((e) => e.text)).toEqual(['$ npm test → OK'])
    expect(evs.some((e) => e.kind === 'status' && e.text === '파일 변경 — add: a.ts')).toBe(true)
    expect(evs.some((e) => e.kind === 'exit' && e.text === 'done')).toBe(true)

    // 보고는 마지막 agent_message로 판정한다.
    expect(vi.mocked(parseReport)).toHaveBeenCalledWith('끝났다')
    expect(report).toEqual({ status: 'done', summary: '끝났다', questions: [] })
  })
})

describe('runCodexNavi — resume 재개', () => {
  it('resume <thread_id>가 인자로 전달되고 stdin은 재개 프롬프트뿐이다', async () => {
    const evs: TaskEvent[] = []
    await runCodexNavi(
      makeTask({ naviSessionId: 'thread-abcdefgh' } as Partial<Task>),
      (e) => evs.push(e),
      { resumePrompt: '이어서 해라' },
      new AbortController().signal,
    )

    const d = readDump()
    expect(d.argv.slice(0, 3)).toEqual(['exec', 'resume', 'thread-abcdefgh'])
    expect(d.argv[d.argv.length - 1]).toBe('-')
    expect(d.stdin).toBe('이어서 해라') // 최초 프롬프트가 다시 섞이면 안 된다
    expect(evs.some((e) => e.kind === 'status' && e.text.includes('resume(thread-a'))).toBe(true)
  })
})

describe('runCodexNavi — 실패 종료', () => {
  it('보고 없이 비정상 종료하면 stderr 꼬리를 붙여 throw한다', async () => {
    process.env.LAIN_FAKE_CODEX_MODE = 'fail'
    const evs: TaskEvent[] = []
    await expect(
      runCodexNavi(makeTask(), (e) => evs.push(e), {}, new AbortController().signal),
    ).rejects.toThrow(/codex exec 실패\(코드 2\).*giving up/)
    const exit = evs.find((e) => e.kind === 'exit')
    expect((exit as unknown as { exitReason: string } | undefined)?.exitReason).toBe('error')
  })
})

describe('runCodexNavi — 실행 중 abort', () => {
  it('자식 트리를 실제로 죽이고 부분 보고로 정상 반환한다', async () => {
    process.env.LAIN_FAKE_CODEX_MODE = 'hang'
    const ac = new AbortController()
    const evs: TaskEvent[] = []
    const report = await runCodexNavi(
      makeTask(),
      (e) => {
        evs.push(e)
        if (e.kind === 'text') ac.abort() // 첫 스트리밍 텍스트를 보자마자 중단
      },
      {},
      ac.signal,
    )

    // close가 온 시점 = 자식이 끝난 시점. 자연 종료였다면 마커가 남아 있다(→ 트리 종료 실패).
    expect(fs.existsSync(DONE)).toBe(false)
    expect(report.status).toBe('done')
    expect(report.summary).toBe('먼저 살펴봤다')
    const exit = evs.find((e) => e.kind === 'exit')
    expect((exit as unknown as { exitReason: string } | undefined)?.exitReason).toBe('aborted')
  })
})
