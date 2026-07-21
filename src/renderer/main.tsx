import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// 전역 에러 바운더리 — 렌더 중 예외 1건이 앱 전체를 '빈 화면'으로 만들던 문제 차단.
// render-process-gone 자동 reload는 프로세스 크래시에만 발동하고 JS 렌더 예외엔 안 걸려, 폴백 UI가 필요하다.
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 메인 콘솔(렌더러 devtools)에 남긴다 — 시크릿은 메시지에 섞지 않게 message/stack만.
    console.error('renderer error boundary:', error?.message, info?.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            background: '#0c0a1b',
            color: '#e3def3',
            fontFamily: "'MonoplexKR','Hack',monospace",
            padding: 24,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 14 }}>화면 렌더 중 오류가 발생했어. 데이터는 안전해 — 복구를 눌러 다시 시도해.</div>
          <pre style={{ fontSize: 11, color: '#c4bddc', maxWidth: 600, whiteSpace: 'pre-wrap' }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            onClick={() => {
              this.setState({ error: null })
              location.reload()
            }}
            style={{
              fontFamily: 'inherit',
              fontSize: 12,
              padding: '6px 16px',
              borderRadius: 6,
              border: '1px solid rgba(177,140,240,0.34)',
              background: 'transparent',
              color: '#e7dcff',
              cursor: 'pointer',
            }}
          >
            복구
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// 전역 조용한 실패 관측 — ErrorBoundary는 렌더 중 예외만 잡고, Promise rejection·비동기 예외는 못 잡는다.
// window.lain 호출 다수가 .catch 없이 .then만 달려 있어 실패하면 어디에도 흔적이 없었다(빈 화면·무반응의
// 원인 추적 불가). 최소 조치로 콘솔에 한 줄 남긴다. 폭주 방지: 같은 메시지는 쿨다운 동안 1회, 총량도 상한.
// 시크릿·경로 전문이 섞이지 않게 message만 축약해 남긴다(§9-6).
const SILENT_LOG_COOLDOWN_MS = 10_000
const SILENT_LOG_MAX = 100
const silentLogged = new Map<string, number>()
let silentLogCount = 0
function logSilentFailure(kind: string, message: string) {
  if (silentLogCount >= SILENT_LOG_MAX) return
  const now = Date.now()
  const prev = silentLogged.get(message)
  if (prev != null && now - prev < SILENT_LOG_COOLDOWN_MS) return
  silentLogged.set(message, now)
  silentLogCount++
  console.error(`[renderer] ${kind}: ${message.slice(0, 300)}`)
}

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason as { message?: string } | undefined
  logSilentFailure('unhandledrejection', String(reason?.message || ev.reason))
})
window.addEventListener('error', (ev) => {
  logSilentFailure('error', String(ev.message || (ev.error as Error)?.message || ev.error))
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
