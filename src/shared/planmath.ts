// 플래너 순수 계산(반복·리마인드·방치) — main(planner.ts)·renderer(PlannerPanel) 공용.
// 로컬 ISO 'YYYY-MM-DDTHH:mm'만 다룬다(타임존·초 없음 — routines cron과 동일한 로컬 기준).
import type { PlanItem } from './types'

export function parseLocal(iso: string): Date {
  const [d, t] = iso.split('T')
  const [y, m, day] = d.split('-').map(Number)
  const [hh, mm] = (t ?? '00:00').split(':').map(Number)
  return new Date(y, m - 1, day, hh, mm, 0, 0)
}
export function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const lastDay = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate()

export function nextOccurrence(item: { startAt: string | null; recur: string }, now: Date): string | null {
  if (!item.startAt) return null
  const anchor = parseLocal(item.startAt)
  if (!item.recur || item.recur === 'none') return item.startAt
  const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate(), anchor.getHours(), anchor.getMinutes())
  if (item.recur === 'daily') {
    if (cand < now) cand.setDate(cand.getDate() + 1)
    return fmtLocal(cand)
  }
  const wk = item.recur.match(/^weekly:([0-6])$/)
  if (wk) {
    const want = Number(wk[1])
    while (cand.getDay() !== want || cand < now) cand.setDate(cand.getDate() + 1)
    return fmtLocal(cand)
  }
  const mo = item.recur.match(/^monthly:([0-9]{1,2})$/)
  if (mo) {
    const want = Math.min(31, Math.max(1, Number(mo[1])))
    const mk = (y: number, m0: number) =>
      new Date(y, m0, Math.min(want, lastDay(y, m0)), anchor.getHours(), anchor.getMinutes())
    let c = mk(now.getFullYear(), now.getMonth())
    if (c < now) c = mk(now.getFullYear(), now.getMonth() + 1)
    return fmtLocal(c)
  }
  return item.startAt // 알 수 없는 recur — none 취급(방어)
}

export function occurrencesInRange(
  item: { startAt: string | null; recur: string }, fromISO: string, toISO: string, cap = 62,
): string[] {
  if (!item.startAt) return []
  const from = parseLocal(fromISO), to = parseLocal(toISO)
  if (!item.recur || item.recur === 'none') {
    const s = parseLocal(item.startAt)
    return s >= from && s < to ? [item.startAt] : []
  }
  const out: string[] = []
  let cursor = new Date(from.getTime() - 60_000) // from 자체 발생 포함
  for (let i = 0; i < cap; i++) {
    const nxt = nextOccurrence(item, new Date(cursor.getTime() + 60_000))
    if (!nxt) break
    const d = parseLocal(nxt)
    if (d >= to) break
    if (d >= from) out.push(nxt)
    cursor = d
  }
  return out
}

const REMIND_LATE_MIN = 60 // 발생 후에도 60분까진 발사(스누즈 복귀·틱 지연 흡수)

export function dueReminders(items: PlanItem[], now: Date, defaultMin: number) {
  const out: { item: PlanItem; occur: string }[] = []
  for (const it of items) {
    if (it.done || it.archived || !it.startAt) continue
    if (it.snoozeUntil && parseLocal(it.snoozeUntil) > now) continue
    const occ = nextOccurrence(it, new Date(now.getTime() - REMIND_LATE_MIN * 60_000))
    if (!occ) continue
    const occD = parseLocal(occ)
    // allDay 항목은 오프셋 무시 — 발생일 당일 09:00을 발사 시각으로 삼는다(전날 밤 오발사 방지).
    const fireAt = it.allDay
      ? new Date(occD.getFullYear(), occD.getMonth(), occD.getDate(), 9, 0, 0, 0).getTime()
      : occD.getTime() - (it.remindOffsetMin ?? defaultMin) * 60_000
    if (now.getTime() < fireAt) continue
    if (now.getTime() > fireAt + REMIND_LATE_MIN * 60_000) continue
    if (it.remindSentAt === occ) continue // 같은 발생 재발사 금지
    out.push({ item: it, occur: occ })
  }
  return out
}

export function staleTodos(items: PlanItem[], now: Date, staleDays: number): PlanItem[] {
  const limit = now.getTime() - staleDays * 86_400_000
  return items.filter(
    (i) => i.kind === 'todo' && !i.done && !i.pinned && !i.archived && parseLocal(i.updatedAt.replace(' ', 'T').slice(0, 16)).getTime() < limit,
  )
}
