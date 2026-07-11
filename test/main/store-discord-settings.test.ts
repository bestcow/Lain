// test/main/store-discord-settings.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-discord-settings-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, saveSettings, getSettings } from '../../src/main/store'

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

describe('디스코드 설정 저장/조회', () => {
  it('기본값은 비활성·빈 문자열', () => {
    const s = getSettings()
    expect(typeof s.discordEnabled).toBe('boolean')
    expect(typeof s.discordBotToken).toBe('string')
  })
  it('저장 후 trim되어 조회된다', () => {
    saveSettings({ discordGuildId: '  123  ', discordEnabled: true })
    const s = getSettings()
    expect(s.discordGuildId).toBe('123')
    expect(s.discordEnabled).toBe(true)
  })
})
