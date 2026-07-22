// C6 — 전역 활동 피드(타임라인) 패널. task_events(의미있는 kind)+cc_events를 시간 역순으로 병합해
// '오늘 이 머신에서 무슨 일이 있었나'를 한눈에 본다. 신규 백엔드 조회(activity:recent) 1개를 쓰되 병합·
// 라벨링·정렬은 렌더러 순수 함수(mergeActivity)로 검증한다. 구조·스타일은 HistoryPanel/LessonsPanel을 따른다.
import { useEffect, useState } from 'react'
import type { ActivityRaw, EngineCapabilityInfo, Project } from '../../shared/types'
import { mergeActivity } from '../lib/activityFeed'
import { fmtRelTime } from '../lib/chat'
import { Icon } from './icons'
import { EngineBadge, engineInfoFor } from './EngineBadge'

const LIMIT = 20

export function ActivityPanel({ onClose }: { onClose: () => void }) {
  const [raws, setRaws] = useState<ActivityRaw[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [engineInfos, setEngineInfos] = useState<EngineCapabilityInfo[]>([])

  useEffect(() => {
    window.lain.recentActivity(LIMIT).then(setRaws)
    window.lain.listProjects().then(setProjects)
    window.lain.engineCapabilities().then(setEngineInfos)
    // 라이브 갱신 — 작업 상태 변화·새 CC 세션이 곧 피드에 잡히게, tasks:updated 신호에 편승해 재조회.
    return window.lain.onTasksUpdated(() => window.lain.recentActivity(LIMIT).then(setRaws))
  }, [])

  const items = raws ? mergeActivity(raws, LIMIT) : []
  const projectName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name ?? id : '')

  return (
    <div className="drawer panel activity-panel">
      <div className="drawer-head">
        <span className="drawer-title">[ wired://activity — 최근 활동 ]</span>
        <span className="dim">{items.length}건</span>
        <button onClick={onClose}>
          <Icon name="x-circle" size={18} />
        </button>
      </div>
      {!raws ? (
        <div className="dim">로딩...</div>
      ) : items.length === 0 ? (
        <div className="empty">
          아직 기록된 활동이 없다. 작업 실행·Claude Code 세션이 있으면 여기에 타임라인으로 쌓인다.
        </div>
      ) : (
        <div className="activity-list">
          {items.map((it, i) => {
            const proj = projectName(it.projectId)
            return (
              <div key={`${it.source}-${it.at}-${i}`} className="activity-row">
                <span className={`activity-src activity-src-${it.source}`}>
                  {it.source === 'task' && 'TASK '}
                  <EngineBadge
                    engine={it.engine}
                    info={engineInfoFor(engineInfos, it.engine)}
                    observed={it.source === 'cc'}
                  />
                </span>
                <div className="activity-body">
                  <div className="activity-label">
                    {proj && <span className="activity-proj">{proj}</span>}
                    {proj ? ' — ' : ''}
                    {it.label}
                  </div>
                  <div className="dim activity-meta">{fmtRelTime(it.at)}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
