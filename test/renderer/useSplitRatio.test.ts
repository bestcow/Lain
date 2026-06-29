import { describe, it, expect } from 'vitest'
import { clampRatio } from '../../src/renderer/lib/useSplitRatio'
describe('clampRatio', () => {
  it('범위 안은 그대로', () => expect(clampRatio(0.5)).toBe(0.5))
  it('하한 0.2', () => expect(clampRatio(0.05)).toBe(0.2))
  it('상한 0.8', () => expect(clampRatio(0.95)).toBe(0.8))
})
