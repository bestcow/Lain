// 외부 MCP 서버 → SDK mcpServers 레코드 빌더 (CC-FEATURES P1).
// 백본 ③: 등록=사용자 UI, 사용=cascade(Lain·Navi). 각 query 사이트가 { lain, ...mcpServersFor(target) }로 머지한다.
// 시크릿(env/headers)은 여기서 로그하지 않는다(§9-6) — query 옵션으로만 흘러간다.
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { McpServer, McpTarget } from '../shared/types'
import { listMcpServers } from './store'

// 순수 — 한 서버 행을 SDK config로. 필수 필드(command/url)가 비면 null(=주입 제외, 잘못 설정한 서버가 턴을 안 깨게).
function toSdkConfig(s: McpServer): McpServerConfig | null {
  if (s.transport === 'stdio') {
    if (!s.command) return null
    return {
      type: 'stdio',
      command: s.command,
      args: s.args ?? [],
      ...(Object.keys(s.env ?? {}).length ? { env: s.env } : {}),
    }
  }
  if (s.transport === 'sse') {
    if (!s.url) return null
    return {
      type: 'sse',
      url: s.url,
      ...(Object.keys(s.headers ?? {}).length ? { headers: s.headers } : {}),
    }
  }
  if (s.transport === 'http') {
    if (!s.url) return null
    return {
      type: 'http',
      url: s.url,
      ...(Object.keys(s.headers ?? {}).length ? { headers: s.headers } : {}),
    }
  }
  return null
}

// 순수 — enabled + target 일치 서버만 레코드로. 'lain'(내부) 키 충돌은 저장 시 validateMcpName이 이미 차단.
function buildMcpServers(
  servers: McpServer[],
  target: McpTarget,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const s of servers) {
    if (!s.enabled) continue
    if (!s.targets.includes(target)) continue
    const cfg = toSdkConfig(s)
    if (cfg) out[s.name] = cfg
  }
  return out
}

// 결합 — 저장소에서 읽어 해당 레벨용 외부 서버 레코드를 만든다. query 사이트에서 spread로 머지.
export function mcpServersFor(target: McpTarget): Record<string, McpServerConfig> {
  return buildMcpServers(listMcpServers(), target)
}
