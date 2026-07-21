// L6(P6) — 루프 성적표: 최근 N일 작업의 1회 통과율·재작업률·실패 사유를 집계해 다이제스트/주간 보고에 얹는다.
// 순수 포맷·판정 함수만 여기(main/renderer 공용 아님 — 집계 SQL은 store.ts, 소비는 manager.ts/scheduler.ts/briefing.ts
// 셋뿐이라 LoopStats·PromotionStats 타입도 shared/types.ts 대신 이 파일에 함께 둔다).
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

// ── A3 확신도 축 — 승격/강등 '제안' (체크리스트: 자율성은 실적으로 획득하며 승격/강등 조건을 명시) ──
// 판정은 순수함수, 집계는 store.ts promotionStats. 어디서도 자동 적용하지 않는다 — 적용은 사람이 설정에서 확정.
export const PROMOTE_STREAK = 5 // 연속 무수정(1회) 통과 이 건수 이상 → 승격 제안
export const DEMOTE_REWORK = 2 // 최근 창 내 재작업(rework) 이 건수 이상 → 강등 제안
export const DEMOTE_AUDIT = 2 // 최근 창 내 심사 미통과 자동 재작업(audit) 이 건수 이상 → 강등 제안

/** 프로젝트 단위 실적(promotionAdvice 입력). 집계 SQL은 store.ts promotionStats. */
export interface PromotionStats {
  projectId: string
  days: number // recentReworked·recentAuditRetried·specGamingBlocked의 집계 창(일)
  consecutiveFirstPass: number // 최근 종결 작업 기준 연속 무수정 통과 수(cancelled는 중립 — 끊지도 늘리지도 않음)
  recentReworked: number // 창 내 rework_count > 0 작업 수
  recentAuditRetried: number // 창 내 audit_retried=1 작업 수(심사 미통과 자동 재작업)
  specGamingBlocked: boolean // 창 내 spec-gaming 차단/의심 이벤트 유무
}

/** 승격/강등 제안 텍스트 또는 null(제안 없음). 강등이 승격보다 우선 — 사고 신호가 있는데 승격을 제안하지 않는다. */
export function promotionAdvice(s: PromotionStats): string | null {
  if (s.specGamingBlocked)
    return `${s.projectId}: 최근 ${s.days}일 spec-gaming 차단 발생 — 자율성 강등(autonomous 회수·심사 상향) 제안`
  if (s.recentReworked >= DEMOTE_REWORK || s.recentAuditRetried >= DEMOTE_AUDIT) {
    const parts = [
      s.recentReworked >= DEMOTE_REWORK ? `재작업 ${s.recentReworked}건` : '',
      s.recentAuditRetried >= DEMOTE_AUDIT ? `심사 미통과 ${s.recentAuditRetried}건` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return `${s.projectId}: 최근 ${s.days}일 ${parts} — 자율성 강등(심사 상향) 제안`
  }
  if (s.consecutiveFirstPass >= PROMOTE_STREAK)
    return `${s.projectId}: 연속 무수정 통과 ${s.consecutiveFirstPass}건 — 기본 작업방식 승격(autonomous·심사 하향) 제안`
  return null
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
