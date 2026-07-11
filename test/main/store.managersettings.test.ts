import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-ms-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import { initStore, getSettings, saveSettings } from '../../src/main/store'

beforeAll(() => {
  initStore()
})

describe('레인용 settings (권한·작업량·작업방식)', () => {
  it('기본값: acceptEdits / effort high / 자동 ON / fast off / 빠른대화 ON / 작업방식 auto', () => {
    const s = getSettings()
    expect(s.managerPermissionMode).toBe('acceptEdits')
    expect(s.managerEffort).toBe('high')
    expect(s.managerEffortAuto).toBe(true)
    expect(s.managerFastMode).toBe(false)
    expect(s.managerFastChat).toBe(true) // 빠른 대화 레인 기본 on
    expect(s.defaultTaskMode).toBe('auto')
  })

  it('저장 후 로드 라운드트립', () => {
    saveSettings({
      managerPermissionMode: 'bypass',
      managerEffort: 'ultracode',
      managerEffortAuto: false,
      managerFastMode: true,
      managerFastChat: false,
      defaultTaskMode: 'interactive',
    })
    const s = getSettings()
    expect(s.managerPermissionMode).toBe('bypass')
    expect(s.managerEffort).toBe('ultracode')
    expect(s.managerEffortAuto).toBe(false)
    expect(s.managerFastMode).toBe(true)
    expect(s.managerFastChat).toBe(false)
    expect(s.defaultTaskMode).toBe('interactive')
  })

  it('미지 effort는 high 폴백', () => {
    // @ts-expect-error — 잘못된 값 강제 저장 테스트
    saveSettings({ managerEffort: 'garbage' })
    expect(getSettings().managerEffort).toBe('high')
  })
})
