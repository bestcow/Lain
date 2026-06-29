// 프로젝트 컨벤션 주입 — 프로젝트 루트 + 상위 디렉터리의 컨벤션 md를 모으는 순수 fs 로직.
// 임시 디렉터리 트리로 '프로젝트 CLAUDE.md + 상위 CONVENTIONS.md' 수집·순서·상한·빈경우를 못박는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConventions, conventionsBlock } from '../../src/main/conventions'

let root: string
let proj: string

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-conv-'))
  proj = path.join(root, 'apps', 'proj')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(root, 'CONVENTIONS.md'), 'WS_CONVENTIONS_MARK', 'utf8') // 상위(워크스페이스)
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'PROJ_RULES_MARK', 'utf8') // 프로젝트 루트
})
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* 무시 */
  }
})

describe('loadConventions', () => {
  it('프로젝트 CLAUDE.md + 상위 CONVENTIONS.md를 함께 모은다', () => {
    const c = loadConventions(proj)
    expect(c).toContain('PROJ_RULES_MARK')
    expect(c).toContain('WS_CONVENTIONS_MARK')
  })

  it('가까운(프로젝트) 컨벤션이 상위보다 먼저 온다', () => {
    const c = loadConventions(proj)
    expect(c.indexOf('PROJ_RULES_MARK')).toBeLessThan(c.indexOf('WS_CONVENTIONS_MARK'))
  })

  it('컨벤션 파일이 없으면 빈 문자열', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-conv-empty-'))
    try {
      expect(loadConventions(empty)).toBe('')
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  it('빈 경로는 빈 문자열', () => {
    expect(loadConventions('')).toBe('')
  })
})

describe('conventionsBlock', () => {
  it('내용이 있으면 <프로젝트 컨벤션>으로 감싼다', () => {
    const b = conventionsBlock(proj)
    expect(b).toContain('<프로젝트 컨벤션>')
    expect(b).toContain('PROJ_RULES_MARK')
  })

  it('내용이 없으면 빈 문자열(빈 블록 주입 방지)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-conv-empty2-'))
    try {
      expect(conventionsBlock(empty)).toBe('')
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})
