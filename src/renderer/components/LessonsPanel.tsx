// §22 자기개선 — 누적된 학습 목록. "점점 똑똑해지는 게 보인다"의 가시화.
import { useEffect, useState } from 'react'
import type { Lesson, Project } from '../../shared/types'
import { isCleanupCandidate } from '../lib/lessonDerive'
import { lineageLayout } from '../lib/lessonGraph'
import { Icon } from './icons'

export function LessonsPanel({ onClose }: { onClose: () => void }) {
  const [lessons, setLessons] = useState<Lesson[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeOnly, setActiveOnly] = useState(false)
  const [adding, setAdding] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

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
  // '사용만' = 미사용(archived) 제외(stale은 폐지된 잔재라 사용과 동일 취급 — store.ts §수명주기 참조).
  const visible = activeOnly ? all.filter((l) => l.status !== 'archived') : all
  const totalReuse = all.reduce((s, l) => s + l.reuseCount, 0)
  const selected = selectedId != null ? all.find((l) => l.id === selectedId) ?? null : null

  // 범위 표기 — global=레인 자신(Lain), project=그 프로젝트 이름. 내부 sentinel(__lain__)·raw id는 노출 안 함.
  const scopeLabel = (l: Lesson) =>
    l.scope === 'global' ? 'Lain' : projects.find((p) => p.id === l.projectId)?.name ?? l.projectId
  // 상태 — 실질 2상태(사용/미사용). stale은 사용으로 합침(학습 시간만료 폐지).
  const statusLabel = (l: Lesson) => (l.status === 'archived' ? '미사용' : '사용')
  // 등록자 — 이 학습을 누가 추가했나. agent=레인이 자동 추출, user=사용자가 직접 입력.
  const originLabel = (l: Lesson) => (l.origin === 'user' ? 'User' : 'Lain')
  const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '없음')

  async function submitLesson() {
    const trigger = formTrigger.trim()
    const lesson = formLesson.trim()
    if (!lesson || (formScope === 'project' && !formProject)) return
    await window.lain.addLesson({ projectId: formProject, scope: formScope, trigger, lesson })
    setFormTrigger('')
    setFormLesson('')
    setAdding(false)
  }

  return (
    <div className="drawer panel lessons-panel">
      <div className="drawer-head">
        <span className="drawer-title">[ wired://learning — 자기개선 §22 ]</span>
        <span className="dim">
          {all.length}건 · 재사용 {totalReuse}회
        </span>
        <button
          className={`chip lesson-filter-chip${activeOnly ? ' chip-inbox-on' : ''}`}
          onClick={() => setActiveOnly((v) => !v)}
          title="미사용 학습 표시 여부"
        >
          {activeOnly ? '사용만' : '전체'}
        </button>
        <button onClick={onClose}><Icon name="x-circle" size={18} /></button>
      </div>
      {!lessons ? (
        <div className="dim">로딩...</div>
      ) : visible.length === 0 ? (
        <div className="empty">
          {activeOnly && all.length > 0
            ? '사용 중인 학습이 없다. 전체 보기로 미사용 학습을 확인할 수 있다.'
            : '아직 학습한 내용이 없다. 작업이 검증(verify pass)을 통과하면 재사용 학습이 쌓인다.'}
        </div>
      ) : (
        <div className="lessons-list">
          {visible.map((l) => {
            const archived = l.status === 'archived'
            return (
              <div
                key={l.id}
                className={`lesson-row lesson-clickable${archived ? ' lesson-status-archived' : ''}${l.pinned ? ' lesson-pinned' : ''}`}
                onClick={() => setSelectedId(l.id)}
                title="클릭하면 상세 정보"
              >
                <span className={`lesson-scope lesson-scope-${l.scope}`}>{scopeLabel(l)}</span>
                <div className="lesson-body">
                  <div className="lesson-text">{l.lesson}</div>
                  <div className="dim lesson-meta">
                    <span className={`lesson-status lesson-status-${archived ? 'archived' : 'active'}`}>
                      {statusLabel(l)}
                    </span>
                    {l.pinned && (
                      <span className="lesson-status">
                        <Icon name="pin" size={12} />
                      </span>
                    )}
                    {isCleanupCandidate(l) && (
                      <span
                        className="lesson-status lesson-status-cleanup"
                        title="주입은 되는데 한 번도 인용 안 됨 — 정리 후보"
                      >
                        정리 후보
                      </span>
                    )}
                    {l.trigger ? `${l.trigger} · ` : ''}주입 {l.injectCount}회 · 인용 {l.reuseCount}회
                  </div>
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
            <option value="global">Lain (전역)</option>
            <option value="project">프로젝트</option>
          </select>
          <select
            className="lesson-add-input"
            value={formProject}
            onChange={(e) => setFormProject(e.target.value)}
            disabled={formScope === 'global'}
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
            placeholder="적용 시점 (작업 유형·키워드 — 선택)"
          />
          <input
            className="lesson-add-input"
            value={formLesson}
            onChange={(e) => setFormLesson(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitLesson()
            }}
            placeholder="학습 (재사용 가능한 내용)"
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
          + 학습 추가
        </button>
      )}

      {selected && (
        <LessonDetail
          lesson={selected}
          scopeLabel={scopeLabel(selected)}
          statusLabel={statusLabel(selected)}
          originLabel={originLabel(selected)}
          fmtDate={fmtDate}
          onClose={() => setSelectedId(null)}
          onSelect={(id) => {
            // 계보 노드 클릭 → 그 학습 상세로 이동. 목록(all)에 없는 id면 무시(상세가 조용히 닫히지 않게).
            if (all.some((x) => x.id === id)) setSelectedId(id)
          }}
        />
      )}
    </div>
  )
}

// 병합 계보 그래프 — 중심 umbrella(통합본) + 방사형 원본. 좌표 산술은 lessonGraph.ts 순수 함수,
// 여기는 SVG 렌더만(외부 라이브러리 없음, CRT 테마 CSS 변수로 채색). 원본 노드 클릭=그 학습 상세로 이동,
// '+N' 노드 클릭=접힘 펼침. key={umbrella.id}로 마운트돼 학습이 바뀌면 접힘 상태가 초기화된다.
function LessonLineageGraph({
  umbrella,
  originals,
  onSelect,
}: {
  umbrella: Lesson
  originals: Lesson[]
  onSelect: (id: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const lay = lineageLayout(umbrella, originals, expanded)
  if (!lay) return null
  return (
    <svg
      className="lesson-lineage-svg"
      viewBox={`0 0 ${lay.width} ${lay.height}`}
      role="img"
      aria-label={`병합 계보 — 흡수된 원본 ${originals.length}건`}
    >
      {lay.edges.map((e, i) => (
        <line key={i} className="lesson-lineage-edge" x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
      ))}
      {lay.satellites.map((nd) => (
        <g
          key={nd.lessonId ?? 'more'}
          className={`lesson-lineage-node lesson-lineage-${nd.kind}`}
          onClick={() => (nd.kind === 'more' ? setExpanded(true) : nd.lessonId != null && onSelect(nd.lessonId))}
        >
          <title>{nd.title}</title>
          <circle cx={nd.x} cy={nd.y} r={nd.kind === 'more' ? 12 : 8} />
          <text x={nd.x} y={nd.y + (nd.kind === 'more' ? 3 : 21)} textAnchor="middle">
            {nd.label}
          </text>
        </g>
      ))}
      <g className="lesson-lineage-node lesson-lineage-umbrella">
        <title>{lay.umbrella.title}</title>
        <circle cx={lay.cx} cy={lay.cy} r={13} />
        <text x={lay.cx} y={lay.cy + 28} textAnchor="middle">
          {lay.umbrella.label}
        </text>
      </g>
    </svg>
  )
}

// 학습 상세 — 목록에서 뺀 세부(출처·생성·마지막 사용 등) + 관리 버튼(핀/보관/복원/병합 되돌리기)을 모은 모달.
function LessonDetail({
  lesson: l,
  scopeLabel,
  statusLabel,
  originLabel,
  fmtDate,
  onClose,
  onSelect,
}: {
  lesson: Lesson
  scopeLabel: string
  statusLabel: string
  originLabel: string
  fmtDate: (iso: string | null) => string
  onClose: () => void
  onSelect: (id: number) => void // 계보 그래프 노드 클릭 → 그 학습 상세로 전환
}) {
  const archived = l.status === 'archived'
  const isCurator = l.taskId === 'curator'
  const cleanup = isCleanupCandidate(l)
  // C7 — 병합 통합본(umbrella)이면 흡수된 원본 학습 목록을 역참조로 로드(absorbed_into). 큐레이터 산물만.
  const [absorbed, setAbsorbed] = useState<Lesson[]>([])
  useEffect(() => {
    if (isCurator) window.lain.lessonsAbsorbedInto(l.id).then(setAbsorbed)
    else setAbsorbed([])
  }, [l.id, isCurator])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-window lesson-detail" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">학습 상세</span>
          <button className="modal-close" onClick={onClose}>
            <Icon name="x-circle" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="lesson-detail-text">{l.lesson}</div>
          <dl className="lesson-detail-meta">
            <div>
              <dt>범위</dt>
              <dd>{scopeLabel}</dd>
            </div>
            <div>
              <dt>상태</dt>
              <dd>{statusLabel}</dd>
            </div>
            <div>
              <dt>등록자</dt>
              <dd>{originLabel}</dd>
            </div>
            <div>
              <dt>적용 시점</dt>
              <dd>{l.trigger || '지정 안 됨'}</dd>
            </div>
            <div>
              <dt>주입 / 인용</dt>
              <dd>
                주입 {l.injectCount}회 · 인용 {l.reuseCount}회
                {cleanup && (
                  <span
                    className="lesson-status lesson-status-cleanup lesson-detail-cleanup"
                    title="주입은 되는데 한 번도 인용 안 됨 — 정리 후보"
                  >
                    정리 후보
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>생성</dt>
              <dd>{fmtDate(l.createdAt)}</dd>
            </div>
            <div>
              <dt>마지막 사용</dt>
              <dd>{fmtDate(l.lastUsedAt)}</dd>
            </div>
            <div>
              <dt>고정</dt>
              <dd>
                {l.pinned ? (
                  <>
                    <Icon name="pin" size={12} /> 고정됨
                  </>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            {isCurator && (
              <div>
                <dt>출처 유형</dt>
                <dd>큐레이터 병합</dd>
              </div>
            )}
          </dl>
          {/* 병합 계보 그래프 — 이 통합본(umbrella)에 흡수된 원본 학습을 방사형으로 시각화(absorbed_into 역참조).
              노드 클릭=해당 학습 상세로 이동, 많으면 '+N' 노드로 접힘(lessonGraph.ts). */}
          {isCurator && absorbed.length > 0 && (
            <div className="lesson-absorbed">
              <div className="lesson-absorbed-head dim">
                병합 계보 — 흡수된 원본 {absorbed.length}건 (노드 클릭=해당 학습으로 이동)
              </div>
              <LessonLineageGraph key={l.id} umbrella={l} originals={absorbed} onSelect={onSelect} />
            </div>
          )}
          <div className="lesson-detail-actions">
            <button onClick={() => window.lain.pinLesson(l.id, !l.pinned)}>
              <Icon name="pin" size={14} /> {l.pinned ? '고정 해제' : '고정'}
            </button>
            {archived ? (
              <button onClick={() => window.lain.unflagLesson(l.id)}>
                <Icon name="restore" size={14} /> 사용으로
              </button>
            ) : (
              <button onClick={() => window.lain.archiveLesson(l.id)}>
                <Icon name="trash" size={14} /> 미사용으로
              </button>
            )}
            {isCurator && l.consolidationBatch && (
              <button
                onClick={() => {
                  window.lain.revertConsolidation(l.consolidationBatch!)
                  onClose()
                }}
                title="병합 되돌리기 — 흡수된 원본 학습 복구"
              >
                병합 되돌리기
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
