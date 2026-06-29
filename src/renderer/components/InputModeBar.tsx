import { useState, useRef, useEffect, type ReactNode } from 'react'
import type { LainSettings, TaskPermissionMode, ManagerEffort } from '../../shared/types'
import { MODEL_TIERS } from '../../shared/models'

type Opt = { value: string; label: string }

// 커스텀 드롭다운 — 버튼 위로 뜨는 팝업(둥근 사각형·연한 테두리·헤더·옵션 하단 footer 슬롯).
function ModeDropdown({
  value,
  options,
  onChange,
  disabled,
  title,
  header,
  footer,
  align = 'left',
}: {
  value: string
  options: Opt[]
  onChange: (v: string) => void
  disabled?: boolean
  title?: string
  header?: string
  footer?: ReactNode
  align?: 'left' | 'right'
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
      <button
        className="imb-sel"
        disabled={disabled}
        title={title}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        {current?.label ?? value}
      </button>
      {open && !disabled && (
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
              {o.value === value && <span className="imb-item-check">✓</span>}
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
  { value: 'autonomous', label: '자동' },
  { value: 'interactive', label: '대화형' },
]
const MODEL_NAME: Record<string, string> = {
  haiku: 'Claude_Haiku_4.5',
  sonnet: 'Claude_Sonnet_4.6',
  opus: 'Claude_Opus_4.8',
}
const MODEL_OPTS: Opt[] = MODEL_TIERS.map((t) => ({ value: t, label: MODEL_NAME[t] }))
const CONC_OPTS: Opt[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
  value: String(n),
  label: `동시 ${n}`,
}))

export function InputModeBar({
  settings,
  onPatch,
}: {
  settings: LainSettings
  onPatch: (p: Partial<LainSettings>) => void
}) {
  return (
    <div className="input-modebar">
      <div className="imb-left">
        <ModeDropdown
          value={settings.managerPermissionMode}
          options={PERM_OPTS}
          onChange={(v) => onPatch({ managerPermissionMode: v as TaskPermissionMode })}
          title="레인 권한 — 요청 / 편집 수락 / 계획 / 건너뛰기"
          header="권한"
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
          title="레인 작업량 — 자동(스스로 조절) 또는 낮음~Ultracode"
          header="작업량"
          align="right"
        />
        <ModeDropdown
          value={settings.defaultTaskMode}
          options={TASKMODE_OPTS}
          onChange={(v) => onPatch({ defaultTaskMode: v as LainSettings['defaultTaskMode'] })}
          title="작업 위임 기본 방식"
          header="작업"
          align="right"
        />
        <ModeDropdown
          value={String(settings.concurrencyCap)}
          options={CONC_OPTS}
          onChange={(v) => onPatch({ concurrencyCap: Number(v) || 1 })}
          title="동시 작업(내비) 수"
          header="동시 작업"
          align="right"
        />
        <button
          className={`imb-watch${settings.overlayMonitoringEnabled ? ' imb-on' : ''}`}
          onClick={() => onPatch({ overlayMonitoringEnabled: !settings.overlayMonitoringEnabled })}
          title="어깨너머 — 메인창을 안 볼 때 화면 작업을 관찰해 먼저 조언(우하단 오버레이). on/off"
        >
          <span>어깨너머</span>
          <span
            className={`imb-switch${settings.overlayMonitoringEnabled ? ' imb-switch-on' : ''}`}
          />
        </button>
        <span className="imb-orb" title="사용량 (곧)" />
      </div>
    </div>
  )
}
