import { describe, it, expect } from 'vitest'

// D12 — 엔진 capability 레지스트리(순수). worker/orchestrator/manager의 엔진 분기 단일 출처.
import { engineCapabilities, engineCapabilityInfo, ENGINE_CAPABILITIES } from '../../src/main/engines'

describe('engineCapabilities — 엔진 능력 조회(순수)', () => {
  it('claude는 모든 능력 true(lain 네이티브)', () => {
    expect(engineCapabilities('claude')).toEqual({
      approvals: true,
      askManager: true,
      autonomous: true,
      lessons: true,
    })
  })

  it('codex는 모든 능력 false(비대화형 exec·샌드박스 방어)', () => {
    expect(engineCapabilities('codex')).toEqual({
      approvals: false,
      askManager: false,
      autonomous: false,
      lessons: false,
    })
  })

  it('미지정(undefined/null)은 claude로 폴백', () => {
    expect(engineCapabilities(undefined)).toEqual(ENGINE_CAPABILITIES.claude)
    expect(engineCapabilities(null)).toEqual(ENGINE_CAPABILITIES.claude)
  })

  it('레지스트리는 TaskEngine 유니언 전부를 덮는다(새 엔진 누락 감지)', () => {
    // 새 엔진을 types.TaskEngine에 추가하고 레지스트리에 안 넣으면 이 키 목록이 어긋난다.
    expect(Object.keys(ENGINE_CAPABILITIES).sort()).toEqual(['claude', 'codex'])
  })

  it('UI가 쓰는 강등 사유도 같은 레지스트리에서 제공한다', () => {
    const codex = engineCapabilityInfo().find((i) => i.engine === 'codex')!
    expect(codex.label).toBe('Codex')
    expect(codex.capabilityNotes.approvals).toContain('승인 큐 없음')
    expect(Object.values(codex.capabilities).every((v) => !v)).toBe(true)
  })
})
