import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
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
  tryMerge: vi.fn(() => ({ merged: false, reason: 'mocked' })), // ff 불가 → rebase 폴백 유도(I6 await 갭)
  rebaseWorktreeOntoMain: vi.fn(() => ({ ok: true, reason: 'rebased' })),
  revertMergeRange: vi.fn(() => ({ ok: true, reason: 'reverted' })),
}))

// collectors — verifyInDir를 제어 가능한(수동 resolve) 프라미스로 덮어 I6 동시성 await 갭을 만든다.
const { verifyDeferred } = vi.hoisted(() => ({ verifyDeferred: { resolve: (_v?: unknown) => {} } }))
vi.mock('../../src/main/collectors', () => ({
  verifyInDir: vi.fn(
    () =>
      new Promise((res) => {
        verifyDeferred.resolve = () => res({ pass: true, tail: '' })
      }),
  ),
}))

// worker — runNavi를 절대 호출하지 않음(배경 launch 차단)
vi.mock('../../src/main/worker', () => ({
  runNavi: vi.fn(async () => ({ status: 'done', summary: '', questions: [] })),
  abortNavi: vi.fn(),
  waitApproval: vi.fn(),
  isNaviRunning: vi.fn(() => false),
  isAwaitingApproval: vi.fn(() => false), // D1 — cap/held 계수용(테스트에선 held 없음)
  approvalTimeoutMs: vi.fn(() => 0),
}))

// notify — 시스템 알림 억제
vi.mock('../../src/main/notify', () => ({ notifyUser: vi.fn() }))

import {
  initStore,
  closeStore,
  upsertProject,
  insertTask,
  getTask,
  updateTask,
  activeTaskForProject,
  queuedTasks,
  saveSettings,
} from '../../src/main/store'
import {
  startTask,
  classifyVerifyFailure,
  pickTaskMode,
  nextAutoRetry,
  shouldAutoStartTask,
  shouldPauseForBudget,
  rerunTask,
  resolveReview,
  hasActiveWorkAmong,
  slotOccupyingCount,
  capRoom,
  selectQueuedToLaunch,
  drainQueue,
  interruptTask,
  cancelTask,
} from '../../src/main/orchestrator'
import { runNavi, isNaviRunning } from '../../src/main/worker'
import type { Task } from '../../src/shared/types'

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

describe('shouldAutoStartTask — D5 자동 착수 3중 게이트(순수)', () => {
  it('설정 ON + autonomous 마커 + verify_cmd 있음 → 착수', () => {
    expect(shouldAutoStartTask('mode: autonomous\n할일', true, true)).toBe(true)
    expect(shouldAutoStartTask('<!-- lain:autonomous -->', true, true)).toBe(true)
  })
  it('설정 OFF면 마커·verify_cmd가 다 있어도 착수하지 않는다', () => {
    expect(shouldAutoStartTask('mode: autonomous', false, true)).toBe(false)
  })
  it('verify_cmd 없으면 마커·설정이 다 있어도 착수하지 않는다(테스트=판사 전제)', () => {
    expect(shouldAutoStartTask('mode: autonomous', true, false)).toBe(false)
  })
  it('마커 없는 TASK.md는 설정·verify_cmd가 다 있어도 착수하지 않는다(자동판정 대상은 항상 수동)', () => {
    expect(shouldAutoStartTask('그냥 평범한 작업 지시', true, true)).toBe(false)
  })
  it('interactive 마커는 당연히 착수하지 않는다', () => {
    expect(shouldAutoStartTask('mode: interactive', true, true)).toBe(false)
  })
  it('셋 다 없으면 당연히 착수하지 않는다', () => {
    expect(shouldAutoStartTask('아무 내용', false, false)).toBe(false)
  })
})

describe('nextAutoRetry — D3 error 자동 재개 카운트·상한(순수)', () => {
  it('카운트 0(첫 실패) → 재시도, 카운트 1로 증가, 5s 백오프', () => {
    const r = nextAutoRetry(0)
    expect(r.retry).toBe(true)
    expect(r.nextCount).toBe(1)
    expect(r.backoffMs).toBe(5_000)
  })
  it('카운트 1(두 번째 실패) → 재시도, 카운트 2로 증가, 15s 백오프', () => {
    const r = nextAutoRetry(1)
    expect(r.retry).toBe(true)
    expect(r.nextCount).toBe(2)
    expect(r.backoffMs).toBe(15_000)
  })
  it('카운트 2(상한 도달) → 재시도 안 함(소진), 카운트 유지, 백오프 0', () => {
    const r = nextAutoRetry(2)
    expect(r.retry).toBe(false)
    expect(r.nextCount).toBe(2)
    expect(r.backoffMs).toBe(0)
  })
  it('상한 초과 카운트도 소진으로 판정(무한루프 방지 — 이미 넘긴 경우도 안전)', () => {
    expect(nextAutoRetry(3).retry).toBe(false)
    expect(nextAutoRetry(99).retry).toBe(false)
  })
  it('max를 낮추면(1) 첫 실패만 재시도하고 그 다음은 소진', () => {
    expect(nextAutoRetry(0, 1).retry).toBe(true)
    expect(nextAutoRetry(0, 1).nextCount).toBe(1)
    expect(nextAutoRetry(1, 1).retry).toBe(false)
  })
  it('max=0(자동재개 끔)이면 첫 실패부터 소진', () => {
    expect(nextAutoRetry(0, 0).retry).toBe(false)
  })
  it('상한까지 순차 소비 — 재시도는 정확히 max회로 제한된다', () => {
    let count = 0
    let retries = 0
    for (let i = 0; i < 10; i++) {
      const d = nextAutoRetry(count)
      if (!d.retry) break
      retries++
      count = d.nextCount
    }
    expect(retries).toBe(2) // AUTO_RETRY_MAX
    expect(count).toBe(2)
  })
})

// C1 — D4 hold(무인 승인/질문 대기) 작업을 슬롯·유휴 게이트에서 제외하는 순수 판정.
// held 작업은 state='working' 고정이지만 compute 슬롯을 안 쓰고 사람을 기다리는 중이라 활성으로 세면 안 된다.
describe('hasActiveWorkAmong — C1 held 제외(순수)', () => {
  const t = (id: string, state: Task['state']): Task =>
    ({ id, state } as unknown as Task)
  const held = new Set(['h1', 'h2'])
  const isHeld = (id: string) => held.has(id)

  it('hasActiveWorkAmong — held만 있으면 false(유휴 허용)', () => {
    expect(hasActiveWorkAmong([t('h1', 'working'), t('h2', 'working')], isHeld)).toBe(false)
  })
  it('hasActiveWorkAmong — held 아닌 working이 하나라도 있으면 true(유휴 억제)', () => {
    expect(hasActiveWorkAmong([t('h1', 'working'), t('a', 'working')], isHeld)).toBe(true)
  })
  it('hasActiveWorkAmong — working이 없으면 false(유휴)', () => {
    expect(hasActiveWorkAmong([t('a', 'review'), t('b', 'done')], isHeld)).toBe(false)
    expect(hasActiveWorkAmong([], isHeld)).toBe(false)
  })

  // C3 — idle 게이트(hasActiveWorkAmong)는 working-only(held 제외) 기준 그대로여야 한다(behavior 불변).
  // slotOccupyingCount에 clarifying을 더한 것과 별개로, clarifying만 있을 땐 여전히 유휴(false)로 판정돼야 한다.
  it('hasActiveWorkAmong — clarifying만 있으면 여전히 유휴(false) — idle 게이트 불변', () => {
    expect(hasActiveWorkAmong([t('c', 'clarifying')], isHeld)).toBe(false)
    expect(hasActiveWorkAmong([t('c1', 'clarifying'), t('c2', 'clarifying')], isHeld)).toBe(false)
    // working이 함께 있으면 clarifying 유무와 무관하게 true(기존과 동일).
    expect(hasActiveWorkAmong([t('c', 'clarifying'), t('w', 'working')], isHeld)).toBe(true)
  })
})

// C3 — cap 슬롯 점유 계수(순수). working(held 제외) + clarifying을 센다. idle 게이트와 분리된 전용 계수.
describe('slotOccupyingCount — C3 cap 슬롯 점유(순수)', () => {
  const t = (id: string, state: Task['state']): Task => ({ id, state } as unknown as Task)
  const held = new Set(['h1'])
  const isHeld = (id: string) => held.has(id)

  it('working(held 제외) + clarifying을 센다', () => {
    const tasks = [t('w', 'working'), t('c', 'clarifying'), t('h1', 'working'), t('q', 'queued'), t('r', 'review')]
    // w(working) + c(clarifying) = 2. h1은 held라 제외, queued/review는 슬롯 아님.
    expect(slotOccupyingCount(tasks, isHeld)).toBe(2)
  })
  it('clarifying만 있어도 슬롯으로 센다(idle 계수와 다른 점)', () => {
    expect(slotOccupyingCount([t('c', 'clarifying')], isHeld)).toBe(1)
  })
  it('held working은 슬롯을 안 쓴다(제외)', () => {
    expect(slotOccupyingCount([t('h1', 'working')], isHeld)).toBe(0)
  })
  it('queued/review/blocked/done은 슬롯이 아니다', () => {
    expect(
      slotOccupyingCount([t('q', 'queued'), t('r', 'review'), t('b', 'blocked'), t('d', 'done')], isHeld),
    ).toBe(0)
  })
})

// C1+I5 — 예산 게이트가 done 리포트를 막지 않는지(무한 루프 방지), blocked만 예산 초과 시 멈추는지(순수).
describe('shouldPauseForBudget — C1+I5 예산 게이트(순수)', () => {
  it('done 리포트는 예산 초과여도 pause하지 않는다(verify/review 정상 진행)', () => {
    expect(shouldPauseForBudget('done', 1_000_000, 100)).toBe(false)
    expect(shouldPauseForBudget('done', 999_999_999, 1)).toBe(false)
  })
  it('blocked 리포트는 예산 초과 시 pause한다', () => {
    expect(shouldPauseForBudget('blocked', 100, 100)).toBe(true) // 경계 포함(budgetExceeded)
    expect(shouldPauseForBudget('blocked', 101, 100)).toBe(true)
  })
  it('blocked이어도 예산 미만이면 pause하지 않는다', () => {
    expect(shouldPauseForBudget('blocked', 99, 100)).toBe(false)
  })
  it('budget off(<=0)면 blocked이어도 pause하지 않는다(기존 동작 불변)', () => {
    expect(shouldPauseForBudget('blocked', 9_999_999, 0)).toBe(false)
  })
})

// D1 — 대기 큐 순수부: cap 여유 계산 + 드레인 선택(우선순위·프로젝트 중복·cap 상한).
describe('capRoom — D1 cap 여유(순수, startTask 계수와 동일)', () => {
  const t = (id: string, state: Task['state']): Task => ({ id, state } as unknown as Task)
  const noHold = () => false
  it('cap - (held 아닌 working) 만큼 여유', () => {
    expect(capRoom([t('a', 'working'), t('b', 'working')], 3, noHold)).toBe(1)
    expect(capRoom([t('a', 'working')], 2, noHold)).toBe(1)
  })
  it('queued/review/blocked는 cap 슬롯을 안 센다(clarifying은 C3로 센다 — 아래 별도 테스트)', () => {
    // C3 이후 clarifying은 슬롯을 점유하므로, 여유 cap 전부를 확인하려면 clarifying을 빼야 한다.
    expect(capRoom([t('q', 'queued'), t('r', 'review'), t('b', 'blocked')], 2, noHold)).toBe(2)
  })
  it('C3 — clarifying(드레인이 착수 진행 중으로 올린 상태)도 cap 슬롯을 점유한다', () => {
    // 후속 드레인·startTask가 이 자리를 빈 슬롯으로 오인해 cap을 초과 착수하지 않도록.
    expect(capRoom([t('c', 'clarifying')], 2, noHold)).toBe(1)
    expect(capRoom([t('w', 'working'), t('c', 'clarifying')], 2, noHold)).toBe(0)
    expect(capRoom([t('c1', 'clarifying'), t('c2', 'clarifying')], 3, noHold)).toBe(1)
  })
  it('held(무인 대기) working은 슬롯을 안 쓰니 여유에 포함', () => {
    const held = new Set(['h'])
    expect(capRoom([t('h', 'working'), t('a', 'working')], 2, (id) => held.has(id))).toBe(1) // a만 슬롯
  })
  it('가득 차거나 초과면 0으로 클램프(음수 없음)', () => {
    expect(capRoom([t('a', 'working'), t('b', 'working')], 2, noHold)).toBe(0)
    expect(capRoom([t('a', 'working'), t('b', 'working'), t('c', 'working')], 2, noHold)).toBe(0)
  })
})

describe('selectQueuedToLaunch — D1 드레인 선택(순수)', () => {
  const q = (id: string, projectId: string) => ({ id, projectId })

  it('여유 슬롯 수만큼, 큐 순서(=priority ASC 정렬 입력)대로 착수', () => {
    const queued = [q('t1', 'pA'), q('t2', 'pB'), q('t3', 'pC')]
    expect(selectQueuedToLaunch(queued, 2, new Map())).toEqual(['t1', 't2'])
  })
  it('입력 순서를 그대로 존중한다(호출부가 priority ASC·created_at ASC로 정렬해 넘긴다)', () => {
    // 우선순위가 낮은(=먼저) 것이 앞에 온 상태로 들어온다고 가정.
    const queued = [q('high', 'pA'), q('mid', 'pB'), q('low', 'pC')]
    expect(selectQueuedToLaunch(queued, 3, new Map())).toEqual(['high', 'mid', 'low'])
  })
  it('cap이 0이면 아무것도 착수하지 않는다', () => {
    expect(selectQueuedToLaunch([q('t1', 'pA')], 0, new Map())).toEqual([])
  })
  it('이미 활성인 프로젝트의 대기 작업은 건너뛴다(기본 perProjectCap=1 — 프로젝트 중복 착수 차단)', () => {
    const queued = [q('t1', 'pA'), q('t2', 'pB')]
    expect(selectQueuedToLaunch(queued, 5, new Map([['pA', 1]]))).toEqual(['t2'])
  })
  it('같은 프로젝트가 큐에 둘이면 하나만 착수하고 나머지는 남긴다(레이스 방어)', () => {
    const queued = [q('t1', 'pA'), q('t2', 'pA'), q('t3', 'pB')]
    // room=3이지만 pA는 t1 착수 후 계수 +1로 상한 도달 → t2는 스킵 → t1, t3만.
    expect(selectQueuedToLaunch(queued, 3, new Map())).toEqual(['t1', 't3'])
  })
  it('연속 착수가 cap을 넘기지 않는다 — room을 로컬로 소진', () => {
    const queued = [q('t1', 'pA'), q('t2', 'pB'), q('t3', 'pC'), q('t4', 'pD')]
    expect(selectQueuedToLaunch(queued, 2, new Map())).toEqual(['t1', 't2'])
  })
  it('원본 activeCountByProject 맵을 변형하지 않는다(불변)', () => {
    const active = new Map([['pX', 1]])
    selectQueuedToLaunch([q('t1', 'pA')], 1, active)
    expect([...active.entries()]).toEqual([['pX', 1]])
  })
  // D14 — 프로젝트 병렬 cap
  it('perProjectCap=2면 같은 프로젝트 두 개까지 착수(활성 1 + 착수 1도 상한 계산에 포함)', () => {
    const queued = [q('t1', 'pA'), q('t2', 'pA'), q('t3', 'pA')]
    expect(selectQueuedToLaunch(queued, 5, new Map(), 2)).toEqual(['t1', 't2'])
    expect(selectQueuedToLaunch(queued, 5, new Map([['pA', 1]]), 2)).toEqual(['t1'])
    expect(selectQueuedToLaunch(queued, 5, new Map([['pA', 2]]), 2)).toEqual([])
  })
  it('perProjectCap=2여도 전역 room이 우선한다', () => {
    const queued = [q('t1', 'pA'), q('t2', 'pA'), q('t3', 'pB')]
    expect(selectQueuedToLaunch(queued, 2, new Map(), 2)).toEqual(['t1', 't2'])
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

// D12 — autonomous 거절이 하드코딩 엔진 문자열이 아니라 engineCapabilities(engine).autonomous로 일반화됐는지.
// codex는 autonomous:false라 verify_cmd가 있어도 autonomous 마커면 거절, claude는 착수한다.
describe('startTask — autonomous 미지원 엔진 거절(capability 일반화)', () => {
  const ENGINE_PROJECT_ID = 'test-proj-engine-autonomous'
  beforeAll(() => {
    upsertProject({
      id: ENGINE_PROJECT_ID,
      path: os.tmpdir(),
      name: 'engine-autonomous',
      stack: '',
      verifyCmd: 'npm test', // autonomous 전제(테스트=판사) 충족 — 그래야 엔진 capability 게이트까지 도달
      isGit: true,
    })
  })

  it('codex + autonomous 마커 → capability(autonomous:false)로 거절', async () => {
    const r = await startTask(ENGINE_PROJECT_ID, {
      content: 'mode: autonomous\n무개입 작업',
      engine: 'codex',
    })
    expect(r.taskId).toBeUndefined()
    expect(r.error).toContain('autonomous')
    expect(r.error).toContain('codex')
  })

  it('claude + autonomous 마커 → capability(autonomous:true)라 거절하지 않고 착수', async () => {
    const r = await startTask(ENGINE_PROJECT_ID, {
      content: 'mode: autonomous\n무개입 작업',
      engine: 'claude',
    })
    expect(r.error).toBeUndefined()
    expect(r.taskId).toBeTruthy()
    expect(getTask(r.taskId!)!.mode).toBe('autonomous')
    updateTask(r.taskId!, { state: 'done' }) // 정리(프로젝트 busy 해제)
  })
})

describe('rerunTask — D11 종결 작업의 content 복제 재실행', () => {
  const RERUN_PROJECT_ID = 'test-proj-rerun'
  beforeAll(() => {
    // 전용 프로젝트 — TEST_PROJECT_ID를 공유하면 앞선 describe들이 만든 task가 review/clarifying으로
    // 남아 activeTaskForProject에 걸려 startTask가 '이미 진행 중' 에러를 내는 순서 의존을 피한다.
    upsertProject({
      id: RERUN_PROJECT_ID,
      path: os.tmpdir(),
      name: 'test-proj-rerun',
      stack: '',
      verifyCmd: null,
      isGit: true,
    })
  })

  it('done 작업을 같은 content(합격 기준 포함)로 새 task를 만든다 — 원본은 보존', async () => {
    const original = await startTask(RERUN_PROJECT_ID, {
      content: '원본 작업 지시\n\n## 합격 기준 (lain elicitation §21.3 — 이걸 충족하면 완료)\n- npm test 통과',
      skipClarify: true,
    })
    expect(original.taskId).toBeTruthy()
    const origId = original.taskId!
    const origContent = getTask(origId)!.content
    updateTask(origId, { state: 'done' }) // resolveReview 없이 종결 상태만 흉내(순수 content 복제 검증 목적)

    const r = await rerunTask(origId)
    expect(r.error).toBeUndefined()
    expect(r.taskId).toBeTruthy()
    expect(r.taskId).not.toBe(origId) // 새 task — 원본과 다른 id

    const rerun = getTask(r.taskId!)!
    expect(rerun.content).toBe(origContent) // content(합격 기준 포함) 그대로 복제
    expect(getTask(origId)!.state).toBe('done') // 원본은 그대로 보존(손대지 않음)
    updateTask(r.taskId!, { state: 'done' }) // 다음 테스트가 activeTaskForProject에 안 걸리게 정리
  })

  it('cancelled 작업도 재실행할 수 있다', async () => {
    const original = await startTask(RERUN_PROJECT_ID, {
      content: '폐기됐던 작업',
      skipClarify: true,
    })
    updateTask(original.taskId!, { state: 'cancelled' })
    const r = await rerunTask(original.taskId!)
    expect(r.error).toBeUndefined()
    expect(getTask(r.taskId!)!.content).toBe('폐기됐던 작업')
    updateTask(r.taskId!, { state: 'done' }) // 다음 테스트가 activeTaskForProject에 안 걸리게 정리
  })

  it('working/review 등 종결 아닌 상태는 재실행을 거부한다', async () => {
    const original = await startTask(RERUN_PROJECT_ID, {
      content: '진행 중 작업',
      skipClarify: true,
    })
    updateTask(original.taskId!, { state: 'review' })
    const r = await rerunTask(original.taskId!)
    expect(r.error).toBeTruthy()
    expect(r.taskId).toBeUndefined()
  })

  it('존재하지 않는 task_id는 에러를 반환한다', async () => {
    const r = await rerunTask('no-such-task-id')
    expect(r.error).toBeTruthy()
  })
})

// D1 — 대기 큐 통합: activeTaskForProject의 queued 제외, startTask 큐 적재, drainQueue 착수.
describe('D1 대기 큐 — activeTaskForProject 제외 / startTask 적재 / drainQueue', () => {
  const P = 'test-proj-queue'
  beforeAll(() => {
    upsertProject({
      id: P,
      path: os.tmpdir(),
      name: 'test-proj-queue',
      stack: '',
      verifyCmd: null,
      isGit: true,
    })
  })

  it('activeTaskForProject는 queued를 활성으로 보지 않는다(안 그러면 드레인이 영영 막힘)', () => {
    insertTask({ id: 'q-only', projectId: P, title: 't', state: 'queued', content: 'c' })
    expect(activeTaskForProject(P)).toBeNull() // queued뿐이면 활성 없음
    updateTask('q-only', { state: 'done' }) // 정리
  })

  it('프로젝트에 활성 작업이 있으면 startTask는 거절이 아니라 queued로 적재하고 성공 반환', async () => {
    // 활성(working) 작업을 직접 심어 프로젝트를 busy로 만든다(launch 비동기 배제 — 결정론).
    insertTask({ id: 'q-active', projectId: P, title: 'active', state: 'working', content: 'c' })
    const r = await startTask(P, { content: '두 번째 작업(큐로 가야 함)' })
    expect(r.error).toBeUndefined()
    expect(r.queued).toBe(true)
    expect(r.taskId).toBeTruthy()
    expect(getTask(r.taskId!)!.state).toBe('queued')
    expect(r.queuePos).toBe(1) // 큐에서 첫 번째 대기
    // 정리
    updateTask('q-active', { state: 'done' })
    updateTask(r.taskId!, { state: 'done' })
  })

  it('큐 적재는 옵션(engine·priority 등)을 task 레코드에 보존한다', async () => {
    insertTask({ id: 'q-active2', projectId: P, title: 'active', state: 'working', content: 'c' })
    const r = await startTask(P, { content: '옵션 보존 확인', modelOverride: 'opus' })
    expect(r.queued).toBe(true)
    const t = getTask(r.taskId!)!
    expect(t.state).toBe('queued')
    expect(t.modelOverride).toBe('opus') // 드레인 시 재사용될 옵션 보존
    updateTask('q-active2', { state: 'done' })
    updateTask(r.taskId!, { state: 'done' })
  })

  it('drainQueue는 슬롯이 열리면 queued 작업을 착수(queued→clarifying)하고, priority 순서를 따른다', () => {
    // 활성 작업 없음. 서로 다른 프로젝트의 대기 작업 둘 — priority로 우선순위.
    // cap을 넉넉히 올려 앞 테스트들의 잔여 working 슬롯에 무관하게 둘 다 착수되게 한다(결정론).
    saveSettings({ concurrencyCap: 20 })
    const PB = 'test-proj-queue-b'
    upsertProject({ id: PB, path: os.tmpdir(), name: 'qb', stack: '', verifyCmd: null, isGit: true })
    insertTask({ id: 'drain-lo', projectId: P, title: '먼저', state: 'queued', content: 'c', priority: -5 })
    insertTask({ id: 'drain-hi', projectId: PB, title: '나중', state: 'queued', content: 'c', priority: 10 })

    expect(queuedTasks().map((t) => t.id)).toEqual(['drain-lo', 'drain-hi']) // priority ASC

    drainQueue()
    // 동기적으로 setState('clarifying')이 걸렸는지 — 더는 queued가 아님.
    expect(getTask('drain-lo')!.state).not.toBe('queued')
    expect(getTask('drain-hi')!.state).not.toBe('queued')
    // 정리(배경 clarifyAndLaunch가 뭘 하든 종결 상태로 덮어써 다음 테스트 격리).
    updateTask('drain-lo', { state: 'done' })
    updateTask('drain-hi', { state: 'done' })
  })

  it('drainQueue는 같은 프로젝트에 이미 활성 작업이 있으면 그 프로젝트의 대기 작업을 착수하지 않는다', () => {
    insertTask({ id: 'busy-active', projectId: P, title: 'active', state: 'working', content: 'c' })
    insertTask({ id: 'busy-queued', projectId: P, title: 'queued', state: 'queued', content: 'c' })
    drainQueue()
    expect(getTask('busy-queued')!.state).toBe('queued') // 여전히 대기(프로젝트 중복 차단)
    updateTask('busy-active', { state: 'done' })
    updateTask('busy-queued', { state: 'done' })
  })
})

// C1+I5 — finishWork 예산 게이트 통합: done은 예산 초과여도 review로 진행(무한 루프 방지),
// blocked+예산초과는 blocked로 멈추되 예산 메시지 + Navi 원래 질문을 둘 다 보존.
// runNavi(mock)가 실제 worker처럼 tokensTotal을 갱신하도록 per-test로 덮어써 finishWork의 예산 판정을 태운다.
describe('finishWork 예산 게이트 — C1+I5 통합(done 통과 / blocked 질문 보존)', () => {
  const BP = 'test-proj-budget'
  // taskId를 주면 'working'을 벗어날 때까지 실시간으로 폴링(최대 3s)한다 — verify_cmd 없는 작업도
  // 이제 T14 심사 게이트를 타 실제 git 서브프로세스(비동기 IO)가 끼어들어 마이크로태스크 5틱만으론
  // 부족하다(finding #2: verify_cmd 없음도 audit 게이트 포함). taskId 없으면 기존 마이크로태스크 플러시.
  const flush = async (taskId?: string) => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
    if (!taskId) return
    const start = Date.now()
    while (getTask(taskId)?.state === 'working' && Date.now() - start < 3000) {
      await new Promise((res) => setTimeout(res, 20))
    }
  }
  beforeAll(() => {
    upsertProject({ id: BP, path: os.tmpdir(), name: 'budget', stack: '', verifyCmd: null, isGit: true })
  })
  afterEach(() => {
    saveSettings({ taskTokenBudget: 0 }) // off로 복원
    vi.mocked(runNavi).mockReset()
    vi.mocked(runNavi).mockImplementation(async () => ({ status: 'done', summary: '', questions: [] }))
  })

  it('done + 예산 초과 → pause되지 않고 review로 진행(verify_cmd 없음이라 바로 review)', async () => {
    saveSettings({ taskTokenBudget: 100 })
    // runNavi가 세션에서 예산 초과 토큰을 태운 뒤 done 보고 — 실제 worker의 tokensTotal 갱신을 흉내.
    vi.mocked(runNavi).mockImplementation(async (t: Task) => {
      updateTask(t.id, { tokens: 500, tokensTotal: 500 })
      return { status: 'done', summary: '완료', questions: [] }
    })
    const r = await startTask(BP, { content: 'done 예산초과 작업', skipClarify: true })
    await flush(r.taskId!)
    const task = getTask(r.taskId!)!
    expect(task.state).toBe('review') // done은 예산 초과여도 막히지 않는다(무한 루프 방지)
    updateTask(r.taskId!, { state: 'done' }) // 프로젝트 busy 해제
  })

  it('blocked + 예산 초과 → blocked로 멈추고 예산 메시지 + Navi 질문을 둘 다 보존', async () => {
    saveSettings({ taskTokenBudget: 100 })
    vi.mocked(runNavi).mockImplementation(async (t: Task) => {
      updateTask(t.id, { tokens: 500, tokensTotal: 500 })
      return { status: 'blocked', summary: '막힘', questions: ['원래 Navi 질문A', '질문B'] }
    })
    const r = await startTask(BP, { content: 'blocked 예산초과 작업', skipClarify: true })
    await flush()
    const task = getTask(r.taskId!)!
    expect(task.state).toBe('blocked')
    // 예산 메시지가 선두, Navi 원래 질문이 뒤에 보존됨(pauseForBudget extraQuestions).
    expect(task.questions.some((q) => q.includes('예산'))).toBe(true)
    expect(task.questions).toContain('원래 Navi 질문A')
    expect(task.questions).toContain('질문B')
    updateTask(r.taskId!, { state: 'done' })
  })

  it('blocked + 예산 미달 → 예산 게이트를 통과하고 통상 blocked 경로(Navi 질문만)', async () => {
    saveSettings({ taskTokenBudget: 100_000 }) // 넉넉
    vi.mocked(runNavi).mockImplementation(async (t: Task) => {
      updateTask(t.id, { tokens: 500, tokensTotal: 500 }) // 예산 미달
      return { status: 'blocked', summary: '막힘', questions: ['통상 질문'] }
    })
    const r = await startTask(BP, { content: 'blocked 예산미달 작업', skipClarify: true })
    await flush()
    const task = getTask(r.taskId!)!
    expect(task.state).toBe('blocked')
    expect(task.questions).toEqual(['통상 질문']) // 예산 메시지 없이 Navi 질문만
    updateTask(r.taskId!, { state: 'done' })
  })
})

// I6 — resolveReview in-flight 가드: verifyInDir await(rebase 폴백) 동안 두 번째 동시 호출이 거절되는지.
// verifyInDir를 수동 resolve 프라미스로 덮어 첫 호출을 await 지점에 세워둔 뒤 둘째를 발사한다.
describe('resolveReview — I6 동시 호출 이중 병합 방지', () => {
  const RP = 'test-proj-resolve-lock'
  beforeAll(() => {
    upsertProject({
      id: RP, path: os.tmpdir(), name: 'resolve-lock', stack: '',
      verifyCmd: 'npm test', // rebase 후 verifyInDir을 태우려면 verify_cmd 필요
      isGit: true,
    })
    saveSettings({ autoRebaseOnMerge: true }) // ff 불가(tryMerge mock) → rebase 폴백 진입 → verifyInDir await
  })

  it('첫 호출이 verifyInDir await에 걸린 동안 둘째 호출은 거절된다', async () => {
    insertTask({ id: 'lock-task', projectId: RP, title: 'review', state: 'review', content: 'c' })
    updateTask('lock-task', { worktreePath: os.tmpdir(), branch: 'lock-branch' })

    // 첫 호출: 가드 통과 후 rebase 폴백 → verifyInDir(pending)에서 멈춘다.
    const p1 = resolveReview('lock-task', 'merge')
    await Promise.resolve() // tryMerge→rebase→verifyInDir 호출까지 진행시킨다
    await Promise.resolve()

    // 둘째 호출: 동일 taskId in-flight라 즉시 거절(await 전 동기 체크).
    const r2 = await resolveReview('lock-task', 'merge')
    expect(r2).toBe('이미 결재 처리 중이다')

    // 첫 호출 완결 — verify 통과시켜 merge 진행, finally에서 in-flight 해제.
    verifyDeferred.resolve()
    await p1

    // 해제됐으니 이후 호출은 가드에 안 걸린다(이미 done이라 'review 아님'으로 거절되는 게 정상).
    const r3 = await resolveReview('lock-task', 'merge')
    expect(r3).toBe('검토 상태가 아니다')
  })
})

// 재리뷰 #3 — 인터럽트 in-flight(메시지 세팅 후 runNavi 언와인드 전) 중 cancelTask가 들어오면,
// runWithInterrupts 루프가 스테일 인터럽트 메시지를 보고 취소된 작업을 'working'으로 되살려
// 삭제된 worktree에서 세션을 재개하던 레이스. 취소가 이겨야 한다.
describe('cancelTask — 인터럽트 in-flight 취소 레이스(#3)', () => {
  const IP = 'test-proj-interrupt-cancel'
  beforeAll(() => {
    upsertProject({
      id: IP, path: os.tmpdir(), name: 'interrupt-cancel', stack: '',
      verifyCmd: null, isGit: true,
    })
  })

  it('인터럽트 걸린 채 취소하면 부활하지 않는다 — runNavi 1회, cancelled 유지', async () => {
    vi.mocked(isNaviRunning).mockReturnValue(true) // interruptTask 게이트 통과용
    vi.mocked(runNavi).mockReset()
    vi.mocked(runNavi).mockImplementation(async (t: Task) => {
      // Navi 실행 중 사용자가: 인터럽트(메시지 주입) → 곧바로 취소. runNavi는 abort로 정상 반환.
      interruptTask(t.id, '이거 먼저 해줘')
      cancelTask(t.id)
      return { status: 'done', summary: '', questions: [] }
    })
    const r = await startTask(IP, { content: '취소 레이스 작업', skipClarify: true })
    for (let i = 0; i < 6; i++) await Promise.resolve() // launch 비동기 체인 소진
    expect(getTask(r.taskId!)!.state).toBe('cancelled') // ★ working으로 부활하지 않는다
    expect(vi.mocked(runNavi)).toHaveBeenCalledTimes(1) // 재실행 없음(삭제된 worktree 재개 차단)
    // 복원(다른 테스트 오염 방지)
    vi.mocked(isNaviRunning).mockReturnValue(false)
    vi.mocked(runNavi).mockImplementation(async () => ({ status: 'done', summary: '', questions: [] }))
  })
})
