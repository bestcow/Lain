// P1 텔레그램 라이브 카드 — 순수 헬퍼(카드 본문·활동 라인·edit 판정·diff 전달 방식).
// IO(sendMessage/editMessageText)는 telegram.ts가 담당하고, 여기는 결정론 계산만(테스트 용이).
import type { Task, TaskEvent } from '../shared/types'
import { humanizeActivity } from '../shared/activity'
import { todoProgress } from '../shared/todoline'
import { ENGINE_LABELS } from './engines'

/** 라이브 카드 갱신 최소 간격 — 텔레그램 editMessageText rate limit(채팅당 ~1/s) 안전 마진. */
export const LIVE_EDIT_MIN_MS = 4000

/** 작업 이벤트 → 카드 '지금' 줄(사람말). 카드에 안 싣는 이벤트는 null.
 *  worker의 tool 로그("도구명: 인자")는 humanizeActivity가 사람말로, text(내비 발화)·checkpoint는 원문 머리. */
export function liveActivityLine(ev: Pick<TaskEvent, 'kind' | 'text'>): string | null {
  const t = (ev.text ?? '').trim()
  if (!t) return null
  switch (ev.kind) {
    case 'tool':
      return humanizeActivity(t)
    case 'text':
    case 'checkpoint':
      return t.replace(/\s+/g, ' ').slice(0, 100)
    case 'status':
      // approval:<id>는 내부 신호(버튼 카드가 따로 감) — 카드 활동 줄로 흘리지 않는다.
      return t.startsWith('approval:') ? null : t.replace(/\s+/g, ' ').slice(0, 100)
    default:
      return null // todo(진행률은 카드가 task.todos로 계산)·exit·error·subagent는 카드 줄 제외
  }
}

function fmtElapsed(createdAt: string, now: number): string {
  const min = Math.max(0, Math.round((now - new Date(createdAt).getTime()) / 60_000))
  if (min < 60) return `${min}분`
  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

/** 라이브 카드 본문 — 한 메시지를 editMessageText로 계속 갱신하는 텍스트(플레인, HTML 아님). */
export function buildLiveCard(
  t: Pick<Task, 'projectId' | 'title' | 'createdAt' | 'todos' | 'turns'> & Pick<Partial<Task>, 'engine'>,
  activity: string | null,
  now: number,
): string {
  const engine = t.engine ?? 'claude'
  const lines = [`⚙ [${ENGINE_LABELS[engine]}] ${t.projectId} — ${t.title.slice(0, 70)}`]
  let meta = `실행 중 · ${fmtElapsed(t.createdAt, now)} 경과`
  if (t.turns > 0) meta += ` · ${t.turns}턴`
  if (t.todos && t.todos.length > 0) {
    const p = todoProgress(t.todos)
    meta += ` · 할일 ${p.done}/${p.total}`
  }
  lines.push(meta)
  if (activity) lines.push(`지금: ${activity.slice(0, 160)}`)
  return lines.join('\n')
}

/** 카드 edit 판정 — 내용이 실제로 바뀌었고 최소 간격이 지났을 때만(스팸·rate limit 방지). */
export function shouldEditLiveCard(
  prevText: string,
  nextText: string,
  lastEditAt: number,
  now: number,
  minMs = LIVE_EDIT_MIN_MS,
): boolean {
  return nextText !== prevText && now - lastEditAt >= minMs
}

/** 종료 상태 → 카드 확정 라벨. working이 아니게 된 순간 카드를 이 한 줄로 굳힌다(버튼 제거). */
export function finalCardLabel(state: string): string {
  switch (state) {
    case 'done':
      return '✅ 완료'
    case 'review':
      return '📋 결재 대기 — 아래 결재 카드에서 처리'
    case 'blocked':
      return '❓ 질문 대기 — 아래 질문에 답장'
    case 'error':
      return '❌ 오류로 종료'
    case 'cancelled':
      return '🚫 취소됨'
    default:
      return `상태: ${state}`
  }
}

/** diff 전달 방식 — 짧으면 코드블록 텍스트, 길면 .diff 파일 첨부, 비었으면 안내만. */
export function diffDelivery(
  diff: string,
): { mode: 'empty' } | { mode: 'text'; text: string } | { mode: 'file' } {
  const t = diff.trim()
  if (!t) return { mode: 'empty' }
  // send()가 3800자에서 절단하므로 펜스 여유 포함 3300자까지만 텍스트로.
  if (t.length <= 3300) return { mode: 'text', text: t }
  return { mode: 'file' }
}
