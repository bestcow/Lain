// D12 — Navi 실행 엔진 추상화. TaskEngine('claude'|'codex')마다 능력(capability) 플래그를
// 단일 출처로 모아, worker/orchestrator/manager에 흩어져 있던 `if (engine==='codex')` 하드코딩을
// capability 조회로 대체한다. 제3 엔진 추가 비용 = 레지스트리 엔트리 1개 + start_task enum 1개로 좁힌다.
//
// ⚠ 순수 모듈 — LLM 호출·SDK·codex spawn 없음. run 함수는 여기 두지 않는다(worker/codex 순환 방지):
//   실행 dispatch는 worker.runNavi가 이 capability를 보고 codex 러너로 위임할지 정한다.
import type {
  EngineCapabilityInfo,
  EngineCapability,
  NaviEngineCapabilities,
  TaskEngine,
} from '../shared/types'

// 엔진 능력 — 승인 큐·ask_manager·autonomous·학습/스킬 주입 지원 여부.
// claude는 lain 네이티브라 전부 지원, codex는 비대화형 exec라 전부 미지원(codex.ts:14-16 주석 근거:
// 승인 큐·ask_manager 없음, 학습/스킬 미주입, autonomous의 테스트 보호 게이트가 canUseTool 기반이라 불가).
// 레지스트리 — 새 엔진 추가 시 여기 엔트리 1개 + types.TaskEngine 유니언 + start_task enum만 늘리면 된다.
export const ENGINE_CAPABILITIES: Record<TaskEngine, NaviEngineCapabilities> = {
  claude: { approvals: true, askManager: true, autonomous: true, lessons: true },
  codex: { approvals: false, askManager: false, autonomous: false, lessons: false },
}

export const ENGINE_LABELS: Record<TaskEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

// 지원하지 않는 능력을 숨기지 않고 회색 비활성 + 사유로 보여주기 위한 문구 단일 출처.
export const ENGINE_CAPABILITY_NOTES: Record<
  TaskEngine,
  Partial<Record<EngineCapability, string>>
> = {
  claude: {},
  codex: {
    approvals: '승인 큐 없음 — Codex 샌드박스가 보호',
    askManager: '작업 중 질문 없음 — Codex exec는 비대화형',
    autonomous: '자율 모드 없음 — 테스트 보호 게이트 미지원',
    lessons: '학습·스킬 주입 없음 — Codex exec 독립 실행',
  },
}

/** 엔진 능력 조회(순수) — orchestrator·manager가 capability 기반 분기에 쓴다. 미지정=claude. */
export function engineCapabilities(engine: TaskEngine | undefined | null): NaviEngineCapabilities {
  return ENGINE_CAPABILITIES[engine ?? 'claude'] ?? ENGINE_CAPABILITIES.claude
}

export function engineCapabilityInfo(): EngineCapabilityInfo[] {
  return (Object.keys(ENGINE_CAPABILITIES) as TaskEngine[]).map((engine) => ({
    engine,
    label: ENGINE_LABELS[engine],
    capabilities: { ...ENGINE_CAPABILITIES[engine] },
    capabilityNotes: { ...ENGINE_CAPABILITY_NOTES[engine] },
  }))
}
