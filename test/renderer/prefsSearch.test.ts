import { describe, it, expect } from 'vitest'
import {
  normalizeQuery,
  matchesItem,
  matchingItems,
  matchingKeys,
  targetCategory,
  type PrefsSearchItem,
} from '../../src/renderer/lib/prefsSearch'

const items: PrefsSearchItem[] = [
  { key: 'concurrencyCap', label: '동시 작업 cap', hint: '동시에 working 상태일 수 있는 작업 수', cat: 'automation' },
  { key: 'naviModel', label: 'Navi 모델', hint: 'TASK.md 본 작업', cat: 'models' },
  { key: 'groqApiKey', label: 'Groq API 키', hint: 'Whisper STT 음성 변환', cat: 'telegram' },
  { key: 'groqApiKeyVoice', label: 'Groq API 키', hint: 'PC 마이크 STT', cat: 'voice' },
  { key: 'scanIntervalMin', label: '주기 스캔(분)', hint: '현황 자동 재수집 간격', cat: 'general' },
]

describe('normalizeQuery', () => {
  it('트림·소문자', () => {
    expect(normalizeQuery('  Navi ')).toBe('navi')
  })
})

describe('matchesItem — 라벨/힌트 부분일치', () => {
  it('라벨 부분일치', () => {
    expect(matchesItem(items[1], 'navi')).toBe(true)
  })
  it('힌트 부분일치', () => {
    expect(matchesItem(items[0], '동시에 working')).toBe(true)
  })
  it('다중 토큰 AND', () => {
    expect(matchesItem(items[0], '동시 cap')).toBe(true)
    expect(matchesItem(items[0], '동시 없는단어')).toBe(false)
  })
  it('빈 쿼리는 매치 없음', () => {
    expect(matchesItem(items[1], '')).toBe(false)
    expect(matchesItem(items[1], '   ')).toBe(false)
  })
})

describe('matchingItems / matchingKeys', () => {
  it('여러 카테고리에 걸친 매치(Groq 키가 텔레그램·음성 둘 다)', () => {
    const hits = matchingItems(items, 'groq')
    expect(hits.map((h) => h.cat).sort()).toEqual(['telegram', 'voice'])
  })
  it('매치 key 집합', () => {
    expect(matchingKeys(items, 'cap')).toEqual(new Set(['concurrencyCap']))
  })
  it('빈 쿼리는 빈 결과', () => {
    expect(matchingItems(items, '')).toEqual([])
    expect(matchingKeys(items, '').size).toBe(0)
  })
})

describe('targetCategory — 검색 시 전환할 카테고리', () => {
  it('매치 없으면 null(전환 안 함)', () => {
    expect(targetCategory(items, 'zzz')).toBeNull()
    expect(targetCategory(items, '')).toBeNull()
  })
  it('첫 매치 항목의 카테고리(현재 위치 무관)', () => {
    // 'cap'은 automation에만 — general에 있어도 automation으로 전환
    expect(targetCategory(items, 'cap', 'general')).toBe('automation')
  })
  it('현재 카테고리에 이미 매치가 있으면 유지(안 튐)', () => {
    // 'groq'는 telegram·voice 둘 다 — 이미 voice면 voice 유지
    expect(targetCategory(items, 'groq', 'voice')).toBe('voice')
    expect(targetCategory(items, 'groq', 'telegram')).toBe('telegram')
    // 관계없는 카테고리(general)에서는 첫 매치(telegram)로
    expect(targetCategory(items, 'groq', 'general')).toBe('telegram')
  })
})
