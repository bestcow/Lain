// 플래너 결정론 배관(L0 — LLM 0회): 1분 틱이 due 리마인드를 발사(PC 토스트+텔레그램 콜백),
// 다이제스트 라인은 buildDigest가 호출. 판단(넛지 발화·대신 처리)은 레인 몫 — 여기선 데이터만.
import { listPlanItems, markPlanReminded, getSettings } from './store'
import { notifyUser } from './notify'
import { dueReminders, occurrencesInRange, staleTodos, fmtLocal } from '../shared/planmath'
import type { PlanItem } from '../shared/types'

let timer: ReturnType<typeof setInterval> | null = null
let reminderCb: ((item: PlanItem, occur: string) => void) | null = null
// cb=null로 호출하면 등록 해제 — 텔레그램 정지 시 이전 send 클로저를 계속 들고 있지 않도록 stopTelegram에서 사용.
export function onPlanReminder(cb: ((item: PlanItem, occur: string) => void) | null): void { reminderCb = cb }

export function plannerTickOnce(now = new Date()): void {
  try {
    const s = getSettings()
    const due = dueReminders(listPlanItems(), now, s.plannerRemindDefaultMin)
    for (const { item, occur } of due) {
      markPlanReminded(item.id, occur) // 발사 전에 마킹 — 실패해도 같은 발생 중복 발사 방지
      notifyUser('lain 플래너', `⏰ ${occur.slice(11)} ${item.title}`)
      if (s.plannerTelegramRemind) reminderCb?.(item, occur)
    }
  } catch { /* 틱 실패 무해 — 다음 분에 재시도 */ }
}
export function startPlannerTick(): void {
  if (timer) return
  timer = setInterval(() => plannerTickOnce(), 60_000)
}
export function stopPlannerTick(): void { if (timer) clearInterval(timer); timer = null }

export function plannerDigestLine(items: PlanItem[], now: Date, s: { plannerStaleDays: number }): string {
  const dayStart = fmtLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0))
  const dayEnd = fmtLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0))
  const today = items
    .filter((i) => !i.done && !i.archived)
    .flatMap((i) => occurrencesInRange(i, dayStart, dayEnd).map((o) => ({ i, o })))
    .sort((a, b) => a.o.localeCompare(b.o))
  const stale = staleTodos(items, now, s.plannerStaleDays)
  const parts: string[] = []
  if (today.length) parts.push(`오늘 일정 ${today.length}건(${today[0].o.slice(11)} ${today[0].i.title}${today.length > 1 ? ' 외' : ''})`)
  if (stale.length) parts.push(`방치 ${stale.length}건`)
  return parts.length ? `플래너: ${parts.join(' · ')}` : ''
}
