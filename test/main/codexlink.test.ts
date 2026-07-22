import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CODEX_NOTIFY_SCRIPT_SOURCE,
  installCodexLink,
  mergeCodexNotifyConfig,
  stripCodexNotifyConfig,
  uninstallCodexLink,
} from '../../src/main/codexlink'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-codexlink-'))

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
})
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

describe('Codex config.toml 마커 편집', () => {
  it('최상단에 마커 블록을 멱등 삽입하고 기존 설정을 보존한다', () => {
    const first = mergeCodexNotifyConfig('model = "gpt-5"\n', 'C:\\x\\notify.cjs')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.text.startsWith('# lain-codex-link begin')).toBe(true)
    expect(first.text).toContain('model = "gpt-5"')
    const second = mergeCodexNotifyConfig(first.text, 'C:\\new\\notify.cjs')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.text.match(/lain-codex-link begin/g)).toHaveLength(1)
    expect(second.text).toContain('C:\\\\new\\\\notify.cjs')
  })

  it('사용자의 기존 notify가 있으면 fail-closed로 설치를 거부한다', () => {
    const out = mergeCodexNotifyConfig('notify = ["my-hook"]\nmodel="x"\n', 'x.cjs')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('기존 notify')
  })

  it('제거는 우리 블록만 지우고 나머지를 그대로 남긴다', () => {
    const merged = mergeCodexNotifyConfig('model = "x"\n', 'x.cjs')
    if (!merged.ok) throw new Error('fixture')
    expect(stripCodexNotifyConfig(merged.text)).toBe('model = "x"\n')
  })

  it('기존 파일의 선행 공백·주석도 설치 후 제거하면 바이트 그대로 복원한다', () => {
    const original = '\n# user comment\nmodel = "x"\n'
    const merged = mergeCodexNotifyConfig(original, 'x.cjs')
    if (!merged.ok) throw new Error('fixture')
    expect(stripCodexNotifyConfig(merged.text)).toBe(original)
  })

  it('최초 수정 전 백업을 만들고 재설치 때 덮지 않으며, 언인스톨은 마커만 제거한다', () => {
    const config = path.join(ROOT, '.codex', 'config.toml')
    const link = path.join(ROOT, 'link')
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.writeFileSync(config, 'model = "one"\n', 'utf8')
    expect(installCodexLink(config, link).ok).toBe(true)
    expect(fs.readFileSync(`${config}.lain-bak`, 'utf8')).toBe('model = "one"\n')
    fs.writeFileSync(`${config}.lain-bak`, 'keep', 'utf8')
    expect(installCodexLink(config, link).ok).toBe(true)
    expect(fs.readFileSync(`${config}.lain-bak`, 'utf8')).toBe('keep')
    expect(uninstallCodexLink(config).ok).toBe(true)
    expect(fs.readFileSync(config, 'utf8')).toBe('model = "one"\n')
  })
})

describe('Codex notify 스크립트 spawn 실측', () => {
  function run(payload: object): ReturnType<typeof spawnSync> {
    const link = path.join(ROOT, 'link')
    const script = path.join(link, 'lain-codex-notify.cjs')
    fs.mkdirSync(link, { recursive: true })
    fs.writeFileSync(script, CODEX_NOTIFY_SCRIPT_SOURCE, 'utf8')
    fs.writeFileSync(
      path.join(link, 'projects.json'),
      JSON.stringify([{ id: 'p1', path: 'C:\\Repo\\Alpha' }]),
      'utf8',
    )
    return spawnSync(process.execPath, [script, JSON.stringify(payload)], { encoding: 'utf8' })
  }

  it('등록 프로젝트 하위 cwd의 thread-id/type만 이벤트로 남긴다', () => {
    const r = run({
      type: 'agent-turn-complete',
      cwd: 'c:/repo/alpha/src',
      'thread-id': 'thread-1',
      'last-assistant-message': '사적 내용',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    const dir = path.join(ROOT, 'link', 'events')
    const files = fs.readdirSync(dir)
    expect(files).toHaveLength(1)
    const ev = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))
    expect(ev).toMatchObject({ projectId: 'p1', sessionId: 'thread-1', event: 'agent-turn-complete' })
    expect(JSON.stringify(ev)).not.toContain('사적 내용')
  })

  it('비등록 cwd와 루트 접두만 같은 폴더는 무시한다', () => {
    expect(run({ cwd: 'C:/Repo/Alpha-x', 'thread-id': 'x', type: 'agent-turn-complete' }).status).toBe(0)
    expect(fs.existsSync(path.join(ROOT, 'link', 'events'))).toBe(false)
  })
})
