// test/main/store-discord-origin.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-discord-origin-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, addMessage, listConversationMessages, ensureActiveConversation } from '../../src/main/store'

beforeAll(() => {
  initStore()
})
afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

describe("messages origin='discord'", () => {
  it('discord 출처로 저장하면 조회 시 origin=discord', () => {
    const conv = ensureActiveConversation('manager')
    addMessage('manager', 'user', '통화테스트', conv, [], 'discord')
    const msgs = listConversationMessages(conv)
    expect(msgs.at(-1)?.origin).toBe('discord')
  })
})
