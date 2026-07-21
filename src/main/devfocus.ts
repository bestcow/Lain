// src/main/devfocus.ts — 오버레이 개발 컨텍스트 판정 (L0 순수함수, LLM 0)
// 개발자 전향(2026-07-18): 개발 도구 화면일 때만 감시 — 그 외엔 캡처 자체를 안 한다.
export const DEFAULT_DEV_APPS = [
  'windowsterminal', 'wt', 'conhost', 'powershell', 'pwsh', 'cmd',
  'code', 'cursor', 'webstorm', 'idea64', 'idea', 'rider64', 'devenv',
  'sublime_text', 'notepad++', 'gitkraken', 'fork', 'sourcetree',
]
const BROWSERS = ['chrome', 'msedge', 'firefox', 'whale']
const DEV_TITLE_RE = /(localhost|127\.0\.0\.1|:\d{4}\b|github\.com|github\.io|[:\-]\s*github\b|gitlab|stack ?overflow|mdn|npmjs|developer\.|docs\.|api reference|vercel|supabase)/i

export function isDevForeground(app: string, title: string, extra: string[] = []): boolean {
  const a = (app || '').toLowerCase()
  if (!a) return false
  const allow = [...DEFAULT_DEV_APPS, ...extra.map((e) => e.trim().toLowerCase()).filter(Boolean)]
  if (allow.some((k) => a.includes(k))) return true
  if (BROWSERS.some((b) => a.includes(b))) return DEV_TITLE_RE.test(title || '')
  return false
}

export function parseDevApps(csv: string | undefined): string[] {
  return (csv || '').split(',').map((s) => s.trim()).filter(Boolean)
}
