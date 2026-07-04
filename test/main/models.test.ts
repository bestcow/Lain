import { describe, it, expect } from 'vitest'
import { MODEL_IDS, MODEL_TIERS, modelId } from '../../src/shared/models'

describe('modelId — 티어를 고정 모델 ID로 박는다', () => {
  it('각 티어를 명시 모델 ID로 매핑한다', () => {
    expect(modelId('opus')).toBe('claude-opus-4-8')
    expect(modelId('sonnet')).toBe('claude-sonnet-4-6')
    expect(modelId('haiku')).toBe('claude-haiku-4-5-20251001')
    expect(modelId('local')).toBe('qwen3.6-35b-a3b') // 로컬 llama-server 티어 — 라우팅은 tierQueryOptions
  })

  it('모든 티어가 매핑을 가진다(누락 0)', () => {
    for (const t of MODEL_TIERS) expect(MODEL_IDS[t]).toBeTruthy()
  })

  it('미지 값은 sonnet으로 폴백한다', () => {
    expect(modelId('')).toBe('claude-sonnet-4-6')
    expect(modelId('gpt-4')).toBe('claude-sonnet-4-6')
  })

  it('별칭이 아니라 버전 박힌 ID다(표류 방지 — 티어 문자열과 달라야 함)', () => {
    for (const t of MODEL_TIERS) expect(MODEL_IDS[t]).not.toBe(t)
  })
})
