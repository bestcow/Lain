// Lain 스킬 할당 — 큐레이션 코딩 플러그인을 plugins로 깨끗 로딩(settingSources 회피·정체성 보존).
// 순수(parse/assemble) + 경로해석(fs). manager/worker/navichat 세 query()가 skillOptions로 동일 조립.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk'

// 설치 실측 확인된 코딩 플러그인만(앱 내장 anthropic-skills pdf/docx는 plugins로 못 줘 제외).
export const CURATED_PLUGIN_NAMES = [
  'superpowers', 'feature-dev', 'commit-commands', 'skill-creator', 'code-review', 'code-simplifier',
] as const

const MARKETPLACE = 'claude-plugins-official'

export type SkillOptions = {
  plugins?: SdkPluginConfig[]
  skills?: string[] | 'all'
  settingSources?: SettingSource[]
}

// 순수 — installed_plugins.json 문자열에서 플러그인 installPath 추출.
export function parseInstalledPlugin(
  manifestJson: string,
  name: string,
  marketplace = MARKETPLACE,
): string | null {
  try {
    const json = JSON.parse(manifestJson)
    const entry = json?.plugins?.[`${name}@${marketplace}`]
    const installPath = Array.isArray(entry) ? entry[0]?.installPath : undefined
    return typeof installPath === 'string' && installPath ? installPath : null
  } catch {
    return null
  }
}

// 순수 — plugins·할당·enabled로 query() 부분옵션 조립.
export function assembleSkillOptions(
  plugins: SdkPluginConfig[],
  assigned: string[] | null,
  enabled: boolean,
): SkillOptions {
  if (!enabled || plugins.length === 0) return {}
  return {
    plugins,
    settingSources: [],
    skills: assigned && assigned.length ? assigned : 'all',
  }
}

export function resolveInstalledPlugin(name: string): string | null {
  try {
    const manifest = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')
    const p = parseInstalledPlugin(fs.readFileSync(manifest, 'utf8'), name)
    return p && fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}

// names 기본 = 큐레이션 코딩셋(CURATED_PLUGIN_NAMES). 사용자가 설정에서 바꾸면 그 목록을 받는다
// (CC-FEATURES P1). store↔skills 순환 import를 피하려 값을 인자로 주입받는다(skills는 순수 유지).
export function curatedPlugins(
  names: readonly string[] = CURATED_PLUGIN_NAMES,
): SdkPluginConfig[] {
  const out: SdkPluginConfig[] = []
  for (const name of names) {
    const p = resolveInstalledPlugin(name)
    if (p) out.push({ type: 'local', path: p, skipMcpDiscovery: true })
  }
  return out
}

export function skillOptions(
  assigned: string[] | null,
  enabled: boolean,
  curatedNames: readonly string[] = CURATED_PLUGIN_NAMES,
): SkillOptions {
  return assembleSkillOptions(curatedPlugins(curatedNames), assigned, enabled)
}
