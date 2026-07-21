// #15 — 주기 스캔 낭비 2건: ① refreshBriefing 상태 해시 가드(현황 무변화면 judge 콜 스킵 —
// 매 틱 ~144회/일 상시 낭비 차단, 시작 브리핑은 가드 제외) ② routines 전용 60초 경량 타이머
// (scanIntervalMin=0이어도 루틴이 죽지 않고, cron 정밀도가 스캔 간격으로 뭉개지지 않는다).
// store·briefing·judge 전부 목 — LLM/DB 없이 결정론 배관만 검증한다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'

const S = vi.hoisted(() => ({
  settingsKV: new Map<string, string>(),
  settings: {
    scanIntervalMin: 0,
    routinesEnabled: true,
    autoStartTaskMd: false,
    autoPriority: false,
    lessonCurator: false,
    idleMin: 3,
  } as Record<string, unknown>,
  projects: [] as any[],
  tasks: [] as any[],
  approvals: [] as any[],
  dueRoutines: [] as any[],
}))

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: require('node:os').tmpdir(),
  AGENT_CWD: '.',
  CLAUDE_BIN: 'claude',
}))
vi.mock('../../src/main/logfile', () => ({ appendCapped: vi.fn() }))
vi.mock('../../src/main/collectors', () => ({ collectStatus: vi.fn(async () => {}) }))
vi.mock('../../src/main/briefing', () => ({ generateBriefing: vi.fn(async () => '브리핑 텍스트') }))
vi.mock('../../src/main/autobackup', () => ({ runAutoBackupIfDue: vi.fn() }))
vi.mock('../../src/main/rewind', () => ({ cleanupCheckpoints: vi.fn() }))
vi.mock('../../src/main/notify', () => ({ notifyUser: vi.fn() }))
vi.mock('../../src/main/manager', () => ({
  buildDigest: vi.fn(() => 'digest'),
  pushManagerNotice: vi.fn(),
  sendToManager: vi.fn(async () => {}),
  setStartupBriefing: vi.fn(),
}))
vi.mock('../../src/main/orchestrator', () => ({
  shouldAutoStartTask: vi.fn(() => false),
  startTask: vi.fn(),
  hasActiveWork: vi.fn(() => false),
  drainQueue: vi.fn(),
}))
// judge — 러너 자체는 judge.test.ts가 검증. 여기선 호출 여부만 본다(스캔 배관 테스트).
vi.mock('../../src/main/judge', () => ({
  runJudge: vi.fn(async () => null),
  parseJsonBlock: vi.fn(() => null),
  isJsonObject: (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null,
}))
vi.mock('../../src/main/store', () => ({
  addMessage: vi.fn(),
  applyConsolidation: vi.fn(),
  applySkillLifecycle: vi.fn(),
  getSetting: (k: string) => S.settingsKV.get(k) ?? null,
  getSettings: () => S.settings,
  lastChatActivityAt: () => null,
  lessonsForCuration: () => [],
  flagLesson: vi.fn(),
  listApprovals: () => S.approvals,
  listDueRoutines: vi.fn(() => S.dueRoutines),
  listProjects: () => S.projects,
  listTasks: () => S.tasks,
  loopStats: () => ({ days: 7, total: 0, done: 0, error: 0, cancelled: 0, firstPass: 0, reworked: 0, topFailReasons: [] }),
  markRoutineRan: vi.fn((id: string) => {
    // 실제 markRoutineRan은 next_run_at을 다음 cron 시각으로 전진시켜 재디스패치를 차단한다 — 동형 흉내.
    S.dueRoutines = S.dueRoutines.filter((r) => r.id !== id)
  }),
  promotionStats: vi.fn(),
  setSetting: vi.fn((k: string, v: string) => {
    S.settingsKV.set(k, v)
  }),
}))

import { refreshBriefing, briefNow, rearmScheduler, stopScheduler } from '../../src/main/scheduler'
import { generateBriefing } from '../../src/main/briefing'
import { collectStatus } from '../../src/main/collectors'
import { sendToManager, setStartupBriefing } from '../../src/main/manager'
import { listDueRoutines, markRoutineRan } from '../../src/main/store'

// 테스트마다 1시간씩 전진하는 시각 기반 — 모듈 상태 lastBriefAt(스로틀)이 테스트 간 이월돼도
// 항상 스로틀 창(5분) 밖에서 시작하게 한다(시계를 되감으면 이전 테스트의 lastBriefAt에 걸린다).
let base = Date.parse('2026-07-22T00:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  base += 60 * 60_000
  vi.setSystemTime(base)
  vi.mocked(generateBriefing).mockClear()
  vi.mocked(sendToManager).mockClear()
  vi.mocked(markRoutineRan).mockClear()
  vi.mocked(listDueRoutines).mockClear()
  vi.mocked(collectStatus).mockClear()
  S.settingsKV.clear()
  S.projects = []
  S.tasks = []
  S.approvals = []
  S.dueRoutines = []
})
afterEach(() => {
  stopScheduler()
  vi.useRealTimers()
})

// 스로틀(BRIEF_MIN_MS=5분)을 넘겨 다음 호출이 가드까지 도달하게 한다.
const passThrottle = () => vi.setSystemTime(Date.now() + 6 * 60_000)

describe('refreshBriefing — 상태 해시 가드(#15)', () => {
  it('첫 호출은 생성하고, 현황 무변화 재호출은 judge 콜을 스킵한다', async () => {
    S.tasks = [{ id: 't1', state: 'working' }]
    expect(await refreshBriefing()).toBe('브리핑 텍스트')
    expect(generateBriefing).toHaveBeenCalledTimes(1)
    expect(S.settingsKV.get('dock_briefing_hash')).toBeTruthy()

    passThrottle()
    expect(await refreshBriefing()).toBeNull() // 무변화 → 스킵
    expect(generateBriefing).toHaveBeenCalledTimes(1)
  })

  it('현황이 바뀌면 다시 생성한다', async () => {
    S.tasks = [{ id: 't1', state: 'working' }]
    await refreshBriefing()
    expect(generateBriefing).toHaveBeenCalledTimes(1)

    passThrottle()
    S.tasks = [{ id: 't1', state: 'review' }] // 상태 전이 = 브리핑 문면이 바뀔 신호
    expect(await refreshBriefing()).toBe('브리핑 텍스트')
    expect(generateBriefing).toHaveBeenCalledTimes(2)
  })

  it('프로젝트 status(test fail·dirty 유무) 변화도 해시에 잡힌다', async () => {
    S.projects = [{ id: 'p1', muted: false, status: { testState: 'pass', dirtyFiles: 0 } }]
    await refreshBriefing()
    passThrottle()
    S.projects = [{ id: 'p1', muted: false, status: { testState: 'fail', dirtyFiles: 0 } }]
    await refreshBriefing()
    expect(generateBriefing).toHaveBeenCalledTimes(2)
  })

  it('시작 브리핑(briefNow·includePrior)은 무변화여도 가드를 타지 않는다', async () => {
    await briefNow()
    expect(generateBriefing).toHaveBeenCalledTimes(1)
    expect(generateBriefing).toHaveBeenCalledWith({ includePrior: true })
    expect(setStartupBriefing).toHaveBeenCalledWith('브리핑 텍스트')

    await briefNow() // 같은 상태로 재실행(앱 재시작 시나리오) — 그래도 새로 생성
    expect(generateBriefing).toHaveBeenCalledTimes(2)
  })
})

describe('rearmScheduler — routines 전용 60초 경량 타이머(#15)', () => {
  const routine = { id: 'r1', title: '아침 루틴', cron: '0 9 * * *', prompt: '루틴 프롬프트', enabled: true }

  it('scanIntervalMin=0(스캔 꺼짐)이어도 60초 틱에 due 루틴이 디스패치된다', async () => {
    S.settings.scanIntervalMin = 0
    S.settings.routinesEnabled = true
    S.dueRoutines = [routine]
    rearmScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(markRoutineRan).toHaveBeenCalledWith('r1')
    expect(sendToManager).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendToManager).mock.calls[0][0]).toBe('루틴 프롬프트')
    expect(collectStatus).not.toHaveBeenCalled() // 스캔은 안 돈다 — 루틴만 경량으로
  })

  it('markRoutineRan(중복 차단) 후 다음 틱은 재디스패치하지 않는다', async () => {
    S.dueRoutines = [routine]
    rearmScheduler()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendToManager).toHaveBeenCalledTimes(1) // due에서 빠졌으니 한 번뿐
  })

  it('routinesEnabled=false면 틱이 돌아도 디스패치하지 않는다(opt-in 유지, rearm 없이 토글 반영)', async () => {
    S.settings.routinesEnabled = false
    S.dueRoutines = [routine]
    rearmScheduler()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(listDueRoutines).not.toHaveBeenCalled()
    expect(sendToManager).not.toHaveBeenCalled()

    S.settings.routinesEnabled = true // 설정 토글 — rearm 없이 다음 틱부터 반영
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendToManager).toHaveBeenCalledTimes(1)
  })

  it('stopScheduler가 루틴 타이머도 멈춘다(종료 시퀀스 — 닫히는 DB 접근 차단)', async () => {
    S.dueRoutines = [routine]
    rearmScheduler()
    stopScheduler()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(sendToManager).not.toHaveBeenCalled()
  })
})
