import { describe, it, expect } from 'vitest'
import { isCodeEdit, isVerifyRun, shouldNudge, VERIFY_NUDGE_NOTE } from '../../src/main/verifynudge'

describe('isCodeEdit — 코드 파일 수정 감지(결정론)', () => {
  it('Edit/Write + 코드 확장자 → true', () => {
    expect(isCodeEdit('Edit', { file_path: 'C:\\lain\\src\\main\\store.ts' })).toBe(true)
    expect(isCodeEdit('Write', { file_path: '/app/main.py' })).toBe(true)
    expect(isCodeEdit('MultiEdit', { file_path: 'a/b.tsx' })).toBe(true)
  })
  it('문서류(.md/.txt/.json)·비편집 도구는 false(hermes 오탐 수정 반영)', () => {
    expect(isCodeEdit('Edit', { file_path: 'README.md' })).toBe(false)
    expect(isCodeEdit('Write', { file_path: 'notes.txt' })).toBe(false)
    expect(isCodeEdit('Edit', { file_path: 'package.json' })).toBe(false)
    expect(isCodeEdit('Read', { file_path: 'a.ts' })).toBe(false)
    expect(isCodeEdit('Bash', { command: 'echo hi > a.ts' })).toBe(false)
  })
})

describe('isVerifyRun — 검증 실행 감지(결정론)', () => {
  it.each([
    ['Bash', 'npm run typecheck'],
    ['Bash', 'npm test'],
    ['PowerShell', 'npm run test'],
    ['Bash', 'npx vitest run'],
    ['Bash', 'cargo test'],
    ['Bash', 'go test ./...'],
    ['Bash', 'pnpm build'],
  ])('%s "%s" → true', (tool, command) => {
    expect(isVerifyRun(tool, { command })).toBe(true)
  })
  it('lain 자체 검증/배포 도구도 검증으로 친다', () => {
    expect(isVerifyRun('mcp__lain__run_verify', {})).toBe(true)
    expect(isVerifyRun('mcp__lain__deploy_lain', {})).toBe(true)
  })
  it('일반 셸 명령·비셸 도구는 false', () => {
    expect(isVerifyRun('Bash', { command: 'git status' })).toBe(false)
    expect(isVerifyRun('Bash', { command: 'ls -la' })).toBe(false)
    expect(isVerifyRun('Edit', { file_path: 'a.ts' })).toBe(false)
  })
})

describe('shouldNudge — 코드 수정 있고 검증 없을 때만', () => {
  it.each([
    [true, false, true],
    [true, true, false],
    [false, false, false],
    [false, true, false],
  ])('codeEdited=%s verifyRan=%s → %s', (edit, verify, expected) => {
    expect(shouldNudge(edit, verify)).toBe(expected)
  })
})

describe('VERIFY_NUDGE_NOTE — 1회 넛지 본문', () => {
  it('검증 지시와 무시 가능 안내를 담는다(루프 강제 아님)', () => {
    expect(VERIFY_NUDGE_NOTE).toContain('검증')
    expect(VERIFY_NUDGE_NOTE).toContain('무시해도 된다')
  })
})
