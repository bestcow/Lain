// A4 — TodoWrite 진행 체크리스트. Claude Code TodoWrite 도구의 input(todos 배열)을 파싱해
// 구조화하고, 진행률(n/m)을 계산하는 순수 함수. main(worker.ts·manager.ts)이 tool_use 스트림에서
// TodoWrite를 감지해 이 모듈로 파싱·인코딩하고, renderer(TaskDrawer·NaviTile·ChatPanel)가 같은
// 모듈로 디코딩·렌더한다. toolline.ts(A17)와 동일한 "main 요약 + renderer 표시" 공유 패턴.
//
// 누적이 아니라 "최신 상태" — TodoWrite는 매번 todos 배열 전체(현재 상태)를 넘기므로, 마지막
// 호출의 todos가 곧 진실이다(호출부가 이전 이벤트를 병합하지 않고 항상 통째로 교체·저장한다).
//
// TodoStatus/TodoItem은 shared/types.ts가 단일 출처(IPC 계약 타입과 동거) — 여기선 재-export.
import type { TodoStatus, TodoItem } from './types'
export type { TodoStatus, TodoItem }

// status별 아이콘 — 브리프 지정(✓완료/▸진행중/○대기).
export const TODO_STATUS_ICON: Record<TodoStatus, string> = {
  completed: '✓',
  in_progress: '▸',
  pending: '○',
}

function isTodoStatus(v: unknown): v is TodoStatus {
  return v === 'pending' || v === 'in_progress' || v === 'completed'
}

/** TodoWrite tool_use의 input을 파싱한다. 형태가 규격(todos: {content,status,activeForm}[])과
 *  다르면(방어적 — SDK 버전 차이·손상 입력) null. 항목 단위로도 잘못된 건 걸러낸다(전체 폐기 대신). */
export function parseTodoWriteInput(input: unknown): TodoItem[] | null {
  const todos = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(todos)) return null
  const out: TodoItem[] = []
  for (const t of todos) {
    const o = t as { content?: unknown; status?: unknown; activeForm?: unknown }
    if (typeof o?.content !== 'string' || !isTodoStatus(o.status)) continue
    out.push({
      content: o.content,
      status: o.status,
      activeForm: typeof o.activeForm === 'string' ? o.activeForm : '',
    })
  }
  return out
}

/** 진행률 n/m — completed 개수 / 전체 개수. 빈 배열이면 {done:0, total:0}. */
export function todoProgress(todos: TodoItem[]): { done: number; total: number } {
  return { done: todos.filter((t) => t.status === 'completed').length, total: todos.length }
}

/** 지금 진행 중인 항목(activeForm 표시용) — 여럿이면 첫 번째. 없으면 null. */
export function currentTodo(todos: TodoItem[]): TodoItem | null {
  return todos.find((t) => t.status === 'in_progress') ?? null
}

// ── 인코딩 — task_events.content / ChatMessage.content 한 문자열에 todos를 실어 나른다 ──
// toolline.ts와 동일한 "표시 라인 + 구분자 + 원문" 형태이되, 원문은 JSON(todos 배열)이다.
const TODO_PREFIX = '§todo§'

/** todos를 한 줄 문자열로 인코딩. 표시 라인(진행률 요약)은 렌더러가 다시 계산하므로 저장하지 않고,
 *  파싱 즉시 알아볼 수 있게 접두사 + JSON만 싣는다(디코더가 파싱 실패해도 접두사로 무해하게 원문 표시 가능). */
export function encodeTodoLine(todos: TodoItem[]): string {
  return `${TODO_PREFIX}${JSON.stringify(todos)}`
}

/** encodeTodoLine 결과를 todos로 복원. 접두사가 없거나 JSON이 깨졌으면 null(호출부가 평범한 라인으로 폴백). */
export function decodeTodoLine(content: string): TodoItem[] | null {
  if (!content.startsWith(TODO_PREFIX)) return null
  try {
    const parsed = JSON.parse(content.slice(TODO_PREFIX.length))
    return parseTodoWriteInput({ todos: parsed })
  } catch {
    return null
  }
}
