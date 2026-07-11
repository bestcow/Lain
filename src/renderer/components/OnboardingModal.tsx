// 첫 실행 온보딩 위저드 — 새 사용자가 README 없이도 최소 셋업(로그인 확인→폴더 등록→호칭)을
// 끝내게 안내한다. onboardingDone 설정으로 1회만 표시(기존 설치는 store 마이그레이션이 자동 스킵).
// 결정론 검사만(onboarding:status) — LLM 호출 없음.
import { useEffect, useState } from 'react'
import type { LainSettings } from '../../shared/types'
import { Icon } from './icons'

interface Props {
  settings: LainSettings
  onDone: (next: LainSettings) => void
}

export function OnboardingModal({ settings, onDone }: Props) {
  const [status, setStatus] = useState<{
    claudeBin: boolean
    loggedIn: boolean
    claudeBinPath: string
    isPackaged: boolean
  } | null>(null)
  const [projectCount, setProjectCount] = useState<number | null>(null)
  const [title, setTitle] = useState(settings.userTitle || '유저')
  const [loggingIn, setLoggingIn] = useState(false)
  const [loginErr, setLoginErr] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')

  const refresh = (): void => {
    void window.lain.onboardingStatus().then(setStatus)
    void window.lain.listProjects().then((ps) => setProjectCount(ps.length))
  }
  useEffect(refresh, [])

  // E2 — 번들 Claude로 새 콘솔에 `auth login`(구독 OAuth)을 띄운다. 완료 후 사용자가 '다시 확인'.
  const openLogin = async (): Promise<void> => {
    setLoginErr(null)
    setLoggingIn(true)
    try {
      const r = await window.lain.onboardingLogin()
      if (!r.ok) setLoginErr(r.error || '터미널을 열지 못했습니다.')
    } catch (e) {
      setLoginErr((e as Error).message)
    } finally {
      setLoggingIn(false)
    }
  }

  // E5 — 구독 대신 API 키로 연결. 앱 설정에 저장하면 onboarding:status가 인정(spawn env 주입).
  const saveApiKey = async (): Promise<void> => {
    const k = apiKey.trim()
    if (!k) return
    await window.lain.setSettings({ anthropicApiKey: k })
    setApiKey('')
    refresh()
  }

  const addFolder = async (): Promise<void> => {
    await window.lain.addProjectDialog()
    refresh()
  }

  // E6 — 워크스페이스 루트를 스캔해 하위 프로젝트를 자동 등록(설정한 루트/기본 C:\workspace).
  const scanNow = async (): Promise<void> => {
    await window.lain.scanProjects()
    refresh()
  }

  const finish = async (): Promise<void> => {
    const next = await window.lain.setSettings({
      onboardingDone: true,
      userTitle: title.trim() || '유저',
    })
    onDone(next)
  }

  const check = (ok: boolean | undefined): string => (ok == null ? '…' : ok ? '✅' : '❌')

  return (
    <div className="modal-backdrop">
      <div className="modal-window" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">lain 시작하기</span>
        </div>
        <div className="modal-body">
          <div className="onboarding">
            <p className="dim">
              lain은 내 PC에 상주하며 나에게 길들여지는 개인 AI 매니저입니다. 세 가지만 확인하면
              바로 시작할 수 있어요.
            </p>

            <h3>1. Claude 연결 {check(status ? status.claudeBin && status.loggedIn : undefined)}</h3>
            {status && !status.claudeBin && (
              <p>
                ❌ 내장 Claude 실행 파일을 찾지 못했습니다 (기대 경로: <code>{status.claudeBinPath}</code>).{' '}
                {status.isPackaged
                  ? '설치가 손상됐을 수 있어요. 재설치를 권합니다.'
                  : '소스 실행 환경으로 보입니다 — npm install을 다시 실행해 플랫폼별 SDK 바이너리를 받으세요.'}
              </p>
            )}
            {status && status.claudeBin && !status.loggedIn && (
              <>
                <p>
                  Claude 계정 로그인이 필요합니다 (Claude Pro/Max 구독). 아래 버튼을 누르면 터미널 창이
                  열리고 브라우저에서 로그인이 진행됩니다. 완료 후 <b>다시 확인</b>을 눌러주세요.
                </p>
                <div className="onboarding-login-actions">
                  <button className="primary" onClick={() => void openLogin()} disabled={loggingIn}>
                    <Icon name="key" size={14} /> {loggingIn ? '터미널 여는 중…' : '로그인 터미널 열기'}
                  </button>
                  <button onClick={refresh}>다시 확인</button>
                </div>
                {loginErr && <p className="onboarding-err">터미널을 열지 못했습니다: {loginErr}</p>}
                <details className="onboarding-manual">
                  <summary className="dim">터미널 창이 안 열리나요? 직접 실행</summary>
                  <p className="dim">명령 프롬프트/터미널에서 아래를 실행하세요:</p>
                  <pre className="onboarding-cmd">claude auth login</pre>
                  <p className="dim">
                    <code>claude</code> 명령이 없다면 (앱 밖에서 쓰려면) 먼저 설치:
                  </p>
                  <pre className="onboarding-cmd">npm install -g @anthropic-ai/claude-code</pre>
                </details>
                <div className="onboarding-apikey">
                  <span className="dim">또는 API 키로 연결 (구독 없이 사용):</span>
                  <div className="onboarding-apikey-row">
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) void saveApiKey()
                      }}
                      placeholder="sk-ant-…"
                    />
                    <button onClick={() => void saveApiKey()} disabled={!apiKey.trim()}>
                      저장
                    </button>
                  </div>
                  <p className="dim">console.anthropic.com에서 발급. 저장하면 즉시 연결됩니다.</p>
                </div>
              </>
            )}
            {status?.loggedIn && <p className="dim">Claude 계정이 연결되어 있습니다.</p>}

            <h3>2. 프로젝트 폴더 등록 {check(projectCount == null ? undefined : projectCount > 0)}</h3>
            <p className="dim">
              lain이 관리할 코드 폴더를 등록하세요. 등록한 폴더마다 담당 Navi가 붙습니다.
              {projectCount != null && projectCount > 0 && ` (현재 ${projectCount}개 등록됨)`}
            </p>
            <div className="onboarding-login-actions">
              <button onClick={() => void addFolder()}>
                <Icon name="folder" size={14} /> 폴더 추가…
              </button>
              <button onClick={() => void scanNow()}>
                <Icon name="magnifier" size={14} /> 워크스페이스 스캔
              </button>
            </div>

            <h3>3. 호칭</h3>
            <p className="dim">lain이 당신을 부를 호칭입니다. 나중에 채팅으로도 바꿀 수 있어요.</p>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="유저"
              maxLength={20}
            />

            <h3 className="dim">더 해볼 것들 (환경설정에서 언제든지)</h3>
            <ul className="dim">
              <li>어깨너머 감시 — 화면을 보고 레인이 먼저 조언 (기본 꺼짐)</li>
              <li>텔레그램 연동 — 자리를 비워도 폰으로 지휘·결재</li>
              <li>클로드코드 연동 — 레인 밖에서 돌린 claude 세션도 레인이 인지</li>
            </ul>

            <div className="onboarding-actions">
              <button className="primary" onClick={() => void finish()}>
                시작하기 <Icon name="play" size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
