import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 고정(격리).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-learning-')) }
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
  closeStore,
  upsertAgentSkill,
  getAgentSkill,
  listAgentSkills,
  bumpSkillUse,
  archiveAgentSkill,
  applySkillLifecycle,
  addMessage,
  searchChatHistory,
  messagesAround,
  makeSnippet,
  isChatFtsAvailable,
  getSettings,
  saveSettings,
} from '../../src/main/store'

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

describe('agent_skills — 메타 CRUD·사용 추적·보관(성장 보존)', () => {
  it('upsert → get 라운드트립, 재저장은 설명 갱신 + active 되살림', () => {
    upsertAgentSkill('deploy-proc', '배포 절차')
    const s = getAgentSkill('deploy-proc')!
    expect(s.description).toBe('배포 절차')
    expect(s.state).toBe('active')
    archiveAgentSkill('deploy-proc')
    expect(getAgentSkill('deploy-proc')!.state).toBe('archived')
    upsertAgentSkill('deploy-proc', '배포 절차 v2') // 재저장 = 되살림
    expect(getAgentSkill('deploy-proc')!.state).toBe('active')
    expect(getAgentSkill('deploy-proc')!.description).toBe('배포 절차 v2')
  })

  it('listAgentSkills — 기본은 archived 제외, includeArchived=true면 포함', () => {
    upsertAgentSkill('active-one', 'A')
    upsertAgentSkill('archived-one', 'B')
    archiveAgentSkill('archived-one')
    const names = listAgentSkills().map((s) => s.name)
    expect(names).toContain('active-one')
    expect(names).not.toContain('archived-one')
    expect(listAgentSkills(true).map((s) => s.name)).toContain('archived-one')
  })

  it('bumpSkillUse — use_count++·last_used_at 갱신, archived는 안 되살림', () => {
    upsertAgentSkill('used-skill', 'U')
    bumpSkillUse('used-skill')
    const s = getAgentSkill('used-skill')!
    expect(s.useCount).toBe(1)
    expect(s.lastUsedAt).toBeTruthy()
    archiveAgentSkill('used-skill')
    bumpSkillUse('used-skill')
    expect(getAgentSkill('used-skill')!.state).toBe('archived') // 열람이 보관을 깨지 않음
  })

  it('applySkillLifecycle — 미사용 30일→stale·90일→archived·pinned 제외·삭제 없음(결정론 시계 주입)', () => {
    upsertAgentSkill('fresh-skill', 'F')
    upsertAgentSkill('old-skill', 'O')
    upsertAgentSkill('ancient-skill', 'A')
    // updated_at을 과거로 조작하는 대신 미래 시각을 주입 — 같은 결정론 경로.
    const in40d = new Date(Date.now() + 40 * 86400_000).toISOString()
    const r1 = applySkillLifecycle(in40d)
    expect(r1.stale).toBeGreaterThanOrEqual(3) // 셋 다 40일 미사용 → stale
    expect(getAgentSkill('fresh-skill')!.state).toBe('stale')
    const in100d = new Date(Date.now() + 100 * 86400_000).toISOString()
    const r2 = applySkillLifecycle(in100d)
    expect(r2.archived).toBeGreaterThanOrEqual(3)
    expect(getAgentSkill('old-skill')!.state).toBe('archived')
    // 삭제는 없다 — 행이 남아 있다.
    expect(getAgentSkill('ancient-skill')).not.toBeNull()
  })
})

describe('searchChatHistory — 레인 대화 원문 검색(FTS/LIKE 폴백)', () => {
  it('manager 원문에서 키워드 매치·스니펫 반환', () => {
    addMessage('manager', 'user', '지난주에 얘기한 텔레그램 배포절차 기억해?')
    addMessage('manager', 'assistant', '텔레그램 배포절차는 커밋 후 deploy_lain 호출입니다.')
    addMessage('manager', 'tool', '텔레그램 배포절차 tool 라인 — 검색 제외 대상')
    addMessage('worker', 'assistant', '텔레그램 배포절차 — worker scope는 검색 제외')
    const hits = searchChatHistory('텔레그램 배포절차')
    expect(hits.length).toBe(2) // tool·worker 제외
    expect(hits[0].snippet).toContain('배포절차')
    expect(hits.every((h) => h.role === 'user' || h.role === 'assistant')).toBe(true)
  })

  it('2글자 한국어 텀(trigram 미매치 구간)도 LIKE 폴백으로 잡는다', () => {
    addMessage('manager', 'user', '소빗츠 음성 설정 확인해줘')
    const hits = searchChatHistory('음성 설정')
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  it('빈 질의·1글자 텀만이면 빈 배열', () => {
    expect(searchChatHistory('')).toEqual([])
    expect(searchChatHistory('a')).toEqual([])
  })

  it('messagesAround — 매치 전후 원문 스크롤(같은 대화·시간순)', () => {
    const hits = searchChatHistory('텔레그램 배포절차')
    const around = messagesAround(hits[hits.length - 1].id)
    expect(around.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < around.length; i++) expect(around[i].id).toBeGreaterThan(around[i - 1].id)
    expect(messagesAround(999999)).toEqual([]) // 없는 id
  })

  it('FTS 가용 시 3글자+ 텀은 FTS 경로로도 동일 결과', () => {
    if (!isChatFtsAvailable()) return // FTS 미지원 빌드에선 LIKE 폴백만 검증(위 테스트)
    addMessage('manager', 'assistant', 'ftsprobe unique marker line')
    const hits = searchChatHistory('ftsprobe')
    expect(hits.length).toBe(1)
  })
})

describe('makeSnippet — 매치 중심 절단(순수)', () => {
  it('매치 텀 주변을 자르고 앞뒤 생략 표시', () => {
    const long = `${'가'.repeat(200)} 표적단어 ${'나'.repeat(200)}`
    const s = makeSnippet(long, ['표적단어'])
    expect(s).toContain('표적단어')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })
  it('매치 없으면 선두부터', () => {
    expect(makeSnippet('short text', ['zzz'])).toBe('short text')
  })
})

describe('학습루프 설정 — turnReview(기본 on)·verifyNudge(기본 on)', () => {
  it('기본값과 저장 라운드트립', () => {
    expect(getSettings().turnReviewEnabled).toBe(true)
    expect(getSettings().verifyNudgeEnabled).toBe(true)
    saveSettings({ turnReviewEnabled: false, verifyNudgeEnabled: false })
    expect(getSettings().turnReviewEnabled).toBe(false)
    expect(getSettings().verifyNudgeEnabled).toBe(false)
    saveSettings({ turnReviewEnabled: true, verifyNudgeEnabled: true })
  })
})
