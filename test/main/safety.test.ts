import { describe, it, expect } from 'vitest'
import {
  isSecretFile,
  isTestFile,
  blocksSecretFile,
  toolFilePath,
  FILE_PATH_TOOLS,
} from '../../src/main/safety'

describe('isSecretFile — 비밀 파일 데노리스트(§24)', () => {
  it.each([
    ['.env', true],
    ['.env.local', true],
    ['.env.production', true],
    ['secrets.json', true],
    ['secret_key', true],
    ['app.secret.ts', true],
    ['credentials', true],
    ['aws_credentials.json', true],
    ['api_key.txt', true],
    ['apikey', true],
    ['auth_token.json', true],
    ['id_token.json', true],
    ['session_token', true],
    ['.npmrc', true],
    ['.netrc', true],
    ['id_rsa', true],
    ['id_ed25519', true],
    ['server.pem', true],
    ['app.key', true],
    ['cert.pfx', true],
    ['store.jks', true],
    ['key.p12', true],
  ])('비밀 파일로 차단: %s', (p, expected) => {
    expect(isSecretFile(p)).toBe(expected)
  })

  it.each([
    ['.env.example', false],
    ['config.sample.json', false],
    ['foo.template.json', false],
    ['dist.config.js', false],
    ['env.dist', false],
    ['README.md', false],
    ['index.ts', false],
    ['design.tokens.ts', false], // bare 'token'은 의도적 제외(렉서/디자인 토큰 오탐)
    ['token.txt', false], // bare token 단독 false
    ['', false],
  ])('비밀 아님(예시/화이트리스트/bare token): %s', (p, expected) => {
    expect(isSecretFile(p)).toBe(expected)
  })

  it('basename 기준 — 경로 구분자 무시(POSIX/Windows 둘 다)', () => {
    expect(isSecretFile('a/b/secrets.json')).toBe(true)
    expect(isSecretFile('dir/sub/.env')).toBe(true)
    expect(isSecretFile('dir\\sub\\.env')).toBe(true)
    expect(isSecretFile('C:/proj/.env')).toBe(true)
  })

  it('후행 슬래시(디렉터리형) — basename으로 판정', () => {
    expect(isSecretFile('secrets/')).toBe(true)
    expect(isSecretFile('config/example/')).toBe(false)
  })

  it('화이트리스트가 SECRET보다 우선', () => {
    // .env.example: SECRET_RE(.env) 매칭 가능하지만 EXAMPLE_RE가 먼저 false로 끊는다.
    expect(isSecretFile('.env.example')).toBe(false)
    expect(isSecretFile('.env.sample')).toBe(false)
  })
})

describe('toolFilePath — 도구별 키 폴백', () => {
  it('file_path > path > notebook_path 순서', () => {
    expect(toolFilePath({ file_path: 'a' })).toBe('a')
    expect(toolFilePath({ path: 'b' })).toBe('b')
    expect(toolFilePath({ notebook_path: 'c' })).toBe('c')
    expect(toolFilePath({ file_path: 'a', path: 'b' })).toBe('a')
  })
  it('없으면 빈 문자열', () => {
    expect(toolFilePath({})).toBe('')
    expect(toolFilePath(null)).toBe('')
    expect(toolFilePath(undefined)).toBe('')
  })
})

describe('blocksSecretFile — 파일 도구 게이트', () => {
  it('파일 도구 + 비밀 파일 → 차단', () => {
    expect(blocksSecretFile('Read', { file_path: 'C:/p/.env' })).toBe(true)
    expect(blocksSecretFile('Edit', { path: '.env' })).toBe(true)
    expect(blocksSecretFile('Write', { file_path: 'secrets.json' })).toBe(true)
    expect(blocksSecretFile('NotebookEdit', { notebook_path: 'secret.key' })).toBe(true)
    expect(blocksSecretFile('MultiEdit', { file_path: 'id_rsa' })).toBe(true)
    expect(blocksSecretFile('Grep', { path: '.env.local' })).toBe(true)
  })
  it('파일 도구지만 비밀 아님 → 통과', () => {
    expect(blocksSecretFile('Read', { file_path: 'README.md' })).toBe(false)
    expect(blocksSecretFile('Edit', { file_path: '.env.example' })).toBe(false)
  })
  it('파일 도구 게이트 밖 도구 → 통과(Glob/Bash 등)', () => {
    expect(blocksSecretFile('Glob', { path: '.env' })).toBe(false)
    expect(blocksSecretFile('Bash', { command: 'cat .env' })).toBe(false)
  })
  it('빈 입력/빈 경로 → 통과', () => {
    expect(blocksSecretFile('Read', {})).toBe(false)
    expect(blocksSecretFile('Read', { file_path: '' })).toBe(false)
  })
  it('FILE_PATH_TOOLS 상수 무결성', () => {
    expect([...FILE_PATH_TOOLS].sort()).toEqual(
      ['Edit', 'Grep', 'MultiEdit', 'NotebookEdit', 'Read', 'Write'].sort(),
    )
  })
})

describe('isTestFile — spec-gaming 판사 보호(§21.6)', () => {
  it.each([
    'src/foo.test.ts',
    'src/foo.spec.ts',
    'tests/x.py',
    'test/x.js',
    'spec/x.rb',
    '__tests__/comp.tsx',
    'a/__tests__/b/c.ts',
    'test_models.py',
    'pkg/foo_test.go',
    'src\\bar.test.ts',
  ])('테스트 파일로 인식: %s', (p) => {
    expect(isTestFile(p)).toBe(true)
  })
  it.each(['src/index.ts', 'README.md', 'lib/contest.ts', '', 'src/latest.ts'])(
    '테스트 파일 아님: %s',
    (p) => {
      expect(isTestFile(p)).toBe(false)
    },
  )
})
