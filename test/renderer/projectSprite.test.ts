import { describe, it, expect } from 'vitest'
import { spriteFor } from '../../src/renderer/components/projectSprite'

describe('projectSprite — 키워드 매칭은 이름 기준(경로 prefix 오염 방지)', () => {
  it('tools/ 경로가 gear로 오분류되지 않는다 (podcast→헤드폰·reference→책)', () => {
    // 버그였던 것: id의 "tools"가 "tool"(gear 키워드)에 걸려 tools/* 가 전부 톱니로 보였다.
    expect(spriteFor({ id: 'tools/podcast', name: 'podcast' }).colors['1']).toBe('#5fd0d0') // 오디오 테마색
    expect(spriteFor({ id: 'tools/reference_view', name: 'reference_view' }).colors['1']).toBe(
      '#7fb0ff', // reference 테마색
    )
    // 같은 이름이면 경로가 달라도 동일 테마(경로 미반영)
    expect(spriteFor({ id: 'x/podcast', name: 'podcast' }).colors['1']).toBe('#5fd0d0')
  })

  it('gear.io는 그대로 gear 테마', () => {
    expect(spriteFor({ id: 'games/gear.io', name: 'gear.io' }).colors['1']).toBe('#c9b6f3')
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
