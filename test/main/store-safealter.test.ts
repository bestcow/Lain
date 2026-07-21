// 클론 관점 감사(요청 5번) — initStore의 ALTER TABLE 마이그레이션들이 전부 '어떤 에러든' catch{}로
// 무조건 삼켰다("컬럼이 이미 있어서"라고 가정). 컬럼이 이미 있어서 나는 'duplicate column name' 외의
// 진짜 실패(디스크·권한 등)까지 조용히 넘기면, 그 컬럼이 실제로는 안 생긴 채 부팅이 '성공'으로 끝나
// 반쯤 초기화된 상태(zombie)로 계속 돌고, 그 컬럼을 쓰는 코드가 한참 뒤 다른 자리에서 'no such column'
// 으로 터져 원인 추적이 안 됐다. safeAlter가 원인을 구분해 진짜 실패만 recovery.log에 남기는지,
// 부팅 자체는 여전히 막지 않는지(기존 무중단 설계 유지) 검증한다.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-safealter-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, safeAlter } from '../../src/main/store'

afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* 파일 잠금 — 무시 */
  }
})

const recoveryLog = (): string => {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'recovery.log'), 'utf8')
  } catch {
    return ''
  }
}

beforeAll(() => {
  initStore()
})

describe('safeAlter — 마이그레이션 실패 원인 구분(부팅은 막지 않되 진짜 실패는 로그)', () => {
  it("'duplicate column name'(정상 — 이미 있는 컬럼 재시도)은 조용히 넘어간다(로그 없음, 부팅 스팸 방지)", () => {
    const before = recoveryLog()
    expect(() => safeAlter("ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'interactive'")).not.toThrow()
    const after = recoveryLog()
    // 로그 총량이 이 호출로 늘지 않아야 한다(매 부팅 30여 개 마이그레이션이 전부 이 케이스라 스팸 방지가 핵심).
    expect(after.length).toBe(before.length)
  })

  it('존재하지 않는 테이블 등 진짜 실패는 throw 없이 recovery.log에 진단을 남긴다', () => {
    expect(() => safeAlter('ALTER TABLE no_such_table_xyz ADD COLUMN q TEXT')).not.toThrow()
    const log = recoveryLog()
    expect(log).toMatch(/마이그레이션 실패/)
    expect(log).toContain('no_such_table_xyz')
  })
})
