// 플래너 패널(A안) — 월/주/일 캘린더 + 체크리스트 사이드바. 데이터는 plannerList 1회 로드 +
// onPlannerUpdated 재로드(레인 도구·텔레그램發 변경도 라이브). 반복 전개는 planmath 공용 함수.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LainSettings, PlanItem, PlanItemInput, PlanSection, PlanTag, Routine, Task } from '../../shared/types'
import { occurrencesInRange, fmtLocal, parseLocal, staleTodos } from '../../shared/planmath'
import { Icon } from './icons'

type View = 'month' | 'week' | 'day'
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토']
const pad = (n: number) => String(n).padStart(2, '0')
const dateOnly = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}
// 시간축 레인 범위(7시~24시) — 주/일 뷰
const HOURS = Array.from({ length: 18 }, (_, i) => i + 7)

// 루틴 cron이 특정 날짜에 해당하는지(당일 매칭). interval:은 캘린더 의미 없음 — 매칭 안 함.
function routineLabelForDay(cron: string, day: Date): string | null {
  const parts = cron.split(':')
  const kind = parts[0]
  if (kind === 'daily') return `매일 ${parts[1]}:${parts[2]}`
  if (kind === 'hourly') return '매시'
  if (kind === 'weekly') {
    const [, dow, hh, mm] = parts
    if (Number(dow) !== day.getDay()) return null
    return `매주 ${DOW_KO[Number(dow)]} ${hh}:${mm}`
  }
  return null
}

export function PlannerPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<PlanItem[]>([])
  const [tags, setTags] = useState<PlanTag[]>([])
  const [sections, setSections] = useState<PlanSection[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [routines, setRoutines] = useState<Routine[]>([])
  const [settings, setSettings] = useState<LainSettings | null>(null)
  const [view, setView] = useState<View>('month')
  const [cursor, setCursor] = useState(() => new Date()) // 표시 기준일
  const [editing, setEditing] = useState<Partial<PlanItemInput> | null>(null) // null=닫힘, id 없으면 신규
  const [filterTag, setFilterTag] = useState<number | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const dragRef = useRef<{ startX: number; startW: number; side: 'left' | 'right' } | null>(null)

  const reload = useCallback(() => {
    void window.lain.plannerList().then((r) => {
      setItems(r.items)
      setTags(r.tags)
      setSections(r.sections)
    })
    void window.lain.listTasks().then(setTasks)
    void window.lain.listRoutines().then(setRoutines)
  }, [])
  useEffect(() => {
    reload()
    void window.lain.getSettings().then((s) => {
      setSettings(s)
      setView(s.plannerDefaultView)
      setSidebarWidth(s.plannerSidebarWidth)
    })
    return window.lain.onPlannerUpdated(reload)
  }, [reload])

  // ── 뷰 범위 계산: month=6주 그리드(주 시작 설정 반영), week=7일, day=1일 ──
  const weekStart = settings?.plannerWeekStart ?? 1
  const range = useMemo(() => {
    if (view === 'day') {
      const from = dateOnly(cursor)
      return { from, to: addDays(from, 1), cells: [from] }
    }
    if (view === 'week') {
      const c = dateOnly(cursor)
      const diff = (c.getDay() - weekStart + 7) % 7
      const from = addDays(c, -diff)
      const cells = Array.from({ length: 7 }, (_, i) => addDays(from, i))
      return { from, to: addDays(from, 7), cells }
    }
    // month — 6주(42셀) 그리드, 주 시작 반영
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const diff = (first.getDay() - weekStart + 7) % 7
    const from = addDays(first, -diff)
    const cells = Array.from({ length: 42 }, (_, i) => addDays(from, i))
    return { from, to: addDays(from, 42), cells }
  }, [view, cursor, weekStart])

  const fromISO = fmtLocal(range.from)
  const toISO = fmtLocal(range.to)

  // 셀별 표기 — events/마감 todo: occurrencesInRange, filterTag 적용
  const occByDay = useMemo(() => {
    const map = new Map<string, { item: PlanItem; occur: string }[]>()
    for (const it of items) {
      if (it.archived) continue
      if (filterTag != null && it.tagId !== filterTag) continue
      if (it.kind === 'event' && settings && !settings.plannerShowEvents) continue
      if (it.kind === 'todo' && settings && !settings.plannerShowTodos) continue
      if (it.kind === 'todo' && it.done && settings && !settings.plannerShowDone) continue
      for (const occ of occurrencesInRange(it, fromISO, toISO)) {
        const key = occ.slice(0, 10)
        const arr = map.get(key) ?? []
        arr.push({ item: it, occur: occ })
        map.set(key, arr)
      }
    }
    return map
  }, [items, filterTag, fromISO, toISO, settings])

  // 루틴 오버레이(읽기 전용, 노랑) — 당일 매칭 규칙(daily/hourly/weekly). interval은 표시 안 함.
  const routinesByDay = useMemo(() => {
    const map = new Map<string, string[]>()
    if (!settings?.plannerShowRoutines) return map
    for (const day of range.cells) {
      const key = fmtLocal(day).slice(0, 10)
      const labels: string[] = []
      for (const r of routines) {
        if (!r.enabled) continue
        const l = routineLabelForDay(r.cron, day)
        if (l) labels.push(`${r.title} · ${l}`)
      }
      if (labels.length) map.set(key, labels)
    }
    return map
  }, [routines, range.cells, settings])

  // 작업 오버레이(읽기 전용, 청록) — working/review 작업을 updatedAt 날짜에 뱃지
  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>()
    if (!settings?.plannerShowTasks) return map
    for (const t of tasks) {
      if (t.state !== 'working' && t.state !== 'review') continue
      const key = t.updatedAt.slice(0, 10)
      const arr = map.get(key) ?? []
      arr.push(t)
      map.set(key, arr)
    }
    return map
  }, [tasks, settings])

  const todayKey = fmtLocal(new Date()).slice(0, 10)

  const goPrev = () => setCursor((c) => (view === 'month' ? new Date(c.getFullYear(), c.getMonth() - 1, 1) : addDays(c, view === 'week' ? -7 : -1)))
  const goNext = () => setCursor((c) => (view === 'month' ? new Date(c.getFullYear(), c.getMonth() + 1, 1) : addDays(c, view === 'week' ? 7 : 1)))
  const goToday = () => setCursor(new Date())

  const openNewEvent = (day: Date) => {
    const d = new Date(day)
    d.setHours(9, 0, 0, 0)
    setEditing({ kind: 'event', title: '', startAt: fmtLocal(d), endAt: null, allDay: false, recur: 'none' })
  }
  const openNewTodo = () => {
    setEditing({ kind: 'todo', title: '', startAt: null, endAt: null, allDay: false, recur: 'none' })
  }
  const openEdit = (item: PlanItem) => setEditing({ ...item })

  async function saveEditing(input: Partial<PlanItemInput>) {
    if (!input.title || !input.title.trim() || !input.kind) return
    await window.lain.plannerUpsertItem(input as PlanItemInput)
    setEditing(null)
  }
  async function deleteEditing(id: number) {
    await window.lain.plannerDeleteItem(id)
    setEditing(null)
  }

  // 사이드바 폭 드래그 — mousedown에서 시작 좌표 기록, mousemove로 px 갱신, mouseup에 설정 저장.
  const onSidebarDragStart = (e: React.MouseEvent) => {
    const side = settings?.plannerSidebarSide ?? 'right'
    dragRef.current = { startX: e.clientX, startW: sidebarWidth, side }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const delta = dragRef.current.side === 'right' ? -dx : dx
      const w = Math.min(480, Math.max(200, dragRef.current.startW + delta))
      setSidebarWidth(w)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragRef.current = null
      setSidebarWidth((w) => {
        void window.lain.setSettings({ plannerSidebarWidth: w })
        return w
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const density = settings?.plannerDensity ?? 'cozy'
  const sidebarSide = settings?.plannerSidebarSide ?? 'right'
  const staleDays = settings?.plannerStaleDays ?? 7
  const now = Date.now()
  const staleIds = useMemo(() => new Set(staleTodos(items, new Date(now), staleDays).map((i) => i.id)), [items, now, staleDays])

  const headerLabel =
    view === 'month'
      ? `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`
      : view === 'week'
        ? `${fmtLocal(range.cells[0]).slice(0, 10)} ~ ${fmtLocal(range.cells[6]).slice(0, 10)}`
        : fmtLocal(cursor).slice(0, 10)

  const sidebarTodos = useMemo(() => {
    return items
      .filter((i) => i.kind === 'todo' && !i.archived)
      .filter((i) => (settings?.plannerShowDone ? true : !i.done))
      .filter((i) => filterTag == null || i.tagId === filterTag)
      .sort((a, b) => (a.pinned === b.pinned ? a.sortOrder - b.sortOrder : a.pinned ? -1 : 1))
  }, [items, settings, filterTag])

  const sectionOf = (secId: number | null) => sections.find((s) => s.id === secId) ?? null

  return (
    <div className="drawer panel planner-panel" data-density={density}>
      <div className="drawer-head">
        <span className="drawer-title">[ wired://planner — {headerLabel} ]</span>
        <span className="planner-viewsw">
          {(['month', 'week', 'day'] as View[]).map((v) => (
            <button key={v} className={`chip${view === v ? ' chip-inbox-on' : ''}`} onClick={() => setView(v)}>
              {v === 'month' ? '월' : v === 'week' ? '주' : '일'}
            </button>
          ))}
        </span>
        <button className="chip" onClick={goPrev} title="이전"><Icon name="caret-left" size={14} /></button>
        <button className="chip" onClick={goToday} title="오늘">오늘</button>
        <button className="chip" onClick={goNext} title="다음"><Icon name="caret-right" size={14} /></button>
        <span className="planner-tagfilter">
          <Icon name="tag" size={14} />
          <button className={`chip${filterTag == null ? ' chip-inbox-on' : ''}`} onClick={() => setFilterTag(null)}>
            전체
          </button>
          {tags.map((t) => (
            <button
              key={t.id}
              className={`chip planner-tag-chip${filterTag === t.id ? ' chip-inbox-on' : ''}`}
              style={{ borderColor: t.color, color: filterTag === t.id ? undefined : t.color }}
              onClick={() => setFilterTag((cur) => (cur === t.id ? null : t.id))}
            >
              {t.name}
            </button>
          ))}
        </span>
        <button onClick={onClose}><Icon name="x-circle" size={18} /></button>
      </div>

      <div className={`planner-body planner-side-${sidebarSide}`}>
        {sidebarSide === 'left' && (
          <PlannerSidebar
            sections={sections}
            todos={sidebarTodos}
            staleIds={staleIds}
            now={now}
            onEdit={openEdit}
            onToggleDone={(id, done) => window.lain.plannerSetDone(id, done)}
            onAdd={openNewTodo}
            onDragStart={onSidebarDragStart}
            width={sidebarWidth}
            handleSide="right"
          />
        )}

        <div className="planner-main">
          {view === 'month' && (
            <MonthGrid
              cells={range.cells}
              cursorMonth={cursor.getMonth()}
              todayKey={todayKey}
              occByDay={occByDay}
              routinesByDay={routinesByDay}
              tasksByDay={tasksByDay}
              tags={tags}
              onCellClick={openNewEvent}
              onItemClick={openEdit}
            />
          )}
          {(view === 'week' || view === 'day') && (
            <TimelineView
              cells={range.cells}
              occByDay={occByDay}
              routinesByDay={routinesByDay}
              tasksByDay={tasksByDay}
              tags={tags}
              todayKey={todayKey}
              onCellClick={openNewEvent}
              onItemClick={openEdit}
            />
          )}
        </div>

        {sidebarSide === 'right' && (
          <PlannerSidebar
            sections={sections}
            todos={sidebarTodos}
            staleIds={staleIds}
            now={now}
            onEdit={openEdit}
            onToggleDone={(id, done) => window.lain.plannerSetDone(id, done)}
            onAdd={openNewTodo}
            onDragStart={onSidebarDragStart}
            width={sidebarWidth}
            handleSide="left"
          />
        )}
      </div>

      {editing && (
        <PlannerEditForm
          editing={editing}
          tags={tags}
          sections={sections}
          onChange={setEditing}
          onSave={saveEditing}
          onDelete={deleteEditing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// ── 월 그리드 — 7열 42셀 ──
function MonthGrid({
  cells,
  cursorMonth,
  todayKey,
  occByDay,
  routinesByDay,
  tasksByDay,
  tags,
  onCellClick,
  onItemClick,
}: {
  cells: Date[]
  cursorMonth: number
  todayKey: string
  occByDay: Map<string, { item: PlanItem; occur: string }[]>
  routinesByDay: Map<string, string[]>
  tasksByDay: Map<string, Task[]>
  tags: PlanTag[]
  onCellClick: (d: Date) => void
  onItemClick: (item: PlanItem) => void
}) {
  const tagColor = (id: number | null) => (id != null ? tags.find((t) => t.id === id)?.color : undefined)
  return (
    <div className="planner-grid">
      {DOW_KO.map((d) => (
        <div key={d} className="planner-dow">
          {d}
        </div>
      ))}
      {cells.map((day) => {
        const key = fmtLocal(day).slice(0, 10)
        const occs = occByDay.get(key) ?? []
        const routineLabels = routinesByDay.get(key) ?? []
        const dayTasks = tasksByDay.get(key) ?? []
        const outside = day.getMonth() !== cursorMonth
        return (
          <div
            key={key}
            className={`planner-cell${outside ? ' planner-cell-outside' : ''}${key === todayKey ? ' planner-cell-today' : ''}`}
            onClick={() => onCellClick(day)}
          >
            <div className="planner-cell-date">{day.getDate()}</div>
            <div className="planner-cell-evs">
              {occs.map(({ item, occur }) => {
                const color = tagColor(item.tagId)
                return (
                  <div
                    key={`${item.id}-${occur}`}
                    className={`planner-ev${item.kind === 'todo' ? ' planner-ev-todo' : ''}${item.done ? ' planner-ev-done' : ''}`}
                    style={color ? { borderLeftColor: color, color } : undefined}
                    onClick={(e) => {
                      e.stopPropagation()
                      onItemClick(item)
                    }}
                  >
                    {item.title}
                  </div>
                )
              })}
              {routineLabels.map((l, i) => (
                <div key={`r${i}`} className="planner-ev planner-ev-routine">
                  {l}
                </div>
              ))}
              {dayTasks.map((t) => (
                <div key={t.id} className="planner-ev planner-ev-task">
                  ⚙ {t.title}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── 주/일 뷰 — 시간축(07~24시) 레인. all_day·마감 todo는 상단 띠 ──
function TimelineView({
  cells,
  occByDay,
  routinesByDay,
  tasksByDay,
  tags,
  todayKey,
  onCellClick,
  onItemClick,
}: {
  cells: Date[]
  occByDay: Map<string, { item: PlanItem; occur: string }[]>
  routinesByDay: Map<string, string[]>
  tasksByDay: Map<string, Task[]>
  tags: PlanTag[]
  todayKey: string
  onCellClick: (d: Date) => void
  onItemClick: (item: PlanItem) => void
}) {
  const tagColor = (id: number | null) => (id != null ? tags.find((t) => t.id === id)?.color : undefined)
  return (
    <div className="planner-timeline-wrap" style={{ '--planner-cols': cells.length } as React.CSSProperties}>
      <div className="planner-timeline-head">
        <div className="planner-timeline-gutter" />
        {cells.map((day) => {
          const key = fmtLocal(day).slice(0, 10)
          return (
            <div
              key={key}
              className={`planner-timeline-daylabel${key === todayKey ? ' planner-cell-today' : ''}`}
              onClick={() => onCellClick(day)}
            >
              {DOW_KO[day.getDay()]} {day.getMonth() + 1}/{day.getDate()}
            </div>
          )
        })}
      </div>
      <div className="planner-timeline-allday">
        <div className="planner-timeline-gutter dim">종일</div>
        {cells.map((day) => {
          const key = fmtLocal(day).slice(0, 10)
          const occs = (occByDay.get(key) ?? []).filter(({ item }) => item.allDay || item.kind === 'todo')
          const routineLabels = routinesByDay.get(key) ?? []
          const dayTasks = tasksByDay.get(key) ?? []
          return (
            <div key={key} className="planner-timeline-alldaycell">
              {occs.map(({ item, occur }) => {
                const color = tagColor(item.tagId)
                return (
                  <div
                    key={`${item.id}-${occur}`}
                    className={`planner-ev${item.kind === 'todo' ? ' planner-ev-todo' : ''}${item.done ? ' planner-ev-done' : ''}`}
                    style={color ? { borderLeftColor: color, color } : undefined}
                    onClick={() => onItemClick(item)}
                  >
                    {item.title}
                  </div>
                )
              })}
              {routineLabels.map((l, i) => (
                <div key={`r${i}`} className="planner-ev planner-ev-routine">
                  {l}
                </div>
              ))}
              {dayTasks.map((t) => (
                <div key={t.id} className="planner-ev planner-ev-task">
                  ⚙ {t.title}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <div className="planner-timeline-body">
        <div className="planner-timeline-gutter-col">
          {HOURS.map((h) => (
            <div key={h} className="planner-timeline-hour">
              {pad(h % 24)}:00
            </div>
          ))}
        </div>
        {cells.map((day) => {
          const key = fmtLocal(day).slice(0, 10)
          const occs = (occByDay.get(key) ?? []).filter(({ item }) => !item.allDay && item.kind === 'event')
          return (
            <div key={key} className="planner-timeline-daycol" onClick={() => onCellClick(day)}>
              {HOURS.map((h) => (
                <div key={h} className="planner-timeline-slot" />
              ))}
              {occs.map(({ item, occur }) => {
                const start = parseLocal(occur)
                const startHour = start.getHours() + start.getMinutes() / 60
                const top = Math.max(0, (startHour - HOURS[0]) * 32)
                let heightHrs = 1
                if (item.endAt) {
                  const end = parseLocal(item.endAt)
                  const s = parseLocal(item.startAt!)
                  heightHrs = Math.max(0.5, (end.getTime() - s.getTime()) / 3_600_000)
                }
                const color = tagColor(item.tagId)
                return (
                  <div
                    key={`${item.id}-${occur}`}
                    className="planner-ev planner-ev-timed"
                    style={{
                      top,
                      height: Math.max(20, heightHrs * 32),
                      ...(color ? { borderLeftColor: color, color } : {}),
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      onItemClick(item)
                    }}
                  >
                    {item.title}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 사이드바 — 체크리스트(섹션별) ──
function PlannerSidebar({
  sections,
  todos,
  staleIds,
  now,
  onEdit,
  onToggleDone,
  onAdd,
  onDragStart,
  width,
  handleSide,
}: {
  sections: PlanSection[]
  todos: PlanItem[]
  staleIds: Set<number>
  now: number
  onEdit: (item: PlanItem) => void
  onToggleDone: (id: number, done: boolean) => void
  onAdd: () => void
  onDragStart: (e: React.MouseEvent) => void
  width: number
  handleSide: 'left' | 'right'
}) {
  const grouped = useMemo(() => {
    const bySec = new Map<number | null, PlanItem[]>()
    for (const t of todos) {
      const arr = bySec.get(t.sectionId) ?? []
      arr.push(t)
      bySec.set(t.sectionId, arr)
    }
    return bySec
  }, [todos])

  const ordered = [...sections].sort((a, b) => a.sortOrder - b.sortOrder)

  const renderRow = (item: PlanItem) => {
    const stale = staleIds.has(item.id)
    // body 안 URL을 <a>로 표시
    const bodyParts = item.body ? item.body.split(/(https?:\/\/\S+)/g) : []
    return (
      <div key={item.id} className={`planner-todo-row${item.done ? ' planner-todo-done' : ''}`}>
        <input
          type="checkbox"
          checked={item.done}
          onChange={(e) => onToggleDone(item.id, e.target.checked)}
          onClick={(e) => e.stopPropagation()}
        />
        <div className="planner-todo-body" onClick={() => onEdit(item)}>
          <span className="planner-todo-title">
            {item.pinned && (
              <>
                <Icon name="pin" size={12} />{' '}
              </>
            )}
            {item.title}
            {stale && <span className="planner-stale-badge"> ⚠ {Math.floor((now - parseLocal(item.updatedAt.replace(' ', 'T').slice(0, 16)).getTime()) / 86_400_000)}d</span>}
          </span>
          {item.startAt && <span className="dim planner-todo-due"> · 마감 {fmtLocal(parseLocal(item.startAt)).replace('T', ' ')}</span>}
          {bodyParts.length > 0 && (
            <div className="dim planner-todo-note">
              {bodyParts.map((p, i) =>
                /^https?:\/\//.test(p) ? (
                  <a key={i} href={p} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    {p}
                  </a>
                ) : (
                  <span key={i}>{p}</span>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="planner-side" style={{ width }}>
      <div className={`planner-side-handle planner-side-handle-${handleSide}`} onMouseDown={onDragStart} />
      <div className="planner-side-scroll">
        {ordered.map((sec) => {
          const rows = grouped.get(sec.id) ?? []
          const isCollapsed = sec.collapsed
          return (
            <div key={sec.id} className="planner-section">
              <div
                className="planner-section-head"
                onClick={() =>
                  window.lain.plannerUpsertSection({ id: sec.id, name: sec.name, sortOrder: sec.sortOrder, collapsed: !isCollapsed })
                }
              >
                <span>
                  <Icon name={isCollapsed ? 'chevron-down' : 'chevron-up'} size={12} /> {sec.name}
                </span>
                <span className="dim">{rows.length}</span>
              </div>
              {!isCollapsed && rows.map(renderRow)}
            </div>
          )
        })}
        {(grouped.get(null) ?? []).length > 0 && (
          <div className="planner-section">
            <div className="planner-section-head">
              <span>미분류</span>
              <span className="dim">{(grouped.get(null) ?? []).length}</span>
            </div>
            {(grouped.get(null) ?? []).map(renderRow)}
          </div>
        )}
        {todos.length === 0 && <div className="empty">할 일이 없다.</div>}
      </div>
      <button className="chip planner-side-add" onClick={onAdd}>
        <Icon name="plus" size={14} /> 할 일 추가
      </button>
    </div>
  )
}

// ── 편집 폼 ──
function PlannerEditForm({
  editing,
  tags,
  sections,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  editing: Partial<PlanItemInput>
  tags: PlanTag[]
  sections: PlanSection[]
  onChange: (v: Partial<PlanItemInput>) => void
  onSave: (v: Partial<PlanItemInput>) => void
  onDelete: (id: number) => void
  onClose: () => void
}) {
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#b18cf0')
  const [addingTag, setAddingTag] = useState(false)

  const set = <K extends keyof PlanItemInput>(k: K, v: PlanItemInput[K]) => onChange({ ...editing, [k]: v })

  const recurKind = (() => {
    const r = editing.recur ?? 'none'
    if (r === 'none' || r === 'daily') return r
    if (r.startsWith('weekly:')) return 'weekly'
    if (r.startsWith('monthly:')) return 'monthly'
    return 'none'
  })()
  const recurDow = editing.recur?.startsWith('weekly:') ? Number(editing.recur.split(':')[1]) : new Date().getDay()
  const recurDom = editing.recur?.startsWith('monthly:') ? Number(editing.recur.split(':')[1]) : 1

  async function addTag() {
    if (!newTagName.trim()) return
    const id = await window.lain.plannerUpsertTag({ name: newTagName.trim(), color: newTagColor })
    set('tagId', id)
    setNewTagName('')
    setAddingTag(false)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-window planner-edit-form" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{editing.id ? '일정/할 일 편집' : '새 일정/할 일'}</span>
          <button className="modal-close" onClick={onClose}><Icon name="x-circle" size={18} /></button>
        </div>
        <div className="modal-body planner-edit-body">
          <div className="planner-edit-row">
            <select value={editing.kind ?? 'event'} onChange={(e) => set('kind', e.target.value as 'event' | 'todo')}>
              <option value="event">일정</option>
              <option value="todo">할 일</option>
            </select>
            <input
              className="planner-edit-title"
              value={editing.title ?? ''}
              onChange={(e) => set('title', e.target.value)}
              placeholder="제목"
              autoFocus
            />
          </div>

          <div className="planner-edit-row">
            <label className="dim">시작</label>
            <input
              type="datetime-local"
              value={editing.startAt ?? ''}
              onChange={(e) => set('startAt', e.target.value || null)}
            />
            <label className="dim">종료</label>
            <input
              type="datetime-local"
              value={editing.endAt ?? ''}
              onChange={(e) => set('endAt', e.target.value || null)}
            />
            <label className="dim">
              <input type="checkbox" checked={editing.allDay ?? false} onChange={(e) => set('allDay', e.target.checked)} /> 종일
            </label>
          </div>

          <div className="planner-edit-row">
            <label className="dim">반복</label>
            <select
              value={recurKind}
              onChange={(e) => {
                const k = e.target.value
                if (k === 'none' || k === 'daily') set('recur', k)
                else if (k === 'weekly') set('recur', `weekly:${recurDow}`)
                else if (k === 'monthly') set('recur', `monthly:${recurDom}`)
              }}
            >
              <option value="none">없음</option>
              <option value="daily">매일</option>
              <option value="weekly">매주</option>
              <option value="monthly">매월</option>
            </select>
            {recurKind === 'weekly' && (
              <select value={recurDow} onChange={(e) => set('recur', `weekly:${e.target.value}`)}>
                {DOW_KO.map((d, i) => (
                  <option key={i} value={i}>{d}요일</option>
                ))}
              </select>
            )}
            {recurKind === 'monthly' && (
              <input
                type="number"
                min={1}
                max={31}
                value={recurDom}
                onChange={(e) => set('recur', `monthly:${Math.min(31, Math.max(1, Number(e.target.value) || 1))}`)}
                style={{ width: 56 }}
              />
            )}
          </div>

          <div className="planner-edit-row">
            <label className="dim">태그</label>
            <select value={editing.tagId ?? ''} onChange={(e) => set('tagId', e.target.value ? Number(e.target.value) : null)}>
              <option value="">없음</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {addingTag ? (
              <>
                <input
                  className="planner-edit-newtag"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="새 태그 이름"
                />
                <input type="color" value={newTagColor} onChange={(e) => setNewTagColor(e.target.value)} />
                <button onClick={addTag}>추가</button>
                <button onClick={() => setAddingTag(false)}>취소</button>
              </>
            ) : (
              <button className="chip" onClick={() => setAddingTag(true)}>
                <Icon name="plus" size={12} /> 새 태그
              </button>
            )}
          </div>

          {editing.kind === 'todo' && (
            <div className="planner-edit-row">
              <label className="dim">섹션</label>
              <select value={editing.sectionId ?? ''} onChange={(e) => set('sectionId', e.target.value ? Number(e.target.value) : null)}>
                <option value="">미분류</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="planner-edit-row">
            <label className="dim">리마인드(분 전)</label>
            <input
              type="number"
              min={0}
              value={editing.remindOffsetMin ?? ''}
              onChange={(e) => set('remindOffsetMin', e.target.value ? Number(e.target.value) : null)}
              placeholder="설정 기본"
              style={{ width: 80 }}
            />
          </div>

          <textarea
            className="planner-edit-note"
            value={editing.body ?? ''}
            onChange={(e) => set('body', e.target.value)}
            placeholder="메모 (URL은 자동으로 링크 표시)"
          />

          <div className="planner-edit-actions">
            <button onClick={() => onSave(editing)} disabled={!editing.title?.trim()}>저장</button>
            {editing.id != null && (
              <>
                <button onClick={() => window.lain.plannerSetDone(editing.id!, !editing.done)}>
                  {editing.done ? '미완료로' : '완료 처리'}
                </button>
                <button onClick={() => onDelete(editing.id!)}>
                  <Icon name="trash" size={14} /> 삭제
                </button>
              </>
            )}
            <button onClick={onClose}>취소</button>
          </div>
        </div>
      </div>
    </div>
  )
}
