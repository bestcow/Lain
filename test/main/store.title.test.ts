import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'에서 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 고정(격리).
// (electron mock으로 paths.ts가 평가는 되지만 DATA_DIR=PROJECT_ROOT/data라 공유되므로 직접 mock한다.)
// vi.mock 팩토리는 파일 최상단으로 호이스트되므로, tmp dir 생성도 vi.hoisted로 함께 끌어올린다.
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-store-')) }
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
  createConversation,
  getConversation,
  needsAutoTitle,
  setAutoTitle,
  renameConversation,
} from '../../src/main/store'

beforeAll(() => {
  initStore()
})
afterAll(() => {
  // node:sqlite는 DB 파일을 연 채로 둔다(store.ts에 close 없음) → Windows에서 rm이 EPERM.
  // tmp는 OS가 회수하므로 정리는 best-effort.
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

describe('세션 자동제목 가드 (§ title_auto)', () => {
  it('새 대화는 자동요약 필요(needsAutoTitle=true)', () => {
    const id = createConversation('manager')
    expect(needsAutoTitle(id)).toBe(true)
  })

  it('setAutoTitle: 1회만 적용 — 두 번째는 false·제목 불변(원자 가드)', () => {
    const id = createConversation('manager')
    expect(setAutoTitle(id, '요약 제목')).toBe(true)
    expect(needsAutoTitle(id)).toBe(false)
    // 두 번째 호출 — title_auto=0 행만 UPDATE라 0건 → false
    expect(setAutoTitle(id, '다른 제목')).toBe(false)
  })

  it('setAutoTitle: 공백/빈 제목 → 갱신 안 함(false)', () => {
    const id = createConversation('manager')
    expect(setAutoTitle(id, '   ')).toBe(false)
    expect(setAutoTitle(id, '')).toBe(false)
    expect(needsAutoTitle(id)).toBe(true) // 여전히 미요약
  })

  it('setAutoTitle: 첫 줄만 + trim 먼저 후 30자 절단 (선행 공백이 글자수 먹지 않음)', () => {
    const id = createConversation('manager')
    const long = ' ' + 'ㄱ'.repeat(50) + '\n둘째줄'
    expect(setAutoTitle(id, long)).toBe(true)
    // 되읽어 실제 저장된 제목 검증: 첫 줄만·trim 먼저·정확히 30자(.slice→.trim 순서면 29자 회귀).
    expect(getConversation(id)?.title).toBe('ㄱ'.repeat(30))
    expect(needsAutoTitle(id)).toBe(false)
    expect(setAutoTitle(id, '재시도')).toBe(false)
  })

  it('renameConversation 후 자동요약이 덮지 못함(수동 제목 보호)', () => {
    const id = createConversation('manager')
    renameConversation(id, '수동 제목')
    expect(needsAutoTitle(id)).toBe(false) // title_auto=1 고정
    expect(setAutoTitle(id, '자동요약')).toBe(false)
  })

  it('없는 id → needsAutoTitle=false, setAutoTitle=false', () => {
    expect(needsAutoTitle('no-such-id')).toBe(false)
    expect(setAutoTitle('no-such-id', '제목')).toBe(false)
  })
})
