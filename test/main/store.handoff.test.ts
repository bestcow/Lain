import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-handoff-')) }
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
  getConversationHandoff,
  setConversationHandoff,
  getSettings,
  saveSettings,
  insertTask,
  updateTask,
  getTask,
  upsertProject,
  addMessage,
  listConversationMessages,
  setManagerViewWindow,
} from '../../src/main/store'

beforeAll(() => initStore())
afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

describe('Navi 유한세션 핸드오프 저장', () => {
  it('새 대화는 핸드오프 없음(null)', () => {
    const id = createConversation('proj-a')
    expect(getConversationHandoff(id)).toBeNull()
  })
  it('set 후 get으로 그대로 반환', () => {
    const id = createConversation('proj-a')
    setConversationHandoff(id, '## 지금 하던 일\n슬림화')
    expect(getConversationHandoff(id)).toBe('## 지금 하던 일\n슬림화')
  })
  it('덮어쓰면 최신값', () => {
    const id = createConversation('proj-a')
    setConversationHandoff(id, 'v1')
    setConversationHandoff(id, 'v2')
    expect(getConversationHandoff(id)).toBe('v2')
  })
})

describe('worker task 유한세션 핸드오프 저장', () => {
  beforeAll(() => {
    // tasks.project_id FK — 프로젝트가 먼저 있어야 insertTask 가능.
    upsertProject({
      id: 'p',
      path: 'C:/tmp/p',
      name: 'p',
      stack: '',
      verifyCmd: null,
      isGit: false,
      enabled: true,
    } as any)
  })
  it('insertTask 후 context_tokens 0·handoff_md null 기본', () => {
    insertTask({ id: 'wt1', projectId: 'p', title: 'T', state: 'working', content: '' })
    const t = getTask('wt1')!
    expect(t.contextTokens).toBe(0)
    expect(t.handoffMd).toBeNull()
  })
  it('updateTask로 context_tokens·handoff_md 라운드트립', () => {
    insertTask({ id: 'wt2', projectId: 'p', title: 'T', state: 'working', content: '' })
    updateTask('wt2', { contextTokens: 42000, handoffMd: '## 지금 하던 일\nX' })
    const t = getTask('wt2')!
    expect(t.contextTokens).toBe(42000)
    expect(t.handoffMd).toBe('## 지금 하던 일\nX')
  })
})

describe('단일 세션 화면 정리 — visible_from_id 워터마크', () => {
  it('기본은 전부 보임(visible_from_id=0)', () => {
    const id = createConversation('manager')
    for (let i = 0; i < 10; i++) addMessage('manager', 'user', `m${i}`, id)
    expect(listConversationMessages(id, 500).length).toBe(10)
  })
  it('메시지 < keepRecent면 워터마크 no-op(전부 보임)', () => {
    const id = createConversation('manager')
    for (let i = 0; i < 5; i++) addMessage('manager', 'user', `m${i}`, id)
    setManagerViewWindow(id, 40)
    expect(listConversationMessages(id, 500).length).toBe(5)
  })
  it('메시지 > keepRecent면 최근 keepRecent개만 보임(오래된 건 숨김·DB 보존)', () => {
    const id = createConversation('manager')
    for (let i = 0; i < 50; i++) addMessage('manager', 'user', `m${i}`, id)
    setManagerViewWindow(id, 40)
    const visible = listConversationMessages(id, 500)
    expect(visible.length).toBe(40)
    expect(visible[0].content).toBe('m10') // 오래된 m0~m9 숨김, 최근 40(m10~m49)
    expect(visible[visible.length - 1].content).toBe('m49')
  })
  it('keepRecent=0이면 전부 숨김(계약 정합성)', () => {
    const id = createConversation('manager')
    for (let i = 0; i < 5; i++) addMessage('manager', 'user', `m${i}`, id)
    setManagerViewWindow(id, 0)
    expect(listConversationMessages(id, 500).length).toBe(0)
  })
})

describe('naviHandoffThreshold 설정', () => {
  it('기본값 150000', () => {
    expect(getSettings().naviHandoffThreshold).toBe(150000)
  })
  it('저장 라운드트립(음수·소수는 보정)', () => {
    saveSettings({ naviHandoffThreshold: 80000 })
    expect(getSettings().naviHandoffThreshold).toBe(80000)
    saveSettings({ naviHandoffThreshold: 0 })
    expect(getSettings().naviHandoffThreshold).toBe(0)
  })
})

describe('turnWatchdogMin 설정 (무진전 자동종료 임계)', () => {
  it('기본값 10분', () => {
    expect(getSettings().turnWatchdogMin).toBe(10)
  })
  it('저장 라운드트립', () => {
    saveSettings({ turnWatchdogMin: 10 })
    expect(getSettings().turnWatchdogMin).toBe(10)
  })
  it('0(끔)을 저장·복원한다', () => {
    saveSettings({ turnWatchdogMin: 0 })
    expect(getSettings().turnWatchdogMin).toBe(0)
  })
  it('음수·소수는 보정(0 이상 정수)', () => {
    saveSettings({ turnWatchdogMin: -3 })
    expect(getSettings().turnWatchdogMin).toBe(0)
    saveSettings({ turnWatchdogMin: 7.9 })
    expect(getSettings().turnWatchdogMin).toBe(7)
  })
})
