import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// agentskills는 paths(DATA_DIR)와 store(listAgentSkills)만 의존 — 둘 다 모킹해 SQLite 없이 시험.
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-agentskills-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))
const listAgentSkills = vi.hoisted(() => vi.fn(() => [] as any[]))
vi.mock('../../src/main/store', () => ({ listAgentSkills }))

import {
  isValidSkillName,
  readSkillBody,
  writeSkillBody,
  patchSkillBody,
  applyPatch,
  buildSkillsIndex,
  skillsIndexBlock,
  scoreSkillRelevance,
  naviSkillsBlock,
} from '../../src/main/agentskills'
import type { AgentSkillMeta } from '../../src/main/store'

const meta = (name: string, description: string, over: Partial<AgentSkillMeta> = {}): AgentSkillMeta => ({
  name,
  description,
  useCount: 0,
  lastUsedAt: null,
  state: 'active',
  pinned: false,
  createdAt: '2026-07-02 00:00:00',
  updatedAt: '2026-07-02 00:00:00',
  ...over,
})

describe('isValidSkillName — ascii kebab 강제', () => {
  it.each(['deploy', 'lain-deploy-procedure', 'a1-b2', 'x'])('"%s" → true', (n) => {
    expect(isValidSkillName(n)).toBe(true)
  })
  it.each(['', '배포절차', 'Deploy', 'a b', '-lead', 'a/b', '../evil', 'a'.repeat(70)])(
    '"%s" → false',
    (n) => {
      expect(isValidSkillName(n)).toBe(false)
    },
  )
})

describe('스킬 본문 파일 IO — DATA_DIR/skills/<name>/SKILL.md', () => {
  it('write → read 라운드트립, 없는 스킬은 null', () => {
    expect(readSkillBody('no-such')).toBeNull()
    writeSkillBody('deploy-proc', '# 배포 절차\n1. 커밋\n2. deploy_lain')
    expect(readSkillBody('deploy-proc')).toContain('배포 절차')
    expect(fs.existsSync(path.join(DATA_DIR, 'skills', 'deploy-proc', 'SKILL.md'))).toBe(true)
  })

  it('잘못된 이름은 read=null·write=throw(경로 탈출 차단)', () => {
    expect(readSkillBody('../evil')).toBeNull()
    expect(() => writeSkillBody('../evil', 'x')).toThrow()
  })

  it('patchSkillBody — 첫 매치 교체·미매치/무스킬 구분', () => {
    writeSkillBody('patch-me', 'step A then step B')
    expect(patchSkillBody('patch-me', 'step B', 'step C')).toBe('ok')
    expect(readSkillBody('patch-me')).toBe('step A then step C')
    expect(patchSkillBody('patch-me', 'no-match', 'x')).toBe('not-found')
    expect(patchSkillBody('ghost', 'a', 'b')).toBe('no-skill')
  })
})

describe('applyPatch — 순수 부분 문자열 교체', () => {
  it('첫 등장만 교체', () => {
    expect(applyPatch('aa bb aa', 'aa', 'cc')).toBe('cc bb aa')
  })
  it('미매치·빈 old는 null', () => {
    expect(applyPatch('abc', 'zz', 'x')).toBeNull()
    expect(applyPatch('abc', '', 'x')).toBeNull()
  })
})

describe('buildSkillsIndex — 인덱스 조립(cap·stale 표기)', () => {
  it('name — description 줄, cap 적용', () => {
    const idx = buildSkillsIndex([meta('a', 'A 설명'), meta('b', 'B 설명', { state: 'stale' })], 1)
    expect(idx).toBe('- a — A 설명')
    const full = buildSkillsIndex([meta('a', 'A 설명'), meta('b', 'B 설명', { state: 'stale' })])
    expect(full).toContain('- b — B 설명 (오래 미사용)')
  })
})

describe('skillsIndexBlock / naviSkillsBlock — 주입 게이트', () => {
  it('스킬 0개면 빈 문자열(주입 0 — 기존 동작 불변)', () => {
    listAgentSkills.mockReturnValue([])
    expect(skillsIndexBlock()).toBe('')
    expect(naviSkillsBlock('아무 작업')).toBe('')
  })

  it('스킬 있으면 <skills-index> 블록·skill_view 안내 포함', () => {
    listAgentSkills.mockReturnValue([meta('deploy-proc', '배포 절차')])
    const block = skillsIndexBlock()
    expect(block).toContain('<skills-index>')
    expect(block).toContain('deploy-proc — 배포 절차')
    expect(block).toContain('skill_view')
  })

  it('naviSkillsBlock — 작업 내용과 겹치는 스킬만(무관 스킬은 주입 안 함)', () => {
    listAgentSkills.mockReturnValue([
      meta('deploy-proc', '배포 절차 정리'),
      meta('css-theme', '테마 색상 규칙'),
    ])
    const block = naviSkillsBlock('배포 파이프라인을 고쳐라')
    expect(block).toContain('deploy-proc')
    expect(block).not.toContain('css-theme')
    expect(naviSkillsBlock('전혀 무관한 내용')).toBe('')
  })
})

describe('scoreSkillRelevance — 키워드 겹침 스코어(순수)', () => {
  it('name+description 겹침 수를 센다', () => {
    const m = meta('deploy-proc', '배포 절차 정리')
    expect(scoreSkillRelevance(m, '배포 절차')).toBe(2)
    expect(scoreSkillRelevance(m, '무관')).toBe(0)
    expect(scoreSkillRelevance(m, '')).toBe(0)
  })
})
