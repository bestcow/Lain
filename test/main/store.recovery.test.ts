import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// store.ts는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 고정(격리).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-recovery-')) }
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
  isCorruptResult,
  formatCorruptDetail,
  isQuickCheckOk,
  addMessage,
  listMessages,
  ensureActiveConversation,
  parseNullViolations,
  repairNullViolations,
} from '../../src/main/store'

afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

// 이 판정이 과거 버그의 핵심 — 복구 프로브가 `SELECT COUNT(*) FROM messages`만 보던 시절엔
// messages 외(settings 인덱스 등) 손상을 못 잡아 rw 오픈 후 도처에서 malformed가 터졌다.
// quick_check 결과(행)/throw로부터 손상을 판정하는 이 순수함수가 그 갭을 메운다.
describe('isCorruptResult — quick_check 결과/throw 손상 판정', () => {
  it("quick_check 'ok' 단일 행 → 정상", () => {
    expect(isCorruptResult([{ quick_check: 'ok' }])).toBe(false)
  })
  it("integrity_check 'ok' 단일 행 → 정상", () => {
    expect(isCorruptResult([{ integrity_check: 'ok' }])).toBe(false)
  })
  it('인덱스 엔트리 수 불일치 행 → 손상 (과거 프로브가 놓치던 케이스)', () => {
    expect(
      isCorruptResult([{ quick_check: 'wrong # of entries in index sqlite_autoindex_settings_1' }]),
    ).toBe(true)
  })
  it('문제 행이 여러 개 → 손상', () => {
    expect(isCorruptResult([{ quick_check: 'row 1 missing' }, { quick_check: 'page 5 corrupt' }])).toBe(
      true,
    )
  })
  it('malformed/disk image throw → 손상', () => {
    expect(isCorruptResult(null, new Error('database disk image is malformed'))).toBe(true)
    expect(isCorruptResult(null, new Error('file is not a database'))).toBe(true)
  })
  it('무관한 에러·빈 결과 → 정상(불필요한 WAL 폐기 방지)', () => {
    expect(isCorruptResult(null, new Error('ENOENT: no such file'))).toBe(false)
    expect(isCorruptResult([])).toBe(false)
    expect(isCorruptResult(null)).toBe(false)
  })
})

// REINDEX 반복 루프 진단용 — 손상 내용을 사람이 읽을 한 줄로(반복 시 동일 인덱스인지 추적). 비밀 비유출.
describe('formatCorruptDetail — quick_check 손상 진단 문자열', () => {
  it('throw는 예외 메시지로', () => {
    expect(formatCorruptDetail(null, new Error('database disk image is malformed'))).toContain(
      'database disk image is malformed',
    )
  })
  it('손상 행들을 합쳐서', () => {
    expect(
      formatCorruptDetail([
        { quick_check: 'wrong # of entries in index sqlite_autoindex_settings_1' },
        { quick_check: 'row 1 missing from index idx_x' },
      ]),
    ).toBe(
      'wrong # of entries in index sqlite_autoindex_settings_1 | row 1 missing from index idx_x',
    )
  })
  it('빈 결과/널은 표식 문자열', () => {
    expect(formatCorruptDetail([])).toBe('결과 없음')
    expect(formatCorruptDetail(null)).toBe('결과 없음')
  })
  it('300자 상한', () => {
    expect(formatCorruptDetail([{ quick_check: 'x'.repeat(500) }]).length).toBeLessThanOrEqual(300)
  })
})

// 영속화 게이트 — '명시적 ok'만 통과(화이트리스트). isCorruptResult의 '모름=정상'이 미검증 상태를
// 메인에 굳히는 것을 막는다(적대 리뷰: BUSY/빈결과/예외에 게이트 열림 방지).
describe('isQuickCheckOk — REINDEX 후 영속화 화이트리스트 게이트', () => {
  it("단일 'ok' 행만 통과", () => {
    expect(isQuickCheckOk([{ quick_check: 'ok' }])).toBe(true)
    expect(isQuickCheckOk([{ integrity_check: 'ok' }])).toBe(true)
  })
  it('예외는 미통과(BUSY/locked 등 비손상 예외 포함)', () => {
    expect(isQuickCheckOk(null, new Error('database is locked'))).toBe(false)
    expect(isQuickCheckOk([{ quick_check: 'ok' }], new Error('busy'))).toBe(false)
  })
  it('빈 결과·null·다중 행은 미통과(미확인=미영속)', () => {
    expect(isQuickCheckOk([])).toBe(false)
    expect(isQuickCheckOk(null)).toBe(false)
    expect(isQuickCheckOk([{ quick_check: 'ok' }, { quick_check: 'ok' }])).toBe(false)
  })
  it("손상 행은 미통과", () => {
    expect(isQuickCheckOk([{ quick_check: 'wrong # of entries in index x' }])).toBe(false)
  })
})

// 관측된 무한 REINDEX 루프 회귀 방지 — quick_check가 보고하는 NOT NULL 데이터 위반(과거 손상으로
// projects.hidden이 NULL이 된 행)은 REINDEX로 못 고쳐, 매 부팅 'REINDEX→여전히 손상→미영속'이 영원히
// 반복됐다(recovery.log 관측: "NULL value in projects.hidden"). 파서가 위반 대상을 뽑고, 치유 함수가
// 선언 default로 NULL을 메워 quick_check를 ok로 수렴시키는지 검증한다. (node:sqlite는 방어모드라
// sqlite_master를 직접 못 고쳐 실제 위반 파일을 위조할 수 없으므로 두 단계를 분리 검증한다.)
describe('parseNullViolations — quick_check NOT NULL 위반 추출(순수)', () => {
  it("'NULL value in T.C' 행에서 (table, column)을 뽑는다", () => {
    expect(parseNullViolations([{ quick_check: 'NULL value in projects.hidden' }])).toEqual([
      { table: 'projects', column: 'hidden' },
    ])
  })
  it('NOT NULL 외(인덱스 손상 등) 행은 제외하고 NULL 위반만', () => {
    expect(
      parseNullViolations([
        { quick_check: 'wrong # of entries in index sqlite_autoindex_settings_1' },
        { quick_check: 'NULL value in tasks.fast_mode' },
      ]),
    ).toEqual([{ table: 'tasks', column: 'fast_mode' }])
  })
  it("'ok'·빈결과·예외는 빈 배열(불필요한 데이터 변경 방지)", () => {
    expect(parseNullViolations([{ quick_check: 'ok' }])).toEqual([])
    expect(parseNullViolations([])).toEqual([])
    expect(parseNullViolations(null)).toEqual([])
    expect(parseNullViolations(null, new Error('database disk image is malformed'))).toEqual([])
  })
})

describe('repairNullViolations — NOT NULL 위반 행을 선언 default로 치유', () => {
  it('NULL 컬럼을 table_info의 default로 채우고 치유 행수를 돌려준다', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, hidden INTEGER DEFAULT 0)')
    db.exec("INSERT INTO projects (id, hidden) VALUES ('a', NULL), ('b', NULL), ('c', 1)")
    const n = repairNullViolations(db, [{ table: 'projects', column: 'hidden' }])
    expect(n).toBe(2)
    const rows = db.prepare('SELECT id, hidden FROM projects ORDER BY id').all() as any[]
    expect(rows.map((r) => r.hidden)).toEqual([0, 0, 1])
    db.close()
  })
  it('default 없는 컬럼은 건드리지 않는다(임의 데이터 생성 금지)', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, x INTEGER)')
    db.exec("INSERT INTO t (id, x) VALUES ('a', NULL)")
    const n = repairNullViolations(db, [{ table: 't', column: 'x' }])
    expect(n).toBe(0)
    db.close()
  })
  it('문자열 default도 그대로 복원한다', () => {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE TABLE s (id TEXT PRIMARY KEY, state TEXT DEFAULT 'unknown')")
    db.exec("INSERT INTO s (id, state) VALUES ('a', NULL)")
    expect(repairNullViolations(db, [{ table: 's', column: 'state' }])).toBe(1)
    expect((db.prepare('SELECT state FROM s').get() as any).state).toBe('unknown')
    db.close()
  })
})

describe('closeStore + 재오픈 — 정상 종료 후 데이터·구조 보존', () => {
  it('체크포인트 후 재오픈해도 메시지가 보존되고 store가 쓰기 가능하다', () => {
    initStore()
    const cid = ensureActiveConversation('manager')
    addMessage('manager', 'user', 'SURVIVOR', cid)
    closeStore() // wal_checkpoint(TRUNCATE) + close — WAL을 메인에 합침
    // 재오픈: recoverCorruptWalBeforeOpen(정상→noop) + repairIndexesIfCorrupt(quick_check ok→noop)
    initStore()
    const after = listMessages('manager')
    expect(after.some((m) => m.content === 'SURVIVOR')).toBe(true)
    // 재오픈 후에도 쓰기 가능(인덱스 복구가 healthy DB를 깨지 않음)
    expect(() => addMessage('manager', 'assistant', 'OK', cid)).not.toThrow()
  })
})
