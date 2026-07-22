import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  codexSessionDigest,
  codexSessionMeta,
  codexSessionStatus,
  findCodexSessionFile,
  listCodexSessions,
} from '../../src/main/codexsessions'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-codexsessions-'))
const PROJECT = path.join(ROOT, 'repo')
const ID = '019f8a91-2947-7303-9c95-cd74a70458db'

function writeRollout(id = ID, cwd = PROJECT): string {
  const dir = path.join(ROOT, 'sessions', '2026', '07', '23')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-07-23T00-00-00-${id}.jsonl`)
  const rows = [
    { type: 'session_meta', payload: { id, cwd, source: 'cli', model_provider: 'openai' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '첫 작업 지시' }] },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '처리 중' }] },
    },
    { type: 'event_msg', payload: { type: 'agent_message', message: '중복 신호' } },
  ]
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return file
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(PROJECT, { recursive: true })
})
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

describe('Codex rollout 세션 열람', () => {
  it('session_meta cwd/id + 첫 user 제목 + provider를 읽는다', () => {
    const file = writeRollout()
    const meta = codexSessionMeta(file, Date.now())!
    expect(meta).toMatchObject({
      id: ID,
      title: '첫 작업 지시',
      cwd: PROJECT,
      engine: 'codex',
      origin: 'observed',
      provider: 'openai',
      status: 'active',
    })
  })

  it('프로젝트 경계 안 cwd만 최근순으로 나열한다', () => {
    const a = writeRollout(ID, path.join(PROJECT, 'src'))
    writeRollout('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', `${PROJECT}-other`)
    fs.utimesSync(a, new Date(), new Date(Date.now() + 1000))
    const rows = listCodexSessions(PROJECT, 20, path.join(ROOT, 'sessions'))
    expect(rows.map((r) => r.id)).toEqual([ID])
  })

  it('다이제스트는 response_item만 써 event_msg 중복을 피한다', () => {
    writeRollout()
    const text = codexSessionDigest(PROJECT, ID, 6000, path.join(ROOT, 'sessions'))!
    expect(text).toContain('[User] 첫 작업 지시')
    expect(text).toContain('[Codex] 처리 중')
    expect(text).not.toContain('중복 신호')
  })

  it('세션 id·프로젝트 cwd 가드로 교차 열람과 경로 주입을 막는다', () => {
    writeRollout()
    expect(findCodexSessionFile(PROJECT, '..\\secret', path.join(ROOT, 'sessions'))).toBeNull()
    expect(findCodexSessionFile(path.join(ROOT, 'other'), ID, path.join(ROOT, 'sessions'))).toBeNull()
  })

  it('mtime 정지 기준 3상태를 단정 없이 분류한다', () => {
    const now = 1_000_000_000
    expect(codexSessionStatus(now - 30_000, now)).toBe('active')
    expect(codexSessionStatus(now - 10 * 60_000, now)).toBe('recent')
    expect(codexSessionStatus(now - 2 * 86_400_000, now)).toBe('ended')
  })
})
