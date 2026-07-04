import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectProject } from '../../src/main/registry'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-reg-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content = ''): void {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

describe('detectProject — 스택/검증 명령 자동 감지', () => {
  it('node: scripts.test → npm test (최우선)', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'jest', typecheck: 'tsc', build: 'x' } }))
    expect(detectProject(dir)).toMatchObject({ stack: 'node', verifyCmd: 'npm test' })
  })
  it('node: typecheck만 있으면 npm run typecheck', () => {
    write('package.json', JSON.stringify({ scripts: { typecheck: 'tsc', build: 'x' } }))
    expect(detectProject(dir)).toMatchObject({ stack: 'node', verifyCmd: 'npm run typecheck' })
  })
  it('node: build만 있으면 npm run build', () => {
    write('package.json', JSON.stringify({ scripts: { build: 'vite build' } }))
    expect(detectProject(dir)).toMatchObject({ stack: 'node', verifyCmd: 'npm run build' })
  })
  it('node: 검증 스크립트 없으면 verifyCmd=null', () => {
    write('package.json', JSON.stringify({ scripts: { dev: 'x' } }))
    expect(detectProject(dir)).toMatchObject({ stack: 'node', verifyCmd: null })
  })
  it('node: scripts 자체가 없어도 stack=node, verifyCmd=null', () => {
    write('package.json', JSON.stringify({ name: 'x' }))
    expect(detectProject(dir)).toMatchObject({ stack: 'node', verifyCmd: null })
  })
  it('package.json이 BOM 붙어도 파싱', () => {
    write('package.json', '﻿' + JSON.stringify({ scripts: { test: 'x' } }))
    expect(detectProject(dir)).toMatchObject({ stack: 'node', verifyCmd: 'npm test' })
  })

  it('godot: project.godot → stack=godot, verifyCmd=null', () => {
    write('project.godot')
    expect(detectProject(dir)).toMatchObject({ stack: 'godot', verifyCmd: null })
  })

  it('python: pyproject + tests/ → pytest', () => {
    write('pyproject.toml')
    write('tests/test_a.py')
    expect(detectProject(dir)).toMatchObject({ stack: 'python', verifyCmd: 'pytest' })
  })
  it('python: requirements.txt 있고 tests 없으면 verifyCmd=null', () => {
    write('requirements.txt')
    expect(detectProject(dir)).toMatchObject({ stack: 'python', verifyCmd: null })
  })

  it('static: index.html → stack=static', () => {
    write('index.html')
    expect(detectProject(dir)).toMatchObject({ stack: 'static', verifyCmd: null })
  })

  it('아무것도 없으면 stack=null, verifyCmd=null', () => {
    expect(detectProject(dir)).toMatchObject({ stack: null, verifyCmd: null })
  })

  it('우선순위: package.json이 godot/python보다 먼저', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'x' } }))
    write('project.godot')
    write('pyproject.toml')
    expect(detectProject(dir).stack).toBe('node')
  })

  it('isGit: .git 존재 여부 반영', () => {
    write('index.html')
    expect(detectProject(dir).isGit).toBe(false)
    fs.mkdirSync(path.join(dir, '.git'))
    expect(detectProject(dir).isGit).toBe(true)
  })
})
