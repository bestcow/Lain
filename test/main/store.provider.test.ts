import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-provider-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import {
  getSettings,
  getTask,
  initStore,
  insertTask,
  saveSettings,
  updateTask,
  upsertProject,
} from '../../src/main/store'

beforeAll(() => {
  initStore()
  upsertProject({ id: 'p', path: 'C:/tmp/p', name: 'p', stack: '', verifyCmd: null, isGit: true } as any)
})
afterAll(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* sqlite lock */ }
})

describe('프로바이더 설정·task 왕복', () => {
  const profile = {
    id: 'deepseek',
    label: 'DeepSeek V4 Pro',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authToken: 'secret-token',
    modelId: 'deepseek-v4-pro[1m]',
  }

  it('기본은 완전 OFF다', () => {
    const s = getSettings()
    expect(s.defaultTaskEngine).toBe('claude')
    expect(s.codexLinkEnabled).toBe(false)
    expect(s.providerSwapEnabled).toBe(false)
    expect(s.providerProfiles).toEqual([])
    expect(s.defaultProvider).toBe('')
  })

  it('엔진 기본값과 Codex 링크 토글을 라운드트립한다', () => {
    saveSettings({ defaultTaskEngine: 'codex', codexLinkEnabled: true })
    expect(getSettings()).toMatchObject({ defaultTaskEngine: 'codex', codexLinkEnabled: true })
    saveSettings({ defaultTaskEngine: 'claude', codexLinkEnabled: false })
  })

  it('프로필과 기본값을 저장하고 작업에 provider id를 보존한다', () => {
    saveSettings({ providerSwapEnabled: true, providerProfiles: [profile], defaultProvider: profile.id })
    expect(getSettings()).toMatchObject({
      providerSwapEnabled: true,
      providerProfiles: [profile],
      defaultProvider: 'deepseek',
    })
    insertTask({ id: 't', projectId: 'p', title: 't', state: 'clarifying', content: 'c', provider: 'deepseek' })
    expect(getTask('t')!.provider).toBe('deepseek')
    updateTask('t', { provider: null })
    expect(getTask('t')!.provider).toBeNull()
  })
})
