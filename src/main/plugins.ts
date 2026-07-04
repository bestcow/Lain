// 클로드 플러그인 관리 (CC-FEATURES P1) — 번들 claude CLI 셸아웃.
// 설치는 마켓 git clone + cache 복사 + 등록이라(CC 내부) 재구현 대신 CLI에 위임한다(취약 결합 회피).
// 등록/설치/제거는 사용자 전용(②). "할당"(어떤 플러그인을 lain이 에이전트에 줄지)은 settings.curatedPlugins.
import { execFile } from 'node:child_process'
import { CLAUDE_BIN } from './paths'
import type { PluginInfo } from '../shared/types'

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf('@')
  return at > 0
    ? { name: id.slice(0, at), marketplace: id.slice(at + 1) }
    : { name: id, marketplace: '' }
}

function run(args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          output: (err ? stderr || err.message : stdout || '완료').toString().trim(),
        })
      },
    )
  })
}

// claude plugin list --available --json → { installed, available } 정규화. 실패 시 빈 목록(throw 금지).
export async function listPlugins(): Promise<{ installed: PluginInfo[]; available: PluginInfo[] }> {
  const r = await run(['plugin', 'list', '--available', '--json'], 30_000)
  if (!r.ok) return { installed: [], available: [] }
  let data: any
  try {
    data = JSON.parse(r.output)
  } catch {
    return { installed: [], available: [] }
  }
  const installed: PluginInfo[] = (Array.isArray(data?.installed) ? data.installed : []).map(
    (p: any): PluginInfo => {
      const { name, marketplace } = splitId(String(p.id ?? ''))
      return {
        id: String(p.id ?? ''),
        name,
        marketplace,
        version: p.version ?? null,
        description: null,
        installed: true,
        enabled: !!p.enabled,
        hasMcp: !!(p.mcpServers && Object.keys(p.mcpServers).length),
        installCount: null,
      }
    },
  )
  const installedIds = new Set(installed.map((p) => p.id))
  const available: PluginInfo[] = (Array.isArray(data?.available) ? data.available : [])
    .map((p: any): PluginInfo => {
      const id = String(p.pluginId ?? p.id ?? '')
      const { name, marketplace } = splitId(id)
      return {
        id,
        name: p.name ?? name,
        marketplace: p.marketplaceName ?? marketplace,
        version: null,
        description: p.description ?? null,
        installed: installedIds.has(id),
        enabled: false,
        hasMcp: false,
        installCount: typeof p.installCount === 'number' ? p.installCount : null,
      }
    })
    .filter((p: PluginInfo) => p.id && !p.installed)
  return { installed, available }
}

// 설치 — git clone 포함이라 느릴 수 있어 넉넉한 타임아웃. user 스코프 고정(전역 ~/.claude).
export function installPlugin(id: string): Promise<{ ok: boolean; output: string }> {
  return run(['plugin', 'install', id, '-s', 'user'], 180_000)
}

// 제거 — -y는 prune 확인 스킵(비TTY 필수). user 스코프 고정.
export function uninstallPlugin(id: string): Promise<{ ok: boolean; output: string }> {
  return run(['plugin', 'uninstall', id, '-s', 'user', '-y'], 60_000)
}
