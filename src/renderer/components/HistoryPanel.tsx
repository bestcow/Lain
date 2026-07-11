// C3 — 완료 작업 이력(HISTORY) 패널. done/cancelled 포함 최근 작업을 날짜 역순으로 보여줘, 결재를 끝낸
// 작업이 UI에서 증발하던 문제를 메운다. 신규 백엔드 없이 기존 tasks:list(listTasks)·tasks:updated 재사용.
// 행 클릭 → 상위(App)의 openTask로 기존 TaskDrawer를 읽기전용 재사용(활성 전용 UI는 드로어가 상태로 가림).
// 구조·스타일은 LessonsPanel을 따른다(drawer panel + drawer-head + 목록).
import { useEffect, useState } from 'react'
import type { Project, Task } from '../../shared/types'
import { fmtTokens } from '../App'
import { fmtRelTime } from '../lib/chat'
import { TASK_STATE_LABEL, isFinished, taskDuration, sortTasksForHistory } from '../lib/taskHistory'
import { Icon } from './icons'

export function HistoryPanel({
  onClose,
  onOpenTask,
}: {
  onClose: () => void
  onOpenTask: (taskId: string) => void
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [finishedOnly, setFinishedOnly] = useState(false)

  useEffect(() => {
    window.lain.listTasks().then(setTasks)
    window.lain.listProjects().then(setProjects)
    // 라이브 갱신 — 작업이 끝나(done/review) 목록에 들어오는 즉시 이력에 반영.
    return window.lain.onTasksUpdated(setTasks)
  }, [])

  const all = tasks ? sortTasksForHistory(tasks) : []
  const visible = finishedOnly ? all.filter((t) => isFinished(t.state)) : all
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id

  return (
    <div className="drawer panel history-panel">
      <div className="drawer-head">
        <span className="drawer-title">[ wired://history — 작업 이력 ]</span>
        <span className="dim">{all.length}건</span>
        <button
          className={`chip${finishedOnly ? ' chip-inbox-on' : ''}`}
          onClick={() => setFinishedOnly((v) => !v)}
          title="완료/취소/오류(종결)만 보기"
        >
          {finishedOnly ? '종결만' : '전체'}
        </button>
        <button onClick={onClose}>
          <Icon name="x-circle" size={18} />
        </button>
      </div>
      {!tasks ? (
        <div className="dim">로딩...</div>
      ) : visible.length === 0 ? (
        <div className="empty">
          {finishedOnly && all.length > 0
            ? '종결된 작업이 없다. 전체 보기로 진행 중 작업을 확인할 수 있다.'
            : '아직 작업 기록이 없다. Navi에 작업을 시작하면 여기에 이력이 쌓인다.'}
        </div>
      ) : (
        <div className="history-list">
          {visible.map((t) => {
            const dur = taskDuration(t)
            return (
              <div
                key={t.id}
                className="history-row"
                onClick={() => onOpenTask(t.id)}
                title="클릭하면 이벤트 로그·요약·diff를 연다"
              >
                <span className={`history-state st-task-${t.state}`}>
                  {TASK_STATE_LABEL[t.state]}
                </span>
                <div className="history-body">
                  <div className="history-title">
                    <span className="history-proj">{projectName(t.projectId)}</span> — {t.title}
                  </div>
                  <div className="dim history-meta">
                    {t.turns}턴 · {fmtTokens(t.tokens)} tok
                    {dur ? ` · ${dur}` : ''} · {fmtRelTime(t.createdAt)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
