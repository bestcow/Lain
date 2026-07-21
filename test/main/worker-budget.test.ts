// #14 — 작업 토큰 예산 세션 중 판정: 예산 게이트가 세션 경계(finishWork)에만 있으면 '반복은 적은데
// 한 번이 비싼' 단일 세션이 뚫린다. runNavi가 assistant usage를 스트림 중에 누적해 초과 즉시 abort하고,
// blocked 보고로 반환해 기존 shouldPauseForBudget→pauseForBudget(일시정지) 경로에 합류하는지 검증.
// orchestrator-race.test.ts와 동형 격리(paths→임시 DATA_DIR, notify 목, SDK query 목 + 실제 store).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { DATA_DIR: TEST_DATA_DIR } = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const ph = require('node:path') as typeof import('node:path')
  const osh = require('node:os') as typeof import('node:os')
  const tmpDir = fsh.mkdtempSync(ph.join(osh.tmpdir(), 'lain-wbudget-'))
  return { DATA_DIR: tmpDir }
})

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: TEST_DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

vi.mock('../../src/main/notify', () => ({ notifyUser: vi.fn() }))

// SDK query 목 — queryCtl.msgs를 순서대로 흘리고, 각 yield 뒤 abort가 걸렸으면 실제 SDK처럼 throw.
// (runNavi의 budget abort → 스트림 throw → catch(aborted) → blocked 보고 반환 경로를 그대로 태운다.)
const { queryCtl } = vi.hoisted(() => ({
  queryCtl: { msgs: [] as unknown[], sawAbort: false },
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: { options: { abortController?: AbortController } }) =>
    (async function* () {
      for (const m of queryCtl.msgs) {
        yield m
        if (options.abortController?.signal.aborted) {
          queryCtl.sawAbort = true
          throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
        }
      }
    })(),
  ),
  tool: vi.fn(() => ({})),
  createSdkMcpServer: vi.fn(() => ({})),
}))

import {
  initStore,
  closeStore,
  upsertProject,
  insertTask,
  updateTask,
  getTask,
  saveSettings,
} from '../../src/main/store'
import { budgetExceeded } from '../../src/main/usage'
import { runNavi } from '../../src/main/worker'

// assistant 1건 = API 호출 1건분 usage (manager.ts와 동일하게 message.usage에 실린다).
const assistantMsg = (tokens: number, text = '작업 중...') => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }], usage: { input_tokens: tokens, output_tokens: 0 } },
})
const DONE_JSON = '```json\n{"status": "done", "summary": "끝", "questions": []}\n```'
const resultMsg = (tokens: number) => ({
  type: 'result',
  subtype: 'success',
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: tokens, output_tokens: 0 },
})

let seq = 0
function makeTask(): string {
  const id = `wb-${++seq}`
  insertTask({ id, projectId: 'wbudget', title: 'budget test', state: 'working', content: '테스트 작업' })
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-wbwt-'))
  updateTask(id, { branch: `task/${id}`, worktreePath: wt })
  return id
}

beforeAll(() => {
  initStore()
  upsertProject({
    id: 'wbudget', path: os.tmpdir(), name: 'wbudget', stack: '', verifyCmd: null, isGit: true,
  })
})

afterAll(() => {
  closeStore()
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

beforeEach(() => {
  queryCtl.msgs = []
  queryCtl.sawAbort = false
})

describe('runNavi — #14 작업 토큰 예산 세션 중 판정', () => {
  it('세션 중 누적이 예산을 넘으면 abort → blocked 보고(일시정지 경로 합류, 재시도 루프 아님)', async () => {
    saveSettings({ taskTokenBudget: 1000 })
    const id = makeTask()
    // 600 + 600 = 1200 > 1000 — result(세션 경계)가 오기 전에 두 번째 assistant에서 초과.
    queryCtl.msgs = [assistantMsg(600), assistantMsg(600)]

    // resolve(정상 반환)여야 한다 — throw면 handleRunError의 autoRetry가 재개→재초과 무한 루프를 돈다.
    const report = await runNavi(getTask(id)!, () => {}, {})

    expect(queryCtl.sawAbort).toBe(true) // 스트림 중 실제로 abort 발화
    expect(report.status).toBe('blocked') // done이 아님 — verify/review로 더 태우지 않는다
    expect(report.questions[0]).toContain('예산')
    // abort로 result가 안 와도 tokensTotal은 초과값으로 갱신 — finishWork의 예산 게이트가 이 값을 본다.
    const t = getTask(id)!
    expect(t.tokensTotal).toBe(1200)
    // shouldPauseForBudget 계약(status!=='done' && budgetExceeded) 충족 → pauseForBudget(일시정지)로 간다.
    expect(budgetExceeded(t.tokensTotal, 1000)).toBe(true)
  })

  it('미초과면 abort 없이 정상 완료', async () => {
    saveSettings({ taskTokenBudget: 1_000_000 })
    const id = makeTask()
    queryCtl.msgs = [assistantMsg(100, DONE_JSON), resultMsg(150)]

    const report = await runNavi(getTask(id)!, () => {}, {})

    expect(queryCtl.sawAbort).toBe(false)
    expect(report.status).toBe('done')
    expect(getTask(id)!.tokensTotal).toBe(150) // result 경로의 기존 갱신 그대로
  })

  it('예산 off(0)면 무동작 — 큰 세션도 그대로 완주', async () => {
    saveSettings({ taskTokenBudget: 0 })
    const id = makeTask()
    queryCtl.msgs = [assistantMsg(999_999, DONE_JSON), resultMsg(999_999)]

    const report = await runNavi(getTask(id)!, () => {}, {})

    expect(queryCtl.sawAbort).toBe(false)
    expect(report.status).toBe('done')
  })

  it('run 시작 시점에 이미 예산 이상이면 게이트 무동작 — 예산 일시정지 후 사람이 재개한 run을 첫 메시지에서 재중단하는 루프 방지', async () => {
    saveSettings({ taskTokenBudget: 1000 })
    const id = makeTask()
    updateTask(id, { tokensTotal: 1500 }) // 이전 세션들 누계가 이미 초과(사람이 알고 재개한 상황)
    queryCtl.msgs = [assistantMsg(600, DONE_JSON), resultMsg(600)]

    const report = await runNavi(getTask(id)!, () => {}, {})

    expect(queryCtl.sawAbort).toBe(false) // 세션 중 게이트는 침묵 — 경계 게이트(finishWork)가 판정
    expect(report.status).toBe('done')
  })
})
