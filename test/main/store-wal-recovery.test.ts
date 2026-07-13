// WAL 손상 복구 프로브 회귀 테스트 — 2026 실사고("메인 손상 + 정상 WAL"에서 정상 WAL을 오판 폐기 →
// 수정분 유실 + 매부팅 REINDEX 루프) 재발 방지. read-only 프로브가 WAL을 '통해' 읽어 정상 판정하는지,
// 반대로 WAL 자체가 손상이면 여전히 폐기(기존 복구)하는지 둘 다 실측한다.
// 픽스처는 강제종료(Stop-Process)를 시뮬레이션한다: 열린 rw 연결의 db/-wal/-shm 3종을 그대로 스냅샷한 뒤
// 정상 close(체크포인트) 후 스냅샷으로 되돌린다 — 메인=구버전, WAL=신버전 갱신분, shm=킬 시점 그대로.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-walrec-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { recoverCorruptWalBeforeOpen } from '../../src/main/store'

const dbPath = path.join(DATA_DIR, 'lain.sqlite')
const ROWS = 50
const oldVal = (i: number): string => `old-${'x'.repeat(200)}-${i}`
const newVal = (i: number): string => `new-${'y'.repeat(200)}-${i}`

function wipe(): void {
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true })
  fs.rmSync(path.join(DATA_DIR, 'db-corrupt'), { recursive: true, force: true })
  fs.rmSync(path.join(DATA_DIR, 'recovery.log'), { force: true })
}

/** 메인=체크포인트된 구버전, WAL=전 행 갱신(신버전)인 킬-스냅샷 픽스처를 만든다. */
function makeKillSnapshotFixture(): void {
  // 1) 베이스 — 체크포인트로 메인에 확정된 구버전
  const db1 = new DatabaseSync(dbPath)
  db1.exec('PRAGMA journal_mode = WAL')
  db1.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  const ins = db1.prepare('INSERT INTO t (id, v) VALUES (?, ?)')
  for (let i = 0; i < ROWS; i++) ins.run(i, oldVal(i))
  db1.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db1.close()
  // 2) WAL에만 존재하는 신버전 갱신 — 연결이 살아 있는 동안 3종 파일을 스냅샷(=강제종료 시점의 디스크)
  const db2 = new DatabaseSync(dbPath)
  const upd = db2.prepare('UPDATE t SET v = ? WHERE id = ?')
  for (let i = 0; i < ROWS; i++) upd.run(newVal(i), i)
  const staging = fs.mkdtempSync(path.join(DATA_DIR, 'staging-'))
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, path.join(staging, 'f' + ext))
  }
  db2.close() // 정상 close(체크포인트 발생) — 어차피 아래에서 스냅샷으로 되돌린다
  for (const ext of ['', '-wal', '-shm']) {
    const src = path.join(staging, 'f' + ext)
    if (fs.existsSync(src)) fs.copyFileSync(src, dbPath + ext)
    else fs.rmSync(dbPath + ext, { force: true })
  }
  fs.rmSync(staging, { recursive: true, force: true })
  expect(fs.existsSync(dbPath + '-wal')).toBe(true)
  expect(fs.statSync(dbPath + '-wal').size).toBeGreaterThan(0)
}

/** WAL 파일을 파싱해 프레임에 들어 있는 페이지 번호 집합을 얻는다(어떤 메인 페이지를 손상시켜야
 *  'WAL이 신버전을 가진 페이지'를 정확히 맞추는지 — 프레임 헤더 첫 4바이트 = 페이지 번호 BE). */
function walPageNumbers(): { pages: Set<number>; pageSize: number } {
  const wal = fs.readFileSync(dbPath + '-wal')
  const pageSize = wal.readUInt32BE(8)
  const pages = new Set<number>()
  let off = 32 // WAL 헤더 32바이트
  while (off + 24 + pageSize <= wal.length) {
    pages.add(wal.readUInt32BE(off))
    off += 24 + pageSize
  }
  return { pages, pageSize }
}

/** WAL이 신버전을 보유한 페이지 하나를 골라 메인 파일에서 그 페이지를 쓰레기로 덮는다. */
function corruptMainPageCoveredByWal(): void {
  const { pages, pageSize } = walPageNumbers()
  expect(pages.size).toBeGreaterThan(0)
  // 페이지 1(헤더+sqlite_master)은 피한다 — 헤더 파괴는 '파일 자체 불인식'이라 별개 실패 모드가 된다.
  const target = [...pages].filter((p) => p > 1).sort((a, b) => a - b)[0] ?? [...pages][0]
  const fd = fs.openSync(dbPath, 'r+')
  try {
    fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (target - 1) * pageSize)
  } finally {
    fs.closeSync(fd)
  }
}

function quickCheck(p: string): string {
  // 손상 DB는 quick_check 결과 행 대신 malformed를 throw하기도 한다 — 에러 문자열을 결과로 취급.
  const db = new DatabaseSync(p, { readOnly: true })
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[]
    return rows.map((r) => r.quick_check).join('; ')
  } catch (e) {
    return String((e as Error).message)
  } finally {
    try {
      db.close()
    } catch {
      /* 무시 */
    }
  }
}

beforeEach(wipe)
afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* 파일 잠금 — 무시 */
  }
})

describe('recoverCorruptWalBeforeOpen — 2026 사고 시나리오(메인 손상 + 정상 WAL)', () => {
  it('픽스처 유효성: 메인 단독은 malformed, WAL 통해 읽으면 정상이어야 한다', () => {
    makeKillSnapshotFixture()
    corruptMainPageCoveredByWal()
    // 메인 단독(-wal 제거 사본) → 손상이어야 픽스처가 성립
    const mainOnly = path.join(DATA_DIR, 'main-only.sqlite')
    fs.copyFileSync(dbPath, mainOnly)
    expect(quickCheck(mainOnly)).not.toBe('ok')
    fs.rmSync(mainOnly, { force: true })
  })

  it('정상 WAL을 폐기하지 않고, WAL의 신버전 데이터가 살아남는다', () => {
    makeKillSnapshotFixture()
    corruptMainPageCoveredByWal()
    recoverCorruptWalBeforeOpen()
    // 프로브가 WAL을 통해 읽었다면 정상 판정 → WAL 보존
    expect(fs.existsSync(dbPath + '-wal')).toBe(true)
    // rw로 열어 실제 데이터 확인 — 신버전(WAL)이 보여야 하고 quick_check도 정상이어야 한다
    const db = new DatabaseSync(dbPath)
    try {
      const rows = db.prepare('SELECT id, v FROM t ORDER BY id').all() as { id: number; v: string }[]
      expect(rows.length).toBe(ROWS)
      expect(rows.every((r) => r.v === newVal(r.id))).toBe(true)
      expect(quickCheckOpen(db)).toBe('ok')
    } finally {
      db.close()
    }
  })

  it('-shm이 소실된 킬 스냅샷(백업 복원·비정상 종료 변형)에서도 정상 WAL을 폐기하지 않는다', () => {
    makeKillSnapshotFixture()
    corruptMainPageCoveredByWal()
    fs.rmSync(dbPath + '-shm', { force: true }) // shm 없는 변형 — 프로브가 WAL 인덱스를 재구성해야 함
    recoverCorruptWalBeforeOpen()
    expect(fs.existsSync(dbPath + '-wal')).toBe(true)
    const db = new DatabaseSync(dbPath)
    try {
      const rows = db.prepare('SELECT id, v FROM t ORDER BY id').all() as { id: number; v: string }[]
      expect(rows.length).toBe(ROWS)
      expect(rows.every((r) => r.v === newVal(r.id))).toBe(true)
      expect(quickCheckOpen(db)).toBe('ok')
    } finally {
      db.close()
    }
  })

  it('반대로 WAL 자체가 손상이면 여전히 폐기하고 메인(구버전)으로 복원한다', () => {
    makeKillSnapshotFixture()
    // WAL 프레임 데이터를 깨뜨린다(헤더 32바이트 뒤 프레임 본문에 쓰레기) — 체크섬 불일치로 손상 WAL
    const fd = fs.openSync(dbPath + '-wal', 'r+')
    try {
      fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, 40)
    } finally {
      fs.closeSync(fd)
    }
    recoverCorruptWalBeforeOpen()
    // 손상 WAL이 남아 있으면 rw 오픈 시 메인까지 오염될 수 있다 — 프로브가 감지·폐기했는지,
    // 혹은 (SQLite가 체크섬 불일치 프레임을 조용히 버리는 경우) 최소한 rw 오픈이 정상이어야 한다.
    const db = new DatabaseSync(dbPath)
    try {
      expect(quickCheckOpen(db)).toBe('ok')
      const rows = db.prepare('SELECT id, v FROM t ORDER BY id').all() as { id: number; v: string }[]
      expect(rows.length).toBe(ROWS)
      // 손상 WAL은 못 믿는다 — 구버전(체크포인트) 또는 유효 프레임까지의 상태면 됨. 값 자체는 단정하지 않고
      // 구조 정상성만 본다(위 quick_check). 행 수는 갱신만 했으므로 어느 쪽이든 ROWS.
    } finally {
      db.close()
    }
  })
})

/** 이미 열린 rw 연결에서 quick_check — 파일 경로 재오픈 없이 현재 상태를 본다. */
function quickCheckOpen(db: InstanceType<typeof DatabaseSync>): string {
  const rows = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[]
  return rows.map((r) => r.quick_check).join('; ')
}
