// L6(P6) — 루프 성적표: 최근 N일 작업의 1회 통과율·재작업률·실패 사유를 집계해 다이제스트/주간 보고에 얹는다.
// 순수 포맷 함수만 여기(main/renderer 공용 아님 — 집계 SQL은 store.ts, 소비는 manager.ts/scheduler.ts/briefing.ts
// 셋뿐이라 LoopStats 타입도 shared/types.ts 대신 이 파일에 함께 둔다).
export interface LoopStats {
  days: number
  total: number
  done: number
  error: number
  cancelled: number
  firstPass: number // 자동재시도(auto_retry_count)·수정요청(rework_count) 없이 done된 작업 수
  reworked: number // rework_count > 0인 작업 수
  topFailReasons: Array<[string, number]> // kind='exit' 사유별 건수 상위 N (done 제외)
}

/** 다이제스트용 한 줄. total=0이면 빈 문자열(집계할 게 없으면 줄 자체를 생략). */
export function formatLoopStatsLine(s: LoopStats): string {
  if (!s.total) return ''
  const rate = s.done ? Math.round((s.firstPass / s.done) * 100) : 0
  return `루프 ${s.days}일: 작업 ${s.total} · 완료 ${s.done}(1회 통과 ${rate}%) · 재작업 ${s.reworked} · 실패 ${s.error}`
}

/** 주간 보고용 문단(한 줄 + 주요 실패 사유). total=0이면 빈 문자열. */
export function formatLoopStatsReport(s: LoopStats): string {
  if (!s.total) return ''
  const reasons = s.topFailReasons.map(([k, n]) => `${k} ${n}건`).join(', ')
  return [formatLoopStatsLine(s), reasons ? `주요 실패 사유: ${reasons}` : ''].filter(Boolean).join('\n')
}

/** ISO 8601 주차 문자열 'YYYY-Www' — 주간 워터마크 게이트용(연초/연말 경계는 목요일이 속한 해로 귀속). */
export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}
