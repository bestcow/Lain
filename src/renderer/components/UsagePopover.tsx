// C4 — 헤더 토큰 표시 클릭 시 뜨는 사용량 팝오버: 최근 14일 미니 바차트(자작 div 바, 외부 차트 의존 0)
// + 프로젝트별 상위 소비 목록. 데이터(오늘/일별/상위)는 상위(App)에서 summarizeUsage로 이미 파생돼 온다.
import type { Project } from '../../shared/types'
import type { UsageSummary } from '../lib/tokenUsage'
import { fmtTokens } from '../App'
import { usageLabel } from '../lib/chat'
import { Icon } from './icons'

/** 'YYYY-MM-DD' → 'M/D' (바 축 라벨용, 좁은 팝오버라 간결하게). */
function shortDay(day: string): string {
  const [, m, d] = day.split('-')
  return m && d ? `${Number(m)}/${Number(d)}` : day
}

export function UsagePopover({
  usage,
  projects,
  onClose,
}: {
  usage: UsageSummary
  projects: Project[]
  onClose: () => void
}) {
  const maxTok = Math.max(1, ...usage.days.map((d) => d.tokens))
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id
  const todayKey = usage.days.length ? usage.days[usage.days.length - 1].day : ''
  return (
    <>
      <div className="usage-pop-backdrop" onClick={onClose} />
      <div className="usage-pop" onClick={(e) => e.stopPropagation()}>
        <div className="usage-pop-head">
          <span className="usage-pop-title">토큰 사용량 · 최근 {usage.days.length}일</span>
          <button className="usage-pop-close" onClick={onClose} aria-label="닫기">
            <Icon name="x-circle" size={16} />
          </button>
        </div>
        <div className="usage-pop-today dim">
          오늘 {usageLabel(fmtTokens(usage.todayTokens), usage.todayCost)} · {usage.todayCount}건
        </div>
        {/* 미니 바차트 — div 높이 바(외부 라이브러리 없음). 빈 날도 0-높이 바로 자리를 지켜 축이 연속. */}
        <div className="usage-bars">
          {usage.days.map((d) => {
            const h = Math.round((d.tokens / maxTok) * 100)
            const isToday = d.day === todayKey
            return (
              <div
                key={d.day}
                className="usage-bar-col"
                title={`${d.day} · ${usageLabel(fmtTokens(d.tokens), d.costUsd)} · ${d.count}건`}
              >
                <div className="usage-bar-track">
                  <div
                    className={`usage-bar-fill${isToday ? ' usage-bar-today' : ''}`}
                    style={{ height: `${h}%` }}
                  />
                </div>
                <div className="usage-bar-label dim">{shortDay(d.day)}</div>
              </div>
            )
          })}
        </div>
        {/* 프로젝트별 상위 소비 — 창(15일) 전체 기준. */}
        <div className="usage-pop-projects">
          <div className="usage-pop-subhead dim">프로젝트별 상위</div>
          {usage.topProjects.length === 0 ? (
            <div className="dim">데이터 없음</div>
          ) : (
            usage.topProjects.map((p) => (
              <div key={p.projectId} className="usage-proj-row">
                <span className="usage-proj-name">{projectName(p.projectId)}</span>
                <span className="usage-proj-tok dim">
                  {usageLabel(fmtTokens(p.tokens), p.costUsd)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
