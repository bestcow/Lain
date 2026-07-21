import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 격리.
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-pcvoicein-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, closeStore, getSettings, saveSettings } from '../../src/main/store'

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

describe('pcVoiceIn 설정', () => {
  it('기본값은 false (마이크 숨김)', () => {
    expect(getSettings().pcVoiceIn).toBe(false)
  })
  it('켜고 끄기가 영속된다', () => {
    saveSettings({ pcVoiceIn: true })
    expect(getSettings().pcVoiceIn).toBe(true)
    saveSettings({ pcVoiceIn: false })
    expect(getSettings().pcVoiceIn).toBe(false)
  })
})
