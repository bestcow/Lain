import { describe, it, expect } from 'vitest'
import { localDayKey, summarizeUsage } from '../../src/renderer/lib/tokenUsage'
import type { TaskUsageRow } from '../../src/shared/types'

// created_at은 UTC 'YYYY-MM-DD HH:MM:SS'(datetime('now')). 로컬 날짜 버킷팅을 KST(UTC+9) 기준으로 검증하려
// TZ 의존을 없애기 위해, 테스트는 로컬 타임존 오프셋을 스스로 계산해 경계를 만든다(어느 TZ에서 돌려도 통과).
function utcStampFor(local: Date): string {
  // 주어진 '로컬 시각'을 UTC 'YYYY-MM-DD HH:MM:SS'로 — DB 저장 형식과 동일.
  return new Date(local.getTime() - 0).toISOString().slice(0, 19).replace('T', ' ')
}

function row(over: Partial<TaskUsageRow>): TaskUsageRow {
  return { projectId: 'p', tokens: 0, costUsd: 0, createdAt: '2026-07-07 10:00:00', ...over }
}

describe('localDayKey — UTC 저장 스탬프를 로컬 날짜로', () => {
  it('공백 구분(UTC, Z 없음) 스탬프를 로컬 날짜로 버킷팅', () => {
    // 로컬 자정 직후의 사건 — UTC로는 (양수 오프셋 TZ에서) 전날일 수 있지만 로컬 날짜로 판정돼야 한다.
    const now = new Date(2026, 6, 7, 0, 30, 0) // 로컬 7/7 00:30
    const stamp = utcStampFor(now)
    expect(localDayKey(stamp)).toBe('2026-07-07')
  })
  it('파싱 불가는 빈 문자열', () => {
    expect(localDayKey('nonsense')).toBe('')
  })
})

describe('summarizeUsage — 오늘 합산·일별 추이·프로젝트별 상위', () => {
  const now = new Date(2026, 6, 7, 12, 0, 0) // 로컬 7/7 정오

  it("오늘(로컬 날짜) 작업만 todayTokens에 합산", () => {
    const todayA = utcStampFor(new Date(2026, 6, 7, 9, 0, 0))
    const todayB = utcStampFor(new Date(2026, 6, 7, 11, 0, 0))
    const yesterday = utcStampFor(new Date(2026, 6, 6, 23, 0, 0))
    const rows = [
      row({ createdAt: todayA, tokens: 100, costUsd: 0.1 }),
      row({ createdAt: todayB, tokens: 250, costUsd: 0.2 }),
      row({ createdAt: yesterday, tokens: 999, costUsd: 5 }),
    ]
    const s = summarizeUsage(rows, now)
    expect(s.todayTokens).toBe(350)
    expect(s.todayCount).toBe(2)
    expect(s.todayCost).toBeCloseTo(0.3, 5)
  })

  it('일별 버킷은 오래된→최신 순, maxDays개, 빈 날은 0으로 채움', () => {
    const s = summarizeUsage([], now, 14)
    expect(s.days).toHaveLength(14)
    // 마지막(최신)이 오늘
    expect(s.days[13].day).toBe('2026-07-07')
    // 오름차순(사전순=시간순)
    for (let i = 1; i < s.days.length; i++) expect(s.days[i - 1].day < s.days[i].day).toBe(true)
    // 데이터 없으니 전부 0
    expect(s.days.every((d) => d.tokens === 0 && d.count === 0)).toBe(true)
  })

  it('여러 날 작업이 각 로컬 날짜 버킷으로 들어간다', () => {
    const rows = [
      row({ createdAt: utcStampFor(new Date(2026, 6, 7, 8, 0, 0)), tokens: 10 }),
      row({ createdAt: utcStampFor(new Date(2026, 6, 5, 8, 0, 0)), tokens: 20 }),
      row({ createdAt: utcStampFor(new Date(2026, 6, 5, 20, 0, 0)), tokens: 5 }),
    ]
    const s = summarizeUsage(rows, now, 14)
    const byDay = new Map(s.days.map((d) => [d.day, d]))
    expect(byDay.get('2026-07-07')!.tokens).toBe(10)
    expect(byDay.get('2026-07-05')!.tokens).toBe(25)
    expect(byDay.get('2026-07-05')!.count).toBe(2)
  })

  it('프로젝트별 상위는 tokens 내림차순, topN 제한', () => {
    const rows = [
      row({ projectId: 'a', tokens: 100 }),
      row({ projectId: 'b', tokens: 300 }),
      row({ projectId: 'c', tokens: 50 }),
      row({ projectId: 'b', tokens: 100 }),
    ]
    const s = summarizeUsage(rows, now, 14, 2)
    expect(s.topProjects).toHaveLength(2)
    expect(s.topProjects[0]).toMatchObject({ projectId: 'b', tokens: 400, count: 2 })
    expect(s.topProjects[1]).toMatchObject({ projectId: 'a', tokens: 100 })
  })

  it('창 밖(오래된) 작업도 프로젝트 상위엔 잡히지만 일별 축(maxDays)엔 안 보인다', () => {
    // main이 15일 창으로 이미 잘라 주지만, 파생 함수 자체는 넘어온 행 전부를 프로젝트 합산엔 포함한다.
    const old = utcStampFor(new Date(2026, 5, 1, 8, 0, 0)) // 6/1 (14일 축 밖)
    const s = summarizeUsage([row({ projectId: 'z', tokens: 42, createdAt: old })], now, 14)
    expect(s.topProjects[0]).toMatchObject({ projectId: 'z', tokens: 42 })
    expect(s.days.find((d) => d.day === '2026-06-01')).toBeUndefined()
  })
})
