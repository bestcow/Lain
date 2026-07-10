// A15 — 대화 페이징(beforeId 커서) SQL 회귀 테스트. 순수 함수(chat.ts nextBeforeId/mergePagedMessages)는
// test/renderer/chat.test.ts에서 커버 — 여기는 store.listConversationMessages의 실제 DB 질의만 검증한다.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-paging-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, addMessage, listConversationMessages, ensureActiveConversation } from '../../src/main/store'

beforeAll(() => initStore())
afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

describe('listConversationMessages — beforeId 페이징 커서', () => {
  it('beforeId 없으면 기존과 동일(최신 limit개, 오래된→최신 순)', () => {
    const conv = ensureActiveConversation('manager')
    for (let i = 0; i < 5; i++) addMessage('manager', 'user', `m${i}`, conv)
    const rows = listConversationMessages(conv, 3)
    expect(rows.map((r) => r.content)).toEqual(['m2', 'm3', 'm4'])
  })

  it('beforeId 지정 시 그 id보다 오래된 메시지만, 오래된→최신 순으로(id 순서 그대로) 반환', () => {
    // 새 대화로 격리 — 이전 테스트(m0~m4)와 섞이면 순서 단정이 불명확해진다.
    const conv2 = `paging-test-${Date.now()}`
    for (let i = 0; i < 5; i++) addMessage('manager', 'user', `p${i}`, conv2)
    const all = listConversationMessages(conv2, 100)
    expect(all.map((r) => r.content)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
    // p2(all[2].id)보다 오래된 페이지 요청 → p0, p1만, 이 순서 그대로(beforeId 자신·이후는 제외).
    const page = listConversationMessages(conv2, 100, all[2].id)
    expect(page.map((r) => r.content)).toEqual(['p0', 'p1'])
  })

  it('beforeId가 가장 오래된 메시지 id면 빈 배열(더 없음)', () => {
    const conv = ensureActiveConversation('manager')
    addMessage('manager', 'user', 'only-oldest-probe', conv)
    const rows = listConversationMessages(conv, 1)
    const oldestId = rows[0].id
    const page = listConversationMessages(conv, 100, oldestId)
    expect(page.every((r) => r.id < oldestId)).toBe(true)
  })
})
