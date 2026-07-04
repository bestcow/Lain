import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sumUsageTokens, classifyDivergence, RISKY } from '../../src/main/worker'

describe('sumUsageTokens — usage 4필드 합산', () => {
  it('input+output+cache_creation+cache_read 합산', () => {
    expect(
      sumUsageTokens({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 2,
        },
      }),
    ).toBe(20)
  })
  it('일부 필드 누락 시 0으로 처리', () => {
    expect(sumUsageTokens({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } })).toBe(17)
  })
  it('usage 없으면 0', () => {
    expect(sumUsageTokens({})).toBe(0)
    expect(sumUsageTokens(undefined)).toBe(0)
    expect(sumUsageTokens(null)).toBe(0)
  })
  it('빈 usage → 0', () => {
    expect(sumUsageTokens({ usage: {} })).toBe(0)
  })
})

describe('RISKY — 위험행위 정규식 분류(§9-4)', () => {
  const match = (cmd: string) => RISKY.find((r) => r.re.test(cmd))?.kind
  it('push 류', () => {
    expect(match('git push origin main')).toBe('push')
    expect(match('git remote add upstream x')).toBe('push')
  })
  it('destructive 류', () => {
    expect(match('rm -rf node_modules')).toBe('destructive')
    expect(match('git reset --hard HEAD~1')).toBe('destructive')
    expect(match('git clean -fd')).toBe('destructive')
  })
  it('dep_change 류', () => {
    expect(match('npm install react')).toBe('dep_change')
    expect(match('npm i lodash')).toBe('dep_change')
    expect(match('npm uninstall x')).toBe('dep_change')
    expect(match('pnpm add zod')).toBe('dep_change')
    expect(match('yarn add foo')).toBe('dep_change')
    expect(match('pip install requests')).toBe('dep_change')
    expect(match('uv add httpx')).toBe('dep_change')
  })
  it('network 류', () => {
    expect(match('curl https://x')).toBe('network')
    expect(match('wget https://x')).toBe('network')
    expect(match('Invoke-WebRequest https://x')).toBe('network')
  })
  it('무해한 명령은 매칭 없음', () => {
    expect(match('npm test')).toBeUndefined()
    expect(match('git status')).toBeUndefined()
    expect(match('ls -la')).toBeUndefined()
  })
  it('bare --force를 destructive로 오분류하지 않는다 (autonomous 불필요 escalate 방지)', () => {
    // 예전 destructive 정규식의 앵커 없는 '--force'가 일상 명령을 destructive로 먼저 잡아
    // 선언 의존성 재설치(--force)조차 autonomous 자율 경로를 못 타고 승인 큐로 빠졌다.
    expect(match('npm install react --force')).toBe('dep_change')
    expect(match('npm test -- --forceExit')).toBeUndefined()
    // 진짜 force push는 여전히 push로 잡혀 escalate 유지된다
    expect(match('git push --force')).toBe('push')
    expect(match('git push -f origin main')).toBe('push')
  })
})

describe('classifyDivergence — §21.5 자율/escalate 경계', () => {
  let wt: string
  beforeEach(() => {
    wt = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-wt-'))
  })
  afterEach(() => {
    fs.rmSync(wt, { recursive: true, force: true })
  })
  const setDeps = (deps: Record<string, string>) =>
    fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ dependencies: deps }))

  it('push/destructive/network는 항상 escalate(autonomous=false)', () => {
    expect(classifyDivergence('push', 'git push', wt).autonomous).toBe(false)
    expect(classifyDivergence('destructive', 'rm -rf x', wt).autonomous).toBe(false)
    expect(classifyDivergence('network', 'curl x', wt).autonomous).toBe(false)
    expect(classifyDivergence('outside_dev', 'D:\\x', wt).autonomous).toBe(false)
  })

  it('dep_change: 선언된 JS 의존성 (재)설치만 자율', () => {
    setDeps({ react: '^18' })
    expect(classifyDivergence('dep_change', 'npm install react', wt).autonomous).toBe(true)
  })

  it('dep_change: 새(novel) 패키지는 escalate', () => {
    setDeps({ react: '^18' })
    const v = classifyDivergence('dep_change', 'npm install leftpad', wt)
    expect(v.autonomous).toBe(false)
    expect(v.reason).toContain('leftpad')
  })

  it('dep_change: uninstall/remove는 escalate', () => {
    setDeps({ react: '^18' })
    expect(classifyDivergence('dep_change', 'npm uninstall react', wt).autonomous).toBe(false)
    expect(classifyDivergence('dep_change', 'npm remove react', wt).autonomous).toBe(false)
  })

  it('dep_change: pip/uv(비-JS)는 검증 불가 → escalate', () => {
    setDeps({ react: '^18' })
    expect(classifyDivergence('dep_change', 'pip install requests', wt).autonomous).toBe(false)
    expect(classifyDivergence('dep_change', 'uv add httpx', wt).autonomous).toBe(false)
  })

  it('dep_change: package.json 읽기 실패면 보수적 escalate', () => {
    // package.json 없음 → declaredDeps 빈 집합
    expect(classifyDivergence('dep_change', 'npm install react', wt).autonomous).toBe(false)
  })

  it('dep_change: 버전 지정(@scope/pkg@x)도 기본명으로 매칭', () => {
    setDeps({ '@scope/pkg': '^1' })
    expect(classifyDivergence('dep_change', 'npm install @scope/pkg@1.2.3', wt).autonomous).toBe(true)
  })

  it('dep_change: 선언+미선언 혼합이면 escalate', () => {
    setDeps({ react: '^18' })
    expect(classifyDivergence('dep_change', 'npm install react newpkg', wt).autonomous).toBe(false)
  })

  it('dep_change: devDependencies 선언도 인정', () => {
    fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1' } }))
    expect(classifyDivergence('dep_change', 'npm install vitest', wt).autonomous).toBe(true)
  })
})
