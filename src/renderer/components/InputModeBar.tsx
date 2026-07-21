import { useState, useRef, useEffect, type ReactNode } from 'react'
import type { LainSettings, TaskPermissionMode, ManagerEffort } from '../../shared/types'
import { MODEL_TIERS, MODEL_NAME } from '../../shared/models'
import { Icon } from './icons'

type Opt = { value: string; label: string }

// 커스텀 드롭다운 — 버튼 위로 뜨는 팝업(둥근 사각형·연한 테두리·헤더·옵션 하단 footer 슬롯).
function ModeDropdown({
  value,
  options,
  onChange,
  title,
  header,
  footer,
  align = 'left',
  cat,
}: {
  value: string
  options: Opt[]
  onChange: (v: string) => void
  title?: string
  header?: string
  footer?: ReactNode
  align?: 'left' | 'right'
  cat?: string // 값 앞에 병기할 카테고리 이름표 — 닫힌 상태에서도 무슨 설정인지 보이게
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const current = options.find((o) => o.value === value)
  return (
    <div className="imb-dd" ref={ref}>
      <button className="imb-sel" title={title} onClick={() => setOpen((v) => !v)}>
        {cat && <span className="imb-cat">{cat}</span>}
        {current?.label ?? value}
      </button>
      {open && (
        <div className={`imb-menu${align === 'right' ? ' imb-menu-right' : ''}`}>
          {header && <div className="imb-menu-head">{header}</div>}
          {options.map((o) => (
            <button
              key={o.value}
              className={`imb-item${o.value === value ? ' imb-item-on' : ''}`}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              <span>{o.label}</span>
              {o.value === value && (
                <span className="imb-item-check">
                  <Icon name="check" size={14} />
                </span>
              )}
            </button>
          ))}
          {footer && <div className="imb-menu-foot">{footer}</div>}
        </div>
      )}
    </div>
  )
}

const PERM_OPTS: Opt[] = [
  { value: 'default', label: '요청' },
  { value: 'acceptEdits', label: '편집 수락' },
  { value: 'plan', label: '계획' },
  { value: 'bypass', label: '건너뛰기' },
]
// 작업량 — '자동'(레인이 스스로) + 5단계. 'auto'는 UI 전용 값(managerEffortAuto로 매핑).
const EFFORT_OPTS: Opt[] = [
  { value: 'auto', label: '자동' },
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '중간' },
  { value: 'high', label: '높음' },
  { value: 'xhigh', label: '추가' },
  { value: 'max', label: '최대' },
  { value: 'ultracode', label: 'Ultracode' },
]
const TASKMODE_OPTS: Opt[] = [
  { value: 'auto', label: '자동판정' },
  { value: 'autonomous', label: '자율' },
  { value: 'interactive', label: '대화형' },
]
const MODEL_OPTS: Opt[] = MODEL_TIERS.map((t) => ({ value: t, label: MODEL_NAME[t] }))
// 버튼에 '동시' 이름표를 병기하므로 값은 숫자만 — '동시 동시 7' 중복 방지
const CONC_OPTS: Opt[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
  value: String(n),
  label: String(n),
}))

export function InputModeBar({
  settings,
  onPatch,
  onPlus,
  contextPercent,
}: {
  settings: LainSettings
  onPatch: (p: Partial<LainSettings>) => void
  onPlus: (anchor: { x: number; y: number }) => void
  contextPercent?: number | null // A5 — 무한세션 컨텍스트 게이지(%). null/undefined = 압축 비활성·데이터 없음(빈 orb)
}) {
  // A5 — 게이지 % 클램프(0~100, 표시용) + 임계 접근(80%+) 경고색 판정. null=압축 비활성·데이터 없음(빈 orb).
  const gaugePct = contextPercent == null ? null : Math.min(100, Math.max(0, contextPercent))
  const gaugeWarn = gaugePct != null && gaugePct >= 80
  return (
    <div className="input-modebar">
      <div className="imb-left">
        <button
          className="imb-plus"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            onPlus({ x: r.left, y: r.top })
          }}
          title="추가 — 파일·사진 / 폴더 / 슬래시 명령어"
          aria-label="추가 메뉴"
        >
          ＋
        </button>
        <ModeDropdown
          value={settings.managerPermissionMode}
          options={PERM_OPTS}
          onChange={(v) => onPatch({ managerPermissionMode: v as TaskPermissionMode })}
          title="레인 권한 — 요청 / 편집 수락 / 계획 / 건너뛰기"
          header="권한"
          cat="권한"
          align="left"
        />
      </div>
      <div className="imb-right">
        <ModeDropdown
          value={settings.managerModel}
          options={MODEL_OPTS}
          onChange={(v) => onPatch({ managerModel: v as LainSettings['managerModel'] })}
          title="레인 모델"
          header="모델"
          cat="모델"
          align="right"
          footer={
            <button
              className="imb-foot"
              onClick={() => onPatch({ managerFastMode: !settings.managerFastMode })}
              title="빠른 모드 — 같은 Opus를 더 빠른 출력으로(품질 동일)"
            >
              <span>빠른 모드</span>
              <span className={`imb-switch${settings.managerFastMode ? ' imb-switch-on' : ''}`} />
            </button>
          }
        />
        <ModeDropdown
          value={settings.managerEffortAuto ? 'auto' : settings.managerEffort}
          options={EFFORT_OPTS}
          onChange={(v) =>
            v === 'auto'
              ? onPatch({ managerEffortAuto: true })
              : onPatch({ managerEffortAuto: false, managerEffort: v as ManagerEffort })
          }
          title="레인 강도 — 자동(이번 입력에 맞춰 조절) 또는 낮음~Ultracode"
          header="강도"
          cat="강도"
          align="right"
        />
        {/* 그룹 경계 — 여기부터는 레인 자신이 아니라 '작업을 어떻게 굴리나' */}
        <span className="imb-sep" aria-hidden="true" />
        <ModeDropdown
          value={settings.defaultTaskMode}
          options={TASKMODE_OPTS}
          onChange={(v) => onPatch({ defaultTaskMode: v as LainSettings['defaultTaskMode'] })}
          title="작업 방식 — 자동판정 / 자율(무개입) / 대화형"
          header="작업 방식"
          cat="작업방식"
          align="right"
        />
        <ModeDropdown
          value={String(settings.concurrencyCap)}
          options={CONC_OPTS}
          onChange={(v) => onPatch({ concurrencyCap: Number(v) || 1 })}
          title="동시 작업(내비) 수"
          header="동시 작업"
          cat="동시"
          align="right"
        />
        <span
          className={`imb-orb${gaugeWarn ? ' imb-orb-warn' : ''}`}
          title={
            gaugePct == null
              ? '컨텍스트 사용량 — 압축 비활성(설정에서 켤 수 있음)'
              : `컨텍스트 사용량 ${Math.round(gaugePct)}%`
          }
          style={
            gaugePct == null
              ? undefined
              : { background: `conic-gradient(var(--imb-orb-fill, var(--signal)) ${gaugePct * 3.6}deg, transparent 0deg)` }
          }
        />
      </div>
    </div>
  )
}
