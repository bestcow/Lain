import { describe, expect, it, vi } from 'vitest'
import {
  buildObservedAdoptContent,
  summarizeObservedHandoff,
} from '../../src/main/observedadopt'

describe('관찰 세션 이어받기', () => {
  it('출처와 세션 id를 handoff 블록에 보존한다', () => {
    const content = buildObservedAdoptContent('완료: 타입 추가\n남음: UI', 'codex', 'abc-123')
    expect(content).toContain('Codex 관찰 세션 abc-123 이어받기')
    expect(content).toContain('<handoff>\n완료: 타입 추가\n남음: UI\n</handoff>')
  })

  it('judge 결과를 쓰고 실패하면 원문 꼬리로 폴백한다', async () => {
    const judge = vi.fn().mockResolvedValue('  정리된 핸드오프  ')
    await expect(summarizeObservedHandoff('원문', 'claude', judge)).resolves.toBe('정리된 핸드오프')
    await expect(summarizeObservedHandoff('x'.repeat(7000), 'codex', async () => null)).resolves.toBe(
      'x'.repeat(6000),
    )
  })
})
