// test/main/skills.test.ts
import { describe, it, expect } from 'vitest'
import { parseInstalledPlugin, assembleSkillOptions } from '../../src/main/skills'

const FIXTURE = JSON.stringify({
  version: 2,
  plugins: {
    'superpowers@claude-plugins-official': [{ installPath: 'C:/x/superpowers/6.0.3' }],
    'feature-dev@claude-plugins-official': [{ installPath: 'C:/x/feature-dev/unknown' }],
  },
})

describe('parseInstalledPlugin', () => {
  it('이름→installPath 해석', () => {
    expect(parseInstalledPlugin(FIXTURE, 'superpowers')).toBe('C:/x/superpowers/6.0.3')
  })
  it('미설치 플러그인은 null', () => {
    expect(parseInstalledPlugin(FIXTURE, 'code-review')).toBeNull()
  })
  it('깨진 JSON은 null', () => {
    expect(parseInstalledPlugin('{not json', 'superpowers')).toBeNull()
  })
})

describe('assembleSkillOptions', () => {
  const plugins = [{ type: 'local' as const, path: 'C:/x/superpowers/6.0.3', skipMcpDiscovery: true }]
  it('enabled=false면 빈 객체(회귀0)', () => {
    expect(assembleSkillOptions(plugins, null, false)).toEqual({})
  })
  it('enabled=true·미할당이면 all + settingSources:[]', () => {
    expect(assembleSkillOptions(plugins, null, true)).toEqual({ plugins, settingSources: [], skills: 'all' })
  })
  it('빈 배열 할당도 all로 폴백', () => {
    expect(assembleSkillOptions(plugins, [], true).skills).toBe('all')
  })
  it('할당 배열이면 그 목록', () => {
    expect(assembleSkillOptions(plugins, ['systematic-debugging'], true).skills).toEqual(['systematic-debugging'])
  })
  it('플러그인 0개면 빈 객체(폴백)', () => {
    expect(assembleSkillOptions([], ['x'], true)).toEqual({})
  })
})
