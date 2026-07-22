// C6 — 전역 활동 피드의 순수 병합/정렬 로직. main이 task_events(의미있는 kind)와 cc_events를 각각 원시
// 행으로 넘기면, 여기서 하나의 시간 역순 타임라인으로 병합한다(IPC·상태 없는 순수 함수, vitest 검증).
// '무슨 일이 있었나'를 한 곳에서 보게 하는 게 목적이라 노이즈(도구 호출 낱낱·todo 스냅샷 등)는 main 쿼리
// 에서 이미 제외하고, 여기선 kind→표시 라벨 변환과 시간 정렬만 결정론적으로 한다.
import type { ActivityRaw, ActivityItem } from '../../shared/types'

/** 외부 세션 이벤트 라벨 생성. 엔진명은 배지가 담당하고 summary가 있으면 붙인다(60자 컷). */
function ccEventLabel(r: { detail?: string; summary?: string | null }): string {
  const base =
    r.detail === 'SessionStart'
      ? '외부 세션 시작'
      : r.detail === 'SessionEnd'
        ? '외부 세션 종료'
        : '외부 세션 활동'
  return r.summary ? `${base} — ${r.summary.slice(0, 60)}` : base
}

/** 활동 원시 행(task_event | cc_event)을 사람이 읽을 한 줄 요소로. */
function toItem(r: ActivityRaw): ActivityItem {
  if (r.source === 'cc') {
    // cc_events.event: SessionStart | SessionEnd | agent-turn-complete (레인 밖 관찰 세션)
    const label = ccEventLabel(r)
    return {
      source: 'cc',
      at: r.at,
      projectId: r.projectId ?? null,
      taskId: null,
      label,
      kind: r.detail,
      engine: r.engine ?? 'claude',
    }
  }
  // task_event — kind별 표시. text는 status/error 본문(도구 낱낱은 main에서 이미 제외).
  const label = taskEventLabel(r.detail, r.text ?? '')
  return {
    source: 'task',
    at: r.at,
    projectId: null,
    taskId: r.taskId ?? null,
    label,
    kind: r.detail,
    engine: r.engine ?? 'claude',
  }
}

/** task_event kind + 본문 → 활동 라벨(한국어). status는 본문 앞부분을 함께 보인다(생성/검토대기/종료 등). */
function taskEventLabel(kind: string, text: string): string {
  const head = text.split('\n')[0].trim().slice(0, 80)
  switch (kind) {
    case 'error':
      return head ? `작업 에러 — ${head}` : '작업 에러'
    case 'exit':
      return head ? `작업 종료 — ${head}` : '작업 종료'
    case 'status':
      return head || '작업 상태 변경'
    default:
      return head || kind
  }
}

/** 원시 활동 행들을 시간 역순(최신 먼저)으로 병합·정렬해 상위 limit개를 반환한다.
 *  at은 UTC 'YYYY-MM-DD HH:MM:SS' 또는 ISO — 사전순=시간순이라 문자열 비교로 정렬(동률은 source·id 안정화).
 *  main이 이미 kind 필터를 마친 행만 주지만, 방어적으로 빈 라벨 요소도 그대로 둔다(표시는 렌더러 책임). */
export function mergeActivity(raws: ActivityRaw[], limit = 20): ActivityItem[] {
  const items = raws.map(toItem)
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return limit > 0 ? items.slice(0, limit) : items
}
