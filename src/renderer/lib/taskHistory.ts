// C3 — 완료 작업 이력(HISTORY) 패널의 순수 파생 로직. listTasks()가 이미 created_at DESC로 주지만,
// 결과 상태 라벨·소요시간(끝난 작업의 실제 경과)·정렬 안정화를 렌더러에서 검증 가능한 순수 함수로 분리한다.
// (표시 조립만 — IPC·상태 없음. fmtElapsed는 '진행 중 ~째'라 끝난 작업엔 부적합해 별도 duration을 쓴다.)
import type { Task, TaskState } from '../../shared/types'

/** HISTORY 결과 상태 라벨(한국어) — 종결/진행 모두 커버. */
export const TASK_STATE_LABEL: Record<TaskState, string> = {
  queued: '대기',
  clarifying: '명확화',
  blocked: '질문 대기',
  ready: '대기',
  working: '작업 중',
  review: '결재 대기',
  done: '완료',
  error: '오류',
  cancelled: '취소',
}

/** 종결 상태(done/cancelled/error)인가 — HISTORY에서 소요시간을 '완결 경과'로 표시할지 판단. */
export function isFinished(state: TaskState): boolean {
  return state === 'done' || state === 'cancelled' || state === 'error'
}

/**
 * 작업 소요시간 — created_at→updated_at 간격을 사람이 읽기 좋게. 종결 작업은 이 값이 곧 총 소요시간이다.
 * 파싱 불가·역전(updated<created)이면 '' 반환(호출부에서 생략). 경계 표기는 fmtElapsed와 통일(초/분/시간/일).
 */
export function taskDuration(task: Pick<Task, 'createdAt' | 'updatedAt'>): string {
  const start = Date.parse(task.createdAt)
  const end = Date.parse(task.updatedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) return ''
  const sec = Math.floor((end - start) / 1000)
  if (sec < 0) return ''
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간`
  return `${Math.floor(hr / 24)}일`
}

/**
 * HISTORY 표시용 정렬 — created_at 역순(최신 먼저). listTasks가 이미 정렬돼 오지만, 라이브 갱신
 * (onTasksUpdated) 후에도 안정적으로 역순을 보장하기 위해 렌더러에서 한 번 더 정렬한다(순수·검증 가능).
 * ISO/'YYYY-MM-DD HH:MM:SS' 둘 다 사전순=시간순이라 문자열 비교로 충분.
 */
export function sortTasksForHistory(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}
