import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os'); const fsh = require('node:fs'); const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-plan-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR, PROJECT_ROOT: process.cwd(), AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'), CLAUDE_BIN: 'claude',
}))
import {
  initStore, closeStore, listPlanItems, upsertPlanItem, setPlanItemDone, archivePlanItem,
  markPlanReminded, snoozePlanItem, listPlanTags, upsertPlanTag, deletePlanTag,
  listPlanSections, upsertPlanSection, deletePlanSection, getSettings, saveSettings,
} from '../../src/main/store'

beforeAll(() => initStore())
afterAll(() => { try { closeStore() } catch {} ; try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch {} })

describe('플래너 store CRUD', () => {
  it('item upsert→list→done→archive 라운드트립', () => {
    const id = upsertPlanItem({ kind: 'event', title: '미팅', startAt: '2026-07-06T15:00' })
    expect(listPlanItems().find((i) => i.id === id)?.title).toBe('미팅')
    upsertPlanItem({ id, kind: 'event', title: '미팅(수정)', startAt: '2026-07-06T16:00' })
    expect(listPlanItems().find((i) => i.id === id)?.startAt).toBe('2026-07-06T16:00')
    setPlanItemDone(id, true)
    expect(listPlanItems().find((i) => i.id === id)?.done).toBe(true)
    archivePlanItem(id)
    expect(listPlanItems().some((i) => i.id === id)).toBe(false) // 기본 미포함
    expect(listPlanItems(true).some((i) => i.id === id)).toBe(true) // 보관 포함 조회
  })
  it('todo는 startAt 없이 저장되고 마감일도 붙일 수 있다', () => {
    const id = upsertPlanItem({ kind: 'todo', title: '해커톤 탐색', body: 'https://example.com' })
    const row = listPlanItems().find((i) => i.id === id)!
    expect(row.startAt).toBeNull()
    upsertPlanItem({ id, kind: 'todo', title: '해커톤 탐색', startAt: '2026-07-10T00:00', allDay: true })
    expect(listPlanItems().find((i) => i.id === id)?.allDay).toBe(true)
  })
  it('리마인드 상태 전이: snooze → mark', () => {
    const id = upsertPlanItem({ kind: 'event', title: 'r', startAt: '2026-07-06T15:00' })
    snoozePlanItem(id, '2026-07-06T14:55')
    let row = listPlanItems().find((i) => i.id === id)!
    expect(row.snoozeUntil).toBe('2026-07-06T14:55')
    expect(row.remindSentAt).toBeNull()
    markPlanReminded(id, '2026-07-06T15:00')
    row = listPlanItems().find((i) => i.id === id)!
    expect(row.remindSentAt).toBe('2026-07-06T15:00')
    expect(row.snoozeUntil).toBeNull()
  })
  it('태그·섹션 CRUD + 삭제 시 항목 FK NULL', () => {
    const tg = upsertPlanTag({ name: '개발', color: '#b18cf0' })
    const sc = upsertPlanSection({ name: '이번 주' })
    const id = upsertPlanItem({ kind: 'todo', title: 'x', tagId: tg, sectionId: sc })
    deletePlanTag(tg); deletePlanSection(sc)
    const row = listPlanItems().find((i) => i.id === id)!
    expect(row.tagId).toBeNull(); expect(row.sectionId).toBeNull()
    expect(listPlanTags()).toHaveLength(0); expect(listPlanSections()).toHaveLength(0)
  })
  it('플래너 설정 기본값', () => {
    const s = getSettings()
    expect(s.plannerDefaultView).toBe('month'); expect(s.plannerRemindDefaultMin).toBe(10)
    expect(s.plannerStaleDays).toBe(7); expect(s.plannerInBriefing).toBe(true)
  })
  it('setPlanItemDone은 done_at을 로컬 ISO YYYY-MM-DDTHH:mm 포맷으로 저장한다', () => {
    const id = upsertPlanItem({ kind: 'todo', title: '완료테스트' })
    setPlanItemDone(id, true)
    const row = listPlanItems().find((i) => i.id === id)!
    expect(row.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
  it('plannerRemindDefaultMin=0(즉시 알림)은 폴백에 삼켜지지 않고 보존된다', () => {
    saveSettings({ plannerRemindDefaultMin: 0 })
    expect(getSettings().plannerRemindDefaultMin).toBe(0)
  })
})
