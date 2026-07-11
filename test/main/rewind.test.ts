import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// rewind는 paths.DATA_DIR 아래(checkpoints/)에 스냅샷을 쓴다 — 테스트 고유 tmp로 격리(registry.dedup 패턴).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-rewind-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, closeStore, editCheckpointsForTurn } from '../../src/main/store'
import {
  checkpointEdit,
  turnEditSummary,
  revertTurn,
  cleanupCheckpoints,
} from '../../src/main/rewind'

let work: string // 편집 대상 파일들을 두는 작업 폴더(체크포인트 폴더와 별개)

beforeAll(() => {
  initStore()
  work = fs.mkdtempSync(path.join(DATA_DIR, 'work-'))
})
afterAll(() => {
  try {
    closeStore()
  } catch {
    /* 잠금 무시 */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* 무시 */
  }
})

describe('D15 되감기 — 체크포인트·복원', () => {
  it('Edit 체크포인트 후 수정 → revertTurn이 원본 내용 복원', () => {
    const fp = path.join(work, 'a.txt')
    fs.writeFileSync(fp, '원본 내용', 'utf8')
    checkpointEdit('t100', 'conv1', 'Edit', { file_path: fp, old_string: '원본', new_string: '수정' })
    fs.writeFileSync(fp, '수정된 내용', 'utf8') // 도구 실행을 흉내
    const r = revertTurn('t100')
    expect(r.ok).toBe(true)
    expect(r.restored).toBe(1)
    expect(fs.readFileSync(fp, 'utf8')).toBe('원본 내용')
  })

  it('편집 전 없던 파일(Write 신규) → 복원 = 삭제', () => {
    const fp = path.join(work, 'new.txt')
    expect(fs.existsSync(fp)).toBe(false)
    checkpointEdit('t200', 'conv1', 'Write', { file_path: fp, content: '새 파일' })
    fs.writeFileSync(fp, '새 파일', 'utf8')
    const rows = editCheckpointsForTurn('t200')
    expect(rows.length).toBe(1)
    expect(rows[0].backupPath).toBeNull()
    const r = revertTurn('t200')
    expect(r.ok).toBe(true)
    expect(fs.existsSync(fp)).toBe(false)
  })

  it('같은 파일 여러 번 편집한 턴 → 파일별 최초(pre-turn) 상태로 복원', () => {
    const fp = path.join(work, 'multi.txt')
    fs.writeFileSync(fp, 'v0', 'utf8')
    checkpointEdit('t300', 'conv1', 'Edit', { file_path: fp })
    fs.writeFileSync(fp, 'v1', 'utf8')
    checkpointEdit('t300', 'conv1', 'Edit', { file_path: fp })
    fs.writeFileSync(fp, 'v2', 'utf8')
    expect(turnEditSummary('t300')).toEqual([{ filePath: fp, existed: true }])
    const r = revertTurn('t300')
    expect(r.ok).toBe(true)
    expect(r.restored).toBe(1) // 파일 단위 1건
    expect(fs.readFileSync(fp, 'utf8')).toBe('v0')
  })

  it('복원 직전 상태가 revertTurnId 그룹으로 남아 되돌리기의 되돌리기가 된다', () => {
    const fp = path.join(work, 'undo.txt')
    fs.writeFileSync(fp, '처음', 'utf8')
    checkpointEdit('t400', 'conv1', 'Edit', { file_path: fp })
    fs.writeFileSync(fp, '레인이 고침', 'utf8')
    const r1 = revertTurn('t400')
    expect(fs.readFileSync(fp, 'utf8')).toBe('처음')
    expect(r1.revertTurnId).toBeTruthy()
    const r2 = revertTurn(r1.revertTurnId!)
    expect(r2.ok).toBe(true)
    expect(fs.readFileSync(fp, 'utf8')).toBe('레인이 고침')
  })

  it('체크포인트 없는 턴 복원은 실패 메시지', () => {
    const r = revertTurn('t-none')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('체크포인트가 없다')
  })

  it('시크릿 파일(.env)은 체크포인트 자체를 뜨지 않는다(§9-6 이중 방어)', () => {
    const fp = path.join(work, '.env')
    fs.writeFileSync(fp, 'KEY=secret', 'utf8')
    checkpointEdit('t500', 'conv1', 'Edit', { file_path: fp })
    expect(editCheckpointsForTurn('t500').length).toBe(0)
  })

  it('상대경로·file_path 없음은 무시', () => {
    checkpointEdit('t600', 'conv1', 'Edit', { file_path: 'relative/x.txt' })
    checkpointEdit('t600', 'conv1', 'Edit', {})
    checkpointEdit('t600', 'conv1', 'Bash', { command: 'echo' }) // Edit/Write 외 도구
    expect(editCheckpointsForTurn('t600').length).toBe(0)
  })

  it('보존 정리 — 14일 지난 턴은 행·스냅샷 폴더 모두 삭제', () => {
    const fp = path.join(work, 'old.txt')
    fs.writeFileSync(fp, '옛날', 'utf8')
    checkpointEdit('t700', 'conv1', 'Edit', { file_path: fp })
    expect(editCheckpointsForTurn('t700').length).toBe(1)
    const backup = editCheckpointsForTurn('t700')[0].backupPath!
    expect(fs.existsSync(backup)).toBe(true)
    // now를 15일 뒤로 주입 — created_at(지금)이 보존 기간을 넘긴 것으로 판정된다
    cleanupCheckpoints(Date.now() + 15 * 86_400_000)
    expect(editCheckpointsForTurn('t700').length).toBe(0)
    expect(fs.existsSync(backup)).toBe(false)
  })
})

// 재리뷰 #4 — '복원의 복원' 카드 소스: revertTurn이 복원 파일 목록과 conversationId를 반환해야
// ipc가 revertTurnId를 실은 카드를 채팅에 남길 수 있다(없으면 un-revert 진입점이 UI에 존재하지 않는다).
describe('revertTurn — un-revert 카드 소스(#4)', () => {
  it('files(파일 목록)와 conversationId를 반환한다', () => {
    const fp = path.join(work, 'card.txt')
    fs.writeFileSync(fp, '원본', 'utf8')
    checkpointEdit('t800', 'conv-card', 'Edit', { file_path: fp })
    fs.writeFileSync(fp, '수정', 'utf8')
    const r = revertTurn('t800')
    expect(r.ok).toBe(true)
    expect(r.files).toEqual([fp])
    expect(r.conversationId).toBe('conv-card')
    expect(r.revertTurnId).toBeTruthy()
  })
})
