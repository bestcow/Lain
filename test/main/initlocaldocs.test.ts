// 클론 직후 개인 기록 틀 생성(postinstall) — 멱등성·사용자 내용 보존 검증.
// 실제 파일시스템을 쓰되 임시 디렉터리에 격리한다(복사 자체가 이 함수의 전부라 목으로는 의미 없음).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLocalDocs } from '../../scripts/init-local-docs.mjs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lain-initdocs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('initLocalDocs — example 틀에서 실파일 생성', () => {
  it('실파일이 없으면 example에서 복사한다', () => {
    writeFileSync(join(root, 'HANDOFF.example.md'), '# 틀 H')
    writeFileSync(join(root, 'UPDATE.example.md'), '# 틀 U')

    const created = initLocalDocs(root)

    expect(created.sort()).toEqual(['HANDOFF.md', 'UPDATE.md'])
    expect(readFileSync(join(root, 'HANDOFF.md'), 'utf8')).toBe('# 틀 H')
    expect(readFileSync(join(root, 'UPDATE.md'), 'utf8')).toBe('# 틀 U')
  })

  it('실파일이 이미 있으면 덮어쓰지 않는다 — 사용자 기록 보존', () => {
    writeFileSync(join(root, 'HANDOFF.example.md'), '# 틀')
    writeFileSync(join(root, 'HANDOFF.md'), '# 내 기록')

    const created = initLocalDocs(root)

    expect(created).not.toContain('HANDOFF.md')
    expect(readFileSync(join(root, 'HANDOFF.md'), 'utf8')).toBe('# 내 기록')
  })

  it('두 번 실행해도 결과가 같다(멱등) — 2회차엔 생성 0건', () => {
    writeFileSync(join(root, 'HANDOFF.example.md'), '# 틀')

    expect(initLocalDocs(root)).toEqual(['HANDOFF.md'])
    expect(initLocalDocs(root)).toEqual([])
  })

  it('example 틀이 없으면 조용히 건너뛴다 — 설치가 깨지지 않는다', () => {
    expect(() => initLocalDocs(root)).not.toThrow()
    expect(initLocalDocs(root)).toEqual([])
    expect(existsSync(join(root, 'HANDOFF.md'))).toBe(false)
  })
})
