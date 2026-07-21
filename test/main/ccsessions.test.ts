// CC 세션 열람(ccsessions.ts) — 실측 jsonl 구조(2026-07-13, CC 2.1.205) 기반 픽스처로
// 슬러그 매핑·워크트리 포함·메타(제목/첫 메시지)·다이제스트(사이드체인 제외·최근 우선)·id 형식 가드를 박제.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  ccSlugFor,
  ccDirsFor,
  ccSessionMeta,
  listCcSessions,
  findCcSessionFile,
  ccSessionDigest,
} from '../../src/main/ccsessions'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-ccs-'))
const PROJECT = 'C:\\dev\\blog'
const SLUG = 'C--dev-blog'

function writeSession(dir: string, id: string, lines: object[]): string {
  const d = path.join(ROOT, dir)
  fs.mkdirSync(d, { recursive: true })
  const f = path.join(d, `${id}.jsonl`)
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return f
}

const userLine = (text: string, extra: object = {}) => ({
  type: 'user',
  message: { role: 'user', content: text },
  cwd: PROJECT,
  entrypoint: 'claude-desktop',
  gitBranch: 'main',
  isSidechain: false,
  ...extra,
})
const asstLine = (text: string, extra: object = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  cwd: PROJECT,
  isSidechain: false,
  ...extra,
})

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
})
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

describe('ccSlugFor / ccDirsFor', () => {
  it('영숫자 외 전부 - 로(실측 규칙)', () => {
    expect(ccSlugFor('C:\\lain\\.claude\\worktrees\\epic-1482b4')).toBe(
      'C--lain--claude-worktrees-epic-1482b4',
    )
    expect(ccSlugFor(PROJECT)).toBe(SLUG)
  })
  it('프로젝트 루트 + 그 워크트리 폴더만 잡는다(다른 프로젝트 제외)', () => {
    writeSession(SLUG, 'aaaa-1111', [userLine('hi')])
    writeSession(`${SLUG}--claude-worktrees-foo-abc123`, 'bbbb-2222', [userLine('wt')])
    writeSession('C--dev-blog2', 'cccc-3333', [userLine('other')]) // 접두 유사 — 제외돼야
    const dirs = ccDirsFor(PROJECT, ROOT).map((d) => path.basename(d))
    expect(dirs.sort()).toEqual([SLUG, `${SLUG}--claude-worktrees-foo-abc123`])
  })
})

describe('ccSessionMeta / listCcSessions', () => {
  it('custom-title(꼬리)이 제목, 없으면 첫 user 텍스트 머리', () => {
    const f1 = writeSession(SLUG, 'aaaa-1111', [
      userLine('블로그 다크모드 만들어줘'),
      asstLine('시작합니다'),
      { type: 'custom-title', customTitle: '다크모드 작업' },
    ])
    const f2 = writeSession(SLUG, 'bbbb-2222', [userLine('README 정리해줘'), asstLine('네')])
    expect(ccSessionMeta(f1)?.title).toBe('다크모드 작업')
    expect(ccSessionMeta(f1)?.entrypoint).toBe('claude-desktop')
    expect(ccSessionMeta(f2)?.title).toBe('README 정리해줘')
    expect(ccSessionMeta(f2)?.cwd).toBe(PROJECT)
  })
  it('목록은 최근 수정순 + 워크트리 세션 포함, 채팅 없는 파일은 제외', () => {
    writeSession(SLUG, 'aaaa-1111', [userLine('old')])
    writeSession(`${SLUG}--claude-worktrees-x-1`, 'bbbb-2222', [userLine('wt-session')])
    writeSession(SLUG, 'meta-only', [{ type: 'queue-operation', operation: 'enqueue' }])
    // mtime 차이 보장
    const newer = path.join(ROOT, SLUG, 'aaaa-1111.jsonl')
    fs.utimesSync(newer, new Date(), new Date(Date.now() + 5000))
    const rows = listCcSessions(PROJECT, 20, ROOT)
    expect(rows.map((r) => r.id)).toEqual(['aaaa-1111', 'bbbb-2222'])
  })
})

describe('findCcSessionFile / ccSessionDigest', () => {
  it('세션 id 형식이 아니면(경로 주입 등) null', () => {
    writeSession(SLUG, 'aaaa-1111', [userLine('hi')])
    expect(findCcSessionFile(PROJECT, '..\\..\\etc\\passwd', ROOT)).toBeNull()
    expect(findCcSessionFile(PROJECT, 'aaaa-1111', ROOT)).not.toBeNull()
  })
  it('다이제스트는 user/assistant 텍스트만, 사이드체인 제외, 시간순', () => {
    writeSession(SLUG, 'aaaa-1111', [
      userLine('첫 질문'),
      asstLine('첫 답변'),
      asstLine('사이드체인 답변', { isSidechain: true }),
      { type: 'queue-operation', operation: 'enqueue', content: '메타 줄' },
      userLine('둘째 질문'),
      asstLine('둘째 답변'),
    ])
    const d = ccSessionDigest(PROJECT, 'aaaa-1111', 6000, ROOT)!
    expect(d).toContain('[User] 첫 질문')
    expect(d).toContain('[Claude] 둘째 답변')
    expect(d).not.toContain('사이드체인')
    expect(d).not.toContain('메타 줄')
    expect(d.indexOf('첫 질문')).toBeLessThan(d.indexOf('둘째 답변'))
  })
  it('글자 상한이 있어도 가장 최근 맥락은 항상 포함', () => {
    const lines = [] as object[]
    for (let i = 0; i < 50; i++) lines.push(userLine(`질문 ${i} ${'x'.repeat(200)}`))
    lines.push(asstLine('마지막 결론'))
    writeSession(SLUG, 'aaaa-1111', lines)
    const d = ccSessionDigest(PROJECT, 'aaaa-1111', 1500, ROOT)!
    expect(d).toContain('마지막 결론')
    expect(d).not.toContain('질문 0 ')
  })
})
