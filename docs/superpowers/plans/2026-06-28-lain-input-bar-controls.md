# lain 입력창 컨트롤 바 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 레인 채팅 입력창 밑에 Claude Code식 컨트롤 바(모델·권한·추론·빠른모드·작업방식·동시작업수)를 두어, 환경설정을 열지 않고 레인 동작을 즉시 바꾼다.

**Architecture:** task(Navi)에 이미 있는 권한/추론/빠른모드 자산(`thinkingOption`·bypass 절충·`TaskPermissionMode`)을 레인 채팅(manager)으로 끌어온다. 레인용 설정은 전역 `LainSettings`에 비파괴 추가하고 기존 `settings:get/set` IPC를 재사용한다. plan 모드만 SDK 실측이 필요해 Phase B로 격리한다.

**Tech Stack:** Electron + React + TypeScript, `node:sqlite` 설정 테이블, `@anthropic-ai/claude-agent-sdk` `query()`, vitest.

## Global Constraints

- 설정 추가는 **비파괴 마이그레이션**(기존 `skillsEnabled`·`contextCompactThreshold` 패턴). 컬럼 추가가 아니라 `settings` key-value 테이블 사용.
- `getSettings()`는 매 턴 DB 라이브 — 변경은 재시작 없이 다음 턴 반영.
- bypass는 SDK엔 `acceptEdits`로 주고 **시크릿·테스트 파일 차단(canUseTool)은 유지**(PLAN §9-6). 기존 worker 절충 그대로.
- 모델은 별칭이 아니라 `modelId()` 고정 ID로 SDK에 전달(2026-06-28 `src/shared/models.ts`).
- 검증: 변경마다 `npm run typecheck` 0 + `npx vitest run` 그린. 코드 변경 마무리는 `npm run deploy`(설치본 반영).
- Phase A 완료 시점에 plan 모드 없이도 전부 동작·배포 가능해야 한다.

---

## Phase A — 입력창 바 (확정, 배포 가능)

### Task 1: 레인용 settings 4필드 추가

**Files:**
- Modify: `src/shared/types.ts` (LainSettings 인터페이스, :255 근처)
- Modify: `src/main/store.ts:2205-2259` (getSettings/saveSettings)
- Test: `test/main/store.managersettings.test.ts` (Create)

**Interfaces:**
- Produces: `LainSettings.managerPermissionMode: TaskPermissionMode`, `.managerThinkingLevel: ThinkingLevel`, `.managerFastMode: boolean`, `.defaultTaskMode: 'auto' | 'autonomous' | 'interactive'`

- [ ] **Step 1: Write failing test**

```ts
// test/main/store.managersettings.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { initStore, getSettings, saveSettings } from '../../src/main/store'
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'

describe('레인용 settings 4필드', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-ms-'))
    initStore(dir) // 기존 store 테스트의 init 패턴 따름(실제 시그니처 확인 후 맞춤)
  })
  it('기본값: acceptEdits / default / false / auto', () => {
    const s = getSettings()
    expect(s.managerPermissionMode).toBe('acceptEdits')
    expect(s.managerThinkingLevel).toBe('default')
    expect(s.managerFastMode).toBe(false)
    expect(s.defaultTaskMode).toBe('auto')
  })
  it('저장 후 로드 라운드트립', () => {
    saveSettings({ managerPermissionMode: 'bypass', managerThinkingLevel: 'high', managerFastMode: true, defaultTaskMode: 'interactive' })
    const s = getSettings()
    expect(s.managerPermissionMode).toBe('bypass')
    expect(s.managerThinkingLevel).toBe('high')
    expect(s.managerFastMode).toBe(true)
    expect(s.defaultTaskMode).toBe('interactive')
  })
})
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `npx vitest run test/main/store.managersettings.test.ts`
Expected: FAIL (필드 undefined). initStore 시그니처가 다르면 기존 `test/main/store.*.test.ts`의 init 패턴에 맞춰 수정.

- [ ] **Step 3: types.ts에 필드 추가**

`src/shared/types.ts` LainSettings(:255 근처, naviModel 옆)에 추가:
```ts
  managerPermissionMode: TaskPermissionMode // 레인 채팅 권한 모드(입력창 바)
  managerThinkingLevel: ThinkingLevel       // 레인 추론 강도
  managerFastMode: boolean                  // 레인 빠른 모드
  defaultTaskMode: 'auto' | 'autonomous' | 'interactive' // 작업 위임 기본(auto=현 자동판정)
```

- [ ] **Step 4: store.ts getSettings/saveSettings 배선**

`getSettings()`(:2206 반환 객체)에 추가 — 기존 `asTier`/플래그 패턴 복제:
```ts
    managerPermissionMode: (['default','acceptEdits','plan','bypass'] as const).includes(
      getSetting('manager_permission_mode') as never) ? getSetting('manager_permission_mode') as never : 'acceptEdits',
    managerThinkingLevel: (['default','off','auto','high'] as const).includes(
      getSetting('manager_thinking_level') as never) ? getSetting('manager_thinking_level') as never : 'default',
    managerFastMode: (getSetting('manager_fast_mode') ?? '0') === '1',
    defaultTaskMode: (['auto','autonomous','interactive'] as const).includes(
      getSetting('default_task_mode') as never) ? getSetting('default_task_mode') as never : 'auto',
```
`saveSettings()`(:2253 근처)에 추가:
```ts
  if (patch.managerPermissionMode !== undefined) setSetting('manager_permission_mode', patch.managerPermissionMode)
  if (patch.managerThinkingLevel !== undefined) setSetting('manager_thinking_level', patch.managerThinkingLevel)
  if (patch.managerFastMode !== undefined) setSetting('manager_fast_mode', patch.managerFastMode ? '1' : '0')
  if (patch.defaultTaskMode !== undefined) setSetting('default_task_mode', patch.defaultTaskMode)
```

- [ ] **Step 5: Run test, verify PASS**

Run: `npx vitest run test/main/store.managersettings.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/store.ts test/main/store.managersettings.test.ts
git commit -m "feat(settings): 레인용 권한/추론/빠른모드/작업방식 4필드"
```

---

### Task 2: thinkingOption 공용화 + TaskPermissionMode에 'plan' 추가

**Files:**
- Create: `src/main/agentopts.ts`
- Modify: `src/main/worker.ts:40-51` (thinkingOption 이동, import로 교체)
- Modify: `src/shared/types.ts:65` (TaskPermissionMode)
- Test: `test/main/agentopts.test.ts` (Create)

**Interfaces:**
- Produces: `thinkingOption(level: ThinkingLevel): { thinking?: ThinkingConfig }` (이동), `TaskPermissionMode` 에 `'plan'` 추가 → `'default'|'acceptEdits'|'plan'|'bypass'`

- [ ] **Step 1: Write failing test**

```ts
// test/main/agentopts.test.ts
import { describe, it, expect } from 'vitest'
import { thinkingOption } from '../../src/main/agentopts'

describe('thinkingOption', () => {
  it('off → disabled, auto → adaptive, high → enabled(24000), default → {}', () => {
    expect(thinkingOption('off')).toEqual({ thinking: { type: 'disabled' } })
    expect(thinkingOption('auto')).toEqual({ thinking: { type: 'adaptive' } })
    expect(thinkingOption('high')).toEqual({ thinking: { type: 'enabled', budgetTokens: 24000 } })
    expect(thinkingOption('default')).toEqual({})
  })
})
```

- [ ] **Step 2: Run, verify FAIL** (`agentopts` 없음)

- [ ] **Step 3: agentopts.ts 생성** — worker.ts:40-51의 `thinkingOption` 본문을 그대로 옮긴다(ThinkingConfig·ThinkingLevel import 포함). worker.ts는 로컬 정의 삭제 후 `import { thinkingOption } from './agentopts'`.

- [ ] **Step 4: types.ts TaskPermissionMode 확장**

`src/shared/types.ts:65`:
```ts
export type TaskPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'
```
store.ts:1397 rowToTask 화이트리스트에 `'plan'` 포함되게 확인(`(['default','acceptEdits','plan','bypass'] as const)`).

- [ ] **Step 5: Run all, verify PASS** — `npx vitest run` (worker 기존 테스트 회귀 0) + `npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/main/agentopts.ts src/main/worker.ts src/shared/types.ts
git commit -m "refactor(agentopts): thinkingOption 공용화 + TaskPermissionMode plan 추가"
```

---

### Task 3: 레인 query 옵션 조립 헬퍼 + manager 배선 (권한 3단·thinking·fast)

**Files:**
- Modify: `src/main/agentopts.ts` (managerAgentOptions 추가)
- Modify: `src/main/manager.ts:985-996` (옵션 스프레드)
- Test: `test/main/agentopts.test.ts` (확장)

**Interfaces:**
- Consumes: `thinkingOption` (Task 2)
- Produces: `managerAgentOptions(s: Pick<LainSettings,'managerPermissionMode'|'managerThinkingLevel'|'managerFastMode'>): { permissionMode: PermissionMode } & { thinking?: ThinkingConfig } & { settings?: { fastMode: true } }`
  - 권한 매핑: `bypass` → SDK `acceptEdits`; `plan`은 **Phase B 전까지 `acceptEdits`로 폴백**(가짜 plan 방지); 그 외 그대로.

- [ ] **Step 1: Write failing test**

```ts
import { managerAgentOptions } from '../../src/main/agentopts'

describe('managerAgentOptions', () => {
  it('bypass·plan은 SDK acceptEdits로(Phase B 전), thinking/fast 반영', () => {
    const o = managerAgentOptions({ managerPermissionMode: 'bypass', managerThinkingLevel: 'high', managerFastMode: true })
    expect(o.permissionMode).toBe('acceptEdits')
    expect(o.thinking).toEqual({ type: 'enabled', budgetTokens: 24000 })
    expect(o.settings).toEqual({ fastMode: true })
  })
  it('default 권한·thinking default·fast off → 최소 옵션', () => {
    const o = managerAgentOptions({ managerPermissionMode: 'default', managerThinkingLevel: 'default', managerFastMode: false })
    expect(o.permissionMode).toBe('default')
    expect(o.thinking).toBeUndefined()
    expect(o.settings).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: agentopts.ts에 구현**

```ts
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { LainSettings } from '../shared/types'

export function managerAgentOptions(
  s: Pick<LainSettings, 'managerPermissionMode' | 'managerThinkingLevel' | 'managerFastMode'>,
) {
  // plan은 Phase B에서 실측 후 'plan' 직결로 교체. 그 전엔 가짜 방지 위해 acceptEdits 폴백.
  const permissionMode: PermissionMode =
    s.managerPermissionMode === 'bypass' || s.managerPermissionMode === 'plan' ? 'acceptEdits'
    : s.managerPermissionMode
  return {
    permissionMode,
    ...thinkingOption(s.managerThinkingLevel),
    ...(s.managerFastMode ? { settings: { fastMode: true as const } } : {}),
  }
}
```

- [ ] **Step 4: manager.ts 배선** — `manager.ts:990` `permissionMode: 'acceptEdits',` 줄을 제거하고, 옵션 객체에 스프레드 추가(:992 skillOptions 옆):
```ts
        ...managerAgentOptions(getSettings()),
```
import 추가: `import { managerAgentOptions } from './agentopts'`. (model·skillOptions는 그대로.)

- [ ] **Step 5: Run, verify PASS** + `npm run typecheck`

- [ ] **Step 6: Commit**
```bash
git add src/main/agentopts.ts src/main/manager.ts test/main/agentopts.test.ts
git commit -m "feat(manager): 레인 채팅에 권한/추론/빠른모드 적용(plan은 폴백)"
```

---

### Task 4: 작업 방식 기본값(defaultTaskMode) 배선

**Files:**
- Modify: `src/main/orchestrator.ts:136-152` (decideMode)
- Test: `test/main/orchestrator.test.ts` (확장 — 기존 파일)

**Interfaces:**
- Consumes: `getSettings().defaultTaskMode` (Task 1)
- 동작: `defaultTaskMode==='interactive'` → 항상 interactive. `'autonomous'` → autoGradable·verifyCmd 충족 시 autonomous, 아니면 기존 거부 경로. `'auto'`(기본) → 현행 `decideMode` 자동판정 그대로.

- [ ] **Step 1: Write failing test** — `decideMode`가 export면 직접, 아니면 startTask 경유. 기존 orchestrator.test.ts의 mock 패턴 따름:

```ts
it('defaultTaskMode=interactive면 autoGradable여도 interactive', () => {
  // getSettings stub: defaultTaskMode='interactive'
  // project.verifyCmd 있음, autoGradable=true 입력
  // 기대: 결과 mode === 'interactive'
})
```
(정확한 stub는 기존 orchestrator.test.ts 헬퍼 재사용.)

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: decideMode 수정** — `decideMode`(:136) 진입에 분기 추가:
```ts
  const pref = getSettings().defaultTaskMode
  if (pref === 'interactive') return { mode: 'interactive', reason: '사용자 기본값: interactive' }
  // pref === 'autonomous' 는 아래 auto 판정과 동일 게이트(autoGradable && verifyCmd) 통과 시만 autonomous
  // 'auto' 는 기존 자동판정 그대로
```
(autonomous 강제도 verifyCmd 없으면 거부 — `orchestrator.ts:209` 가드 유지.)

- [ ] **Step 4: Run, verify PASS** + typecheck

- [ ] **Step 5: Commit**
```bash
git commit -am "feat(orchestrator): 작업 위임 기본값(defaultTaskMode) 반영"
```

---

### Task 5: 입력창 컨트롤 바 UI + 동시작업수

**Files:**
- Create: `src/renderer/components/InputModeBar.tsx`
- Modify: `src/renderer/App.tsx:1765-1875` (footer 아래 바 삽입)
- Modify: `src/renderer/styles.css` (.input-modebar)
- Test: 수동(렌더). 순수 매핑 없음.

**Interfaces:**
- Consumes: `window.lain.getSettings/setSettings`, `MODEL_IDS`/`modelId` (`src/shared/models.ts`), `MODEL_TIERS`
- Props: `InputModeBar({ settings: LainSettings, onPatch: (p: Partial<LainSettings>) => void })`

- [ ] **Step 1: InputModeBar.tsx 작성** — TaskDrawer 셀렉트 패턴 재사용. 좌측 권한 / 우측 모델·빠른·추론·작업방식·동시수. 권한 옵션은 Phase A에서 `요청/편집수락/건너뛰기` 3단(plan은 Task 9에서 추가):

```tsx
import type { LainSettings, TaskPermissionMode, ThinkingLevel } from '../../shared/types'
import { MODEL_TIERS, MODEL_IDS } from '../../shared/models'

const PERM_LABEL: Record<string,string> = { default:'요청', acceptEdits:'편집 수락', bypass:'건너뛰기' }
const THINK_LABEL: Record<ThinkingLevel,string> = { default:'추론 기본', off:'추론 끔', auto:'추론 자동', high:'추론 높음' }

export function InputModeBar({ settings, onPatch }: { settings: LainSettings; onPatch: (p: Partial<LainSettings>) => void }) {
  return (
    <div className="input-modebar">
      <div className="imb-left">
        <select value={settings.managerPermissionMode === 'plan' ? 'acceptEdits' : settings.managerPermissionMode}
          onChange={(e) => onPatch({ managerPermissionMode: e.target.value as TaskPermissionMode })}>
          {(['default','acceptEdits','bypass'] as const).map((m) => <option key={m} value={m}>{PERM_LABEL[m]}</option>)}
        </select>
      </div>
      <div className="imb-right">
        <select value={settings.managerModel} onChange={(e) => onPatch({ managerModel: e.target.value as never })}>
          {MODEL_TIERS.map((t) => <option key={t} value={t}>{t} — {MODEL_IDS[t]}</option>)}
        </select>
        <button className={settings.managerFastMode ? 'imb-on' : ''} onClick={() => onPatch({ managerFastMode: !settings.managerFastMode })}>⚡</button>
        <select value={settings.managerThinkingLevel} onChange={(e) => onPatch({ managerThinkingLevel: e.target.value as ThinkingLevel })}>
          {(['default','off','auto','high'] as const).map((l) => <option key={l} value={l}>{THINK_LABEL[l]}</option>)}
        </select>
        <select value={settings.defaultTaskMode} onChange={(e) => onPatch({ defaultTaskMode: e.target.value as never })}>
          <option value="auto">작업: 자동판정</option><option value="autonomous">작업: 자동</option><option value="interactive">작업: 대화형</option>
        </select>
        <select value={String(settings.concurrencyCap)} onChange={(e) => onPatch({ concurrencyCap: Number(e.target.value) })}>
          {[1,2,3,4,5,6,7,8].map((n) => <option key={n} value={n}>동시 {n}</option>)}
        </select>
        <span className="imb-orb" title="사용량(곧)" />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: App.tsx 배선** — footer `input-row`(:1765) **앞**(위)에 삽입. App에 settings state가 없으면 `getSettings()` 로드 + `setSettings` patch 헬퍼 추가(PrefsModal:432-445 패턴 동일). 레인(manager) 타깃일 때만 렌더:
```tsx
{chatIsManager && settings && <InputModeBar settings={settings} onPatch={(p) => { window.lain.setSettings(p).then(setSettings) }} />}
```

- [ ] **Step 3: styles.css** — `.input-modebar`(flex, space-between, 작은 글씨), `.imb-left/.imb-right`(flex gap), `.imb-on`(강조색), `.imb-orb`(원형 ○). 기존 CRT 그린 변수 사용.

- [ ] **Step 4: 빌드 확인** — `npm run typecheck` 0 + `npm run build` 0. 렌더는 deploy 후 수동.

- [ ] **Step 5: Commit**
```bash
git add src/renderer/components/InputModeBar.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(ui): 레인 입력창 컨트롤 바(모델·권한·추론·빠른·작업방식·동시수)"
```

---

### Task 6: Phase A 검증 + 배포

- [ ] **Step 1:** `npm run typecheck` → 0
- [ ] **Step 2:** `npx vitest run` → 그린(신규 테스트 포함)
- [ ] **Step 3:** worktree → 메인 체크아웃 main에 ff 병합
- [ ] **Step 4:** 메인 체크아웃에서 `npm run deploy` → 설치본 반영·재시작
- [ ] **Step 5: 라이브 수동 검증** — 입력창 바 노출·각 컨트롤 변경→레인 다음 턴 반영(권한 default 승인 흐름·thinking·fast·작업방식·동시수). 권한 `건너뛰기`에서도 시크릿 파일 접근 차단 유지 확인.

---

## Phase B — plan 모드 (SDK 실측 의존, 격리)

### Task 7: plan 모드 SDK 동작 스파이크

**Files:**
- Create: `src/main/index.ts`에 dev 훅 `LAIN_PLAN_SPIKE`(env-gated, 격리 DATA_DIR) — 기존 `LAIN_*_TEST` 훅 패턴.
- Create: 결과 문서 `docs/superpowers/specs/2026-06-28-plan-mode-findings.md`

- [ ] **Step 1:** 레인 query를 `permissionMode: 'plan'`로 1턴 구동(파일 수정 요청 프롬프트)하고 스트림 메시지를 전부 로그(`plan-spike.log`).
- [ ] **Step 2:** 관찰 기록: plan 모드에서 (a) 도구 실행이 보류되는가 (b) 계획이 어떤 메시지/도구(ExitPlanMode 등)로 오는가 (c) "수락→실행"으로 잇는 SDK 수단(permissionMode 변경 후 resume? 특정 응답?).
- [ ] **Step 3:** findings 문서에 확정 경로 + Task 8 배선 방법을 적는다. **이 task의 산출물이 Task 8의 입력이다.**

> ⚠️ 스파이크라 TDD 비적용. 결과에 따라 Task 8 코드가 정해진다. plan이 레인 채팅에 부적합으로 판명되면(예: 인라인 승인 흐름 부재) Task 8을 "plan 옵션 비활성+사유 표기"로 축소하고 사용자에게 보고.

### Task 8: plan 모드 배선 + UI 4번째 옵션

**Files:** `src/main/agentopts.ts`, `src/renderer/components/InputModeBar.tsx`, plan 표시/수락 UI(스파이크 결과 위치)

**Interfaces:**
- Consumes: Task 7 findings, `managerAgentOptions`(Task 3)

- [ ] **Step 1:** findings의 확정 경로대로 `managerAgentOptions`의 plan 폴백(`'plan' → 'acceptEdits'`)을 제거하고 `'plan'` 직결 + 수락 흐름 배선. (가장 유력: SDK `permissionMode:'plan'` 직결 → 계획 메시지 수신 시 레인 채팅에 카드로 표시 → 사용자 "실행" 시 같은 세션을 `acceptEdits`로 resume. **단 Task 7 실측이 우선.**)
- [ ] **Step 2:** InputModeBar 권한 셀렉트에 `plan: '계획'` 추가, `settings.managerPermissionMode==='plan'` 폴백 표시 제거.
- [ ] **Step 3:** dev 훅으로 plan→계획표시→수락→실행 라이브 확인.
- [ ] **Step 4:** typecheck + vitest + 병합 + deploy.
- [ ] **Step 5: Commit**
```bash
git commit -am "feat(manager): plan 모드 — 계획 제시 후 수락 시 실행"
```

---

## Self-Review 결과

- **Spec 커버리지**: 컨트롤 6종 모두 task 매핑(모델=Task5 UI+기존, 권한=Task3+9, 빠른/추론=Task3, 작업방식=Task4, 동시수=Task5). 사용량 팝업=스펙 슬라이스2(이 계획 범위 밖, 명시).
- **Placeholder**: plan 배선(Task 8)만 실측 의존 — 의도적 격리이며 Task 7 산출물을 입력으로 명시. 나머지는 구체 코드.
- **타입 일관성**: `TaskPermissionMode`('plan' 포함)·`ThinkingLevel`·`managerAgentOptions` 시그니처가 Task 간 일치.
- **미해결**: Task 1 `initStore` 시그니처는 기존 store 테스트 패턴에 맞춰 실행 시 확정(테스트 헬퍼 재사용).
