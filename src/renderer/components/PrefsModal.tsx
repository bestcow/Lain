// 환경설정 — 가운데 모달. 햄버거 메뉴에서 연다. (기존 CFG 드로어를 여기로 통합)
import { useEffect, useState, type ReactNode } from 'react'
import type {
  LainSettings,
  McpServer,
  McpTarget,
  McpTransport,
  ModelTier,
  PluginInfo,
  TelegramStatus,
  DiscordStatus,
  UpdateStatus,
} from '../../shared/types'
import { MODEL_IDS } from '../../shared/models'

const TIERS: ModelTier[] = ['haiku', 'sonnet', 'opus']

// 업데이트 상태 → 사람이 읽을 한 줄 힌트(④ 설정 행).
function updHint(u: UpdateStatus | null): string {
  if (!u) return '확인 중…'
  switch (u.state) {
    case 'disabled':
      return `현재 v${u.currentVersion} · 자동 업데이트는 설치본(패키징)에서만 동작`
    case 'checking':
      return '새 버전 확인 중…'
    case 'available':
      return `새 버전 v${u.version} 있음 — 다운로드 가능`
    case 'downloading':
      return `다운로드 중… ${u.percent ?? 0}%`
    case 'downloaded':
      return `v${u.version} 준비됨 — 재시작하면 적용`
    case 'not-available':
      return `현재 v${u.currentVersion} · 최신`
    case 'error':
      return `업데이트 오류: ${u.error ?? '알 수 없음'}`
    default:
      return `현재 v${u.currentVersion}`
  }
}

// 텔레그램 시크릿 필드 — 입력 옆에 "알아내는 법" 안내 + 명시적 저장(Enter/버튼) + "저장됨" 피드백.
function TelegramField({
  label,
  secret,
  value,
  placeholder,
  howto,
  extra,
  onSave,
}: {
  label: string
  secret?: boolean
  value: string
  placeholder: string
  howto: ReactNode
  extra?: ReactNode
  onSave: (v: string) => void
}) {
  const [v, setV] = useState(value)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setV(value)
  }, [value]) // 외부(설정 재로딩) 갱신 반영
  const dirty = v.trim() !== value
  const save = () => {
    if (!dirty) return
    onSave(v.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  return (
    <div className="settings-row tg-field">
      <span className="settings-key">{label}</span>
      <div className="tg-field-main">
        <div className="tg-field-input">
          <input
            type={secret ? 'password' : 'text'}
            placeholder={placeholder}
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                save()
              }
            }}
          />
          <button className="tg-save" onClick={save} disabled={!dirty} title="저장">
            저장
          </button>
          {saved && <span className="tg-saved">✓ 저장됨</span>}
          {extra}
        </div>
        <div className="dim tg-howto">{howto}</div>
      </div>
    </div>
  )
}

function ModelSelect({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: ModelTier
  onChange: (v: ModelTier) => void
}) {
  return (
    <label className="settings-row">
      <span className="settings-key">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as ModelTier)}>
        {TIERS.map((t) => (
          <option key={t} value={t}>
            {t} — {MODEL_IDS[t]}
          </option>
        ))}
      </select>
      <span className="dim settings-hint">{hint}</span>
    </label>
  )
}

// ── 외부 MCP 서버 (CC-FEATURES P1) — 등록=사용자 UI(②), 사용=cascade. 시크릿은 로컬 보관만(§9-6) ──
const MCP_TARGETS: { key: McpTarget; label: string }[] = [
  { key: 'manager', label: 'Lain' },
  { key: 'navi', label: 'Navi' },
]

function parseArgs(s: string): string[] {
  const t = s.trim()
  return t ? t.split(/\s+/) : []
}
// 줄바꿈 또는 쉼표로 구분된 KEY=VALUE → 객체. 값에 = 가 있어도 첫 = 만 분리.
function parseKV(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of s.split(/[\n,]/)) {
    const t = line.trim()
    if (!t) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

function McpServersSection() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [targets, setTargets] = useState<McpTarget[]>(['manager', 'navi'])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.lain.listMcpServers().then(setServers)
    return window.lain.onMcpServersUpdated(setServers)
  }, [])

  const toggleTarget = (k: McpTarget) =>
    setTargets((ts) => (ts.includes(k) ? ts.filter((t) => t !== k) : [...ts, k]))

  const add = async () => {
    setError(null)
    const input =
      transport === 'stdio'
        ? { name, transport, command, args: parseArgs(argsText), env: parseKV(envText), targets }
        : { name, transport, url, headers: parseKV(headersText), targets }
    const r = await window.lain.addMcpServer(input)
    if (r.error) {
      setError(r.error)
      return
    }
    setName('')
    setCommand('')
    setArgsText('')
    setEnvText('')
    setUrl('')
    setHeadersText('')
  }

  return (
    <>
      <div
        className="dim"
        style={{ marginTop: 12, borderTop: '1px solid #1c3a2c', paddingTop: 8 }}
      >
        ── 외부 MCP 서버 (등록=나 · 사용=Lain·Navi)
      </div>
      {servers.length === 0 ? (
        <div className="dim settings-hint">등록된 외부 MCP 서버 없음 — 아래에서 추가</div>
      ) : (
        servers.map((s) => (
          <div key={s.id} className="settings-row" style={{ alignItems: 'flex-start' }}>
            <span className="settings-key">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => window.lain.setMcpServerEnabled(s.id, e.target.checked)}
                title="활성 — 켠 서버만 주입(토큰 게이팅)"
              />{' '}
              {s.name}
            </span>
            <span className="dim settings-hint">
              {s.transport} · {s.transport === 'stdio' ? s.command || '(command 없음)' : s.url || '(url 없음)'} ·{' '}
              {s.targets.map((t) => (t === 'manager' ? 'Lain' : 'Navi')).join('/') || '미할당'}
              {Object.keys(s.env).length || Object.keys(s.headers).length ? ' · 🔑' : ''}
            </span>
            <button
              className="tg-save"
              onClick={() => window.lain.removeMcpServer(s.id)}
              title="삭제"
            >
              삭제
            </button>
          </div>
        ))
      )}
      {/* B6 — 브라우저 자동화 MCP 프리셋(원클릭 폼 채움). Navi가 실제 브라우저로 웹 변경을 검증(capturePage≠실화면 정공 해법). */}
      <div className="settings-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="dim settings-hint" style={{ flexBasis: '100%' }}>
          프리셋 — 클릭하면 아래 폼이 채워진다(‘추가’로 등록). 실행엔 Node(npx)·Chrome 필요.
        </span>
        <button
          type="button"
          className="chip"
          title="Chrome DevTools MCP — Navi가 헤드리스 크롬으로 페이지를 열어 DOM·콘솔·스크린샷으로 실제 화면을 검증한다"
          onClick={() => {
            setName('chrome-devtools')
            setTransport('stdio')
            setCommand('npx')
            setArgsText('-y chrome-devtools-mcp@latest --headless')
            setEnvText('')
            setTargets(['navi'])
            setError(null)
          }}
        >
          🌐 Chrome DevTools (브라우저 검증)
        </button>
      </div>
      <div className="settings-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <input
          placeholder="이름 (영문·숫자·_-)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: 150 }}
        />
        <select value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
          <option value="stdio">stdio</option>
          <option value="sse">sse</option>
          <option value="http">http</option>
        </select>
        {MCP_TARGETS.map((t) => (
          <label
            key={t.key}
            className="dim"
            style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}
          >
            <input
              type="checkbox"
              checked={targets.includes(t.key)}
              onChange={() => toggleTarget(t.key)}
            />
            {t.label}
          </label>
        ))}
      </div>
      {transport === 'stdio' ? (
        <div className="settings-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <input
            placeholder="command (예: npx)"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            style={{ width: 150 }}
          />
          <input
            placeholder="args (공백 구분)"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            style={{ flex: 1, minWidth: 160 }}
          />
          <input
            placeholder="env: K=V,K=V (시크릿)"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            style={{ width: 190 }}
            title="시크릿 — KEY=VALUE, 쉼표/줄바꿈 구분. 로그에 안 남는다(§9-6)"
          />
        </div>
      ) : (
        <div className="settings-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <input
            placeholder="url (https://...)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <input
            placeholder="headers: K=V,K=V (시크릿)"
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            style={{ width: 190 }}
            title="시크릿 — KEY=VALUE, 쉼표/줄바꿈 구분"
          />
        </div>
      )}
      <div className="settings-row">
        <button className="tg-save" onClick={add} disabled={!name.trim()}>
          + MCP 서버 추가
        </button>
        {error && (
          <span className="dim" style={{ color: '#f88' }}>
            {error}
          </span>
        )}
        <span className="dim settings-hint">
          stdio(npx 류) 또는 http/sse url. 켠 서버만 해당 계층에 주입 · 🔑=시크릿 로컬 보관
        </span>
      </div>
    </>
  )
}

// ── 클로드 플러그인 (CC-FEATURES P1) — 설치/제거=claude CLI, 할당=lain이 쓸 스킬셋(②사용자 전용) ──
function PluginsSection({
  curated,
  onSetCurated,
}: {
  curated: string[]
  onSetCurated: (names: string[]) => void
}) {
  const [installed, setInstalled] = useState<PluginInfo[]>([])
  const [available, setAvailable] = useState<PluginInfo[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // 진행 중 plugin id
  const [msg, setMsg] = useState<string | null>(null)

  const reload = () =>
    window.lain.listPlugins().then((r) => {
      setInstalled(r.installed)
      setAvailable(r.available)
    })
  useEffect(() => {
    reload()
    return window.lain.onPluginsUpdated(reload)
  }, [])

  const toggleAssign = (name: string) =>
    onSetCurated(curated.includes(name) ? curated.filter((n) => n !== name) : [...curated, name])

  const install = async (id: string) => {
    setBusy(id)
    setMsg(null)
    const r = await window.lain.installPlugin(id)
    setBusy(null)
    setMsg(r.ok ? `설치됨: ${id}` : `설치 실패: ${r.output.slice(0, 200)}`)
  }
  const uninstall = async (id: string) => {
    setBusy(id)
    setMsg(null)
    const r = await window.lain.uninstallPlugin(id)
    setBusy(null)
    setMsg(r.ok ? `제거됨: ${id}` : `제거 실패: ${r.output.slice(0, 200)}`)
  }

  const needle = q.trim().toLowerCase()
  const matches =
    needle.length >= 2
      ? available
          .filter((p) => `${p.name} ${p.description ?? ''}`.toLowerCase().includes(needle))
          .slice(0, 15)
      : []

  return (
    <>
      <div className="dim" style={{ marginTop: 12, borderTop: '1px solid #1c3a2c', paddingTop: 8 }}>
        ── 클로드 플러그인 (할당=lain이 쓸 스킬셋 · 설치/제거=마켓)
      </div>
      {installed.length === 0 ? (
        <div className="dim settings-hint">설치된 플러그인 없음 또는 조회 실패</div>
      ) : (
        installed.map((p) => (
          <div key={p.id} className="settings-row" style={{ alignItems: 'flex-start' }}>
            <span className="settings-key">
              <input
                type="checkbox"
                checked={curated.includes(p.name)}
                onChange={() => toggleAssign(p.name)}
                title="에이전트(Lain·Navi)에 이 플러그인 할당"
              />{' '}
              {p.name}
            </span>
            <span className="dim settings-hint">
              {p.marketplace}
              {p.hasMcp ? ' · MCP' : ''}
              {curated.includes(p.name) ? ' · 할당됨' : ''}
            </span>
            <button
              className="tg-save"
              disabled={busy === p.id}
              onClick={() => uninstall(p.id)}
              title="마켓에서 제거"
            >
              {busy === p.id ? '...' : '제거'}
            </button>
          </div>
        ))
      )}
      <div className="settings-row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <input
          placeholder="플러그인 검색(2자+) → 설치"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
      </div>
      {matches.map((p) => (
        <div key={p.id} className="settings-row" style={{ alignItems: 'flex-start' }}>
          <span className="settings-key">{p.name}</span>
          <span className="dim settings-hint">
            {(p.description ?? '').slice(0, 80)}
            {p.installCount != null ? ` · ⤓${p.installCount}` : ''}
          </span>
          <button className="tg-save" disabled={busy === p.id} onClick={() => install(p.id)}>
            {busy === p.id ? '설치중...' : '설치'}
          </button>
        </div>
      ))}
      <div className="settings-row">
        <span className="dim settings-hint">
          할당은 '스킬 사용'이 켜져 있을 때만 적용 · 설치/제거는 클로드 CLI(전역 ~/.claude) · 다음 세션부터 반영
        </span>
        {msg && (
          <span className="dim" style={{ color: msg.includes('실패') ? '#f88' : '#8f8' }}>
            {msg}
          </span>
        )}
      </div>
    </>
  )
}

export function PrefsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<LainSettings | null>(null)
  const [tg, setTg] = useState<TelegramStatus | null>(null)
  const [dc, setDc] = useState<DiscordStatus | null>(null)
  const [upd, setUpd] = useState<UpdateStatus | null>(null)

  const refreshTg = () => window.lain.telegramStatus().then(setTg)
  const refreshDc = () => window.lain.discordStatus().then(setDc)

  useEffect(() => {
    window.lain.getSettings().then(setSettings)
    window.lain.getUpdateStatus().then(setUpd)
    const offUpd = window.lain.onUpdateStatus(setUpd)
    refreshTg()
    refreshDc()
    const t = setInterval(() => {
      refreshTg()
      refreshDc()
    }, 4000) // 연결 상태 폴링
    return () => {
      clearInterval(t)
      offUpd()
    }
  }, [])

  const patch = (p: Partial<LainSettings>) => {
    if (settings) setSettings({ ...settings, ...p }) // 낙관적 반영
    window.lain.setSettings(p).then(setSettings)
    if (
      p.telegramEnabled !== undefined ||
      p.telegramBotToken !== undefined ||
      p.telegramChatId !== undefined
    )
      setTimeout(refreshTg, 800) // 재시작 후 상태 갱신
    if (
      p.discordEnabled !== undefined ||
      p.discordBotToken !== undefined ||
      p.discordGuildId !== undefined ||
      p.discordVoiceChannelId !== undefined ||
      p.discordUserId !== undefined
    )
      setTimeout(refreshDc, 800)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-window" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">환경설정</span>
          <button className="modal-close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {!settings ? (
            <div className="dim">로딩...</div>
          ) : (
            <div className="settings-body">
              <label className="settings-row">
                <span className="settings-key">동시 작업 cap</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.concurrencyCap}
                  onChange={(e) => patch({ concurrencyCap: Number(e.target.value) || 1 })}
                />
                <span className="dim settings-hint">동시에 working 상태일 수 있는 작업 수 (§9-7)</span>
              </label>
              <ModelSelect
                label="Navi 모델"
                hint="TASK.md 본 작업 (§9b)"
                value={settings.naviModel}
                onChange={(v) => patch({ naviModel: v })}
              />
              <ModelSelect
                label="Lain 모델"
                hint="Lain 채팅"
                value={settings.managerModel}
                onChange={(v) => patch({ managerModel: v })}
              />
              <ModelSelect
                label="판정 모델"
                hint="elicit·ask_manager 즉답 등 짧은 판정류"
                value={settings.judgeModel}
                onChange={(v) => patch({ judgeModel: v })}
              />
              <label className="settings-row">
                <span className="settings-key">주기 스캔(분)</span>
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={settings.scanIntervalMin}
                  onChange={(e) => patch({ scanIntervalMin: Number(e.target.value) || 0 })}
                />
                <span className="dim settings-hint">현황 자동 재수집 간격 — 0이면 끔 (Phase 3)</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">루틴 실행</span>
                <input
                  type="checkbox"
                  checked={settings.routinesEnabled}
                  onChange={(e) => patch({ routinesEnabled: e.target.checked })}
                />
                <span className="dim settings-hint">
                  등록한 루틴(🔁)을 일정마다 Lain에게 디스패치 — 끄면 등록만 되고 실행 안 됨 (§loop)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">트레이 상주</span>
                <input
                  type="checkbox"
                  checked={settings.closeToTray}
                  onChange={(e) => patch({ closeToTray: e.target.checked })}
                />
                <span className="dim settings-hint">창을 닫아도 트레이에 남아 Navi 지속 (§12.5b)</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">자동 시작</span>
                <input
                  type="checkbox"
                  checked={settings.autoStart}
                  onChange={(e) => patch({ autoStart: e.target.checked })}
                />
                <span className="dim settings-hint">로그인 시 트레이로 기동 (패키징 실행에서만 유효)</span>
              </label>
              {/* 자동 업데이트 — ④ 수동 확인/적용 + ② Lain 제안 + ③ 자동 다운로드 토글 */}
              <div className="settings-row">
                <span className="settings-key">업데이트</span>
                <span className="upd-controls">
                  <button
                    type="button"
                    className="upd-btn"
                    onClick={() => void window.lain.checkForUpdate()}
                    disabled={upd?.state === 'disabled' || upd?.state === 'checking'}
                  >
                    업데이트 확인
                  </button>
                  {upd?.state === 'downloaded' ? (
                    <button
                      type="button"
                      className="upd-btn upd-apply"
                      onClick={() => void window.lain.installUpdate()}
                    >
                      지금 재시작해 적용
                    </button>
                  ) : upd?.state === 'available' ? (
                    <button
                      type="button"
                      className="upd-btn"
                      onClick={() => void window.lain.downloadUpdate()}
                    >
                      다운로드
                    </button>
                  ) : null}
                </span>
                <span className="dim settings-hint">{updHint(upd)}</span>
              </div>
              <label className="settings-row">
                <span className="settings-key">Lain 업데이트 제안</span>
                <input
                  type="checkbox"
                  checked={settings.updateNotify}
                  onChange={(e) => patch({ updateNotify: e.target.checked })}
                />
                <span className="dim settings-hint">
                  새 버전이 나오면 작업이 한가할 때 Lain이 먼저 제안한다 (②)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">자동 다운로드</span>
                <input
                  type="checkbox"
                  checked={settings.updateAutoDownload}
                  onChange={(e) => patch({ updateAutoDownload: e.target.checked })}
                />
                <span className="dim settings-hint">
                  새 버전을 백그라운드로 미리 받아둠 — 설치(재시작)는 항상 수동 (③). 기본 꺼짐
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">자동 우선순위</span>
                <input
                  type="checkbox"
                  checked={settings.autoPriority}
                  onChange={(e) => patch({ autoPriority: e.target.checked })}
                />
                <span className="dim settings-hint">
                  스캔 변화 시 lain이 우선순위 보고 (판정 모델 호출)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">교훈 정비</span>
                <input
                  type="checkbox"
                  checked={settings.lessonCurator}
                  onChange={(e) => patch({ lessonCurator: e.target.checked })}
                />
                <span className="dim settings-hint">
                  idle 시 중복 교훈을 자동 병합 (§24 curator · 판정 모델 호출)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">스킬 사용</span>
                <input
                  type="checkbox"
                  checked={settings.skillsEnabled}
                  onChange={(e) => patch({ skillsEnabled: e.target.checked })}
                />
                <span className="dim settings-hint">
                  Lain·Navi에 클로드 스킬 노출(brainstorming·디버깅·TDD 등). 작업별 할당은 Lain이 start_task로.
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">시그널 학습</span>
                <input
                  type="checkbox"
                  checked={settings.signalReview}
                  onChange={(e) => patch({ signalReview: e.target.checked })}
                />
                <span className="dim settings-hint">
                  실험적: 채팅 교정에서 교훈 학습 (§22 · 판정 모델 호출)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">클로드코드 연동</span>
                <input
                  type="checkbox"
                  checked={settings.ccHooksEnabled}
                  onChange={(e) => patch({ ccHooksEnabled: e.target.checked })}
                />
                <span className="dim settings-hint">
                  레인↔클로드코드 양방향 인지(등록 프로젝트 한정) — 밖에서 직접 실행한 CC 세션을 레인이 알고,
                  레인 작업 현황도 그 CC 세션에 주입. 켜면 ~/.claude 훅 자동 설치(끄면 제거)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">idle 임계(분)</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={settings.idleMin}
                  onChange={(e) => patch({ idleMin: Number(e.target.value) || 3 })}
                />
                <span className="dim settings-hint">
                  마지막 채팅 후 이 시간 지나야 idle — 자동 끼어듦 게이트
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">컨텍스트 압축(토큰)</span>
                <input
                  type="number"
                  min={0}
                  step={10000}
                  value={settings.contextCompactThreshold}
                  onChange={(e) => patch({ contextCompactThreshold: Number(e.target.value) || 0 })}
                />
                <span className="dim settings-hint">
                  관리자 대화가 이 토큰 넘으면 월드모델로 요약 후 새 세션(무한세션) — 0이면 끔
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">Navi 핸드오프(토큰)</span>
                <input
                  type="number"
                  min={0}
                  step={10000}
                  value={settings.naviHandoffThreshold}
                  onChange={(e) => patch({ naviHandoffThreshold: Number(e.target.value) || 0 })}
                />
                <span className="dim settings-hint">
                  Navi 대화가 이 토큰 넘으면 핸드오프 md 기록 후 새 세션(유한세션 교체) — 0이면 끔
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">무진전 자동종료(분)</span>
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={settings.turnWatchdogMin}
                  onChange={(e) => patch({ turnWatchdogMin: Number(e.target.value) || 0 })}
                />
                <span className="dim settings-hint">
                  Lain 응답이 이 시간 동안 진전 없으면 자동 종료 — 긴 작업(설치·빌드)을 고려해 넉넉히. ⚠ 단일 도구(npm install·빌드·풀 테스트) 한 번 실행이 이 시간을 넘으면 정상 작업도 종료되니 여유 있게. 0이면 끔
                </span>
              </label>

              {/* §20.3 텔레그램 채널 — 자리 비웠을 때 폰으로 와이어드 지휘·결재 */}
              <div className="dim" style={{ marginTop: 12, borderTop: '1px solid #1c3a2c', paddingTop: 8 }}>
                ── 텔레그램 (§20.3 폰에서 지휘·결재)
              </div>
              <label className="settings-row">
                <span className="settings-key">텔레그램 사용</span>
                <input
                  type="checkbox"
                  checked={settings.telegramEnabled}
                  onChange={(e) => patch({ telegramEnabled: e.target.checked })}
                />
                <span className="dim settings-hint">
                  {tg
                    ? tg.running
                      ? `연결됨${tg.username ? ` @${tg.username}` : ''}${tg.chatLinked ? ' · 채팅 등록' : ' · 채팅 미등록(폰에서 메시지 1회 보내 ID 확인)'}`
                      : tg.lastError
                        ? `중단 — ${tg.lastError}`
                        : '꺼짐'
                    : '상태 확인 중…'}
                </span>
              </label>
              <TelegramField
                label="봇 토큰"
                secret
                value={settings.telegramBotToken}
                placeholder="BotFather 토큰"
                onSave={(v) => patch({ telegramBotToken: v })}
                howto={
                  <>
                    텔레그램 <b>@BotFather</b> 열기 → <code>/mybots</code> → 봇 선택 →{' '}
                    <b>API Token</b> 복사. 시크릿이라 로그에 안 남는다.
                  </>
                }
              />
              <TelegramField
                label="허용 채팅ID"
                value={settings.telegramChatId}
                placeholder="봇이 회신한 채팅 ID"
                onSave={(v) => patch({ telegramChatId: v })}
                extra={
                  tg?.pendingChatId && tg.pendingChatId !== settings.telegramChatId ? (
                    <button
                      className="tg-save"
                      onClick={() => patch({ telegramChatId: tg.pendingChatId! })}
                      title="감지된 채팅 ID로 등록"
                    >
                      감지된 ID {tg.pendingChatId} — 사용
                    </button>
                  ) : null
                }
                howto={
                  <>
                    봇 토큰 저장 후 폰에서 그 봇에게 아무 메시지나 보내면 봇이{' '}
                    <b>「이 채팅 ID: 12345」</b>로 회신한다 → 그 숫자를 입력. (또는 텔레그램{' '}
                    <b>@userinfobot</b>) · 이 채팅만 명령을 받는다 (화이트리스트 §20.5)
                  </>
                }
              />
              <div className="settings-section-label dim">STT (음성 메시지)</div>
              <TelegramField
                label="Groq API 키"
                secret
                value={settings.groqApiKey}
                placeholder="gsk_..."
                onSave={(v) => patch({ groqApiKey: v })}
                howto={
                  <>
                    <b>console.groq.com/keys</b> → Create API Key. 텔레그램 음성 메시지를{' '}
                    Groq Whisper(무료)로 텍스트 변환 — 비우면 STT 비활성화. 시크릿이라 로그에 안 남는다.
                  </>
                }
              />

              {/* §20.3 디스코드 음성 통화 — 폰/데스크 음성채널로 레인과 실시간 통화 */}
              <div className="dim" style={{ marginTop: 12, borderTop: '1px solid #1c3a2c', paddingTop: 8 }}>
                ── 디스코드 음성 통화 (§20.3 음성으로 지휘)
              </div>
              <label className="settings-row">
                <span className="settings-key">디스코드 사용</span>
                <input
                  type="checkbox"
                  checked={settings.discordEnabled}
                  onChange={(e) => patch({ discordEnabled: e.target.checked })}
                />
                <span className="dim settings-hint">
                  {dc
                    ? dc.running
                      ? `연결됨${dc.inCall ? ' · 통화 중' : ' · 대기'}`
                      : dc.error
                        ? `중단 — ${dc.error}`
                        : '꺼짐'
                    : '상태 확인 중…'}
                </span>
              </label>
              <TelegramField
                label="봇 토큰"
                secret
                value={settings.discordBotToken}
                placeholder="Discord 봇 토큰"
                onSave={(v) => patch({ discordBotToken: v })}
                howto={
                  <>
                    <b>Discord Developer Portal</b> → Application → <b>Bot</b> → Reset Token. 봇은
                    서버에 <b>Connect·Speak</b> 권한으로 초대(서버 설치). 시크릿이라 로그에 안 남는다.
                  </>
                }
              />
              <TelegramField
                label="길드(서버) ID"
                value={settings.discordGuildId}
                placeholder="서버 우클릭 → ID 복사"
                onSave={(v) => patch({ discordGuildId: v })}
                howto={<>설정 → 고급 → 개발자 모드 ON 후, 서버 아이콘 우클릭 → ID 복사.</>}
              />
              <TelegramField
                label="음성채널 ID"
                value={settings.discordVoiceChannelId}
                placeholder="음성채널 우클릭 → ID 복사"
                onSave={(v) => patch({ discordVoiceChannelId: v })}
                howto={<>봇이 자동 입장할 전용 음성채널을 우클릭 → ID 복사.</>}
              />
              <TelegramField
                label="내 user ID"
                value={settings.discordUserId}
                placeholder="비우면 채널 첫 입장자로 자동 등록"
                onSave={(v) => patch({ discordUserId: v })}
                howto={<>단일 화자 — 이 user ID의 발화만 청취한다. 비워두면 음성채널에 처음 들어온 사람이 자동 등록된다.</>}
              />
              <label className="settings-row">
                <span className="settings-key">음성(TTS)</span>
                <select
                  value={settings.discordTtsVoice || 'ko-KR-SunHiNeural'}
                  onChange={(e) => patch({ discordTtsVoice: e.target.value })}
                >
                  <option value="ko-KR-SunHiNeural">선희 (여성, 기본)</option>
                  <option value="ko-KR-JiMinNeural">지민 (여성)</option>
                  <option value="ko-KR-SeoHyeonNeural">서현 (여성)</option>
                  <option value="ko-KR-YuJinNeural">유진 (여성)</option>
                  <option value="ko-KR-InJoonNeural">인준 (남성)</option>
                  <option value="ko-KR-HyunsuNeural">현수 (남성)</option>
                  <option value="ko-KR-BongJinNeural">봉진 (남성)</option>
                  <option value="ko-KR-GookMinNeural">국민 (남성)</option>
                </select>
                <span className="dim settings-hint">음성 응답 목소리</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">청취 모드</span>
                <select
                  value={settings.discordVoiceMode || 'always'}
                  onChange={(e) => patch({ discordVoiceMode: e.target.value as 'always' | 'wake' })}
                >
                  <option value="always">항상 청취</option>
                  <option value="wake">호출 시에만 (“레인 …”)</option>
                </select>
                <span className="dim settings-hint">웨이크워드 모드는 잡음·오발동을 줄인다</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">음성 합성</span>
                <select
                  value={settings.ttsBackend || 'edge'}
                  onChange={(e) => patch({ ttsBackend: e.target.value as 'edge' | 'gpt-sovits' })}
                >
                  <option value="edge">Edge TTS (클라우드, 기본)</option>
                  <option value="gpt-sovits">GPT-SoVITS (로컬·음성복제)</option>
                </select>
                <span className="dim settings-hint">로컬은 빠르고 목소리 복제 가능 — 서버 실행 필요</span>
              </label>
              {settings.ttsBackend === 'gpt-sovits' && (
                <>
                  <TelegramField
                    label="GPT-SoVITS 서버"
                    value={settings.gptSovitsUrl}
                    placeholder="http://127.0.0.1:9880"
                    onSave={(v) => patch({ gptSovitsUrl: v })}
                    howto={<>api_v2.py 서버 주소. 기본 포트 9880. 서버가 꺼져 있으면 Edge로 자동 폴백.</>}
                  />
                  <TelegramField
                    label="참조 음성 경로"
                    value={settings.gptSovitsRefAudio}
                    placeholder="C:\\voices\\lain_ref.wav"
                    onSave={(v) => patch({ gptSovitsRefAudio: v })}
                    howto={<>복제할 목소리 3~10초 클립(서버가 접근할 로컬 경로). 비우면 Edge 사용.</>}
                  />
                  <TelegramField
                    label="참조 음성 전사"
                    value={settings.gptSovitsRefText}
                    placeholder="참조 클립에서 실제로 말하는 문장 그대로"
                    onSave={(v) => patch({ gptSovitsRefText: v })}
                    howto={<>위 참조 클립에서 실제로 말하는 내용(prompt_text). 정확할수록 복제 품질↑.</>}
                  />
                  <label className="settings-row">
                    <span className="settings-key">참조 언어</span>
                    <select
                      value={settings.gptSovitsRefLang || 'ko'}
                      onChange={(e) => patch({ gptSovitsRefLang: e.target.value })}
                    >
                      <option value="ko">한국어</option>
                      <option value="ja">일본어 (일본 성우 음색)</option>
                      <option value="en">영어</option>
                      <option value="zh">중국어</option>
                    </select>
                    <span className="dim settings-hint">참조 클립의 언어. 출력은 항상 한국어</span>
                  </label>
                </>
              )}

              <McpServersSection />

              <PluginsSection
                curated={settings.curatedPlugins ?? []}
                onSetCurated={(names) => patch({ curatedPlugins: names })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
