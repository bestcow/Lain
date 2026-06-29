import { type MouseEvent as ReactMouseEvent } from 'react'
import type { ProjectView, Task } from '../../shared/types'
import { ProjectSprite } from './projectSprite'
import { naviStatus } from './StageView'

interface Props {
  project: ProjectView
  task: Task | null
  focused: boolean
  unread: boolean
  onFocus: (id: string) => void
  onOpenTask: (taskId: string) => void
  onStartTask: (id: string) => void
  onContextMenu?: (e: ReactMouseEvent, p: ProjectView) => void
  onRequestRemove?: (p: ProjectView) => void
}

export function NaviTile({
  project: p,
  task,
  focused,
  unread,
  onFocus,
  onOpenTask,
  onStartTask,
  onContextMenu,
  onRequestRemove,
}: Props) {
  const st = naviStatus(p, task)
  const s = p.status
  const meta = [p.stack, s?.gitBranch, s ? `변경 ${s.dirtyFiles}` : null].filter(Boolean).join(' · ')
  return (
    <div
      className={`navi-tile ${st.cls} nt-${st.kind}${focused ? ' navi-tile-focused' : ''}`}
      onClick={() => onFocus(p.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, p) : undefined}
      title={`${p.name} — 클릭해 직통 대화 (${st.label})`}
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
        <div className="nt-meta">{meta || '미수집'}</div>
        <div className="nt-acts">
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
