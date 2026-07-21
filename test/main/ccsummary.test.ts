// C3 — CC 세션 종료 → 레인 역반영: cc_events.summary 컬럼(judge 요약 저장) + 최신순 조회.
// LLM 호출부(cchooks.summarizeCcEnd)는 배관 분리 대상이라 여기선 store 계층만 검증한다.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-ccsummary-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, closeStore, addCcEvent, setCcEventSummary, latestCcSummaries } from '../../src/main/store'

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

describe('CC 세션 요약 저장', () => {
  it('SessionEnd 이벤트에 요약을 붙이고 최신순 조회', () => {
    addCcEvent('demo3', 'sess-1111-2222', 'SessionEnd')
    setCcEventSummary('demo3', 'sess-1111-2222', '로그인 버그 수정, 테스트 2개 추가')
    const rows = latestCcSummaries(5)
    expect(rows[0].summary).toContain('로그인 버그')
    expect(rows[0].projectId).toBe('demo3')
  })

  it('summary가 없는 이벤트는 조회에서 제외된다', () => {
    addCcEvent('demo4', 'sess-3333-4444', 'SessionEnd')
    const rows = latestCcSummaries(5)
    expect(rows.some((r) => r.projectId === 'demo4')).toBe(false)
  })

  it('500자를 넘는 요약은 저장 시 잘린다', () => {
    addCcEvent('demo5', 'sess-5555-6666', 'SessionEnd')
    setCcEventSummary('demo5', 'sess-5555-6666', 'x'.repeat(600))
    const rows = latestCcSummaries(5)
    const r = rows.find((r) => r.projectId === 'demo5')!
    expect(r.summary.length).toBe(500)
  })
})
