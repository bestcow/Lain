import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'

vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(process.cwd(), 'data'),
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { parseSessionCallback, sessionLabel } from '../../src/main/telegram'

describe('parseSessionCallback — 세션 선택 콜백 파싱', () => {
  it("'c|new' → 새 세션", () => {
    expect(parseSessionCallback('c|new')).toEqual({ kind: 'new' })
  })
  it("'c|<convId>' → 그 세션 선택", () => {
    expect(parseSessionCallback('c|abc-123')).toEqual({ kind: 'pick', id: 'abc-123' })
  })
  it('승인/결재 콜백·빈 id는 세션 콜백 아님 → null', () => {
    expect(parseSessionCallback('a12y')).toBeNull()
    expect(parseSessionCallback('r|merge|t1')).toBeNull()
    expect(parseSessionCallback('c|')).toBeNull()
    expect(parseSessionCallback('')).toBeNull()
  })
})

describe('sessionLabel — 버튼 라벨', () => {
  it('제목이 있으면 제목(40자 절단, 개행 제거)', () => {
    expect(sessionLabel({ title: '배포 관련 대화', lastContent: '뭐든' })).toBe('배포 관련 대화')
    expect(sessionLabel({ title: 'a'.repeat(50), lastContent: null })).toHaveLength(40)
    expect(sessionLabel({ title: '줄1\n줄2', lastContent: null })).toBe('줄1 줄2')
  })
  it('제목이 비면 마지막 메시지 미리보기로 폴백', () => {
    expect(sessionLabel({ title: '', lastContent: '안녕 레인' })).toBe('안녕 레인')
    expect(sessionLabel({ title: '   ', lastContent: '폴백됨' })).toBe('폴백됨')
  })
  it('제목·미리보기 둘 다 없으면 (새 대화)', () => {
    expect(sessionLabel({ title: '', lastContent: null })).toBe('(새 대화)')
  })
})
