import { describe, it, expect } from 'vitest'
import { spriteFor, projectColor, THEMES } from '../../src/renderer/components/projectSprite'

// 테마 조회 헬퍼 — 키워드 목록에 해당 키가 든 모티프(어간 표시 '*' 무시).
function themeOf(key: string) {
  const t = THEMES.find((m) => m.keys.some((k) => k.replace(/\*$/, '') === key))
  if (!t) throw new Error(`THEMES에 키워드 없음: ${key}`)
  return t
}

describe('projectSprite — 키워드 매칭은 이름 기준(경로 prefix 오염 방지)', () => {
  it('tools/ 경로가 gear로 오분류되지 않는다 (podcast→헤드폰·reference→책)', () => {
    // 버그였던 것: id의 "tools"가 "tool"(gear 키워드)에 걸려 tools/* 가 전부 톱니로 보였다.
    expect(spriteFor({ id: 'tools/podcast', name: 'podcast' }).map).toEqual(themeOf('podcast').map)
    expect(spriteFor({ id: 'tools/reference_view', name: 'reference_view' }).map).toEqual(
      themeOf('reference').map,
    )
    // 같은 이름이면 경로가 달라도 동일 테마(경로 미반영)
    expect(spriteFor({ id: 'x/podcast', name: 'podcast' }).map).toEqual(themeOf('podcast').map)
  })

  it('gear.io는 그대로 gear 테마', () => {
    expect(spriteFor({ id: 'games/gear.io', name: 'gear.io' }).map).toEqual(themeOf('gear').map)
  })

  it('키워드 없는 프로젝트는 서로 다른 고유 엠블럼(identicon)', () => {
    const a = spriteFor({ id: 'apps/Zenith123', name: 'Zenith123' })
    const b = spriteFor({ id: 'games/MapleWorlds', name: 'MapleWorlds' })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('같은 프로젝트는 항상 같은 아이콘(결정적)', () => {
    const p = { id: 'apps/Zenith123', name: 'Zenith123' }
    expect(JSON.stringify(spriteFor(p))).toBe(JSON.stringify(spriteFor(p)))
  })

  it('identicon은 9×9 좌우대칭', () => {
    const { map } = spriteFor({ id: 'apps/zzz-no-keyword', name: 'zzz-no-keyword' })
    expect(map).toHaveLength(9)
    for (const row of map) {
      expect(row).toHaveLength(9)
      for (let x = 0; x < 9; x++) expect(row[x]).toBe(row[8 - x]) // 대칭
    }
  })
})

describe('projectSprite — 토큰 단위 매칭(부분문자열 오매칭 차단)', () => {
  // 이름을 구분자로 쪼갠 토큰과만 비교한다 → 단어 한가운데 우연히 낀 키워드는 안 걸린다.
  const misses: [string, string][] = [
    ['scowl', 'cow'],
    ['author', 'auth'],
    ['mainframe', 'main'],
    ['bootstrap', 'boot'], // 없는 키워드지만 'bot'류 오염 방지 확인용
    ['warehouse', 'war'],
    ['chatbot-less', 'chat'], // 토큰 'chatbot'은 chat이 아니다
  ]
  for (const [name, key] of misses) {
    it(`${name}은(는) '${key}' 테마로 오매칭되지 않는다`, () => {
      const t = THEMES.find((m) => m.keys.some((k) => k.replace(/\*$/, '') === key))
      const got = spriteFor({ id: `apps/${name}`, name }).map
      if (t) expect(got).not.toEqual(t.map)
      // 키워드가 아예 없는 경우(bootstrap)는 identicon(9×9)으로 떨어지면 된다
      expect(got).toHaveLength(9)
    })
  }

  it('구분자(-, _, ., /, 공백)로 쪼갠 토큰은 매칭된다', () => {
    const chess = themeOf('chess').map
    for (const name of ['chess', 'my-chess', 'my_chess', 'my.chess', 'my chess', 'chess-ai']) {
      expect(spriteFor({ id: `apps/${name}`, name }).map).toEqual(chess)
    }
  })

  it('기존 THEMES 키워드는 전부 자기 테마로 매칭된다(회귀)', () => {
    for (const t of THEMES) {
      for (const raw of t.keys) {
        const word = raw.replace(/\*$/, '')
        expect(spriteFor({ id: `apps/${word}`, name: word }).map).toEqual(t.map)
        // 접두 형태(하이픈 결합)도 동일 테마
        expect(spriteFor({ id: `apps/${word}-x`, name: `${word}-x` }).map).toEqual(t.map)
      }
    }
  })

  it('어간(*) 키워드는 파생어까지 매칭된다', () => {
    const stems: [string, string][] = [
      ['security', 'secur'],
      ['crypto', 'crypt'],
      ['divination', 'divin'],
      ['astrology', 'astro'],
    ]
    for (const [name, key] of stems) {
      expect(spriteFor({ id: `apps/${name}`, name }).map).toEqual(themeOf(key).map)
    }
  })
})

describe('projectSprite — 같은 테마라도 색은 프로젝트마다 회전', () => {
  it('같은 키워드를 가진 프로젝트는 그림은 같고 주색은 다르다', () => {
    const a = spriteFor({ id: 'apps/dashboard-alpha', name: 'dashboard-alpha' })
    const b = spriteFor({ id: 'apps/dashboard-beta', name: 'dashboard-beta' })
    expect(a.map).toEqual(b.map) // 테마(그림)는 공유
    expect(a.colors['1']).not.toBe(b.colors['1']) // 색으로 구분
  })

  it('주색 회전은 충분히 퍼진다(같은 테마 8개 → 색 4종 이상)', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => `docs-${s}`)
    const set = new Set(names.map((n) => spriteFor({ id: `apps/${n}`, name: n }).colors['1']))
    expect(set.size).toBeGreaterThanOrEqual(4)
  })

  it('보조색은 회전하지 않는다 — 테마 색 정체성 유지', () => {
    const t = themeOf('docs')
    for (const n of ['docs-a', 'docs-b', 'docs-c']) {
      expect(spriteFor({ id: `apps/${n}`, name: n }).colors['2']).toBe(t.colors['2'])
    }
  })

  it('회전한 색도 항상 #rrggbb 형식', () => {
    for (const n of ['docs-a', 'chess-x', 'agent-9', 'love-me']) {
      const c = spriteFor({ id: `apps/${n}`, name: n })
      for (const v of Object.values(c.colors)) expect(v).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('색 회전도 결정론적 — 같은 {id,name}은 항상 같은 색', () => {
    const p = { id: 'apps/docs-alpha', name: 'docs-alpha' }
    expect(spriteFor(p).colors).toEqual(spriteFor(p).colors)
    expect(projectColor(p)).toBe(projectColor(p))
  })

  it('projectColor는 스프라이트 주색과 일치한다', () => {
    const p = { id: 'apps/docs-alpha', name: 'docs-alpha' }
    expect(projectColor(p)).toBe(spriteFor(p).colors['1'])
    const q = { id: 'apps/my-chess', name: 'my-chess' } // 주색('1') 없는 테마
    expect(projectColor(q)).toBe(spriteFor(q).colors['2'])
  })
})
