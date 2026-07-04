// Navi 상태 판정 헬퍼(naviStatus) — 활성 task 상태 > git/test 상태로 우선순위·라벨·애니 그룹 결정.
// (옛 무대(Stage) 뷰 컴포넌트는 BoardField·리스트 뷰로 대체돼 제거됨. 이 파일은 공용 naviStatus만 남긴다.)
import type { ProjectView, Task } from '../../shared/types'

// 활성 task 상태 > git/test 상태. prio↓ = 앞(주목 우선), kind = 애니 그룹.
export function naviStatus(
  p: ProjectView,
  task: Task | null,
): { cls: string; label: string; prio: number; kind: 'attn' | 'busy' | 'idle' } {
  if (task) {
    switch (task.state) {
      case 'blocked':
        return { cls: 'st-dirty', label: '질문 대기', prio: 0, kind: 'attn' }
      case 'review':
        return { cls: 'st-review', label: '결재 대기', prio: 1, kind: 'attn' }
      case 'error':
        return { cls: 'st-error', label: '에러', prio: 2, kind: 'attn' }
      case 'working':
        return { cls: 'st-working', label: '작업 중', prio: 3, kind: 'busy' }
      case 'clarifying':
        return { cls: 'st-working', label: '명확화', prio: 3, kind: 'busy' }
    }
  }
  const s = p.status
  if (!s) return { cls: 'st-idle', label: '미수집', prio: 7, kind: 'idle' }
  if (s.testState === 'fail') return { cls: 'st-error', label: '검증 실패', prio: 2, kind: 'attn' }
  if (s.dirtyFiles > 0) return { cls: 'st-dirty', label: '미커밋', prio: 5, kind: 'idle' }
  if (s.testState === 'pass') return { cls: 'st-done', label: '통과', prio: 6, kind: 'idle' }
  return { cls: 'st-idle', label: '대기', prio: 7, kind: 'idle' }
}
