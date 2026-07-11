import { memo, type MouseEvent as ReactMouseEvent } from 'react'
import type { ProjectView, Task } from '../../shared/types'
import { todoProgress } from '../../shared/todoline'
import { fmtRelTime, tileMeta } from '../lib/chat'
import { ProjectSprite } from './projectSprite'
import { naviStatus } from './StageView'

interface Props {
  project: ProjectView
  task: Task | null
  focused: boolean
  unread: boolean
  activity?: string | null // C1 — 이 Navi task의 마지막 라이브 활동 한 줄(decode된 display만). 없으면 미표시
  onFocus: (id: string) => void
  onOpenTask: (taskId: string) => void
  onStartTask: (id: string) => void
  onContextMenu?: (e: ReactMouseEvent, p: ProjectView) => void
  onRequestRemove?: (p: ProjectView) => void
}

function NaviTileInner({
  project: p,
  task,
  focused,
  unread,
  activity,
  onFocus,
  onOpenTask,
  onStartTask,
  onContextMenu,
  onRequestRemove,
}: Props) {
  const st = naviStatus(p, task)
  const s = p.status
  // C2 — 프로젝트 지표: 미푸시(↑)·behind(↓)·TODO 잔여. 0이면 표시 안 함(신호 대 소음).
  const badges = [
    s && s.ahead > 0 ? `↑${s.ahead}` : null,
    s && s.behind > 0 ? `↓${s.behind}` : null,
    s && s.todoCount > 0 ? `TODO ${s.todoCount}` : null,
  ].filter(Boolean)
  const meta = [p.stack, s?.gitBranch, s ? `변경 ${s.dirtyFiles}` : null, ...badges]
    .filter(Boolean)
    .join(' · ')
  // C1 — 진행 중 task가 있으면 meta 줄을 task.title(+경과·턴·토큰)로 교체. 없으면 위 정적 meta 유지.
  const tm = tileMeta(task)
  // C2 — 마지막 커밋 상대시간(둘째 줄 툴팁). 검증 실패 시 출력 tail도 함께.
  const commitRel = s?.lastCommitAt ? fmtRelTime(s.lastCommitAt) : null
  const tileTitle = [
    `${p.name} — 클릭해 직통 대화 (${st.label})`,
    s?.lastCommit ? `마지막 커밋: ${s.lastCommit}${commitRel ? ` (${commitRel})` : ''}` : null,
    s?.testState === 'fail' && s.testOutputTail ? `검증 실패 출력:\n${s.testOutputTail}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div
      className={`navi-tile ${st.cls} nt-${st.kind}${focused ? ' navi-tile-focused' : ''}`}
      onClick={() => onFocus(p.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, p) : undefined}
      title={tileTitle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onFocus(p.id)
        }
      }}
    >
      {onRequestRemove && (
        <button
          className="navi-remove"
          aria-label={`${p.name} 제거`}
          onClick={(e) => {
            e.stopPropagation()
            onRequestRemove(p)
          }}
        >
          ✕
        </button>
      )}
      <span className="nt-icon">
        <ProjectSprite project={p} px={5} />
      </span>
      <div className="nt-body">
        <div className="nt-row1">
          <span className="nt-name">
            {p.name}
            {unread && <span className="unread-dot" />}
          </span>
          <span className={`nt-state ${st.cls}`}>
            <span className="status-dot" />
            {st.label}
          </span>
        </div>
        {tm.active ? (
          <>
            <div className="nt-meta nt-task-title" title={tm.title}>
              {tm.title}
            </div>
            {tm.stats && <div className="nt-task-stats">{tm.stats}</div>}
            {activity && (
              <div className="nt-activity" title={activity}>
                ▸ {activity}
              </div>
            )}
          </>
        ) : (
          <div className="nt-meta">{meta || '미수집'}</div>
        )}
        <div className="nt-acts">
          {/* A4 — TodoWrite 진행률(n/m). 최신 스냅샷(task.todos)이 있을 때만 표시 */}
          {task?.todos && task.todos.length > 0 && (
            <span className="nt-todo-progress" title="TodoWrite 진행 체크리스트">
              {todoProgress(task.todos).done}/{todoProgress(task.todos).total}
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              task ? onOpenTask(task.id) : onStartTask(p.id)
            }}
            disabled={!task && !s?.hasTaskMd}
          >
            {task ? '콘솔' : '▶ 작업'}
          </button>
        </div>
      </div>
    </div>
  )
}

// B4 — 타일을 React.memo로. App이 키 입력·스트리밍 델타로 리렌더돼도, 해당 타일의 project·task·activity·
// unread·focused와 콜백(모두 App에서 useCallback으로 안정화)이 안 바뀌면 그리드의 각 타일 재렌더를 스킵한다.
// 기본 얕은 비교로 충분 — project·task는 원본 배열의 객체 참조(tasks.find가 실제 항목 반환), 나머지는 프리미티브.
export const NaviTile = memo(NaviTileInner)
