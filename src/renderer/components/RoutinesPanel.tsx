// B5 loop-mode — 선언적 루틴(주기 반복) 관리 UI. 백엔드(store CRUD·scheduler 디스패치)는 기존,
// 이 패널만 신규. 만기 루틴의 prompt를 scheduler가 Lain에게 보낸다(routinesEnabled=on일 때만).
import { useEffect, useState } from 'react'
import type { Routine, Project } from '../../shared/types'
import { Icon } from './icons'

type Kind = 'daily' | 'hourly' | 'weekly' | 'interval'
const pad = (n: number) => String(n).padStart(2, '0')
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토']

// 로컬(한국시간) 입력 → UTC cron 문자열. 저장·스케줄러(computeNextRun)는 UTC 기준이라 변환한다.
// hourly(분)·interval(경과분)은 tz 무관 → 변환 없음. daily·weekly만 로컬→UTC로 시·요일 이동.
export function buildCron(kind: Kind, h: number, m: number, dow: number, interval: number): string | null {
  if (kind === 'interval') return interval > 0 ? `interval:${interval}` : null
  if (kind === 'hourly') return m >= 0 && m <= 59 ? `hourly:${m}` : null
  if (kind === 'daily') {
    const d = new Date()
    d.setHours(h, m, 0, 0)
    return `daily:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  }
  // weekly — 이번 주 해당 로컬 요일/시각으로 Date를 맞춘 뒤 UTC 요일/시각을 읽는다(자정 넘으면 요일도 이동).
  const d = new Date()
  d.setHours(h, m, 0, 0)
  d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7))
  return `weekly:${d.getUTCDay()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// 저장된 cron의 '종류'만 사람 말로(정확한 시각은 nextRunAt 로컬 표시가 보여줌).
function cronKindLabel(cron: string): string {
  const [kind, a] = cron.split(':')
  if (kind === 'interval') return `${a}분마다`
  if (kind === 'hourly') return `매시 ${a}분`
  if (kind === 'daily') return '매일'
  if (kind === 'weekly') return `매주 ${DOW_KO[Number(a)] ?? '?'}`
  return cron
}

const fmtLocal = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '—'

export function RoutinesPanel({ onClose }: { onClose: () => void }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [adding, setAdding] = useState(false)
  // 전역 스위치(기본 off) — off면 scheduler가 디스패치 자체를 안 한다. 목록만 보면 'on · 다음 09:00'이라
  // 예약이 살아 있는 것처럼 읽히므로 상시 배너로 알린다.
  const [routinesEnabled, setRoutinesEnabled] = useState(true)

  // 추가 폼
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<Kind>('daily')
  const [time, setTime] = useState('09:00') // 로컬 HH:MM (daily·weekly)
  const [minute, setMinute] = useState(0) // hourly 분
  const [interval, setInterval_] = useState(30) // interval 분
  const [dow, setDow] = useState(1) // weekly 요일(0=일)
  const [projectId, setProjectId] = useState<string>('') // '' = 전역(Lain)

  useEffect(() => {
    window.lain.listRoutines().then(setRoutines)
    window.lain.listProjects().then(setProjects)
    return window.lain.onRoutinesUpdated(setRoutines)
  }, [])

  // 전역 스위치 조회 + 라이브 반영(환경설정·레인 도구에서 바뀌어도 배너가 따라간다).
  useEffect(() => {
    void window.lain.getSettings().then((s) => setRoutinesEnabled(s.routinesEnabled))
    return window.lain.onSettingsUpdated((s) => setRoutinesEnabled(s.routinesEnabled))
  }, [])

  const all = routines ?? []

  async function submit() {
    const [hh, mm] = time.split(':').map(Number)
    // hourly는 time(HH:MM)이 아니라 전용 minute 입력을 쓴다 — time에서 유도하면 항상 hourly:0이 되던 버그.
    const cron = buildCron(kind, hh || 0, kind === 'hourly' ? minute : mm || 0, dow, interval)
    if (!title.trim() || !prompt.trim() || !cron) return
    await window.lain.createRoutine({
      projectId: projectId || null,
      title: title.trim(),
      prompt: prompt.trim(),
      cron,
    })
    setTitle('')
    setPrompt('')
    setAdding(false)
  }

  return (
    <div className="drawer panel routines-panel">
      <div className="drawer-head">
        <span className="drawer-title">[ wired://routines — 반복 실행 §loop ]</span>
        <span className="dim">{all.length}개</span>
        <button onClick={onClose}><Icon name="x-circle" size={18} /></button>
      </div>

      {/* 전역 off 배너 — 목록이 생기면 사라지던 경고를 상시로. 그 자리에서 켤 수 있다. */}
      {!routinesEnabled && (
        <div className="warn routines-off-banner">
          루틴 실행이 꺼져 있다 — 등록만 되고 실행되지 않는다.{' '}
          <button
            className="chip"
            onClick={() => void window.lain.setSettings({ routinesEnabled: true })}
          >
            켜기
          </button>
        </div>
      )}

      {!routines ? (
        <div className="dim">로딩...</div>
      ) : all.length === 0 ? (
        <div className="empty">
          아직 루틴이 없다. 아래에서 만들면 정해진 일정마다 그 지시가 Lain에게 전달된다(설정에서 '루틴 실행'을 켜야 동작).
        </div>
      ) : (
        <div className="routines-list">
          {all.map((r) => (
            // 전역 off면 개별 on이어도 실제로는 안 돌므로 행 전체를 off 표기로(개별 on이 전역 off를 이긴다는 오해 방지)
            <div key={r.id} className={`routine-row${r.enabled && routinesEnabled ? '' : ' routine-off'}`}>
              <div className="routine-body">
                <div className="routine-title">{r.title}</div>
                <div className="routine-prompt dim">{r.prompt}</div>
                <div className="dim routine-meta">
                  {cronKindLabel(r.cron)} · 다음 {fmtLocal(r.nextRunAt)}
                  {!routinesEnabled && ' (실행 안 함)'}
                  {r.projectId ? ` · ${r.projectId}` : ' · 전역'}
                  {r.lastRunAt ? ` · 최근 ${fmtLocal(r.lastRunAt)}` : ''}
                </div>
              </div>
              <div className="routine-actions">
                <button
                  className={`chip${r.enabled && routinesEnabled ? ' chip-inbox-on' : ''}`}
                  title={
                    r.enabled
                      ? routinesEnabled
                        ? '끄기'
                        : '끄기 — 전역 루틴 실행이 꺼져 있어 지금은 어차피 실행되지 않는다'
                      : '켜기'
                  }
                  onClick={() => window.lain.setRoutineEnabled(r.id, !r.enabled)}
                >
                  {r.enabled ? 'on' : 'off'}
                </button>
                <button
                  className="routine-del"
                  title="삭제"
                  onClick={() => window.lain.deleteRoutine(r.id)}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="routine-add-form">
          <input
            className="routine-add-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="제목 (예: 아침 현황 점검)"
          />
          <textarea
            className="routine-add-input routine-add-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Lain에게 줄 지시 (예: 전 프로젝트 현황 요약하고 처리할 게 있으면 알려줘)"
          />
          <div className="routine-sched">
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="daily">매일</option>
              <option value="weekly">매주</option>
              <option value="hourly">매시</option>
              <option value="interval">N분마다</option>
            </select>
            {kind === 'weekly' && (
              <select value={dow} onChange={(e) => setDow(Number(e.target.value))}>
                {DOW_KO.map((d, i) => (
                  <option key={i} value={i}>
                    {d}요일
                  </option>
                ))}
              </select>
            )}
            {(kind === 'daily' || kind === 'weekly') && (
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            )}
            {kind === 'hourly' && (
              <label className="dim">
                매시{' '}
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={minute}
                  onChange={(e) => setMinute(Number(e.target.value) || 0)}
                  style={{ width: 56 }}
                />
                분
              </label>
            )}
            {kind === 'interval' && (
              <label className="dim">
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={interval}
                  onChange={(e) => setInterval_(Number(e.target.value) || 1)}
                  style={{ width: 64 }}
                />
                분마다
              </label>
            )}
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">전역(Lain)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="routine-actions">
            <button onClick={submit} disabled={!title.trim() || !prompt.trim()}>
              추가
            </button>
            <button onClick={() => setAdding(false)}>취소</button>
          </div>
          <div className="dim routine-tz-note">시각은 한국시간 기준으로 입력 — 저장 시 자동 변환된다.</div>
        </div>
      ) : (
        <button className="chip routine-add-toggle" onClick={() => setAdding(true)}>
          + 루틴 추가
        </button>
      )}
    </div>
  )
}
