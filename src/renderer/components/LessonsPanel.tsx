// §22 자기개선 — 누적된 교훈 목록. "점점 똑똑해지는 게 보인다"의 가시화.
import { useEffect, useState } from 'react'
import type { Lesson, Project } from '../../shared/types'

const STATUS_LABEL: Record<Lesson['status'], string> = {
  active: 'active',
  stale: 'stale',
  archived: 'archived',
}

export function LessonsPanel({ onClose }: { onClose: () => void }) {
  const [lessons, setLessons] = useState<Lesson[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeOnly, setActiveOnly] = useState(false)
  const [adding, setAdding] = useState(false)

  // 추가 폼 상태
  const [formProject, setFormProject] = useState('')
  const [formScope, setFormScope] = useState<'project' | 'global'>('project')
  const [formTrigger, setFormTrigger] = useState('')
  const [formLesson, setFormLesson] = useState('')

  useEffect(() => {
    window.lain.listLessons().then(setLessons)
    window.lain.listProjects().then((ps) => {
      setProjects(ps)
      if (ps.length) setFormProject((p) => p || ps[0].id)
    })
    return window.lain.onLessonsUpdated(setLessons)
  }, [])

  const all = lessons ?? []
  const visible = activeOnly ? all.filter((l) => l.status === 'active') : all
  const totalReuse = all.reduce((s, l) => s + l.reuseCount, 0)

  async function submitLesson() {
    const trigger = formTrigger.trim()
    const lesson = formLesson.trim()
    if (!lesson || (formScope === 'project' && !formProject)) return
    await window.lain.addLesson({
      projectId: formProject,
      scope: formScope,
      trigger,
      lesson,
    })
    setFormTrigger('')
    setFormLesson('')
    setAdding(false)
  }

  return (
    <div className="drawer panel lessons-panel">
      <div className="drawer-head">
        <span className="drawer-title">[ wired://lessons — 자기개선 §22 ]</span>
        <span className="dim">
          {all.length}건 · 재사용 {totalReuse}회
        </span>
        <button
          className={`chip lesson-filter-chip${activeOnly ? ' chip-inbox-on' : ''}`}
          onClick={() => setActiveOnly((v) => !v)}
          title="보관·stale 교훈 표시 여부"
        >
          {activeOnly ? '활성만' : '전체'}
        </button>
        <button onClick={onClose}>✕</button>
      </div>
      {!lessons ? (
        <div className="dim">로딩...</div>
      ) : visible.length === 0 ? (
        <div className="empty">
          {activeOnly && all.length > 0
            ? '활성 교훈이 없다. 전체 보기로 보관된 교훈을 확인할 수 있다.'
            : '아직 학습한 교훈이 없다. 작업이 검증(verify pass)을 통과하면 재사용 교훈이 쌓인다.'}
        </div>
      ) : (
        <div className="lessons-list">
          {visible.map((l) => {
            const archived = l.status === 'archived'
            return (
              <div
                key={l.id}
                className={`lesson-row${archived ? ' lesson-status-archived' : ''}${l.pinned ? ' lesson-pinned' : ''}`}
              >
                <span className={`lesson-scope lesson-scope-${l.scope}`}>{l.scope}</span>
                <div className="lesson-body">
                  <div className="lesson-text">{l.lesson}</div>
                  <div className="dim lesson-meta">
                    <span className={`lesson-status lesson-status-${l.status}`}>
                      {STATUS_LABEL[l.status]}
                    </span>
                    <span className={`lesson-origin lesson-origin-${l.origin}`}>
                      {l.origin === 'user' ? 'user' : 'agent'}
                    </span>
                    {l.taskId === 'curator' && <span className="lesson-status">curator 병합</span>}
                    {l.projectId}
                    {l.trigger ? ` · ${l.trigger}` : ''} · 재사용 {l.reuseCount}회
                  </div>
                </div>
                <div className="lesson-actions">
                  {l.taskId === 'curator' && l.consolidationBatch && (
                    <button
                      className="lesson-revert"
                      onClick={() => window.lain.revertConsolidation(l.consolidationBatch!)}
                      title="병합 되돌리기 (umbrella 보관 → 흡수된 원본 교훈 복구)"
                    >
                      병합 되돌리기
                    </button>
                  )}
                  <button
                    className={`lesson-pin${l.pinned ? ' lesson-pinned' : ''}`}
                    onClick={() => window.lain.pinLesson(l.id, !l.pinned)}
                    title={l.pinned ? '고정 해제' : '고정 (수명주기·curator 폐기 제외)'}
                  >
                    📌
                  </button>
                  {archived ? (
                    <button
                      className="lesson-unflag"
                      onClick={() => window.lain.unflagLesson(l.id)}
                      title="복원 (active로)"
                    >
                      ♻
                    </button>
                  ) : (
                    <button
                      className="lesson-flag"
                      onClick={() => window.lain.flagLesson(l.id)}
                      title="보관 (주입 제외)"
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {adding ? (
        <div className="lesson-add-form">
          <select
            className="lesson-add-input"
            value={formScope}
            onChange={(e) => setFormScope(e.target.value as 'project' | 'global')}
          >
            <option value="project">project</option>
            <option value="global">global</option>
          </select>
          <select
            className="lesson-add-input"
            value={formProject}
            onChange={(e) => setFormProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className="lesson-add-input"
            value={formTrigger}
            onChange={(e) => setFormTrigger(e.target.value)}
            placeholder="trigger (언제 적용 — 작업 유형·키워드)"
          />
          <input
            className="lesson-add-input"
            value={formLesson}
            onChange={(e) => setFormLesson(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitLesson()
            }}
            placeholder="lesson (재사용 가능한 교훈 본문)"
          />
          <div className="lesson-actions">
            <button onClick={submitLesson} disabled={!formLesson.trim()} title="추가">
              추가
            </button>
            <button onClick={() => setAdding(false)} title="취소">
              취소
            </button>
          </div>
        </div>
      ) : (
        <button className="chip lesson-add-toggle" onClick={() => setAdding(true)}>
          + 교훈 추가
        </button>
      )}
    </div>
  )
}
