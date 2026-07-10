// 환경설정 — 가운데 모달. 햄버거 메뉴에서 연다. (기존 CFG 드로어를 여기로 통합)
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { Icon } from './icons'
import {
  normalizeQuery,
  matchingItems,
  targetCategory,
  type PrefsSearchItem,
} from '../lib/prefsSearch'

const TIERS: ModelTier[] = ['haiku', 'sonnet', 'opus', 'fable', 'local']

// 환경설정 카테고리(좌측 nav) — 현재 설정들을 묶음. 순서·이름·분류는 자유 조정.
const CATS: { id: string; label: string }[] = [
  { id: 'general', label: '일반' },
  { id: 'models', label: '모델' },
  { id: 'planner', label: '플래너' },
  { id: 'automation', label: '자동화·고급' },
  { id: 'telegram', label: '텔레그램' },
  { id: 'voice', label: '음성·통화' },
  { id: 'extensions', label: '확장' },
]

// B11 — 검색 인덱스. key=설정명(=화면 .settings-key 텍스트와 정확히 일치해야 DOM 하이라이트가 걸린다),
// label=검색 대상 설정명, hint=힌트/부가 검색어, cat=소속 카테고리. 검색 시 첫 매치 카테고리로 자동 전환하고
// (targetCategory) 매치된 라벨 행을 하이라이트한다. 새 설정을 추가하면 여기에 한 줄 등록한다.
const SEARCH_INDEX: PrefsSearchItem[] = [
  // 일반
  { key: '내 호칭', label: '내 호칭', hint: '레인이 너를 부르는 호칭 userTitle', cat: 'general' },
  { key: '외부 표시명', label: '외부 표시명', hint: '디스코드 카톡 닉네임 별칭 userAliases', cat: 'general' },
  { key: '워크스페이스 루트', label: '워크스페이스 루트', hint: '스캔 최상위 폴더 workspaceRoot C:\\workspace', cat: 'general' },
  { key: '스캔 하위 폴더', label: '스캔 하위 폴더', hint: 'apps games tools scanDirs 스캔 대상', cat: 'general' },
  { key: '주기 스캔(분)', label: '주기 스캔(분)', hint: '현황 자동 재수집 간격 scanInterval', cat: 'general' },
  { key: '루틴 실행', label: '루틴 실행', hint: '등록한 루틴 디스패치 routinesEnabled', cat: 'general' },
  { key: '트레이 상주', label: '트레이 상주', hint: '창 닫아도 트레이 closeToTray', cat: 'general' },
  { key: '자동 시작', label: '자동 시작', hint: '로그인 시 기동 autoStart', cat: 'general' },
  { key: '말수', label: '말수', hint: '상호작용 대사 감시 선제 발화 빈도 chattiness 묵언 수다쟁이 quips 말풍선', cat: 'general' },
  { key: '업데이트', label: '업데이트', hint: '확인 다운로드 재시작 update', cat: 'general' },
  { key: 'Lain 업데이트 제안', label: 'Lain 업데이트 제안', hint: 'updateNotify 새 버전 제안', cat: 'general' },
  { key: '자동 다운로드', label: '자동 다운로드', hint: 'updateAutoDownload 백그라운드', cat: 'general' },
  { key: '백업·이식', label: '백업·이식', hint: '데이터 폴더 열기 백업 내보내기 backup export PC 이사', cat: 'general' },
  // 모델
  { key: 'Navi 모델', label: 'Navi 모델', hint: 'TASK.md 본 작업 naviModel', cat: 'models' },
  { key: 'Lain 모델', label: 'Lain 모델', hint: 'Lain 채팅 managerModel', cat: 'models' },
  { key: '판정 모델', label: '판정 모델', hint: 'elicit ask_manager judgeModel', cat: 'models' },
  { key: '로컬 모델 서버', label: '로컬 모델 서버', hint: 'llama-server localBaseUrl Qwen', cat: 'models' },
  { key: 'Anthropic API 키', label: 'Anthropic API 키', hint: '구독 대신 키 인증 anthropicApiKey 과금 console', cat: 'models' },
  // 자동화·고급
  { key: '동시 작업 cap', label: '동시 작업 cap', hint: '동시에 working 작업 수 concurrency', cat: 'automation' },
  { key: '프로젝트 병렬 cap', label: '프로젝트 병렬 cap', hint: '같은 프로젝트 동시 작업 병렬 projectParallelCap D14', cat: 'automation' },
  { key: '작업 토큰 예산', label: '작업 토큰 예산', hint: '초과 시 일시정지 taskTokenBudget D7', cat: 'automation' },
  { key: '전역 사용량 한도(토큰/1시간)', label: '전역 사용량 한도(토큰/1시간)', hint: '스폰 억제 티어 강등 usageWindowTokenLimit D7', cat: 'automation' },
  { key: '자동 우선순위', label: '자동 우선순위', hint: '스캔 변화 우선순위 autoPriority', cat: 'automation' },
  { key: 'TASK.md 자동 착수', label: 'TASK.md 자동 착수', hint: 'autonomous 자동 시작 autoStartTaskMd', cat: 'automation' },
  { key: '병합 자동 rebase', label: '병합 자동 rebase', hint: 'merge ff 불가 시 rebase 폴백 autoRebaseOnMerge', cat: 'automation' },
  { key: '학습 정비', label: '학습 정비', hint: 'curator 중복 학습 병합 lessonCurator', cat: 'automation' },
  { key: '스킬 사용', label: '스킬 사용', hint: '클로드 스킬 노출 skillsEnabled', cat: 'automation' },
  { key: '턴 자기개선 리뷰', label: '턴 자기개선 리뷰', hint: '학습 스킬 후보 추출 turnReview', cat: 'automation' },
  { key: '검증 넛지', label: '검증 넛지', hint: '코드 수정 후 검증 상기 verifyNudge', cat: 'automation' },
  { key: '빠른 대화', label: '빠른 대화', hint: '도구 없는 경량 응답 managerFastChat', cat: 'automation' },
  { key: '클로드코드 연동', label: '클로드코드 연동', hint: 'CC 훅 양방향 ccHooks', cat: 'automation' },
  { key: 'idle 임계(분)', label: 'idle 임계(분)', hint: '자동 끼어듦 게이트 idleMin', cat: 'automation' },
  { key: '컨텍스트 압축(토큰)', label: '컨텍스트 압축(토큰)', hint: '무한세션 요약 compact', cat: 'automation' },
  { key: 'Navi 핸드오프(토큰)', label: 'Navi 핸드오프(토큰)', hint: '유한세션 교체 handoff', cat: 'automation' },
  { key: '무진전 자동종료(분)', label: '무진전 자동종료(분)', hint: 'watchdog 진전 없음 종료', cat: 'automation' },
  { key: '승인 재알림(분)', label: '승인 재알림(분)', hint: '무응답 재알림 approvalTimeout', cat: 'automation' },
  // 플래너
  { key: '캘린더에 일정 표시', label: '캘린더에 일정 표시', hint: 'plannerShowEvents', cat: 'planner' },
  { key: '체크리스트 표시', label: '체크리스트 표시', hint: 'plannerShowTodos 할일', cat: 'planner' },
  { key: '루틴 표시', label: '루틴 표시', hint: 'plannerShowRoutines', cat: 'planner' },
  { key: '작업 표시', label: '작업 표시', hint: 'plannerShowTasks Navi 마감', cat: 'planner' },
  { key: '완료 항목 표시', label: '완료 항목 표시', hint: 'plannerShowDone', cat: 'planner' },
  { key: '기본 뷰', label: '기본 뷰', hint: '월간 주간 일간 plannerDefaultView', cat: 'planner' },
  { key: '주 시작', label: '주 시작', hint: '일요일 월요일 weekStart', cat: 'planner' },
  { key: '사이드바 위치', label: '사이드바 위치', hint: '좌측 우측 sidebarSide', cat: 'planner' },
  { key: '사이드바 폭', label: '사이드바 폭', hint: '픽셀 sidebarWidth', cat: 'planner' },
  { key: '밀도', label: '밀도', hint: '넉넉 촘촘 density', cat: 'planner' },
  { key: '리마인드 기본(분)', label: '리마인드 기본(분)', hint: '알림 시간 remind', cat: 'planner' },
  { key: '방치 기준(일)', label: '방치 기준(일)', hint: '미완료 방치 staleDays', cat: 'planner' },
  { key: '방치 넛지', label: '방치 넛지', hint: '자동 리마인드 nudge', cat: 'planner' },
  { key: '브리핑에 포함', label: '브리핑에 포함', hint: '아침 브리핑 plannerInBriefing', cat: 'planner' },
  { key: '체크리스트 대신 처리 제안', label: '체크리스트 대신 처리 제안', hint: 'offerHelp', cat: 'planner' },
  { key: '텔레그램 리마인드', label: '텔레그램 리마인드', hint: '폰 알림 telegramRemind', cat: 'planner' },
  // 텔레그램
  { key: '텔레그램 사용', label: '텔레그램 사용', hint: 'telegramEnabled 폰', cat: 'telegram' },
  { key: '봇 토큰', label: '봇 토큰', hint: 'BotFather telegramBotToken', cat: 'telegram' },
  { key: '허용 채팅ID', label: '허용 채팅ID', hint: 'chatId 화이트리스트', cat: 'telegram' },
  // Groq 키는 텔레그램·음성 두 카테고리에 같은 설정이 렌더된다(값은 한 곳 저장). 검색이 현재 카테고리를
  // 존중하도록(안 튀도록) 양쪽 모두 인덱스에 등록한다.
  { key: 'Groq API 키', label: 'Groq API 키', hint: 'Whisper STT 음성 인식 텔레그램 groqApiKey', cat: 'telegram' },
  { key: 'Groq API 키', label: 'Groq API 키', hint: 'Whisper STT 음성 인식 마이크 PTT groqApiKey', cat: 'voice' },
  // 음성·통화
  { key: '디스코드 사용', label: '디스코드 사용', hint: 'discordEnabled 통화', cat: 'voice' },
  { key: '청취 모드', label: '청취 모드', hint: '항상 웨이크워드 discordVoiceMode', cat: 'voice' },
  { key: '엔진', label: '엔진', hint: 'TTS edge supertonic gpt-sovits 음성 출력', cat: 'voice' },
  { key: '기본 톤', label: '기본 톤', hint: '무미건조 감정 voiceTone', cat: 'voice' },
  { key: '말 속도', label: '말 속도', hint: 'supertonicSpeed', cat: 'voice' },
  { key: '한국어 발음', label: '한국어 발음', hint: '음차 koreanizeTts', cat: 'voice' },
  // 확장
  { key: '외부 MCP 서버', label: '외부 MCP 서버', hint: 'chrome-devtools mcp 브라우저', cat: 'extensions' },
  { key: '클로드 플러그인', label: '클로드 플러그인', hint: '스킬셋 마켓 plugin', cat: 'extensions' },
]

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
  useEffect(() => {
    setV(value)
  }, [value]) // 외부(설정 재로딩) 갱신 반영
  const dirty = v.trim() !== value
  // 자동 저장: 포커스 아웃(blur)·Enter·버튼 어느 쪽이든 저장된다 — 타이핑 후 그냥 닫아도 유실 안 됨.
  const save = () => {
    if (dirty) onSave(v.trim())
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
            onBlur={save}
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
          {/* 저장 상태가 항상 보이게: 변경됨=미저장(주황), 저장본과 동일+값 있음=저장됨(녹색) */}
          {dirty ? (
            <span className="tg-unsaved">● 미저장</span>
          ) : v ? (
            <span className="tg-saved">✓ 저장됨</span>
          ) : null}
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
            {/* local은 실험적 — 메인테이너 환경(8GB VRAM)에서 실용 검증 불가, README 참조 */}
            {t} — {MODEL_IDS[t]}{t === 'local' ? ' (실험적 — 로컬 서버 필요)' : ''}
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
      <div className="dim settings-section-divider">
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
      {/* B6+브라우저 조작 — chrome-devtools-mcp 프리셋. 네이티브 Windows에서 stdio npx 스폰은
          cmd /c 래퍼가 필요하다(CC 공식 문서 — npx.cmd는 셸 없이 spawn 불가). */}
      <div className="settings-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="dim settings-hint" style={{ flexBasis: '100%' }}>
          프리셋 — 실행엔 Node(npx)·Chrome 필요. 첫 사용은 패키지 다운로드로 수십 초 걸릴 수 있다.
        </span>
        <button
          type="button"
          className="chip"
          title="Chrome DevTools MCP를 Lain에 바로 등록 — 레인이 전용 프로필의 크롬 창을 직접 열어 이동·클릭·입력·스크린샷·콘솔/네트워크 확인을 한다. 일상 크롬 로그인과 분리된 창이라 필요한 사이트는 그 창에서 한 번 로그인하면 유지된다."
          onClick={async () => {
            setError(null)
            const r = await window.lain.addMcpServer({
              name: 'chrome',
              transport: 'stdio',
              command: 'cmd',
              args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@latest'],
              env: {},
              targets: ['manager'],
            })
            if (r.error) setError(r.error)
          }}
        >
          <Icon name="globe" size={14} /> 레인 브라우저 조작 (원클릭 등록)
        </button>
        <button
          type="button"
          className="chip"
          title="Chrome DevTools MCP(헤드리스) — Navi가 헤드리스 크롬으로 페이지를 열어 DOM·콘솔·스크린샷으로 실제 화면을 검증한다. 클릭하면 아래 폼이 채워진다('추가'로 등록)."
          onClick={() => {
            setName('chrome-devtools')
            setTransport('stdio')
            setCommand('cmd')
            setArgsText('/c npx -y chrome-devtools-mcp@latest --headless')
            setEnvText('')
            setTargets(['navi'])
            setError(null)
          }}
        >
          <Icon name="globe" size={14} /> Chrome DevTools (Navi 브라우저 검증)
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
        {error && <span className="err">{error}</span>}
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
      <div className="dim settings-section-divider">
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
        {msg && <span className={msg.includes('실패') ? 'err' : 'ok'}>{msg}</span>}
      </div>
    </>
  )
}

export function PrefsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<LainSettings | null>(null)
  const [tg, setTg] = useState<TelegramStatus | null>(null)
  const [dc, setDc] = useState<DiscordStatus | null>(null)
  const [upd, setUpd] = useState<UpdateStatus | null>(null)
  // E6 — 유효 워크스페이스(env 오버라이드 여부 표시용). 설정 표시=실제 일치.
  const [wsInfo, setWsInfo] = useState<{ root: string; envRootOverride: boolean; envScanOverride: boolean } | null>(null)
  const [cat, setCat] = useState('general') // 환경설정 카테고리(좌측 nav)
  // B11 — 설정 검색어. 매치 시 첫 매치 카테고리로 자동 전환하고(targetCategory) 매치 라벨 행을 하이라이트.
  const [query, setQuery] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const [ttsTesting, setTtsTesting] = useState(false)
  const [ttsTestMsg, setTtsTestMsg] = useState('')
  const runTtsTest = async () => {
    setTtsTesting(true)
    setTtsTestMsg('합성 중…')
    try {
      const uri = await window.lain.testTts() // mime 포함 data URI(edge=mp3, 나머지=wav)
      if (!uri) {
        setTtsTestMsg('합성 실패 — 빈 결과')
        return
      }
      const audio = new Audio(uri)
      audio.onended = () => setTtsTestMsg('재생 완료')
      await audio.play()
      setTtsTestMsg('재생 중…')
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      setTtsTestMsg('실패: ' + m + ' — 모델 다운로드 중이면 잠시 후 다시')
    } finally {
      setTtsTesting(false)
    }
  }

  // 개인 보이스 가져오기 — '찾아보기'로 파일 선택 → lain voices 폴더로 복사(JSON이면 즉시 등록).
  const [voiceImportMsg, setVoiceImportMsg] = useState('')
  const runVoiceImport = async () => {
    setVoiceImportMsg('파일 선택…')
    try {
      const r = await window.lain.importVoice()
      if (!r) {
        setVoiceImportMsg('')
        return
      }
      if (r.error === 'not-voice-style') {
        setVoiceImportMsg(
          `${r.file}: Supertonic 보이스 JSON이 아니야(전사/다른 형식). 보이스 JSON은 style_ttl·style_dp가 있어야 함. 음성 샘플이면 .wav로 넣어.`,
        )
        return
      }
      if (r.kind === 'json') {
        patch({ supertonicVoice: 'custom', supertonicCustomVoice: r.file })
        setVoiceImportMsg(`등록됨: ${r.file} — 개인 보이스로 설정됨`)
      } else {
        patch({ supertonicCustomSample: r.file }) // 영구 기록(껐다 켜도 유지)
        setVoiceImportMsg(`샘플 저장됨: ${r.file} (voices 폴더에 영구 보관)`)
      }
    } catch (e) {
      setVoiceImportMsg('실패: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // E8 — 데이터 백업 내보내기
  const [backupMsg, setBackupMsg] = useState('')
  const runBackup = async () => {
    setBackupMsg('백업 중…')
    try {
      const r = await window.lain.backupData()
      if (r.canceled) {
        setBackupMsg('')
        return
      }
      if (!r.ok) {
        setBackupMsg('실패: ' + (r.error || '알 수 없는 오류'))
        return
      }
      const kb = Math.round((r.bytes || 0) / 1024)
      setBackupMsg(
        r.busy
          ? `저장됨(${kb}KB) — 단, 다른 작업 중이라 일부 최신 변경이 빠졌을 수 있어. 잠시 후 다시 권장.`
          : `백업 완료 — ${kb}KB`,
      )
    } catch (e) {
      setBackupMsg('실패: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const refreshTg = () => window.lain.telegramStatus().then(setTg)
  const refreshDc = () => window.lain.discordStatus().then(setDc)

  useEffect(() => {
    window.lain.getSettings().then(setSettings)
    window.lain.workspaceInfo().then(setWsInfo)
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

  // B11 — 검색: 매치 라벨 집합 + 첫 매치 카테고리. matchingItems/targetCategory는 순수(vitest 검증).
  const matchedLabels = useMemo(
    () => new Set(matchingItems(SEARCH_INDEX, query).map((it) => it.label)),
    [query],
  )
  // 검색어가 바뀌면 매치가 있는 카테고리로 자동 전환(현재 카테고리에 매치 있으면 유지 — 안 튐).
  useEffect(() => {
    if (!normalizeQuery(query)) return
    const target = targetCategory(SEARCH_INDEX, query, cat)
    if (target && target !== cat) setCat(target)
    // cat을 deps에서 뺀다 — 넣으면 전환 직후 재실행돼 다른 카테고리로 연쇄 이동할 수 있다(첫 매치로 한 번만).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])
  // 렌더된 카테고리의 설정 행 중 매치되는 라벨에 하이라이트 클래스를 토글(라벨 텍스트로 DOM 매칭 — 개별 배선 불필요).
  useEffect(() => {
    const root = bodyRef.current
    if (!root) return
    const rows = root.querySelectorAll<HTMLElement>('.settings-row')
    rows.forEach((row) => {
      const keyText = row.querySelector('.settings-key')?.textContent?.trim() ?? ''
      const hit = matchedLabels.size > 0 && matchedLabels.has(keyText)
      row.classList.toggle('prefs-hit', hit)
    })
  }, [matchedLabels, cat, settings])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-window" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">환경설정</span>
          {/* B11 — 설정 검색 — 설정명·힌트 부분일치, 매치 카테고리로 자동 전환 + 매치 행 하이라이트 */}
          <input
            className="prefs-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="설정 검색 — 예: groq · 압축 · 동시 작업"
          />
          <button className="modal-close" onClick={onClose} aria-label="닫기">
            <Icon name="x-circle" size={18} />
          </button>
        </div>
        <div className="modal-body">
          {!settings ? (
            <div className="dim">로딩...</div>
          ) : (
            <div className="prefs-2col">
              <nav className="prefs-nav">
                {CATS.map((c) => (
                  <button
                    key={c.id}
                    className={`prefs-nav-item${cat === c.id ? ' on' : ''}`}
                    onClick={() => setCat(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </nav>
              <div className="settings-body prefs-content" ref={bodyRef}>
                {cat === 'models' && (
                  <>
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
              {/* 초안 상태 + blur/Enter 저장(TelegramField 재사용) — 키스트로크마다 patch하면 저장측
                  정규화(빈값→기본 URL) 에코백이 입력을 되덮어 필드를 비울 수 없고 반쪽 URL이 영속된다. */}
              <TelegramField
                label="로컬 모델 서버"
                value={settings.localBaseUrl}
                placeholder="http://127.0.0.1:8080"
                howto={
                  <>
                    'local(Qwen)' 티어의 llama-server 주소. 설치 scripts\setup-qwen.ps1 → 기동
                    scripts\start-llama.ps1 — 서버가 꺼져 있으면 local 티어 응답 실패
                  </>
                }
                onSave={(v) => patch({ localBaseUrl: v })}
              />
              {/* E5 — 구독 로그인 대신 API 키로 인증(비었으면 구독 OAuth). non-local 티어 spawn env에 주입. 시크릿. */}
              <TelegramField
                label="Anthropic API 키"
                secret
                value={settings.anthropicApiKey}
                placeholder="sk-ant-… (구독 로그인이 있으면 비워두세요)"
                howto={
                  <>
                    Claude 구독 로그인 대신 API 키로 인증할 때만 입력. console.anthropic.com에서 발급.
                    입력하면 Navi·Lain·판정 모두 이 키로 과금된다(local 티어 제외). 비우면 구독 로그인
                    사용. 시크릿이라 로그·다이제스트에 남기지 않는다.
                  </>
                }
                onSave={(v) => patch({ anthropicApiKey: v })}
              />
                  </>
                )}
                {cat === 'general' && (
                  <>
              <TelegramField
                label="내 호칭"
                value={settings.userTitle}
                placeholder="유저"
                howto={
                  <>
                    레인이 대화에서 너를 부르는 호칭(기본 '유저'). 대화 중 "나를 …라고 불러"로도 바꿀 수 있다. 채팅 태그는 'User'로 고정.
                  </>
                }
                onSave={(v) => patch({ userTitle: v })}
              />
              <TelegramField
                label="외부 표시명"
                value={settings.userAliases.join(', ')}
                placeholder="디스코드닉, 카톡이름 (쉼표 구분)"
                howto={
                  <>
                    디스코드·카톡 등 화면 속 채팅에서 너 자신의 닉네임/표시명. 등록해두면 유저 감시가
                    네 메시지를 남의 말로 오인하지 않는다.
                  </>
                }
                onSave={(v) =>
                  patch({
                    userAliases: v
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
              />
              {/* E6 — 워크스페이스 자동 스캔 대상(env LAIN_WORKSPACE·LAIN_SCAN_DIRS가 있으면 그쪽 우선). */}
              <TelegramField
                label="워크스페이스 루트"
                value={settings.workspaceRoot}
                placeholder="C:\workspace (기본)"
                howto={
                  <>
                    SCAN이 프로젝트를 찾는 최상위 폴더. 비우면 기본 <code>C:\workspace</code>.
                    {wsInfo?.envRootOverride && (
                      <>
                        {' '}
                        <b>환경변수 LAIN_WORKSPACE 적용 중</b>(설정보다 우선): <code>{wsInfo.root}</code>
                      </>
                    )}
                  </>
                }
                onSave={(v) => patch({ workspaceRoot: v })}
              />
              <TelegramField
                label="스캔 하위 폴더"
                value={settings.scanDirs.join(', ')}
                placeholder="apps, games, tools (기본)"
                howto={
                  <>
                    루트 아래에서 스캔할 하위 폴더(쉼표 구분). 비우면 기본 apps·games·tools.
                    {wsInfo?.envScanOverride && (
                      <>
                        {' '}
                        <b>환경변수 LAIN_SCAN_DIRS 적용 중</b>(설정보다 우선).
                      </>
                    )}
                  </>
                }
                onSave={(v) =>
                  patch({
                    scanDirs: v
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
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
              {/* 말수 — 상호작용 대사(말풍선)+유저 감시 선제 발화 빈도. 감시 on/off(마스터)와 별개로 빈도만 조절. */}
              <label className="settings-row">
                <span className="settings-key">말수</span>
                <span className="chattiness-ctl">
                  <span className="dim">묵언</span>
                  <input
                    type="range"
                    min={0}
                    max={4}
                    step={1}
                    value={settings.chattiness ?? 2}
                    onChange={(e) => patch({ chattiness: Number(e.target.value) })}
                  />
                  <span className="dim">수다쟁이</span>
                </span>
                <span className="dim settings-hint">
                  UI 반응 대사·감시 중 먼저 말 걸기 빈도 — 묵언(왼끝)이면 말 걸었을 때만 대답. 감시
                  끄기와 별개
                </span>
              </label>
              {/* 유저 감시 토글은 메인 화면(레인 캐릭터 아래)으로 이동함 — 여기선 제거. */}
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
              {/* E8 — 데이터 백업·이식. 설정·대화·교훈·플래너가 %APPDATA%\lain의 SQLite에 쌓인다. */}
              <div className="settings-section-label">데이터</div>
              <div className="settings-row">
                <span className="settings-key">백업·이식</span>
                <span className="upd-controls">
                  <button type="button" className="upd-btn" onClick={() => void window.lain.openDataFolder()}>
                    데이터 폴더 열기
                  </button>
                  <button type="button" className="upd-btn" onClick={() => void runBackup()}>
                    백업 내보내기
                  </button>
                </span>
                <span className="dim settings-hint">
                  {backupMsg || '설정·대화·교훈·플래너를 하나의 파일로 내보낸다. PC 이사 시 이 파일을 데이터 폴더에 lain.sqlite로 되돌린다.'}
                </span>
              </div>
                  </>
                )}
                {cat === 'planner' && (
                  <>
              {/* B11 — 좌측 nav에 이미 '플래너' 라벨이 있어 중복이던 '── 플래너' 구분 헤더 제거. */}
              <div className="settings-section-label">표시</div>
              <label className="settings-row">
                <span className="settings-key">캘린더에 일정 표시</span>
                <input
                  type="checkbox"
                  checked={settings.plannerShowEvents}
                  onChange={(e) => patch({ plannerShowEvents: e.target.checked })}
                />
                <span className="dim settings-hint">일정(event) 항목을 캘린더에 표시</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">체크리스트 표시</span>
                <input
                  type="checkbox"
                  checked={settings.plannerShowTodos}
                  onChange={(e) => patch({ plannerShowTodos: e.target.checked })}
                />
                <span className="dim settings-hint">할일(todo) 항목을 캘린더에 표시</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">루틴 표시</span>
                <input
                  type="checkbox"
                  checked={settings.plannerShowRoutines}
                  onChange={(e) => patch({ plannerShowRoutines: e.target.checked })}
                />
                <span className="dim settings-hint">등록한 루틴을 캘린더에 표시</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">작업 표시</span>
                <input
                  type="checkbox"
                  checked={settings.plannerShowTasks}
                  onChange={(e) => patch({ plannerShowTasks: e.target.checked })}
                />
                <span className="dim settings-hint">Navi 작업 마감을 캘린더에 표시</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">완료 항목 표시</span>
                <input
                  type="checkbox"
                  checked={settings.plannerShowDone}
                  onChange={(e) => patch({ plannerShowDone: e.target.checked })}
                />
                <span className="dim settings-hint">완료된 일정/할일을 흐리게 표시</span>
              </label>
              <div className="settings-section-label">기본값·레이아웃</div>
              <label className="settings-row">
                <span className="settings-key">기본 뷰</span>
                <select
                  value={settings.plannerDefaultView}
                  onChange={(e) => patch({ plannerDefaultView: e.target.value as 'month' | 'week' | 'day' })}
                >
                  <option value="month">월간</option>
                  <option value="week">주간</option>
                  <option value="day">일간</option>
                </select>
                <span className="dim settings-hint">플래너를 열면 처음 보이는 뷰</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">주 시작</span>
                <select
                  value={settings.plannerWeekStart}
                  onChange={(e) => patch({ plannerWeekStart: Number(e.target.value) as 0 | 1 })}
                >
                  <option value="0">일요일</option>
                  <option value="1">월요일</option>
                </select>
                <span className="dim settings-hint">캘린더 주간 뷰에서 첫 요일</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">사이드바 위치</span>
                <select
                  value={settings.plannerSidebarSide}
                  onChange={(e) => patch({ plannerSidebarSide: e.target.value as 'left' | 'right' })}
                >
                  <option value="left">좌측</option>
                  <option value="right">우측</option>
                </select>
                <span className="dim settings-hint">아이템 목록 사이드바 위치</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">사이드바 폭</span>
                <input
                  type="number"
                  min={200}
                  max={480}
                  value={settings.plannerSidebarWidth}
                  onChange={(e) => patch({ plannerSidebarWidth: Number(e.target.value) || 300 })}
                />
                <span className="dim settings-hint">픽셀 (200~480)</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">밀도</span>
                <select
                  value={settings.plannerDensity}
                  onChange={(e) => patch({ plannerDensity: e.target.value as 'cozy' | 'compact' })}
                >
                  <option value="cozy">넉넉</option>
                  <option value="compact">촘촘</option>
                </select>
                <span className="dim settings-hint">캘린더 일자별 항목 표시 밀도</span>
              </label>
              <div className="settings-section-label">알림·보조 기능</div>
              <label className="settings-row">
                <span className="settings-key">리마인드 기본(분)</span>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={settings.plannerRemindDefaultMin}
                  onChange={(e) => {
                    const raw = e.target.value
                    const n = raw === '' ? 10 : Math.max(0, Number(raw))
                    patch({ plannerRemindDefaultMin: Number.isNaN(n) ? 10 : n })
                  }}
                />
                <span className="dim settings-hint">새 항목의 기본 알림 시간(분 전)</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">방치 기준(일)</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={settings.plannerStaleDays}
                  onChange={(e) => patch({ plannerStaleDays: Number(e.target.value) || 7 })}
                />
                <span className="dim settings-hint">항목이 미완료로 방치된 일수 — 넘으면 시각적 강조</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">방치 넛지</span>
                <select
                  value={settings.plannerNudge}
                  onChange={(e) => patch({ plannerNudge: e.target.value as 'off' | 'daily' | 'weekly' })}
                >
                  <option value="off">끔</option>
                  <option value="daily">매일</option>
                  <option value="weekly">주 1회</option>
                </select>
                <span className="dim settings-hint">방치된 항목에 대한 자동 리마인드 빈도</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">브리핑에 포함</span>
                <input
                  type="checkbox"
                  checked={settings.plannerInBriefing}
                  onChange={(e) => patch({ plannerInBriefing: e.target.checked })}
                />
                <span className="dim settings-hint">아침 브리핑에 오늘 일정/할일 포함</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">체크리스트 대신 처리 제안</span>
                <input
                  type="checkbox"
                  checked={settings.plannerOfferHelp}
                  onChange={(e) => patch({ plannerOfferHelp: e.target.checked })}
                />
                <span className="dim settings-hint">방치된 할일에 대해 레인이 처리를 도울지 물어봄</span>
              </label>
              <label className="settings-row">
                <span className="settings-key">텔레그램 리마인드</span>
                <input
                  type="checkbox"
                  checked={settings.plannerTelegramRemind}
                  onChange={(e) => patch({ plannerTelegramRemind: e.target.checked })}
                />
                <span className="dim settings-hint">일정/할일 알림을 텔레그램 폰으로도 발송</span>
              </label>
                  </>
                )}
                {cat === 'automation' && (
                  <>
              {/* B11 — '동시 작업 cap'은 실행/자동화 성격이라 모델→자동화·고급으로 이동. */}
              <label className="settings-row" data-skey="concurrencyCap">
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
              {/* D14 — 같은 프로젝트 병렬 opt-in. 1=현행(프로젝트당 1개), 충돌은 병합 시 rebase→verify가 판사. */}
              <label className="settings-row">
                <span className="settings-key">프로젝트 병렬 cap</span>
                <input
                  type="number"
                  min={1}
                  max={4}
                  value={settings.projectParallelCap}
                  onChange={(e) => patch({ projectParallelCap: Number(e.target.value) || 1 })}
                />
                <span className="dim settings-hint">
                  한 프로젝트에서 동시에 돌 수 있는 작업 수 — 1이면 기존처럼 순차. 같은 파일을 만질
                  작업들은 병렬 대신 의존 체인 권장 (D14)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">작업 토큰 예산</span>
                <input
                  type="number"
                  min={0}
                  step={100000}
                  value={settings.taskTokenBudget}
                  onChange={(e) => patch({ taskTokenBudget: Number(e.target.value) || 0 })}
                />
                <span className="dim settings-hint">
                  작업 하나의 누적 토큰이 이 값을 넘으면 세션 경계에서 일시정지하고 보고 — 재개하면 이어감(작업트리·세션 보존). 0 = 제한 없음
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">전역 사용량 한도(토큰/1시간)</span>
                <input
                  type="number"
                  min={0}
                  step={500000}
                  value={settings.usageWindowTokenLimit}
                  onChange={(e) => patch({ usageWindowTokenLimit: Number(e.target.value) || 0 })}
                />
                <span className="dim settings-hint">
                  최근 1시간 전체 누적 토큰이 이 값에 근접하면 신규 작업을 큐로 미루고 판정 모델을 저티어로 강등(크레딧 보호). 0 = 제한 없음
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
                <span className="settings-key">TASK.md 자동 착수</span>
                <input
                  type="checkbox"
                  checked={settings.autoStartTaskMd}
                  onChange={(e) => patch({ autoStartTaskMd: e.target.checked })}
                />
                <span className="dim settings-hint">
                  스캔이 새 TASK.md를 발견하면, autonomous 마커+verify_cmd가 있는 경우에 한해 자동 시작 (기본 off)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">병합 자동 rebase</span>
                <input
                  type="checkbox"
                  checked={settings.autoRebaseOnMerge}
                  onChange={(e) => patch({ autoRebaseOnMerge: e.target.checked })}
                />
                <span className="dim settings-hint">
                  결재(merge)가 ff 불가일 때 worktree 브랜치를 main에 자동 rebase→verify 재실행→ff 재시도. 충돌·verify실패면 브랜치만 남김(비파괴, 기본 on)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">학습 정비</span>
                <input
                  type="checkbox"
                  checked={settings.lessonCurator}
                  onChange={(e) => patch({ lessonCurator: e.target.checked })}
                />
                <span className="dim settings-hint">
                  idle 시 중복 학습을 자동 병합 (§24 curator · 판정 모델 호출)
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
                <span className="settings-key">턴 자기개선 리뷰</span>
                <input
                  type="checkbox"
                  checked={settings.turnReviewEnabled}
                  onChange={(e) => patch({ turnReviewEnabled: e.target.checked })}
                />
                <span className="dim settings-hint">
                  레인 채팅 턴 후 학습·스킬 후보 자동 추출 (💾 알림 · 판정 모델 호출)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">검증 넛지</span>
                <input
                  type="checkbox"
                  checked={settings.verifyNudgeEnabled}
                  onChange={(e) => patch({ verifyNudgeEnabled: e.target.checked })}
                />
                <span className="dim settings-hint">
                  레인이 코드 수정 후 검증 없이 턴을 끝내면 다음 턴에 1회 상기
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">빠른 대화</span>
                <input
                  type="checkbox"
                  checked={settings.managerFastChat}
                  onChange={(e) => patch({ managerFastChat: e.target.checked })}
                />
                <span className="dim settings-hint">
                  작업 아닌 대화 턴은 도구 없는 경량 응답으로 즉답(빠름). 행동·작업이면 자동으로 본체로 승격
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
              <label className="settings-row">
                <span className="settings-key">승인 재알림(분)</span>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={settings.approvalTimeoutMin}
                  onChange={(e) => patch({ approvalTimeoutMin: Number(e.target.value) || 0 })}
                />
                <span className="dim settings-hint">
                  무인 작업(백그라운드 Navi)의 승인·질문이 이 시간 무응답이면 재알림 1회(PC·텔레그램). ⚠ 거절이 아니다 — 이후에도 계속 대기하며 세션·작업트리는 보존되고, 응답하면 그 지점부터 이어진다. 0이면 재알림 없이 조용히 대기
                </span>
              </label>

                  </>
                )}
                {cat === 'telegram' && (
                  <>
              {/* §20.3 텔레그램 채널 — 자리 비웠을 때 폰으로 와이어드 지휘·결재 */}
              <div className="dim settings-section-divider">
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

                  </>
                )}
                {cat === 'voice' && (
                  <>
              {/* B11 — PC 마이크 STT(입력창 PTT)와 텔레그램 음성 메시지 STT는 같은 Groq 키를 쓴다. 텔레그램
                  카테고리에만 있어 음성 카테고리에서 못 찾던 문제 → 여기서도 동일 설정(groqApiKey)을 그대로
                  렌더한다. 값은 한 곳에만 저장되고(이중 저장 아님), 어느 화면에서 바꿔도 즉시 서로 반영된다. */}
              <div className="settings-section-label">음성 인식 (STT)</div>
              <TelegramField
                label="Groq API 키"
                secret
                value={settings.groqApiKey}
                placeholder="gsk_..."
                onSave={(v) => patch({ groqApiKey: v })}
                howto={
                  <>
                    <b>console.groq.com/keys</b> → Create API Key. PC 마이크(입력창 🎙 PTT)·텔레그램 음성 메시지를{' '}
                    Groq Whisper(무료)로 텍스트 변환 — 비우면 STT 비활성화. 텔레그램 카테고리와 <b>같은 키</b>라 한쪽에서
                    바꾸면 양쪽에 반영된다. 시크릿이라 로그에 안 남는다.
                  </>
                }
              />
              {/* §20.3 디스코드 음성 통화 — 폰/데스크 음성채널로 레인과 실시간 통화 */}
              <div className="settings-section-label">디스코드 음성 통화</div>
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
              <div className="settings-section-label">음성 출력 (TTS)</div>
              <label className="settings-row">
                <span className="settings-key">엔진</span>
                <select
                  value={settings.ttsBackend || 'edge'}
                  onChange={(e) =>
                    patch({ ttsBackend: e.target.value as 'edge' | 'gpt-sovits' | 'supertonic' })
                  }
                >
                  <option value="edge">Edge TTS (클라우드, 기본)</option>
                  <option value="supertonic">Supertonic (로컬·한국어, 권장)</option>
                  <option value="gpt-sovits">GPT-SoVITS (로컬·음성복제)</option>
                </select>
                <span className="dim settings-hint">
                  아래 설정은 선택한 엔진에 맞춰 바뀜 · Supertonic=인앱 한국어(빠름) · GPT-SoVITS=음성복제(서버 필요)
                </span>
              </label>
              <label className="settings-row">
                <span className="settings-key">기본 톤</span>
                <select
                  value={settings.voiceTone || 'deadpan'}
                  onChange={(e) =>
                    patch({ voiceTone: e.target.value as 'deadpan' | 'subtle' | 'expressive' })
                  }
                >
                  <option value="deadpan">무미건조 (감정 표현 없음 · 기본)</option>
                  <option value="subtle">미세한 감정 (아주 드물게)</option>
                  <option value="expressive">표현 풍부 (감정 태그 적극)</option>
                </select>
                <span className="dim settings-hint">
                  음성 답변의 말투·감정 — 레인이 감정 태그(&lt;sigh&gt; 등)를 얼마나 쓸지. 태그는 Supertonic에서만 발음됨
                </span>
              </label>
              {settings.ttsBackend === 'edge' && (
                <>
                  <div className="settings-section-label">Edge TTS 설정</div>
                  <label className="settings-row">
                    <span className="settings-key">음성</span>
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
                    <span className="dim settings-hint">Edge TTS 음성 응답 목소리</span>
                  </label>
                </>
              )}
              {settings.ttsBackend === 'gpt-sovits' && (
                <>
                  <div className="settings-section-label">GPT-SoVITS 설정</div>
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
                      <option value="ja">일본어</option>
                      <option value="en">영어</option>
                      <option value="zh">중국어</option>
                    </select>
                    <span className="dim settings-hint">참조 클립의 언어. 출력은 항상 한국어</span>
                  </label>
                  <label className="settings-row">
                    <span className="settings-key">말 속도</span>
                    <input
                      type="range"
                      min={0.5}
                      max={2.0}
                      step={0.05}
                      value={settings.gptSovitsSpeed ?? 1.15}
                      onChange={(e) => patch({ gptSovitsSpeed: Number(e.target.value) })}
                    />
                    <span className="dim settings-hint">
                      {(settings.gptSovitsSpeed ?? 1.15).toFixed(2)}x — 높을수록 빠름 (기본 1.15)
                    </span>
                  </label>
                </>
              )}
              {settings.ttsBackend === 'supertonic' && (
                <>
                  <div className="settings-section-label">Supertonic 설정</div>
                  <label className="settings-row">
                    <span className="settings-key">Supertonic 보이스</span>
                    <select
                      value={settings.supertonicVoice || 'F5'}
                      onChange={(e) => patch({ supertonicVoice: e.target.value })}
                    >
                      <option value="F1">F1 (여성)</option>
                      <option value="F2">F2 (여성)</option>
                      <option value="F3">F3 (여성)</option>
                      <option value="F4">F4 (여성)</option>
                      <option value="F5">F5 (여성·기본)</option>
                      <option value="M1">M1 (남성)</option>
                      <option value="M2">M2 (남성)</option>
                      <option value="M3">M3 (남성)</option>
                      <option value="M4">M4 (남성)</option>
                      <option value="M5">M5 (남성)</option>
                      <option value="custom">개인 보이스 (로컬·직접 추가)</option>
                    </select>
                    <span className="dim settings-hint">내장 한국어 보이스 (F=여성 / M=남성) · 개인 보이스는 직접 가져온 로컬 파일</span>
                  </label>
                  {settings.supertonicVoice === 'custom' && (
                    <>
                      <label className="settings-row">
                        <span className="settings-key">파일 가져오기</span>
                        <span className="upd-controls">
                          <button type="button" className="upd-btn" onClick={runVoiceImport}>
                            찾아보기…
                          </button>
                          <button
                            type="button"
                            className="upd-btn"
                            onClick={() => void window.lain.openVoicesFolder()}
                          >
                            폴더 열기
                          </button>
                        </span>
                        <span className="dim settings-hint">
                          {voiceImportMsg ||
                            '파일 선택 → voices 폴더로 복사·영구 보관. 스타일 JSON이면 바로 보이스 등록, 오디오 샘플은 보관(변환 필요).'}
                        </span>
                      </label>
                      {settings.supertonicCustomSample && (
                        <label className="settings-row">
                          <span className="settings-key">내 음성 샘플</span>
                          <span className="tg-saved">✓ {settings.supertonicCustomSample}</span>
                          <span className="dim settings-hint">
                            voices 폴더에 영구 저장됨 — 잃어버리지 않음. 오디오를 레인 목소리로 쓰려면 스타일 JSON
                            변환이 필요(동의된 음성 한정).
                          </span>
                        </label>
                      )}
                      <TelegramField
                        label="개인 보이스 파일"
                        value={settings.supertonicCustomVoice}
                        placeholder="my_voice.json"
                        onSave={(v) => patch({ supertonicCustomVoice: v })}
                        howto={
                          <>
                            데이터 폴더 <code>%APPDATA%\lain\voices\</code> 안의 Supertonic 스타일 JSON 파일명. 위
                            ‘찾아보기’로 자동 입력되거나 직접 적을 수 있음. 이 파일은 배포본에 포함되지 않으며(직접 가져온
                            개인 음성), 음성권은 사용자 책임. 비우면 F5로 폴백.
                          </>
                        }
                      />
                    </>
                  )}
                  <label className="settings-row">
                    <span className="settings-key">말 속도</span>
                    <input
                      type="range"
                      min={0.5}
                      max={2.0}
                      step={0.05}
                      value={settings.supertonicSpeed ?? 1.05}
                      onChange={(e) => patch({ supertonicSpeed: Number(e.target.value) })}
                    />
                    <span className="dim settings-hint">
                      {(settings.supertonicSpeed ?? 1.05).toFixed(2)}x — 낮출수록 차분·무미건조
                    </span>
                  </label>
                  <label className="settings-row">
                    <span className="settings-key">품질 스텝</span>
                    <input
                      type="range"
                      min={2}
                      max={16}
                      step={1}
                      value={settings.supertonicStep ?? 8}
                      onChange={(e) => patch({ supertonicStep: Number(e.target.value) })}
                    />
                    <span className="dim settings-hint">
                      {settings.supertonicStep ?? 8} — 높을수록 품질↑·느림 (기본 8)
                    </span>
                  </label>
                  <div className="settings-row">
                    <span className="settings-key">테스트</span>
                    <span className="upd-controls">
                      <button type="button" className="upd-btn" disabled={ttsTesting} onClick={runTtsTest}>
                        {ttsTesting ? (
                          '생성 중…'
                        ) : (
                          <>
                            <Icon name="play" size={14} /> 테스트 재생
                          </>
                        )}
                      </button>
                    </span>
                    <span className="dim settings-hint">
                      {ttsTestMsg ||
                        '현재 보이스·속도로 한 문장 합성해 들려줌 (첫 사용 시 모델 ~398MB 1회 다운로드)'}
                    </span>
                  </div>
                  <div className="settings-row">
                    <span className="settings-key">감정</span>
                    <span className="dim settings-hint">
                      Supertonic은 감정을 <b>수치가 아니라 텍스트 태그</b>로 표현 — 말할 문장에{' '}
                      <code>&lt;laugh&gt; &lt;sigh&gt; &lt;breath&gt; &lt;scream&gt;</code> 를 넣는다.
                      피치·톤 같은 별도 숫자 파라미터는 Supertonic에 없음(조절 수치는 위 보이스·속도·품질이 전부).
                    </span>
                  </div>
                  <label className="settings-row">
                    <span className="settings-key">한국어 발음</span>
                    <input
                      type="checkbox"
                      checked={settings.koreanizeTts !== false}
                      onChange={(e) => patch({ koreanizeTts: e.target.checked })}
                    />
                    <span className="dim settings-hint">
                      영어·숫자를 한글 음차로 바꿔 한국어 억양으로 발음(화면 글자는 그대로). 끄면 원문대로 — 영어가
                      섞이면 이상한 억양이 날 수 있음.
                    </span>
                  </label>
                </>
              )}
                  </>
                )}
                {cat === 'extensions' && (
                  <>
              <McpServersSection />

              <PluginsSection
                curated={settings.curatedPlugins ?? []}
                onSetCurated={(names) => patch({ curatedPlugins: names })}
              />
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
