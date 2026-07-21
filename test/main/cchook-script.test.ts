// 클로드코드 연동 — 설치되는 훅 스크립트(HOOK_SCRIPT_SOURCE) 실행 검증. 이 47줄은 템플릿 리터럴
// 안의 생짜 문자열이라 tsc·린트·기존 단위테스트(mergeOurHooks/stripOurHooks) 어디에도 안 걸린다.
// 실제로 node로 spawn해 stdin→이벤트 파일·stdout 주입·비등록 무시를 못박는다(파일시스템은 tmpdir 격리).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOOK_SCRIPT_SOURCE } from '../../src/main/cchooks'

let LINK: string // 훅이 __dirname으로 삼는 cc-link 루트(projects.json·events가 여기 붙는다)
let HOOK: string
let PROJ: string // 등록 프로젝트 루트
let DIGEST: string
const DIGEST_TEXT = '# Lain 작업 현황 (이 프로젝트)\n\n- [running] 테스트 작업'

type Payload = { cwd?: string; session_id?: string; hook_event_name?: string }

function writeProjects(entries: unknown[]): void {
  fs.writeFileSync(path.join(LINK, 'projects.json'), JSON.stringify(entries), 'utf8')
}

function eventsDir(): string {
  return path.join(LINK, 'events')
}

function readEvents(): any[] {
  let files: string[] = []
  try {
    files = fs.readdirSync(eventsDir()).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(eventsDir(), f), 'utf8')))
}

function clearEvents(): void {
  fs.rmSync(eventsDir(), { recursive: true, force: true })
}

function runHook(payload: Payload): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeAll(() => {
  LINK = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-cchook-'))
  HOOK = path.join(LINK, 'lain-cc-hook.cjs')
  PROJ = path.join(LINK, 'repo')
  DIGEST = path.join(LINK, 'status', 'p1.md')
  fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true })
  fs.mkdirSync(path.dirname(DIGEST), { recursive: true })
  fs.writeFileSync(DIGEST, DIGEST_TEXT, 'utf8')
  fs.writeFileSync(HOOK, HOOK_SCRIPT_SOURCE, 'utf8')
  writeProjects([{ id: 'p1', path: PROJ, digest: DIGEST }])
})

afterAll(() => {
  fs.rmSync(LINK, { recursive: true, force: true })
})

describe('cchook 스크립트 — 실행 e2e', () => {
  it('등록 프로젝트 하위 cwd → 이벤트 파일 1개(projectId/sessionId/event 정확)', () => {
    clearEvents()
    const r = runHook({ cwd: path.join(PROJ, 'src'), session_id: 's1', hook_event_name: 'SessionEnd' })
    expect(r.status).toBe(0)
    const evs = readEvents()
    expect(evs).toHaveLength(1)
    expect(evs[0].projectId).toBe('p1')
    expect(evs[0].sessionId).toBe('s1')
    expect(evs[0].event).toBe('SessionEnd')
    expect(typeof evs[0].ts).toBe('number')
    expect(r.stdout).toBe('') // SessionEnd엔 주입 없음
  })

  it('SessionStart + 다이제스트 → stdout이 오직 그 JSON 한 덩어리(주석 한 줄도 섞이면 CC 파서가 깨진다)', () => {
    clearEvents()
    const r = runHook({ cwd: PROJ, session_id: 's2', hook_event_name: 'SessionStart' })
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout) // 앞뒤에 뭐라도 붙으면 여기서 throw
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toBe(DIGEST_TEXT)
    expect(readEvents()).toHaveLength(1) // 주입과 별개로 이벤트도 남는다
  })

  it('다이제스트 파일이 없으면 주입 없이 이벤트만(크래시 없음)', () => {
    clearEvents()
    writeProjects([{ id: 'p1', path: PROJ, digest: path.join(LINK, 'status', 'none.md') }])
    const r = runHook({ cwd: PROJ, session_id: 's3', hook_event_name: 'SessionStart' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(readEvents()).toHaveLength(1)
    writeProjects([{ id: 'p1', path: PROJ, digest: DIGEST }]) // 원복
  })

  it('비등록 폴더·루트 접두만 겹치는 폴더는 무시(피드백 루프 차단)', () => {
    clearEvents()
    expect(runHook({ cwd: path.join(LINK, 'other'), session_id: 's4', hook_event_name: 'SessionStart' }).status).toBe(0)
    // 'repo-x'는 'repo'로 시작하지만 다른 폴더 — 경계(/) 검사가 없으면 오탐한다
    expect(runHook({ cwd: PROJ + '-x', session_id: 's5', hook_event_name: 'SessionStart' }).status).toBe(0)
    expect(readEvents()).toHaveLength(0)
  })

  it('경로 정규화 — 역슬래시·대소문자 차이를 넘어 매칭(윈도우 cwd)', () => {
    clearEvents()
    writeProjects([{ id: 'winp', path: 'C:\\Repo\\Alpha', digest: '' }])
    const r = runHook({ cwd: 'c:/repo/alpha/src', session_id: 's6', hook_event_name: 'SessionEnd' })
    expect(r.status).toBe(0)
    const evs = readEvents()
    expect(evs).toHaveLength(1)
    expect(evs[0].projectId).toBe('winp')
    writeProjects([{ id: 'p1', path: PROJ, digest: DIGEST }]) // 원복
  })

  it('cwd 없음·projects.json 없음·깨진 stdin → 조용히 종료(exit 0, 이벤트 0)', () => {
    clearEvents()
    expect(runHook({ session_id: 's7', hook_event_name: 'SessionStart' }).status).toBe(0)
    const saved = fs.readFileSync(path.join(LINK, 'projects.json'), 'utf8')
    fs.rmSync(path.join(LINK, 'projects.json'), { force: true })
    expect(runHook({ cwd: PROJ, session_id: 's8', hook_event_name: 'SessionStart' }).status).toBe(0)
    fs.writeFileSync(path.join(LINK, 'projects.json'), 'not json', 'utf8')
    expect(runHook({ cwd: PROJ, session_id: 's9', hook_event_name: 'SessionStart' }).status).toBe(0)
    fs.writeFileSync(path.join(LINK, 'projects.json'), saved, 'utf8')
    const bad = spawnSync(process.execPath, [HOOK], { input: '{ broken', encoding: 'utf8' })
    expect(bad.status).toBe(0)
    expect(readEvents()).toHaveLength(0)
  })
})
