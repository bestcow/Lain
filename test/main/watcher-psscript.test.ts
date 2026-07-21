// 오버레이 감시의 포그라운드 폴링 PowerShell 스크립트 — 실제 실행 e2e.
// devfocus 판정은 단위 테스트가 있지만, 실제 포그라운드를 읽어 "프로세스명\t제목\n"을 뱉는 이 본문은
// 문자열 안에 갇혀 tsc·린트·기존 테스트 어디에도 안 걸린다(Add-Type 인용, [char]9 구분자, Start-Sleep 루프).
// 여기서는 buildPsScript 결과를 tmp에 떨구고 프로덕션과 같은 인자로 spawn해 출력 형식을 못박는다.
// 포그라운드 창이 없어도(빈 이름·빈 제목) 탭 구분·개행 종료는 지켜져야 한다.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { killTree } from '../../src/main/prockill'

// watcher는 electron·SQLite 배관을 끌고 온다 — 여기선 순수 함수 하나만 필요하므로 가볍게 스텁.
vi.mock('../../src/main/store', () => ({ getSettings: () => ({ monitorPollMs: 1500 }) }))
vi.mock('../../src/main/quips', () => ({ overlayCooldownScale: () => 1 }))
vi.mock('../../src/main/logfile', () => ({ appendCapped: () => {} }))

import { buildPsScript } from '../../src/main/watcher'

const IS_WIN = process.platform === 'win32'
const POLL_MS = 500 // 루프 간격 검증용 — 짧게 잡아 테스트를 늘리지 않는다
const WANT_LINES = 2 // 1줄은 1회성일 수 있어 2줄까지 받아 Start-Sleep 루프까지 확인
const SPAWN_TIMEOUT_MS = 10_000

let TMP = ''
let proc: ChildProcessWithoutNullStreams | null = null
let lines: string[] = [] // 개행 제거 전(\r만 정리)의 원본 라인
let stamps: number[] = [] // 각 라인 도착 시각 — 폴링 간격 확인용
let sawTrailingNewline = false

function collectLines(scriptPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    )
    proc = p
    let buf = ''
    let stderr = ''
    const timer = setTimeout(() => {
      reject(new Error(`포그라운드 스크립트가 ${SPAWN_TIMEOUT_MS}ms 안에 ${WANT_LINES}줄을 못 냈다 stderr=${stderr.slice(0, 300)}`))
    }, SPAWN_TIMEOUT_MS)
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0 && lines.length < WANT_LINES) {
        sawTrailingNewline = true // 라인이 개행으로 끝나야 watcher의 스트림 파서가 조각을 안 흘린다
        lines.push(buf.slice(0, nl).replace(/\r$/, ''))
        stamps.push(Date.now())
        buf = buf.slice(nl + 1)
      }
      if (lines.length >= WANT_LINES) done()
    })
    p.stderr.setEncoding('utf8')
    p.stderr.on('data', (c: string) => {
      stderr += c
    })
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('exit', (code) => {
      // 루프 스크립트라 정상적으로는 안 끝난다 — 조기 종료면 스크립트 자체가 깨진 것.
      if (lines.length < WANT_LINES) {
        clearTimeout(timer)
        reject(new Error(`스크립트가 조기 종료 code=${code} stderr=${stderr.slice(0, 300)}`))
      }
    })
  })
}

describe.skipIf(!IS_WIN)('포그라운드 감시 PowerShell 스크립트 — 실행 e2e', () => {
  beforeAll(async () => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-psfg-'))
    const scriptPath = path.join(TMP, 'foreground-watch.ps1')
    fs.writeFileSync(scriptPath, buildPsScript(POLL_MS), 'utf8')
    await collectLines(scriptPath)
  }, SPAWN_TIMEOUT_MS + 5_000)

  afterAll(() => {
    killTree(proc?.pid) // 상주 루프 — 반드시 트리째 정리(powershell 고아 방지)
    proc = null
    if (TMP) fs.rmSync(TMP, { recursive: true, force: true })
  })

  it('개행으로 끝나는 라인을 낸다(스트림 파서 전제)', () => {
    expect(sawTrailingNewline).toBe(true)
    expect(lines).toHaveLength(WANT_LINES)
  })

  it('각 라인은 탭으로 프로세스명/제목을 가른다 — 포그라운드가 없어도 빈 값으로 성립', () => {
    for (const line of lines) {
      const tab = line.indexOf('\t')
      expect(tab).toBeGreaterThanOrEqual(0)
      const app = line.slice(0, tab)
      // 프로세스명은 확장자·경로 없는 이름(또는 창이 없으면 빈 문자열)이어야 한다.
      expect(app).toMatch(/^[A-Za-z0-9_. +-]*$/)
      expect(app).not.toContain('\\')
      // handleLine이 쓰는 규칙 그대로 갈랐을 때 제목 쪽에 예외가 나지 않아야 한다.
      expect(typeof line.slice(tab + 1)).toBe('string')
    }
  })

  it('PowerShell 에러 텍스트가 stdout에 섞이지 않는다', () => {
    for (const line of lines) {
      expect(line).not.toMatch(/Exception|CategoryInfo|FullyQualifiedErrorId/)
    }
  })

  it('Start-Sleep 루프가 폴링 간격을 지킨다(1회성 출력이 아니다)', () => {
    expect(stamps).toHaveLength(WANT_LINES)
    // 스케줄러 오차를 감안해 넉넉히 — 간격 배선이 빠지면 0ms에 붙어 나온다.
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(POLL_MS * 0.6)
  })

  it('폴링 간격 인자가 스크립트 본문에 반영된다', () => {
    expect(buildPsScript(2500)).toContain('Start-Sleep -Milliseconds 2500')
  })
})
