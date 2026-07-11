// A12 — @파일 자동완성 파일 목록 수집. parseGitignore/isIgnored는 순수 함수, walkProjectFiles는
// 임시 디렉터리 트리로 실제 fs 순회·gitignore 상속·상한을 검증한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseGitignore, isIgnored, walkProjectFiles } from '../../src/main/filewalk'

describe('parseGitignore — 패턴 파싱', () => {
  it('주석·빈 줄 무시', () => {
    expect(parseGitignore('# comment\n\n  \n')).toEqual([])
  })
  it('일반 패턴은 dirOnly=false, negate=false, anchored=false', () => {
    const [r] = parseGitignore('*.log')
    expect(r.dirOnly).toBe(false)
    expect(r.negate).toBe(false)
    expect(r.anchored).toBe(false)
  })
  it("끝 '/'는 dirOnly", () => {
    const [r] = parseGitignore('node_modules/')
    expect(r.dirOnly).toBe(true)
  })
  it("시작 '/'는 anchored", () => {
    const [r] = parseGitignore('/ui-proposals.html')
    expect(r.anchored).toBe(true)
  })
  it("'!'는 negate", () => {
    const [r] = parseGitignore('!.env.example')
    expect(r.negate).toBe(true)
  })
})

describe('isIgnored — 규칙 적용', () => {
  it('단순 이름 매치(디렉터리 무관 위치)', () => {
    const rules = parseGitignore('node_modules/')
    expect(isIgnored('node_modules', true, rules)).toBe(true)
    expect(isIgnored('apps/foo/node_modules', true, rules)).toBe(true)
    expect(isIgnored('node_modules', false, rules)).toBe(false) // dirOnly라 파일엔 미적용
  })
  it('와일드카드(*.log)', () => {
    const rules = parseGitignore('*.log')
    expect(isIgnored('a.log', false, rules)).toBe(true)
    expect(isIgnored('sub/b.log', false, rules)).toBe(true)
    expect(isIgnored('a.log.txt', false, rules)).toBe(false)
  })
  it('앵커(/로 시작)는 루트만', () => {
    const rules = parseGitignore('/ui-proposals.html')
    expect(isIgnored('ui-proposals.html', false, rules)).toBe(true)
    expect(isIgnored('sub/ui-proposals.html', false, rules)).toBe(false)
  })
  it("negate('!')가 뒤에서 앞 규칙을 재포함", () => {
    const rules = parseGitignore('.env.*\n!.env.example')
    expect(isIgnored('.env.local', false, rules)).toBe(true)
    expect(isIgnored('.env.example', false, rules)).toBe(false)
  })
  it('규칙 없으면 무시 안 됨', () => {
    expect(isIgnored('anything', false, [])).toBe(false)
  })
})

describe('walkProjectFiles — 실제 디렉터리 순회', () => {
  let root: string

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-filewalk-'))
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n*.log\ndist/\n')
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), '')
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), '')
    fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), '')
    fs.writeFileSync(path.join(root, 'src', 'components', 'App.tsx'), '')
    fs.writeFileSync(path.join(root, 'debug.log'), '')
    fs.writeFileSync(path.join(root, 'README.md'), '')
    // 하위 디렉터리의 자체 .gitignore도 상속 누적돼야 함
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'sub', '.gitignore'), 'secret.txt\n')
    fs.writeFileSync(path.join(root, 'sub', 'secret.txt'), '')
    fs.writeFileSync(path.join(root, 'sub', 'ok.txt'), '')
  })

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('.gitignore로 제외된 디렉터리·파일은 결과에 없다', () => {
    const files = walkProjectFiles(root)
    expect(files).not.toContain('node_modules/pkg/index.js')
    expect(files).not.toContain('dist/bundle.js')
    expect(files).not.toContain('debug.log')
  })

  it('허용된 파일은 상대경로(슬래시 구분)로 포함', () => {
    const files = walkProjectFiles(root)
    expect(files).toContain('src/index.ts')
    expect(files).toContain('src/components/App.tsx')
    expect(files).toContain('README.md')
  })

  it('항상 배제 디렉터리(node_modules)는 자체 .gitignore 없어도 스킵(성능 가지치기)', () => {
    const files = walkProjectFiles(root)
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
  })

  it('하위 디렉터리 .gitignore는 그 하위 트리에만 적용(상속 누적)', () => {
    const files = walkProjectFiles(root)
    expect(files).not.toContain('sub/secret.txt')
    expect(files).toContain('sub/ok.txt')
  })

  it('maxFiles 상한을 넘지 않는다', () => {
    const files = walkProjectFiles(root, 2)
    expect(files.length).toBeLessThanOrEqual(2)
  })
})
