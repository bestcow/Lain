// C4 — 토큰 사용량 '오늘' 정확화 + 일별 추이의 순수 파생 로직.
// 배경: tasks.created_at은 SQLite datetime('now')라 UTC 'YYYY-MM-DD HH:MM:SS'다. date()로 SQL에서
// 버킷팅하면 UTC 날짜라 사용자 로컬(KST 등)과 하루 어긋날 수 있다 → main은 창(window) 내 원시 행만
// 넘기고, 여기서 **로컬 날짜**로 버킷팅한다(IPC·상태 없는 순수 함수, vitest 검증 대상).
import type { TaskUsageRow } from '../../shared/types'

/** 로컬 날짜 키 'YYYY-MM-DD' — created_at(UTC 'YYYY-MM-DD HH:MM:SS' 또는 ISO)을 로컬 타임존 날짜로. */
export function localDayKey(createdAt: string): string {
  const d = parseUtcStamp(createdAt)
  if (!d) return ''
  return fmtLocalDay(d)
}

/** UTC 'YYYY-MM-DD HH:MM:SS'(공백) / ISO('T', 'Z' 유무 무관) 스탬프를 Date로. 실패 시 null.
 *  DB 저장형식은 datetime('now')=UTC 공백 표기라 'Z' 없이도 UTC로 해석해야 한다(공백형은 Z 부착). */
function parseUtcStamp(s: string): Date | null {
  const t = s.trim()
  if (!t) return null
  // 공백 구분(UTC, Z 없음) → ISO UTC로 정규화. 이미 'T'가 있으면 그대로 Date.parse에 맡긴다.
  const iso = t.includes('T') ? t : t.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? '' : 'Z')
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/** Date → 로컬 'YYYY-MM-DD'. */
function fmtLocalDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface DayBucket {
  day: string // 로컬 'YYYY-MM-DD'
  tokens: number
  costUsd: number
  count: number
}

export interface ProjectUsage {
  projectId: string
  tokens: number
  costUsd: number
  count: number
}

export interface UsageSummary {
  todayTokens: number
  todayCost: number
  todayCount: number
  days: DayBucket[] // 오래된→최신(차트 좌→우). 최근 maxDays개.
  topProjects: ProjectUsage[] // 창 전체 기간 프로젝트별 소비 상위(tokens 내림차순)
}

/** 원시 작업 행을 로컬 날짜로 버킷팅해 '오늘' 합계·일별 추이·프로젝트별 상위를 파생한다.
 *  - maxDays: 반환할 일별 버킷 수(기본 14). now 기준 로컬 오늘부터 과거로.
 *  - topN: 프로젝트별 상위 개수(기본 5).
 *  값이 0인 날도 버킷을 채워(연속 축) 미니 바차트가 빈 날을 건너뛰지 않게 한다. */
export function summarizeUsage(
  rows: TaskUsageRow[],
  now = new Date(),
  maxDays = 14,
  topN = 5,
): UsageSummary {
  const todayKey = fmtLocalDay(now)
  const perDay = new Map<string, DayBucket>()
  const perProject = new Map<string, ProjectUsage>()
  let todayTokens = 0
  let todayCost = 0
  let todayCount = 0
  for (const r of rows) {
    const key = localDayKey(r.createdAt)
    if (!key) continue
    const tok = r.tokens || 0
    const cost = r.costUsd || 0
    const db = perDay.get(key) ?? { day: key, tokens: 0, costUsd: 0, count: 0 }
    db.tokens += tok
    db.costUsd += cost
    db.count += 1
    perDay.set(key, db)
    const pu = perProject.get(r.projectId) ?? { projectId: r.projectId, tokens: 0, costUsd: 0, count: 0 }
    pu.tokens += tok
    pu.costUsd += cost
    pu.count += 1
    perProject.set(r.projectId, pu)
    if (key === todayKey) {
      todayTokens += tok
      todayCost += cost
      todayCount += 1
    }
  }
  // 연속 일별 축 — 오늘부터 과거로 maxDays개, 빈 날은 0으로 채운다. 반환은 오래된→최신.
  const days: DayBucket[] = []
  for (let i = maxDays - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = fmtLocalDay(d)
    days.push(perDay.get(key) ?? { day: key, tokens: 0, costUsd: 0, count: 0 })
  }
  const topProjects = [...perProject.values()]
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count)
    .slice(0, topN)
  return { todayTokens, todayCost, todayCount, days, topProjects }
}
