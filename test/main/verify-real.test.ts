import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// verifyInDir e2e — child_process를 목으로 덮지 않고 실제 프로세스를 띄워 판정을 검증한다.
// verifyindir.test.ts는 spawn 목으로 배선(인자·타임아웃 트리 종료)만 보므로, 자율 모드의 유일한
// 판사인 verify가 실제 실행에서도 계약({pass, tail})을 지키는지는 여기서만 확인된다.
// 명령은 셸·플랫폼 의존을 없애려 `"<node>" -e "..."` 로만 쓴다(cmd/sh 양쪽에서 동일 해석).
// 타임아웃(5분 하드코딩)은 e2e 범위 밖 — 목 테스트가 이미 덮는다.
vi.mock('../../src/main/store', () => ({ saveStatus: vi.fn() }))

import { verifyInDir } from '../../src/main/collectors'

// collectors.ts의 TAIL_CHARS(비공개 상수)와 같은 값. 여기서 상한을 검증한다.
const TAIL_CHARS = 2000
const NODE = `"${process.execPath}"`
/** node -e 한 줄 실행. 스크립트엔 cmd.exe가 특별 취급하는 문자(%, !, ^, &)를 쓰지 않는다. */
const nodeEval = (script: string): string => `${NODE} -e "${script}"`

let dir: string

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lain-verify-')))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('verifyInDir — 실제 프로세스 e2e', () => {
  it('정상 종료(exit 0) → pass=true, tail에 stdout', async () => {
    const r = await verifyInDir(nodeEval("console.log('ok')"), dir)

    expect(r.pass).toBe(true)
    expect(r.tail).toContain('ok')
  })

  it('비정상 종료 → pass=false, tail에 stderr', async () => {
    const r = await verifyInDir(nodeEval("console.error('boom');process.exit(3)"), dir)

    expect(r.pass).toBe(false)
    expect(r.tail).toContain('boom')
  })

  it('출력이 아주 길면 tail이 상한으로 잘린다(앞이 아니라 꼬리 보존)', async () => {
    const r = await verifyInDir(nodeEval("process.stdout.write('A'.repeat(5000) + 'END')"), dir)

    expect(r.pass).toBe(true)
    expect(r.tail.length).toBe(TAIL_CHARS)
    expect(r.tail.endsWith('END')).toBe(true) // 머리가 아니라 꼬리를 남긴다
  })

  it('존재하지 않는 명령 → 던지지 않고 pass=false', async () => {
    const r = await verifyInDir('lain-no-such-command-9d3f', dir)

    expect(r.pass).toBe(false)
    expect(r.tail.length).toBeGreaterThan(0) // 셸 에러 메시지 또는 exit 코드 폴백
  })
})
