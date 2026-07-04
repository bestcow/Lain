import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── startTask skills 테스트용 격리 세팅 ──────────────────────────────────────
// vi.hoisted: paths 모킹은 모듈 평가 전에 결정돼야 한다(store.ts top-level에서 DATA_DIR 참조).
// require()를 써야 ESM import 초기화 전에 안전하게 호출된다(store.recovery.test.ts와 동형).
const { DATA_DIR: TEST_DATA_DIR } = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const ph = require('node:path') as typeof import('node:path')
  const osh = require('node:os') as typeof import('node:os')
  const tmpDir = fsh.mkdtempSync(ph.join(osh.tmpdir(), 'lain-orch-'))
  return { DATA_DIR: tmpDir }
})

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

// worktree — 실제 git 없이 빈 응답 반환
vi.mock('../../src/main/worktree', () => ({
  createWorktree: vi.fn(() => ({ branch: 'test-branch', path: require('node:os').tmpdir(), depsWarning: null })),
  removeWorktree: vi.fn(),
  diffStat: vi.fn(() => ''),
  changedFiles: vi.fn(() => []),
  tryMerge: vi.fn(() => ({ merged: false, reason: 'mocked' })),
}))

// worker — runNavi를 절대 호출하지 않음(배경 launch 차단)
vi.mock('../../src/main/worker', () => ({
  runNavi: vi.fn(async () => ({ status: 'done', summary: '', questions: [] })),
  abortNavi: vi.fn(),
  waitApproval: vi.fn(),
  isNaviRunning: vi.fn(() => false),
}))

// notify — 시스템 알림 억제
vi.mock('../../src/main/notify', () => ({ notifyUser: vi.fn() }))

import { initStore, closeStore, upsertProject, getTask } from '../../src/main/store'
import { startTask, classifyVerifyFailure, pickTaskMode } from '../../src/main/orchestrator'

describe('pickTaskMode — 작업 모드 결정(순수)', () => {
  it('마커가 최우선', () => {
    expect(pickTaskMode('mode: interactive', 'autonomous', true, true)).toBe('interactive')
    expect(pickTaskMode('lain:autonomous', 'interactive', false, false)).toBe('autonomous')
  })
  it('pref interactive면 강제 interactive', () => {
    expect(pickTaskMode('hi', 'interactive', true, true)).toBe('interactive')
  })
  it('pref autonomous는 verifyCmd 있을 때만, 없으면 interactive 폴백', () => {
    expect(pickTaskMode('hi', 'autonomous', false, true)).toBe('autonomous')
    expect(pickTaskMode('hi', 'autonomous', false, false)).toBe('interactive')
  })
  it('pref auto는 autoGradable && verifyCmd 둘 다일 때만 autonomous', () => {
    expect(pickTaskMode('hi', 'auto', true, true)).toBe('autonomous')
    expect(pickTaskMode('hi', 'auto', true, false)).toBe('interactive')
    expect(pickTaskMode('hi', 'auto', false, true)).toBe('interactive')
  })
})

const TEST_PROJECT_ID = 'test-proj-skills'

beforeAll(() => {
  initStore()
  upsertProject({
    id: TEST_PROJECT_ID,
    path: os.tmpdir(), // tmpdir는 항상 존재
    name: 'test-proj',
    stack: '',
    verifyCmd: null,
    isGit: true,
    enabled: true,
  })
})

afterAll(() => {
  closeStore()
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('classifyVerifyFailure — verify 실패 재시도 판정(§24)', () => {
  it.each([
    ['Error: connect ECONNREFUSED 127.0.0.1:5432', '네트워크 도달 불가'],
    ['getaddrinfo ENOTFOUND registry.npmjs.org', '네트워크 도달 불가'],
    ['request to https://x failed, reason: socket hang up', '네트워크 도달 불가'],
    ['ETIMEDOUT', '네트워크 도달 불가'],
  ])('네트워크 블로커 → retryable=false: %s', (tail, reason) => {
    const r = classifyVerifyFailure(tail)
    expect(r.retryable).toBe(false)
    expect(r.reason).toBe(reason)
  })

  it.each([
    "'jest' is not recognized as an internal or external command",
    'bash: pytest: command not found',
    'tsc: not found',
  ])('명령/도구 없음 → retryable=false: %s', (tail) => {
    const r = classifyVerifyFailure(tail)
    expect(r.retryable).toBe(false)
    expect(r.reason).toBe('필요한 명령/도구 없음')
  })

  it.each([
    'Error: missing API_KEY',
    'required credential not provided',
    'environment variable DATABASE_URL is not set',
    'ENOENT: no such file .env',
  ])('환경값/시크릿 누락 → retryable=false: %s', (tail) => {
    const r = classifyVerifyFailure(tail)
    expect(r.retryable).toBe(false)
    expect(r.reason).toBe('환경값/시크릿 누락')
  })

  it.each(['EACCES: permission denied', 'operation not permitted'])(
    '권한 거부 → retryable=false: %s',
    (tail) => {
      const r = classifyVerifyFailure(tail)
      expect(r.retryable).toBe(false)
      expect(r.reason).toBe('권한 거부')
    },
  )

  it.each([
    'Tests: 2 failed, 5 passed',
    'AssertionError: expected 4 to equal 5',
    'TypeError: undefined is not a function',
    '',
  ])('일반 코드 실패 → retryable=true, kind 없음: %s', (tail) => {
    const r = classifyVerifyFailure(tail)
    expect(r.retryable).toBe(true)
    expect(r.reason).toBe('')
    expect(r.kind).toBeUndefined()
  })

  it('첫 매칭 우선 — 네트워크가 권한보다 앞', () => {
    // 둘 다 들어 있으면 배열 순서상 네트워크가 먼저.
    expect(classifyVerifyFailure('ECONNREFUSED ... permission denied').reason).toBe('네트워크 도달 불가')
  })

  it.each([
    'Error: listen EADDRINUSE: address already in use :::3000',
    'listen EADDRINUSE :::8080',
    'address already in use',
    'Error: port 5173 is already in use',
    'Timeout - Async callback was not invoked within the 5000 ms timeout',
    'thrown: "Exceeded timeout of 5000 ms for a test."',
    'Test timeout of 30000ms exceeded',
  ])('flake → retryable=true, kind=flake: %s', (tail) => {
    const r = classifyVerifyFailure(tail)
    expect(r.retryable).toBe(true)
    expect(r.reason).toBe('')
    expect(r.kind).toBe('flake')
  })

  it('flake가 환경 블로커와 겹치지 않는다 — 명령없음/네트워크/권한은 flake로 새지 않음', () => {
    // ETIMEDOUT(네트워크)·command not found·permission denied는 NON_RETRYABLE이 먼저 잡아 flake 아님.
    const net = classifyVerifyFailure('connect ETIMEDOUT 1.2.3.4:443')
    expect(net.retryable).toBe(false)
    expect(net.kind).toBeUndefined()
    const cmd = classifyVerifyFailure("'vitest' is not recognized as an internal or external command")
    expect(cmd.retryable).toBe(false)
    expect(cmd.kind).toBeUndefined()
    const perm = classifyVerifyFailure('EACCES: permission denied')
    expect(perm.retryable).toBe(false)
    expect(perm.kind).toBeUndefined()
  })

  it('일반 코드 실패는 flake로 오분류되지 않는다', () => {
    expect(classifyVerifyFailure('AssertionError: expected 4 to equal 5').kind).toBeUndefined()
  })
})

describe('startTask — skills 저장', () => {
  it('startTask가 skills를 task에 저장한다', async () => {
    const r = await startTask(TEST_PROJECT_ID, {
      content: '디버그 작업 내용',
      skills: ['systematic-debugging'],
    })
    expect(r.taskId).toBeTruthy()
    expect(getTask(r.taskId!)!.skills).toEqual(['systematic-debugging'])
  })
})
