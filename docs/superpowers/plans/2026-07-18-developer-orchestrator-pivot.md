# 개발자 오케스트레이터 전향 (P1~P6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** lain을 개발자 전용 오케스트레이터로 전향 — 컨셉 문서 개정, 비개발 기능 다이어트(플래너 제거·음성입력 숨김), UI 관제실화, 오버레이 개발 재조준, CC 관제탑(C1~C4), 루프 엔지니어링(L2→L1→L5→L6→L3→L4).

**Architecture:** Electron main(L0 결정론)/renderer(React)/preload 3계층. 판단은 LLM(judge 패턴: `allowedTools:[]`+60s abort+```json 파싱), 배관·집계·상태 전이는 L0. IPC 추가 시 ipc.ts+preload/index.ts+shared/types.ts 3곳 동기화.

**Tech Stack:** Electron + electron-vite, React, node:sqlite, Claude Agent SDK(`query()`), vitest.

**Spec:** [docs/superpowers/specs/2026-07-18-developer-orchestrator-pivot-design.md](../specs/2026-07-18-developer-orchestrator-pivot-design.md)

## Global Constraints

- 레포 루트 = 이 작업용 워크트리. 모든 경로는 레포 루트 기준 상대경로.
- 검증 명령: `npm run typecheck`(타입 0 에러), `npx vitest run`(전체), `npx vitest run <파일>`(단건). 태스크마다 끝에 둘 다 그린 확인.
- L0(main 배관)에 LLM 호출 금지 — judge 호출은 명시된 지점만. judge 패턴은 `judgeQueryOptions()`(src/main/agentopts.ts:58) + `allowedTools:[]` + `maxTurns:2` + 60s AbortController + try 밖 텍스트 누적 + ```json 파싱 (기존 예: orchestrator.ts `elicit` :119).
- 사용자 대면 한국어에서 '교훈' 금지 — '학습' 사용. UI 문구는 존댓말 톤 유지.
- IPC 채널 추가/제거 시 세 곳 동기화: `src/main/ipc.ts` + `src/preload/index.ts` + `src/shared/types.ts`(LainApi).
- 시크릿·API 키를 로그/다이제스트에 남기지 않는다.
- 커밋은 태스크당 1회, push 금지(사용자 명시 요청 시에만).
- DB는 하위호환: 테이블/컬럼 추가는 `try{db.exec(...)}catch{}` 마이그레이션 패턴(store.ts:326 `ALTER TABLE task_events ADD COLUMN speaker` 참조). 제거되는 기능의 기존 테이블·설정키는 DROP/DELETE 하지 않는다(읽지 않으면 무해 — 실측 확인됨).
- 각 Phase 마감: 변경 요약을 한 줄로 기록한다. 배포(`npm run deploy`)는 **메인 체크아웃의 main에 병합 후**에만(비자손 배포 가드) — 병합·배포는 사용자 확인 후 실행.

---

## Phase P1 — 컨셉 재정립

### Task 1: PLAN.md·CLAUDE.md·HANDOFF.md 컨셉 개정

**Files:**
- Modify: `PLAN.md` (§1 목적, §2 비목표)
- Modify: `CLAUDE.md` (첫 소개 문단)
- Modify: `HANDOFF.md` (디스코드 음성 동결 표기)

**Interfaces:**
- Produces: 한 줄 정의 문구 — 이후 모든 태스크의 컨셉 게이트. 코드 무관(문서만).

- [ ] **Step 1: PLAN.md §1 첫머리에 한 줄 정의 추가**

PLAN.md §1(`## 1. 목적과 문제`) 본문 맨 앞에 다음 문단 삽입:

```markdown
> **한 줄 정의 (2026-07-18 전향)**: lain은 **여러 레포를 가진 개발자의 로컬 AI 오케스트레이터** — Claude Code 작업을 지휘·검증·병합하는 관제탑이다. 얼굴은 레인(페르소나 유지), 본질은 개발 도구다.
```

- [ ] **Step 2: PLAN.md §2 비목표에 항목 추가**

`### 비목표 (이 프로그램이 하지 않는 것)` 목록 끝에 추가:

```markdown
- **일반 비서·컴패니언 기능** (2026-07-18 확정): 캘린더·리마인드 등 일정관리, 범용 화면 감시, 음성 대화 입력, 캐릭터 중심 UI 확장은 만들지 않는다. 페르소나는 인터페이스이지 제품이 아니다. 신규 기능 제안은 "개발자 오케스트레이션에 기여하는가"를 게이트로 판정한다.
```

- [ ] **Step 3: CLAUDE.md 소개 문단 교체**

CLAUDE.md 상단
`여러 프로젝트에 Claude Code Navi를 붙여 관리자 Claude가 지휘하는 로컬 오케스트레이터.` 를 다음으로 교체:

```markdown
여러 레포를 가진 개발자의 로컬 AI 오케스트레이터 — Claude Code 작업을 지휘·검증·병합하는 관제탑(얼굴은 레인). 일정관리·음성대화·범용 감시 같은 컴패니언 기능은 비목표(PLAN.md §2).
```

- [ ] **Step 4: HANDOFF.md 디스코드 동결 표기**

HANDOFF.md의 "다음 후보" 목록들에서 `디스코드 음성 T6~T10(자격증명 대기)` 표기를 `디스코드 음성 T6~T10(**동결** — 2026-07-18 개발자 전향으로 신규 개발 안 함, 코드 유지)` 로 바꾼다(등장하는 곳 전부, `Grep "디스코드 음성 T6"` 로 확인). 같은 방식으로 "레인 3D 캐릭터"·"Rive 캐릭터" 항목에 `(**보류** — 2026-07-18 전향, 문서만 유지)` 를 덧붙인다.

- [ ] **Step 5: Commit**

```bash
git add PLAN.md CLAUDE.md HANDOFF.md
git commit -m "docs(concept): 개발자 오케스트레이터 전향 — 한 줄 정의·비목표 게이트·동결 표기 (P1)"
```

---

## Phase P2 — 다이어트

### Task 2: 플래너 완전 제거

**Files:**
- Delete: `src/main/planner.ts`, `src/shared/planmath.ts`, `src/renderer/components/PlannerPanel.tsx`, `test/main/planner.test.ts`, `test/main/planstore.test.ts`, `test/shared/planmath.test.ts`
- Modify: `src/main/index.ts`, `src/main/ipc.ts`, `src/main/manager.ts`, `src/main/store.ts`, `src/main/telegram.ts`, `src/main/quips.ts`, `src/preload/index.ts`, `src/shared/types.ts`, `src/shared/activity.ts`, `src/renderer/App.tsx`, `src/renderer/components/PrefsModal.tsx`, `src/renderer/styles.css`, `test/shared/activity.test.ts`, `test/main/shutdown.test.ts`, `test/main/quips.test.ts`

**Interfaces:**
- Consumes: 없음 (제거 태스크)
- Produces: 플래너 심볼 0 상태의 코드베이스. DB 테이블 `plan_items`/`plan_tags`/`plan_sections`와 설정키 `planner_*`는 DB에 잔존하되 코드가 읽지 않음(무해 — 실측 확인). **단독 커밋**(스펙 §8: revert 용이).

주의: `test/main/questionbus.test.ts`의 "plan" 매치는 Claude plan mode(EnterPlanMode) 관련 — 건드리지 않는다.

- [ ] **Step 1: 테스트부터 제거/수정 (RED 방지)**

```bash
git rm test/main/planner.test.ts test/main/planstore.test.ts test/shared/planmath.test.ts
```

`test/shared/activity.test.ts`: `plan_manage`/`plan_view`/`plan_tag_manage`/`plan_section_manage` 라벨 케이스 삭제.
`test/main/shutdown.test.ts`: 셧다운 맵 기대값에서 `planner` 항목 삭제.
`test/main/quips.test.ts`: `busy_week` 트리거 참조 케이스 삭제.

- [ ] **Step 2: 렌더러 제거**

- `git rm src/renderer/components/PlannerPanel.tsx`
- `src/renderer/App.tsx`: import(:45) · `plannerOpen` state(:239) · Esc 닫기(:1334) · 의존성 배열(:1378) · 커맨드팔레트 `act:planner`(:1863) · 슬래시 `/plan`(:1916-1917) · 📅 메뉴 버튼(:2409-2417) · `{plannerOpen && <PlannerPanel/>}`(:3251) 전부 삭제.
- `src/renderer/components/PrefsModal.tsx`: nav 탭 `{ id: 'planner', label: '플래너' }`(:29) · 검색 힌트 16줄(:81-97) · 플래너 설정 섹션(:1070-1238) 삭제.
- `src/renderer/styles.css`: `.planner-*` 셀렉터 블록 전부 삭제(2684행 인근부터, `Grep "planner" styles.css` 로 전수 확인).

- [ ] **Step 3: preload + types 제거**

- `src/preload/index.ts:93-101`: `plannerList`~`onPlannerUpdated` 9개 삭제.
- `src/shared/types.ts`: `PlanItem`/`PlanTag`/`PlanSection`/`PlanItemInput`(:155-180) · `LainSettings` 플래너 16필드(:363-378) · `LainApi` 플래너 9메서드(:664-672) 삭제.

- [ ] **Step 4: main 제거**

- `src/main/ipc.ts`: `refreshPlanner` hooks 배선(:349) · `planner:list`~`planner:deleteSection` 핸들러와 `busy_week` quip 로직(:990-1035) 삭제.
- `src/main/manager.ts`: plan store import(:73-82) · `plannerDigestLine` import(:85) · SYSTEM_PROMPT 플래너 규칙 2줄(:149-150) · buildDigest의 `plannerInBriefing` 게이트+호출(:275-276) · hooks 타입/기본값 `refreshPlanner`(:444-445, :453) · `resolvePlanTagId`/`resolvePlanSectionId`(:462-470) · 도구 4종 `plan_manage`/`plan_view`/`plan_tag_manage`/`plan_section_manage`(:868-1019) 삭제.
- `src/main/telegram.ts`: plan import(:25-28, :54, :55) · 리마인드 콜백 `p<id>d`/`p<id>s`(:651-662) · 도움말 `/plan` 줄(:1021) · `case '/plan'`(:1074-1075) · `planText()`(:1196-1217+) · 봇 커맨드 등록(:1395) · `onPlanReminder` 핸들러(:1422-1429) · 해제(:1512) 삭제.
- `src/main/index.ts`: import(:45) · 셧다운 맵 `planner`(:107) · `bootStep('planner', ...)`(:400) 삭제.
- `src/main/store.ts`: 타입 import(:34-37) · `CREATE TABLE plan_*` 3개(:231-266) · 플래너 함수 전부(:2720-2914 — `rowToPlanItem`~`deletePlanSection`) · getSettings 플래너 16키 읽기(:3225-3254) · setSettings 16키 쓰기(:3395-3447) 삭제.
- `src/main/quips.ts`: `busy_week` QuipDef(:92 인근) 삭제.
- `src/shared/activity.ts`: `plan_manage`/`plan_view`/`plan_tag_manage`/`plan_section_manage` 매핑(:35-38) 삭제.
- `git rm src/main/planner.ts src/shared/planmath.ts`

- [ ] **Step 5: 잔존 심볼 0 확인**

```bash
# 셋 다 히트 0이어야 함 (questionbus의 EnterPlanMode/ExitPlanMode 제외)
rg -i "plannerP|plannerL|plannerS|plannerD|plannerU|plannerT|plannerN|plannerR|plannerW|plannerI|plannerO" src test
rg "plan_manage|plan_view|plan_tag_manage|plan_section_manage|planmath|PlanItem|PlanTag|PlanSection|onPlanReminder|plannerDigestLine|busy_week" src test
rg "planner:" src
```

- [ ] **Step 6: typecheck + 전체 테스트**

Run: `npm run typecheck` → 에러 0. `npx vitest run` → 전체 그린(플래너 테스트 제거분만큼 총수 감소).

- [ ] **Step 7: Commit (단독 커밋 — revert 단위)**

```bash
git add -A
git commit -m "refactor(diet): 플래너 기능 전체 제거 — 개발자 오케스트레이터 전향 P2 (DB 테이블·설정키는 잔존 무해)"
```

### Task 3: PC 음성입력(마이크 PTT) 숨김 — 설정 `pcVoiceIn` 기본 off

**Files:**
- Modify: `src/shared/types.ts`, `src/main/store.ts`, `src/renderer/App.tsx`, `src/renderer/components/PrefsModal.tsx`
- Test: `test/main/pcvoicein.test.ts` (신규)

**Interfaces:**
- Produces: `LainSettings.pcVoiceIn: boolean` (DB 키 `pc_voice_in`, 기본 `false`). 렌더러 mic-btn은 `settings?.pcVoiceIn` 일 때만 렌더.
- 주의: `pcVoiceOut`(🔊 답변 음성, App.tsx:3168-3189)은 별개 기능 — 건드리지 않는다. STT 배관(`voice:stt` ipc.ts:751-773, `stt-filter.ts`, App.tsx `startRec`/`stopRec` :1435-1493)은 전부 보존(휴면).

- [ ] **Step 1: 실패하는 테스트 작성**

`test/main/pcvoicein.test.ts` (기존 store 기반 테스트 셋업 패턴은 `test/main/retract.test.ts` 참조 — 임시 DATA_DIR로 store 열기):

```ts
import { describe, it, expect } from 'vitest'
// retract.test.ts와 동일한 store 부트스트랩 헬퍼 사용
import { getSettings, setSettings } from '../../src/main/store'

describe('pcVoiceIn 설정', () => {
  it('기본값은 false (마이크 숨김)', () => {
    expect(getSettings().pcVoiceIn).toBe(false)
  })
  it('켜고 끄기가 영속된다', () => {
    setSettings({ pcVoiceIn: true })
    expect(getSettings().pcVoiceIn).toBe(true)
    setSettings({ pcVoiceIn: false })
    expect(getSettings().pcVoiceIn).toBe(false)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/pcvoicein.test.ts`
Expected: FAIL — `pcVoiceIn` 프로퍼티 없음(타입/런타임).

- [ ] **Step 3: 구현**

- `src/shared/types.ts` LainSettings의 `pcVoiceOut` 필드(:414 인근) 옆에 `pcVoiceIn: boolean` 추가.
- `src/main/store.ts` getSettings의 `pc_voice_out` 읽기(:3300 인근) 옆에 `pcVoiceIn: getSetting('pc_voice_in') === '1'` 추가, setSettings 쓰기(:3516 인근)에 `if (s.pcVoiceIn !== undefined) setSetting('pc_voice_in', s.pcVoiceIn ? '1' : '0')` 동형 추가.
- `src/renderer/App.tsx:3154` mic-btn을 `{settings?.pcVoiceIn && (<button className="mic-btn" ...>...</button>)}` 로 감싼다 (:3152의 `chatTarget==='manager'` 통짜 조건은 그대로 — 🔊 버튼 보존).
- `src/renderer/components/PrefsModal.tsx` 음성 카테고리에 체크박스 추가(기존 체크박스 마크업 관례 따름): 라벨 `음성 입력(마이크 PTT) 표시`, `patch({ pcVoiceIn: e.target.checked })`.

- [ ] **Step 4: 통과 확인 + 전체 검증**

Run: `npx vitest run test/main/pcvoicein.test.ts` → PASS. `npm run typecheck` → 0. `npx vitest run` → 그린.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(diet): PC 음성입력(마이크 PTT) 설정 뒤로 숨김 — pcVoiceIn 기본 off, STT 배관 보존 (P2)"
```

**Phase P2 마감**: 변경 요약 한 줄 — `- 다이어트: 플래너 제거·PC 음성입력 숨김 (개발자 전향 P2)` 을 커밋에 포함. (병합·배포는 P3 이후 묶어서 사용자 확인 후.)

---

## Phase P3 — UI 관제실

### Task 4: 캐릭터 컴팩트화 — 평소 축소, 발화·작업 시 부각

**Files:**
- Modify: `src/renderer/App.tsx:2617-2621`, `src/renderer/styles.css:614-648`
- Test: 자동검증 불가(시각) — typecheck+빌드+기존 테스트 그린으로 대체, 라이브 확인은 Phase 마감 목록에.

**Interfaces:**
- Consumes: `quip:show` 구독은 `window.lain.onQuip` (LainBubble.tsx:10과 동일 API).
- Produces: `.lain-char--active` CSS 클래스 (발화/busy 시 부각). 레이아웃 계약: `.lain-char` min-height 288px→148px.

- [ ] **Step 1: App.tsx — 부각 상태 추가**

`App.tsx`의 lain-char 렌더(:2617-2621)를 다음 구조로 교체하고, 컴포넌트 상단에 상태를 추가:

```tsx
// 상태 (기존 useState 블록 옆)
const [charActive, setCharActive] = useState(false)
const charActiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

// 구독 (기존 window.lain.on* useEffect 블록 옆)
useEffect(() => {
  const off = window.lain.onQuip(() => {
    setCharActive(true)
    if (charActiveTimer.current) clearTimeout(charActiveTimer.current)
    charActiveTimer.current = setTimeout(() => setCharActive(false), 6000)
  })
  return () => { off?.(); if (charActiveTimer.current) clearTimeout(charActiveTimer.current) }
}, [])
```

```tsx
<div className={'lain-char' + ((charActive || managerBusy) ? ' lain-char--active' : '')}>
  <LainBubble />
  <ManagerSprite size={120} busy={managerBusy} />
  {/* .lain-meta 기존 그대로 */}
```

(기존 `size={260}` → `120`.)

- [ ] **Step 2: styles.css — 축소 + 부각 트랜지션**

`.side-col .lain-char`(:614-625)의 `min-height: 288px` → `min-height: 148px` 로 변경하고, 파일의 lain-char 블록 뒤에 추가:

```css
.side-col .lain-char { transition: min-height .25s ease; }
.side-col .lain-char .mgr-img { transition: transform .25s ease; transform-origin: bottom center; }
.side-col .lain-char.lain-char--active { min-height: 200px; }
.side-col .lain-char.lain-char--active .mgr-img { transform: scale(1.35); }
```

(스프라이트 컨테이너 flex 규칙(:627-638)·메타 컬럼(:640-648)은 유지 — 축소 시 메타가 세로 공간 우위를 가져감.)

- [ ] **Step 3: 검증 + Commit**

Run: `npm run typecheck` → 0, `npx vitest run` → 그린, `npm run build` → 성공.

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(ui): 캐릭터 컴팩트화 — 평소 축소·발화/작업 시 부각 (관제실 P3)"
```

### Task 5: 프로젝트 카드 관제 확장 — 대기 승인 배지

**Files:**
- Modify: `src/main/store.ts`, `src/shared/types.ts:16-32`, `src/renderer/components/NaviTile.tsx:34-39`
- Test: `test/main/pendingapprovals.test.ts` (신규)

**Interfaces:**
- Produces: `ProjectStatus.pendingApprovals?: number` — `listProjects()`가 채움. NaviTile 배지 `승인 N`.
- Consumes: 기존 `approvals` 테이블(대기 상태 행)과 `tasks.project_id`. 스키마 컬럼명은 구현 시 store.ts의 approvals CREATE TABLE에서 실확인(대기 판정 컬럼이 `status='pending'`인지 `resolved IS NULL`인지) — 아래 SQL의 WHERE를 그에 맞춘다.

- [ ] **Step 1: 실패하는 테스트**

`test/main/pendingapprovals.test.ts` (store 부트스트랩은 retract.test.ts 패턴):

```ts
import { describe, it, expect } from 'vitest'
import { insertTask, insertApproval, listProjects, upsertProject } from '../../src/main/store'

describe('pendingApprovals 카운트', () => {
  it('대기 승인 수가 프로젝트 상태에 실린다', () => {
    upsertProject({ id: 'demo', path: 'C:/tmp/demo', name: 'demo' } as any)
    const taskId = insertTask({ projectId: 'demo', content: 't', state: 'working' } as any)
    insertApproval(taskId, 'push', '테스트 승인')
    const p = listProjects().find(x => x.id === 'demo')!
    expect(p.status.pendingApprovals).toBe(1)
  })
})
```

(store의 실제 `insertTask`/`insertApproval`/`upsertProject` 시그니처에 맞게 조정 — orchestrator.ts:652 `insertApproval(taskId,'question',…)` 호출 형태 참조.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/pendingapprovals.test.ts` → FAIL (`pendingApprovals` undefined).

- [ ] **Step 3: 구현**

- `src/shared/types.ts` `ProjectStatus`(:16)에 `pendingApprovals?: number` 추가.
- `src/main/store.ts` `listProjects()`의 상태 조립부에서 프로젝트별 카운트 병합:

```ts
const apRows = db.prepare(`
  SELECT t.project_id pid, COUNT(*) n FROM approvals a JOIN tasks t ON t.id = a.task_id
  WHERE /* 대기 판정: 실제 스키마 확인 후 status='pending' 또는 resolved_at IS NULL */
  GROUP BY t.project_id`).all() as { pid: string; n: number }[]
const apMap = new Map(apRows.map(r => [r.pid, r.n]))
// 각 ProjectView 조립 시: status.pendingApprovals = apMap.get(p.id) ?? 0
```

- `src/renderer/components/NaviTile.tsx:34-38` 배지 배열에 추가(기존 `↑ahead` 배지와 동형, 0이면 미표시):

```tsx
{(p.status.pendingApprovals ?? 0) > 0 && <span className="tile-badge warn">승인 {p.status.pendingApprovals}</span>}
```

(배지 클래스명은 기존 미푸시 배지의 클래스를 그대로 따른다 — NaviTile.tsx:34 실물 확인.)

- [ ] **Step 4: 검증 + Commit**

Run: `npx vitest run test/main/pendingapprovals.test.ts` → PASS. `npm run typecheck` → 0. `npx vitest run` → 그린.

```bash
git add -A
git commit -m "feat(ui): 프로젝트 카드에 대기 승인 배지 — 관제 1열 확장 (P3)"
```

### Task 6: quips 개발 이벤트 재조준 — task_done·verify_fail·task_error 추가

**Files:**
- Modify: `src/main/quips.ts:71-203`, `src/main/orchestrator.ts`
- Test: `test/main/quips.test.ts`

**Interfaces:**
- Consumes: `emitQuip(trigger, vars?)` (quips.ts:285), orchestrator 전이 지점 — done: `resolveReview` merge 성공(:1313 인근), verify 최종실패→blocked(finishWork :1016 인근), error: `handleRunError`(:737 인근). 기존 `tasks_streak` emit(orchestrator.ts:1033)과 동형 배선.
- Produces: 신규 트리거 3종 `task_done` / `verify_fail` / `task_error` (QuipDef). 기존 15종 중 `busy_week`는 Task 2에서 제거됨 — 나머지는 유지(감시·프로젝트·세션·TTS·모델·슬라이더 트리거는 개발 도구 운영 이벤트로 판단, 존치).

- [ ] **Step 1: 실패하는 테스트 (pickQuip 순수함수 대상)**

`test/main/quips.test.ts`에 추가 (기존 pickQuip 테스트 케이스와 동형):

```ts
it('task_done 트리거가 발화를 고른다 (level 2)', () => {
  const q = pickQuip('task_done', { level: 2, now: 0, lastByTrigger: {}, lastGlobal: 0, rand: () => 0 })
  expect(q).toBeTruthy()
})
it('verify_fail / task_error 트리거 존재', () => {
  expect(pickQuip('verify_fail', { level: 2, now: 0, lastByTrigger: {}, lastGlobal: 0, rand: () => 0 })).toBeTruthy()
  expect(pickQuip('task_error', { level: 2, now: 0, lastByTrigger: {}, lastGlobal: 0, rand: () => 0 })).toBeTruthy()
})
```

(`pickQuip` 실제 시그니처는 quips.ts:230 확인 후 기존 테스트의 호출 형태를 복사.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/quips.test.ts` → FAIL (미지 트리거).

- [ ] **Step 3: QUIPS에 3종 추가**

`src/main/quips.ts` QUIPS 배열에 추가(기존 QuipDef 구조 그대로, `{n}` 치환은 기존 variants 관례 확인):

```ts
{ trigger: 'task_done', rarity: 'common', cooldownSec: 300, variants: [
  '작업 하나 병합 완료됐어요. 확인해 보세요.',
  '방금 그 작업, 검증까지 통과해서 병합했어요.',
  '하나 끝났습니다. 다음 거 시킬 준비 됐어요.',
] },
{ trigger: 'verify_fail', rarity: 'uncommon', cooldownSec: 600, variants: [
  '검증이 계속 빨간불이에요. 제가 원인 정리해 둘게요.',
  '테스트가 안 통과해서 멈춰 세웠어요. 지시가 필요해요.',
] },
{ trigger: 'task_error', rarity: 'uncommon', cooldownSec: 600, variants: [
  '작업 하나가 에러로 넘어졌어요. 로그 봐뒀습니다.',
  '문제가 생겨서 작업을 멈췄어요. 결재함을 봐 주세요.',
] },
```

- [ ] **Step 4: orchestrator 배선 (tasks_streak :1033 동형)**

- `resolveReview` merge 성공 `setState(taskId,'done',...)`(:1313) 직후: `emitQuip('task_done')`
- `finishWork` verify 소진 → blocked 전이(:1016 인근의 최종 실패 분기) 직후: `emitQuip('verify_fail')`
- `handleRunError` error 전이(:737) 직후: `emitQuip('task_error')`

(import는 orchestrator.ts:47에 이미 있음.)

- [ ] **Step 5: 검증 + Commit**

Run: `npx vitest run test/main/quips.test.ts` → PASS. `npm run typecheck` → 0. `npx vitest run` → 그린.

```bash
git add -A
git commit -m "feat(quips): 개발 이벤트 트리거 3종(task_done·verify_fail·task_error) 추가 (P3)"
```

**Phase P3 마감**: 변경 요약 한 줄 — `- UI 관제실: 캐릭터 컴팩트화·승인 배지·quips 개발 재조준 (P3)`. 라이브 확인 항목(사람): 캐릭터 축소/부각 실표시, 승인 배지, task_done 말풍선.

---

## Phase P4 — 오버레이 개발 재조준

### Task 7: 개발 컨텍스트 화이트리스트 게이트 (`devfocus.ts`)

**Files:**
- Create: `src/main/devfocus.ts`
- Modify: `src/main/watcher.ts:88-140`, `src/main/store.ts`, `src/shared/types.ts`, `src/renderer/components/PrefsModal.tsx`
- Test: `test/main/devfocus.test.ts` (신규)

**Interfaces:**
- Produces: `isDevForeground(app: string, title: string, extra?: string[]): boolean` (순수, L0) · `DEFAULT_DEV_APPS: string[]` · 설정 `LainSettings.overlayDevApps: string` (CSV, DB 키 `overlay_dev_apps`, 기본 `''` — 기본 목록에 **더하는** 사용자 확장분).
- Consumes: watcher.ts `handleLine`의 `app`/`title`(:92-94)과 `isSensitive` 게이트(:108) 위치.

- [ ] **Step 1: 실패하는 테스트**

`test/main/devfocus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isDevForeground, DEFAULT_DEV_APPS } from '../../src/main/devfocus'

describe('isDevForeground', () => {
  it('터미널·에디터는 통과', () => {
    expect(isDevForeground('WindowsTerminal', '~ PowerShell')).toBe(true)
    expect(isDevForeground('Code', 'main.ts — lain')).toBe(true)
    expect(isDevForeground('pwsh', '')).toBe(true)
  })
  it('브라우저는 개발성 제목일 때만 통과', () => {
    expect(isDevForeground('chrome', 'localhost:5173 - app')).toBe(true)
    expect(isDevForeground('msedge', 'bestcow/Lain: GitHub')).toBe(true)
    expect(isDevForeground('chrome', 'YouTube')).toBe(false)
  })
  it('비개발 앱은 차단', () => {
    expect(isDevForeground('FL64', 'FL Studio')).toBe(false)
    expect(isDevForeground('KakaoTalk', '')).toBe(false)
    expect(isDevForeground('WINWORD', '보고서.docx')).toBe(false)
  })
  it('사용자 확장 목록이 더해진다', () => {
    expect(isDevForeground('FL64', 'FL Studio', ['fl64'])).toBe(true)
  })
  it('기본 목록에 핵심 개발 앱 포함', () => {
    for (const k of ['windowsterminal', 'code', 'powershell']) expect(DEFAULT_DEV_APPS).toContain(k)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/devfocus.test.ts` → FAIL (모듈 없음).

- [ ] **Step 3: devfocus.ts 구현**

```ts
// src/main/devfocus.ts — 오버레이 개발 컨텍스트 판정 (L0 순수함수, LLM 0)
// 개발자 전향(2026-07-18): 개발 도구 화면일 때만 감시 — 그 외엔 캡처 자체를 안 한다.
export const DEFAULT_DEV_APPS = [
  'windowsterminal', 'wt', 'conhost', 'powershell', 'pwsh', 'cmd',
  'code', 'cursor', 'webstorm', 'idea64', 'idea', 'rider64', 'devenv',
  'sublime_text', 'notepad++', 'gitkraken', 'fork', 'sourcetree',
]
const BROWSERS = ['chrome', 'msedge', 'firefox', 'whale']
const DEV_TITLE_RE = /(localhost|127\.0\.0\.1|:\d{4}\b|github\.com|github -|gitlab|stack ?overflow|mdn|npmjs|developer\.|docs\.|api reference|vercel|supabase)/i

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
```

- [ ] **Step 4: 설정 키 + watcher 게이트**

- `src/shared/types.ts` LainSettings에 `overlayDevApps: string` 추가(오버레이 키들 옆).
- `src/main/store.ts` getSettings(:3184 인근 오버레이 키 블록)에 `overlayDevApps: getSetting('overlay_dev_apps') ?? ''`, setSettings에 동형 쓰기 추가.
- `src/main/watcher.ts` `handleLine`: `isSensitive` 게이트(:108) **바로 다음**에 삽입(상태 추적·유휴 판정은 이미 지난 뒤, 트리거 판정 :121-124 이전):

```ts
// 개발 컨텍스트 밖이면 캡처·관찰 자체를 하지 않는다 (비용·프라이버시)
if (!isDevForeground(app, title, parseDevApps(s.overlayDevApps))) return
```

(import 추가: `import { isDevForeground, parseDevApps } from './devfocus'`.)
- `src/renderer/components/PrefsModal.tsx` 감시(오버레이) 섹션에 텍스트 입력 추가: 라벨 `감시 대상 앱 추가 (쉼표 구분, 기본: 터미널·에디터·개발 브라우저 탭)`, `patch({ overlayDevApps: value })` (기존 TelegramField류 blur 저장 관례 따름).

- [ ] **Step 5: 검증 + Commit**

Run: `npx vitest run test/main/devfocus.test.ts` → PASS. `npm run typecheck` → 0. `npx vitest run` → 그린.

```bash
git add -A
git commit -m "feat(overlay): 개발 컨텍스트 화이트리스트 게이트 — 개발 도구 화면만 감시 (P4)"
```

### Task 8: 오버레이 프롬프트 개발 전용화 + 작업 제안 연결

**Files:**
- Create: `src/main/overlayprompt.ts`
- Modify: `src/main/manager.ts:1852-1934`
- Test: `test/main/overlayprompt.test.ts` (신규)

**Interfaces:**
- Produces: `buildOverlayPrompt(appHint: string): string` — reactToObservation 시스템 프롬프트의 관찰 규칙 부분(페르소나 `personaCore()`는 manager가 앞에 결합, 기존 구조 유지).
- Consumes: manager.ts `reactToObservation`(:1872)의 프롬프트 조립(:1916-1934), `APP_HINTS`(:1852-1867).

- [ ] **Step 1: 실패하는 테스트**

`test/main/overlayprompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildOverlayPrompt } from '../../src/main/overlayprompt'

describe('buildOverlayPrompt', () => {
  const p = buildOverlayPrompt('IDE(VS Code) — 개발 맥락')
  it('개발 신호 목록과 침묵 기본값을 담는다', () => {
    expect(p).toContain('<<SILENT>>')
    expect(p).toMatch(/에러|스택트레이스/)
    expect(p).toMatch(/빌드 실패|테스트 실패/)
  })
  it('작업 위임 제안 규칙을 담는다', () => {
    expect(p).toMatch(/맡을까요|위임/)
  })
  it('appHint가 주입된다', () => {
    expect(p).toContain('IDE(VS Code)')
  })
  it('연구 에스컬레이션 규칙 유지', () => {
    expect(p).toContain('<<RESEARCH>>')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/overlayprompt.test.ts` → FAIL.

- [ ] **Step 3: overlayprompt.ts 구현**

```ts
// src/main/overlayprompt.ts — 오버레이 관찰 규칙 (개발 전용, 순수 문자열 빌더)
// 페르소나(personaCore)는 호출부(manager.reactToObservation)가 앞에 결합한다.
export function buildOverlayPrompt(appHint: string): string {
  return [
    '너는 지금 유저의 개발 화면을 어깨너머로 보고 있다. 화이트리스트 덕에 지금 화면은 터미널·에디터·개발 브라우저 탭 중 하나다.',
    '기본은 침묵이다. 아래 개발 신호가 화면에 뚜렷할 때만 입을 연다. 그 외엔 반드시 <<SILENT>> 만 출력한다:',
    '- 에러 메시지·스택트레이스·예외',
    '- 빌드 실패·테스트 실패·타입 에러 출력',
    '- 같은 명령/수정을 반복하며 막혀 있는 정황',
    '말할 때 규칙:',
    '- 두 문장 이내. 화면에 실제로 보이는 것만 근거로. 단정 금지, 추측이면 추측이라고 말한다.',
    '- 해결이 여러 단계짜리 작업이면 조언 대신 "이거 제가 맡을까요?"라고 위임을 제안한다 (유저가 수락하면 본체 대화에서 start_task로 이어진다).',
    '- 최신 문서 확인이 필요한 문제면 <<RESEARCH>> 를 출력해 웹 조사로 에스컬레이션한다.',
    appHint ? `앱 힌트: ${appHint}` : '',
  ].filter(Boolean).join('\n')
}
```

- [ ] **Step 4: manager.ts 배선 + APP_HINTS 정리**

- `reactToObservation`의 시스템 프롬프트 관찰 규칙 부분(:1916-1934)을 `buildOverlayPrompt(appHint(obs.app))` 호출로 교체(personaCore 결합·`<관찰>` 블록·이미지 스트림(:1946-1961)·`<<SILENT>>`/`<<RESEARCH>>` 후처리(:1989-1995)는 기존 그대로).
- `APP_HINTS`(:1852-1867)에서 비개발 엔트리(메신저·오피스·미디어 류) 삭제 — 화이트리스트로 도달 불가이므로 죽은 데이터 제거. `code`·브라우저 힌트는 유지.

- [ ] **Step 5: 검증 + Commit**

Run: `npx vitest run test/main/overlayprompt.test.ts` → PASS. `npm run typecheck` → 0. `npx vitest run` → 그린.

```bash
git add -A
git commit -m "feat(overlay): 관찰 프롬프트 개발 전용화 + 위임 제안 규칙 (P4)"
```

**Phase P4 마감**: 변경 요약 한 줄 — `- 오버레이 개발 재조준: 화이트리스트 게이트 + 개발 전용 프롬프트 (P4)`. 라이브 확인: 비개발 앱에서 무캡처(로그), 터미널 에러 화면에서 조언/위임 제안 1회.

---

## Phase P5 — CC 관제탑

### Task 9 (C1): 프로젝트 카드에 CC 활동 표시

**Files:**
- Modify: `src/main/store.ts`, `src/shared/types.ts:16`, `src/renderer/components/NaviTile.tsx`
- Test: `test/main/cclastactivity.test.ts` (신규)

**Interfaces:**
- Produces: `ProjectStatus.lastCcAt?: string` (ISO, cc_events 최신) — `listProjects()`가 채움. NaviTile meta 줄에 `CC {상대시간}` 표시.
- Consumes: `cc_events` 테이블(store.ts:163), Task 5의 listProjects 조립 패턴.

- [ ] **Step 1: 실패하는 테스트**

`test/main/cclastactivity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { addCcEvent, listProjects, upsertProject } from '../../src/main/store'

describe('lastCcAt', () => {
  it('최근 CC 이벤트 시각이 프로젝트 상태에 실린다', () => {
    upsertProject({ id: 'demo2', path: 'C:/tmp/demo2', name: 'demo2' } as any)
    addCcEvent('demo2', 'aaaa1111-2222-3333-4444-555566667777', 'SessionStart')
    const p = listProjects().find(x => x.id === 'demo2')!
    expect(p.status.lastCcAt).toBeTruthy()
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/main/cclastactivity.test.ts` → FAIL.

- [ ] **Step 3: 구현**

- `src/shared/types.ts` ProjectStatus에 `lastCcAt?: string` 추가.
- `src/main/store.ts` listProjects 조립부(Task 5의 apMap 옆):

```ts
const ccRows = db.prepare(`SELECT project_id pid, MAX(created_at) m FROM cc_events GROUP BY project_id`).all() as { pid: string; m: string }[]
const ccMap = new Map(ccRows.map(r => [r.pid, r.m]))
// 각 ProjectView 조립 시: status.lastCcAt = ccMap.get(p.id)
```

- `src/renderer/components/NaviTile.tsx` meta 줄(:39)에 항목 추가(기존 상대시간 헬퍼 — :45의 마지막 커밋 상대시간 로직 — 재사용):

```tsx
{p.status.lastCcAt && <span className="tile-cc" title="마지막 Claude Code 활동">CC {relTime(p.status.lastCcAt)}</span>}
```

(`relTime`은 NaviTile 내 기존 상대시간 함수명에 맞춘다.)

- [ ] **Step 4: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(cc): 프로젝트 카드에 마지막 CC 활동 표시 (C1)"
```

### Task 10 (C2): CC 세션 이어받기 — `adopt_cc_session` 도구

**Files:**
- Modify: `src/main/ccsessions.ts`, `src/main/manager.ts` (도구 추가 — `ask_cc_session` :673 옆)
- Test: `test/main/adoptcc.test.ts` (신규)

**Interfaces:**
- Produces: `buildAdoptContent(digest: string, goal: string | undefined, sessionId: string): string` (ccsessions.ts, 순수) · 레인 도구 `adopt_cc_session { project_id, session_id, goal?, mode? }` → `startTask(project_id, { content, mode })`.
- Consumes: `ccSessionDigest(projectPath, sessionId, maxChars)` (ccsessions.ts:154) · `startTask` (orchestrator.ts:353) · `handoffBlock` 포맷 관례(handoff.ts:45 — `<handoff>` 태그).

- [ ] **Step 1: 실패하는 테스트**

`test/main/adoptcc.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildAdoptContent } from '../../src/main/ccsessions'

describe('buildAdoptContent', () => {
  it('TASK 골격 + handoff 블록 + 세션 id를 담는다', () => {
    const c = buildAdoptContent('유저: 버그 고쳐줘\n어시: 원인은 X', '남은 수정 완결', 'abc123def456')
    expect(c).toContain('# TASK')
    expect(c).toContain('## 목표')
    expect(c).toContain('남은 수정 완결')
    expect(c).toContain('<handoff>')
    expect(c).toContain('abc123def456')
    expect(c).toContain('## 완료 조건')
  })
  it('goal 없으면 기본 목표 문구', () => {
    expect(buildAdoptContent('d', undefined, 's1')).toMatch(/이어서 완료/)
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/main/adoptcc.test.ts` → FAIL.

- [ ] **Step 3: buildAdoptContent 구현 (ccsessions.ts 말미)**

```ts
/** CC 세션 이어받기 명세 생성 — Navi 유한세션 핸드오프(<handoff>) 포맷 재사용 */
export function buildAdoptContent(digest: string, goal: string | undefined, sessionId: string): string {
  const g = goal?.trim() || '아래 Claude Code 세션에서 진행하던 작업을 이어서 완료하라.'
  return [
    '# TASK',
    '## 목표',
    g,
    '',
    `## 컨텍스트 — Claude Code 세션 ${sessionId} 이어받기`,
    '<handoff>',
    digest,
    '</handoff>',
    '',
    '## 완료 조건 (DoD)',
    '- 세션에서 진행 중이던 변경을 완결한다',
    '- 프로젝트 verify 명령이 통과한다',
  ].join('\n')
}
```

- [ ] **Step 4: manager.ts 도구 추가 (`ask_cc_session` :673 블록 바로 뒤, 동형 스타일)**

```ts
tool('adopt_cc_session', 'CC 세션에서 하다 만 작업을 레인 작업으로 승격(이어받기). 세션 내용을 핸드오프로 감싸 새 작업을 시작한다.', {
  project_id: z.string(), session_id: z.string(),
  goal: z.string().optional().describe('이어받아 완료할 목표 한 줄(생략 시 세션 작업 완결)'),
  mode: z.enum(['interactive', 'autonomous']).optional(),
}, async (a) => {
  const p = getProject(a.project_id)
  if (!p) return { content: [{ type: 'text', text: '프로젝트 없음' }] }
  const digest = ccSessionDigest(p.path, a.session_id, 6000)
  if (!digest) return { content: [{ type: 'text', text: 'CC 세션을 읽을 수 없음(id 확인)' }] }
  const r = await startTask(a.project_id, { content: buildAdoptContent(digest, a.goal, a.session_id), mode: a.mode })
  return { content: [{ type: 'text', text: r.error ? `실패: ${r.error}` : `이어받기 작업 시작: ${r.taskId}${r.queued ? ' (대기열)' : ''}` }] }
})
```

(정확한 `tool()` 래퍼·`getProject`·반환 형식은 이웃 도구 `ask_cc_session`(:673-705)·`start_task`(:726-787)의 실물 관례를 그대로 따른다. import에 `buildAdoptContent` 추가. SYSTEM_PROMPT의 CC 도구 안내 문구(list/read/ask 언급부)에 `adopt_cc_session`(이어받기) 한 줄 추가.)

- [ ] **Step 5: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(cc): adopt_cc_session — CC 세션을 레인 작업으로 이어받기 (C2)"
```

### Task 11 (C3): CC 세션 종료 → 레인 역반영 (요약 저장 + 다이제스트 노출)

**Files:**
- Modify: `src/main/store.ts` (마이그레이션+함수), `src/main/cchooks.ts:227-243`, `src/main/manager.ts` (buildDigest :271 인근)
- Test: `test/main/ccsummary.test.ts` (신규)

**Interfaces:**
- Produces: `cc_events.summary TEXT` 컬럼 · `setCcEventSummary(projectId: string, sessionId: string, summary: string): void` · `latestCcSummaries(limit?: number): Array<{ projectId: string; sessionId: string; summary: string; createdAt: string }>` · buildDigest에 `CC: <프로젝트>: <요약>` 줄.
- Consumes: `handleEventFile`(cchooks.ts:227)의 SessionEnd 분기 · `ccSessionDigest`(:154) · judge 패턴(Global Constraints) · `buildDigest`(manager.ts:238).

- [ ] **Step 1: 실패하는 테스트 (store 계층만 — LLM은 목 없이 배관 분리)**

`test/main/ccsummary.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { addCcEvent, setCcEventSummary, latestCcSummaries } from '../../src/main/store'

describe('CC 세션 요약 저장', () => {
  it('SessionEnd 이벤트에 요약을 붙이고 최신순 조회', () => {
    addCcEvent('demo3', 'sess-1111-2222', 'SessionEnd')
    setCcEventSummary('demo3', 'sess-1111-2222', '로그인 버그 수정, 테스트 2개 추가')
    const rows = latestCcSummaries(5)
    expect(rows[0].summary).toContain('로그인 버그')
    expect(rows[0].projectId).toBe('demo3')
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/main/ccsummary.test.ts` → FAIL.

- [ ] **Step 3: store 구현**

- 마이그레이션(store.ts:326 패턴 옆): `try { db.exec('ALTER TABLE cc_events ADD COLUMN summary TEXT') } catch {}`
- 함수(addCcEvent :1591 옆):

```ts
export function setCcEventSummary(projectId: string, sessionId: string, summary: string): void {
  db.prepare(`UPDATE cc_events SET summary=? WHERE project_id=? AND session_id=? AND event='SessionEnd'`)
    .run(summary.slice(0, 500), projectId, sessionId)
}
export function latestCcSummaries(limit = 3): Array<{ projectId: string; sessionId: string; summary: string; createdAt: string }> {
  return (db.prepare(`SELECT project_id, session_id, summary, created_at FROM cc_events
    WHERE summary IS NOT NULL AND summary != '' ORDER BY created_at DESC LIMIT ?`).all(limit) as any[])
    .map(r => ({ projectId: r.project_id, sessionId: r.session_id, summary: r.summary, createdAt: r.created_at }))
}
```

- [ ] **Step 4: cchooks SessionEnd 훅 → judge 요약 (fire-and-forget)**

`cchooks.ts` `handleEventFile`의 SessionEnd 처리(:241-243) 직후에:

```ts
if (ev.event === 'SessionEnd') void summarizeCcEnd(projectId, ev.sessionId).catch(() => {})
```

같은 파일에 신규 함수(judge 패턴 — Global Constraints, `judgeQueryOptions`/`AGENT_CWD`/`CLAUDE_BIN` import는 orchestrator.ts `elicit`(:119) 관례):

```ts
async function summarizeCcEnd(projectId: string, sessionId: string): Promise<void> {
  const p = getProject(projectId); if (!p) return
  const digest = ccSessionDigest(p.path, sessionId, 2500); if (!digest) return
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60_000)
  let text = ''
  try {
    const stream = query({ prompt:
      `다음은 방금 끝난 Claude Code 세션 대화 발췌다. 무엇을 했고 결과가 어땠는지 2줄 이내 한국어로 요약하라. 요약만 출력.\n\n${digest}`,
      options: { cwd: AGENT_CWD, allowedTools: [], maxTurns: 2, ...judgeQueryOptions(), abortController: ac,
        executable: 'node', pathToClaudeCodeExecutable: CLAUDE_BIN } })
    for await (const m of stream) { /* assistant 텍스트 누적 — elicit(:119)과 동형 */ }
  } catch { /* 요약 실패는 무해 — 스킵 */ } finally { clearTimeout(t) }
  const s = text.trim(); if (s) setCcEventSummary(projectId, sessionId, s)
}
```

(스트림 누적 루프는 elicit의 실물 코드를 복사해 맞춘다. cchooks는 L0 파일이지만 이 함수는 명시 승인된 judge 지점 — 파일 상단 주석에 그 사실을 남긴다.)

- [ ] **Step 5: buildDigest 노출**

`manager.ts` `buildDigest`(:238)의 base 조립 뒤(:271 인근, 제거된 plannerDigestLine 자리)에:

```ts
const cc = latestCcSummaries(3)
if (cc.length) base += '\n' + cc.map(c => `CC(${c.projectId}): ${c.summary}`).join('\n')
```

- [ ] **Step 6: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(cc): SessionEnd 요약 역반영 — cc_events.summary + 다이제스트 노출 (C3)"
```

### Task 12 (C4): 활동 타임라인에 CC 요약 표기

**Files:**
- Modify: `src/renderer/lib/activityFeed.ts:9-17`, `src/shared/types.ts` (CcEvent에 summary), `src/main/store.ts:1598` (listRecentCcEvents가 summary 포함)
- Test: `test/renderer/activityfeed.test.ts` (기존 있으면 케이스 추가, 없으면 신규)

**Interfaces:**
- Consumes: Task 11의 `cc_events.summary`.
- Produces: 활동 피드 CC 항목 라벨이 `세션 시작/종료`만이 아니라 요약을 함께 표시(`CC 종료 — 로그인 버그 수정…`).

- [ ] **Step 1: 실패하는 테스트** — activityFeed의 CC 라벨 생성 함수(activityFeed.ts:9-17)에 summary 케이스:

```ts
it('CC SessionEnd에 요약이 있으면 라벨에 붙인다', () => {
  const label = ccEventLabel({ event: 'SessionEnd', summary: '버그 수정 완료' } as any)
  expect(label).toContain('버그 수정 완료')
})
```

(실제 함수명·시그니처는 activityFeed.ts:9-17 실물에 맞춘다 — 라벨 빌더가 인라인이면 `ccEventLabel`로 추출해 export.)

- [ ] **Step 2: 실패 확인 → Step 3: 구현**

- `src/shared/types.ts` `CcEvent`(store.ts:1584 대응 타입)에 `summary?: string` 추가.
- `src/main/store.ts` `listRecentCcEvents`(:1598) SELECT에 `summary` 컬럼 포함.
- `activityFeed.ts` 라벨 빌더: `ev.summary ? `${base} — ${ev.summary.slice(0, 60)}` : base`.

- [ ] **Step 4: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(cc): 활동 타임라인에 CC 세션 요약 표기 (C4)"
```

**Phase P5 마감**: 변경 요약 한 줄 — `- CC 관제탑: 카드 CC 활동·이어받기·요약 역반영·타임라인 (C1~C4)`. 라이브 확인: 실제 CC 세션 1개 종료 → 카드/다이제스트/피드 반영, adopt 1건.

---

## Phase P6 — 루프 엔지니어링 (L2→L1→L5→L6→L3→L4)

### Task 13 (L2): 실패 회고 메모 — 실패 원인 자동 학습

**Files:**
- Create: `src/main/postmortem.ts`
- Modify: `src/main/orchestrator.ts` (blocked/error 최종 전이 지점)
- Test: `test/main/postmortem.test.ts` (신규)

**Interfaces:**
- Produces: `buildPostmortemPrompt(taskTitle: string, kind: 'verify' | 'error' | 'blocked', detail: string): string` · `parsePostmortem(text: string): string | null` (한 줄, 200자 컷, `NONE`→null) · orchestrator `reflectFailure(taskId, kind, detail)` — judge 1콜 → `insertLesson({ scope: 'project', trigger: '실패(<kind>)', origin: 'agent' })`.
- Consumes: `insertLesson`(store.ts:2059 — 시그니처 원문 준수) · judge 패턴 · 주입은 기존 `lessonsBlock`(worker.ts:356)이 자동 수행(다음 시도 프롬프트에 실림 — 추가 배선 불요).

- [ ] **Step 1: 실패하는 테스트 (순수함수)**

`test/main/postmortem.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildPostmortemPrompt, parsePostmortem } from '../../src/main/postmortem'

describe('postmortem', () => {
  it('프롬프트에 실패 종류·핵심 지시가 담긴다', () => {
    const p = buildPostmortemPrompt('로그인 수정', 'verify', 'FAIL src/auth.test.ts')
    expect(p).toContain('verify')
    expect(p).toContain('FAIL src/auth.test.ts')
    expect(p).toMatch(/한 줄|한 문장/)
    expect(p).toContain('NONE')
  })
  it('한 줄 회고를 파싱하고 200자 컷', () => {
    expect(parsePostmortem('  verify 명령이 워크트리 밖 경로를 참조함  ')).toBe('verify 명령이 워크트리 밖 경로를 참조함')
    expect(parsePostmortem('x'.repeat(300))!.length).toBe(200)
  })
  it('NONE/빈 응답은 null', () => {
    expect(parsePostmortem('NONE')).toBeNull()
    expect(parsePostmortem('')).toBeNull()
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/main/postmortem.test.ts` → FAIL.

- [ ] **Step 3: postmortem.ts 구현**

```ts
// src/main/postmortem.ts — 실패 회고 한 줄 (L2). 프롬프트/파싱은 순수, LLM 호출은 orchestrator.reflectFailure.
export function buildPostmortemPrompt(taskTitle: string, kind: 'verify' | 'error' | 'blocked', detail: string): string {
  return [
    `작업 "${taskTitle}" 이(가) ${kind} 로 실패했다. 아래는 실패 근거 로그다.`,
    '다음 시도가 같은 이유로 실패하지 않도록, 재사용 가능한 원인·대처를 **한 줄(한 문장)** 로 요약하라.',
    '이 작업에서만 유효한 일회성 사실(특정 파일의 오타 등)이면 NONE 만 출력하라.',
    '출력은 그 한 줄 또는 NONE 뿐이다. 접두사·설명 금지.',
    '', '--- 실패 근거 ---', detail.slice(0, 4000),
  ].join('\n')
}

export function parsePostmortem(text: string): string | null {
  const s = (text || '').trim().split('\n')[0]?.trim() ?? ''
  if (!s || s.toUpperCase() === 'NONE') return null
  return s.slice(0, 200)
}
```

- [ ] **Step 4: orchestrator 배선**

orchestrator.ts에 신규 함수(judge 패턴 — `reflect`(:1049) 골격 복사·축소):

```ts
async function reflectFailure(taskId: string, kind: 'verify' | 'error' | 'blocked', detail: string): Promise<void> {
  const task = getTask(taskId); if (!task) return
  // judge 1콜 (elicit :119 골격): buildPostmortemPrompt → 텍스트 누적 → parsePostmortem
  const lesson = parsePostmortem(text)
  if (lesson) insertLesson({ projectId: task.projectId, taskId, scope: 'project', trigger: `실패(${kind})`, lesson, origin: 'agent' })
}
```

호출 지점(전부 fire-and-forget `void reflectFailure(...).catch(()=>{})`):
- `finishWork` verify 재시도 소진 → blocked 전이 직후: `kind:'verify'`, detail = verify tail.
- `finishWork` 환경 블로커 blocked(:960): `kind:'blocked'`, detail = 블로커 사유.
- `handleRunError` 최종 error(:737): `kind:'error'`, detail = 에러 메시지.

(주입은 다음 `runNavi` 때 `lessonsBlock`이 자동 — lessonsForProject 랭킹에 실림.)

- [ ] **Step 5: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(loop): L2 실패 회고 — 실패 원인 한 줄을 프로젝트 학습으로 자동 저장"
```

### Task 14 (L1): 독립 완료 심사관 — done 전 diff·완료조건 대조

**Files:**
- Create: `src/main/audit.ts`
- Modify: `src/main/orchestrator.ts` (finishWork :1030 직전), `src/main/store.ts` (tasks 컬럼), `src/shared/types.ts` (Task 타입)
- Test: `test/main/audit.test.ts` (신규)

**Interfaces:**
- Produces: `extractCriteria(content: string): string[]` (`## 합격 기준`/`## 완료 조건` 불릿 파싱) · `buildAuditPrompt(spec, criteria, diffStat, summary): string` · `parseAuditVerdict(text): AuditVerdict | null` where `AuditVerdict = { pass: boolean; issues: string[] }` · `auditTask(task, worktreePath): Promise<AuditVerdict | null>` (LLM; null=심사 불능→통과 취급) · tasks 컬럼 `audit_result TEXT`(JSON), `Task.auditResult?: string`.
- Consumes: judge 패턴 · `execP`로 `git diff <mergeBase>...HEAD --stat` (finishWork의 execP 관례 :945) · Task 18(L3)에서 `task.criteria` 구조화 입력으로 업그레이드 예정(현재는 content 파싱).

- [ ] **Step 1: 실패하는 테스트 (순수함수)**

`test/main/audit.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractCriteria, buildAuditPrompt, parseAuditVerdict } from '../../src/main/audit'

describe('audit 순수부', () => {
  it('합격 기준 불릿을 뽑는다', () => {
    const c = extractCriteria('# TASK\n## 목표\nx\n## 합격 기준 (lain elicitation §21.3)\n- 테스트 통과\n- 버튼 동작\n\n## 기타')
    expect(c).toEqual(['테스트 통과', '버튼 동작'])
  })
  it('완료 조건 (DoD) 섹션도 지원', () => {
    expect(extractCriteria('## 완료 조건 (DoD)\n- A\n- B')).toEqual(['A', 'B'])
  })
  it('기준 없으면 빈 배열', () => {
    expect(extractCriteria('# TASK\n그냥 산문')).toEqual([])
  })
  it('프롬프트에 기준·diff·자기보고가 담긴다', () => {
    const p = buildAuditPrompt('스펙', ['A'], ' src/x.ts | 5 +', '다 했습니다')
    expect(p).toContain('A')
    expect(p).toContain('src/x.ts')
    expect(p).toContain('다 했습니다')
    expect(p).toMatch(/자기 보고를 신뢰하지/)
  })
  it('판정 JSON 파싱', () => {
    expect(parseAuditVerdict('```json\n{"pass":false,"issues":["버튼 미구현"]}\n```')).toEqual({ pass: false, issues: ['버튼 미구현'] })
    expect(parseAuditVerdict('잡담')).toBeNull()
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/main/audit.test.ts` → FAIL.

- [ ] **Step 3: audit.ts 구현**

```ts
// src/main/audit.ts — 독립 완료 심사관 (L1). Navi 자기 보고를 신뢰하지 않고 diff·완료조건 대조.
export interface AuditVerdict { pass: boolean; issues: string[] }

const CRITERIA_HEADS = [/^##\s*합격 기준/, /^##\s*완료 조건/]

export function extractCriteria(content: string): string[] {
  const lines = (content || '').split('\n')
  const out: string[] = []
  let inSec = false
  for (const ln of lines) {
    if (/^##\s/.test(ln)) inSec = CRITERIA_HEADS.some((re) => re.test(ln.trim()))
    else if (inSec) {
      const m = ln.match(/^\s*[-*]\s+(.+)/)
      if (m) out.push(m[1].trim())
    }
  }
  return out
}

export function buildAuditPrompt(spec: string, criteria: string[], diffStat: string, summary: string): string {
  return [
    '너는 독립 심사관이다. 작업자의 자기 보고를 신뢰하지 말고, 요구사항과 실제 변경을 대조해 완료 여부를 판정하라.',
    '', '--- 작업 지시(요구사항) ---', spec.slice(0, 3000),
    criteria.length ? ['', '--- 완료 조건 ---', ...criteria.map((c) => `- ${c}`)].join('\n') : '',
    '', '--- 실제 변경 (git diff --stat) ---', diffStat.slice(0, 2000),
    '', '--- 작업자 자기 보고 ---', summary.slice(0, 1500),
    '', '판정 기준: 요구와 다른 구현·누락된 완료 조건·변경 없는 완료 주장. diff stat만으로 판단 불가한 항목은 의심 사유가 없으면 통과로 둔다.',
    '출력(이것만): ```json\n{"pass": true|false, "issues": ["미충족·불일치 사유 …"]}\n```',
  ].filter(Boolean).join('\n')
}

export function parseAuditVerdict(text: string): AuditVerdict | null {
  const m = (text || '').match(/```json\s*([\s\S]*?)```/)
  if (!m) return null
  try {
    const j = JSON.parse(m[1])
    if (typeof j.pass !== 'boolean') return null
    return { pass: j.pass, issues: Array.isArray(j.issues) ? j.issues.map(String).slice(0, 10) : [] }
  } catch { return null }
}
```

`auditTask(task, worktreePath)`는 orchestrator 쪽이 아니라 audit.ts에 두되 LLM·git 호출부는 orchestrator의 기존 유틸을 인자로 받거나 동일 golem 패턴으로 작성: `execP('git diff <base>...HEAD --stat', { cwd: worktreePath })` (base는 `task.mergeBaseSha` 있으면 그것, 없으면 `main`) → `buildAuditPrompt(task.content, extractCriteria(task.content), stat, report.summary)` → judge 1콜 → `parseAuditVerdict`. 실패·타임아웃이면 `null`.

- [ ] **Step 4: tasks 컬럼 + 타입**

- store.ts 마이그레이션: `try { db.exec('ALTER TABLE tasks ADD COLUMN audit_result TEXT') } catch {}` + rowToTask 매핑에 `auditResult` 추가.
- types.ts `Task`에 `auditResult?: string` 추가.

- [ ] **Step 5: finishWork 배선 (:1030 review 전이 직전)**

```ts
// L1 독립 심사 — verify 통과 후, 결재 전
const verdict = await auditTask(task, worktreePath).catch(() => null)
if (verdict && !verdict.pass && !task.auditRetried) {
  setState(taskId, 'working', { auditRetried: true } as any)  // 1회 한정 재시도 플래그(tasks 컬럼 audit_retried INTEGER 마이그레이션 동반)
  const fb = `독립 심사에서 미완료 판정. 미충족 사유:\n${verdict.issues.map(i => `- ${i}`).join('\n')}\n각 사유를 해소하고 다시 완료 보고하라.`
  return void resumeNavi(taskId, fb)  // finishWork의 verify 재시도 resume 경로(:993)와 동일한 재개 함수 — Task 15의 rework도 같은 이름을 쓴다(없으면 :993 인라인 코드를 resumeNavi(taskId, feedback)로 추출)
}
setState(taskId, 'review', { verifyResult, autoRetryCount: 0, auditResult: verdict ? JSON.stringify(verdict) : undefined })
```

(실제 재개 함수명은 :993의 verify 실패 재개 코드와 동일 경로를 재사용 — 구현 시 그 함수/인라인 형태에 맞춘다. `audit_retried` 컬럼도 Step 4 마이그레이션에 포함.) `notifyUser`의 결재 대기 알림(:1039)에 심사 요약 추가: pass면 `심사 통과`, fail(재시도 후)이면 `⚠ 심사 미통과 사유 N건 — 결재 시 참고`.

- [ ] **Step 6: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(loop): L1 독립 완료 심사관 — done 전 diff·완료조건 대조, 미통과 1회 자동 재작업"
```

### Task 15 (L5): 리뷰 리젝 → 자동 재작업 (`rework`)

**Files:**
- Modify: `src/main/orchestrator.ts:1284-1322` (resolveReview), `src/main/store.ts` (tasks 컬럼), `src/shared/types.ts`, `src/main/ipc.ts` + `src/preload/index.ts` (resolveReview 채널에 comment), `src/renderer/components/TaskDrawer.tsx` (수정 요청 UI)
- Test: `test/main/rework.test.ts` (신규)

**Interfaces:**
- Produces: `resolveReview(taskId, resolution: 'merge' | 'keep-branch' | 'discard' | 'rework', comment?: string)` 확장 · tasks 컬럼 `rework_count INTEGER DEFAULT 0` · `REWORK_MAX = 2` · `buildReworkPrompt(comment: string, round: number): string` (순수, orchestrator export).
- Consumes: 기존 resolveReview 3결말(:1284) · worktree 보존 상태의 재개 경로(runWithInterrupts/launch2 — answerClarify :1176의 재개 관례).

- [ ] **Step 1: 실패하는 테스트 (순수부)**

`test/main/rework.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildReworkPrompt, canRework, REWORK_MAX } from '../../src/main/orchestrator'

describe('rework', () => {
  it('재작업 프롬프트에 지적사항·회차가 담긴다', () => {
    const p = buildReworkPrompt('에러 처리 누락. 로그 남길 것.', 1)
    expect(p).toContain('에러 처리 누락')
    expect(p).toMatch(/재작업|수정/)
    expect(p).toContain('1')
  })
  it('상한 판정', () => {
    expect(canRework(0)).toBe(true)
    expect(canRework(REWORK_MAX)).toBe(false)
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/main/rework.test.ts` → FAIL.

(참고: orchestrator.ts 직접 import가 vitest에서 무겁게 굴러가면 — 기존 orchestrator 계열 테스트의 관례를 먼저 확인하고 — 순수부 3개(`REWORK_MAX`/`canRework`/`buildReworkPrompt`)를 `src/main/rework.ts`로 분리해 orchestrator가 re-export 없이 import하는 구조로 바꿔도 된다. 인터페이스는 동일.)

- [ ] **Step 3: orchestrator 구현**

```ts
export const REWORK_MAX = 2
export function canRework(count: number): boolean { return count < REWORK_MAX }
export function buildReworkPrompt(comment: string, round: number): string {
  return [
    `결재에서 수정 요청이 왔다 (재작업 ${round}회차, 최대 ${REWORK_MAX}회).`,
    '--- 지적사항 ---', comment,
    '--- 지시 ---',
    '지적사항 각각을 해소하라. 해소 불가능한 항목은 이유를 보고에 명시하라. 완료 후 동일 JSON 형식으로 다시 보고하라.',
  ].join('\n')
}
```

`resolveReview`(:1284)에 분기 추가:

```ts
if (resolution === 'rework') {
  if (!canRework(task.reworkCount ?? 0)) return { ok: false, reason: `재작업 상한(${REWORK_MAX}회) 도달 — 병합/보류/폐기로 결정하세요` }
  const round = (task.reworkCount ?? 0) + 1
  setState(taskId, 'working', { reworkCount: round } as any)
  void resumeNavi(taskId, buildReworkPrompt(comment ?? '', round))  // verify 실패 재개(:993)와 동일 재개 경로
  return { ok: true }
}
```

(worktree는 review 상태에서 보존돼 있음 — discard(:1320)만 지우므로 추가 조치 불요. 재작업 완료 시 finishWork → verify → L1 audit → review 로 자연 재진입.)
- store.ts: `try { db.exec('ALTER TABLE tasks ADD COLUMN rework_count INTEGER NOT NULL DEFAULT 0') } catch {}` + rowToTask `reworkCount`.
- types.ts: `Task.reworkCount?: number`, resolveReview 관련 LainApi/IPC 타입에 `'rework'`·`comment?` 추가.

- [ ] **Step 4: IPC + UI**

- ipc.ts의 resolveReview 핸들러(`tasks:resolveReview` — 실채널명은 grep으로 확인)에 `comment` 파라미터 전달, preload 동기화.
- `TaskDrawer.tsx` 결재 패널(병합/보류/폐기 버튼 옆)에 추가:

```tsx
<textarea className="rework-input" placeholder="수정 요청 사항 (rework)" value={reworkText} onChange={e => setReworkText(e.target.value)} />
<button disabled={!reworkText.trim()} onClick={() => resolve('rework', reworkText)}>수정 요청</button>
```

(버튼·resolve 헬퍼는 기존 결재 버튼 관례를 따른다. `auditResult`(Task 14)가 있으면 지적사항 프리필: `setReworkText(issues.join('\n'))` 버튼 `심사 사유 불러오기`.)

- [ ] **Step 5: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(loop): L5 리뷰 수정요청(rework) — 지적사항으로 같은 worktree 재작업, 상한 2회"
```

### Task 16 (L6): 루프 성적표 — 통과율·재작업률·실패 사유 집계

**Files:**
- Create: `src/shared/loopstats.ts` (포맷 순수함수)
- Modify: `src/main/store.ts` (집계 쿼리), `src/main/manager.ts` (buildDigest 줄), `src/main/scheduler.ts:385-465` (주간 게이트), `src/main/briefing.ts:48-57` (status 배열)
- Test: `test/main/loopstats.test.ts` (신규)

**Interfaces:**
- Produces: `LoopStats = { days: number; total: number; done: number; error: number; cancelled: number; firstPass: number; reworked: number; topFailReasons: Array<[string, number]> }` (types.ts) · `loopStats(days?: number): LoopStats` (store) · `formatLoopStatsLine(s: LoopStats): string` (한 줄, 다이제스트용) · `formatLoopStatsReport(s: LoopStats): string` (문단, 주간용) — 모두 `src/shared/loopstats.ts` · 주간 워터마크 설정키 `loop_stats_week`.
- Consumes: `tasks`(state, auto_retry_count, rework_count, created_at) · `task_events`(kind='exit' exitReason, kind='status' '검증 실패%') · `buildDigest`(:238) · `runScanOnce`(:385, autoPriority 해시가드 :217 동형 게이트) · briefing status 배열(:48-57).

- [ ] **Step 1: 실패하는 테스트**

`test/main/loopstats.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { insertTask, updateTask, addTaskEvent, loopStats } from '../../src/main/store'
import { formatLoopStatsLine } from '../../src/shared/loopstats'

describe('loopStats', () => {
  it('done·1회통과·재작업·실패사유를 집계한다', () => {
    const a = insertTask({ projectId: 'demo', content: 'a', state: 'done' } as any)      // 1회 통과
    const b = insertTask({ projectId: 'demo', content: 'b', state: 'done' } as any)      // 재작업 후 완료
    updateTask(b, { reworkCount: 1 } as any)
    const c = insertTask({ projectId: 'demo', content: 'c', state: 'error' } as any)
    addTaskEvent(c, 'exit', 'error', 'worker')
    const s = loopStats(7)
    expect(s.total).toBeGreaterThanOrEqual(3)
    expect(s.done).toBeGreaterThanOrEqual(2)
    expect(s.firstPass).toBeGreaterThanOrEqual(1)
    expect(s.reworked).toBeGreaterThanOrEqual(1)
    expect(s.error).toBeGreaterThanOrEqual(1)
  })
  it('한 줄 포맷', () => {
    const line = formatLoopStatsLine({ days: 7, total: 12, done: 9, error: 2, cancelled: 1, firstPass: 7, reworked: 2, topFailReasons: [['verify', 2]] })
    expect(line).toContain('12')
    expect(line).toMatch(/통과|완료/)
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/main/loopstats.test.ts` → FAIL.

- [ ] **Step 3: 구현**

`src/shared/loopstats.ts`:

```ts
export interface LoopStats {
  days: number; total: number; done: number; error: number; cancelled: number
  firstPass: number; reworked: number; topFailReasons: Array<[string, number]>
}
export function formatLoopStatsLine(s: LoopStats): string {
  if (!s.total) return ''
  const rate = s.done ? Math.round((s.firstPass / s.done) * 100) : 0
  return `루프 ${s.days}일: 작업 ${s.total} · 완료 ${s.done}(1회 통과 ${rate}%) · 재작업 ${s.reworked} · 실패 ${s.error}`
}
export function formatLoopStatsReport(s: LoopStats): string {
  if (!s.total) return ''
  const reasons = s.topFailReasons.map(([k, n]) => `${k} ${n}건`).join(', ')
  return [formatLoopStatsLine(s), reasons ? `주요 실패 사유: ${reasons}` : ''].filter(Boolean).join('\n')
}
/** ISO 주차 문자열 'YYYY-Www' — 주간 워터마크 게이트용 */
export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}
```

`src/main/store.ts`:

```ts
export function loopStats(days = 7): LoopStats {
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  const row = db.prepare(`SELECT
      COUNT(*) total,
      SUM(state='done') done, SUM(state='error') error, SUM(state='cancelled') cancelled,
      SUM(state='done' AND COALESCE(auto_retry_count,0)=0 AND COALESCE(rework_count,0)=0) firstPass,
      SUM(COALESCE(rework_count,0)>0) reworked
    FROM tasks WHERE created_at >= ?`).get(since) as any
  const reasons = db.prepare(`SELECT content k, COUNT(*) n FROM task_events
    WHERE kind='exit' AND created_at >= ? AND content != 'done' GROUP BY content ORDER BY n DESC LIMIT 3`).all(since) as any[]
  return { days, total: row.total ?? 0, done: row.done ?? 0, error: row.error ?? 0, cancelled: row.cancelled ?? 0,
    firstPass: row.firstPass ?? 0, reworked: row.reworked ?? 0, topFailReasons: reasons.map(r => [r.k, r.n]) }
}
```

(tasks의 실제 시각 컬럼명(created_at)·exit content 포맷은 store.ts 실물로 확인해 WHERE를 맞춘다.)

- 다이제스트: `buildDigest`(:271 인근)에 `const ls = formatLoopStatsLine(loopStats(7)); if (ls) base += '\n' + ls`
- 주간 보고: `runScanOnce`(:436 인근 autoPriority 옆)에 ISO주 워터마크 게이트:

```ts
const week = isoWeekOf(new Date())  // 'YYYY-Www' 헬퍼 — loopstats.ts에 순수함수로 추가
if (getSetting('loop_stats_week') !== week) {
  const rep = formatLoopStatsReport(loopStats(7))
  if (rep) pushManagerNotice(`[주간 루프 성적표]\n${rep}`)
  setSetting('loop_stats_week', week)
}
```

- briefing.ts status 배열(:48-57)에 `formatLoopStatsLine(loopStats(7))` 항목 추가(빈 문자열이면 제외).

- [ ] **Step 4: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(loop): L6 루프 성적표 — 1회 통과율·재작업·실패 사유 집계 (다이제스트·주간·브리핑)"
```

### Task 17 (L3): 완료 조건 체크리스트(DoD) 구조화

**Files:**
- Modify: `src/main/orchestrator.ts` (clarifyAndLaunch :532-560, elicit 결과 영속), `src/main/store.ts` (tasks 컬럼), `src/shared/types.ts`, `src/main/worker.ts:389-419` (프롬프트), `src/main/audit.ts` (구조화 입력), `src/renderer/components/TaskDrawer.tsx` (체크리스트 표시)
- Test: `test/main/criteria.test.ts` (신규)

**Interfaces:**
- Produces: tasks 컬럼 `criteria TEXT`(JSON string[]) · `Task.criteria?: string[]` · `criteriaBlock(criteria: string[] | undefined): string` (worker 프롬프트용 순수, worker.ts export) · audit는 `task.criteria`가 있으면 content 파싱(extractCriteria) 대신 그것을 사용.
- Consumes: `elicit`(:111)의 `Elicited.criteria: string[]` (이미 존재 — 지금은 content append(:557-560)만 하고 버림) · Task 14의 `buildAuditPrompt(spec, criteria, …)`.

- [ ] **Step 1: 실패하는 테스트**

`test/main/criteria.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { criteriaBlock } from '../../src/main/worker'

describe('criteriaBlock', () => {
  it('체크리스트 블록을 만든다', () => {
    const b = criteriaBlock(['테스트 통과', '버튼 동작'])
    expect(b).toContain('## 완료 조건 체크리스트')
    expect(b).toContain('- [ ] 테스트 통과')
    expect(b).toMatch(/항목별로|모두 충족/)
  })
  it('없으면 빈 문자열', () => {
    expect(criteriaBlock(undefined)).toBe('')
    expect(criteriaBlock([])).toBe('')
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/main/criteria.test.ts` → FAIL.

- [ ] **Step 3: 구현**

- store.ts: `try { db.exec('ALTER TABLE tasks ADD COLUMN criteria TEXT') } catch {}` + rowToTask에서 `criteria: row.criteria ? JSON.parse(row.criteria) : undefined` (JSON.parse는 try/catch).
- types.ts: `Task.criteria?: string[]`.
- orchestrator `clarifyAndLaunch`: `## 합격 기준` append(:557-560) 시점에 함께 영속: `updateTask(taskId, { criteria: JSON.stringify(elicited.criteria) } as any)` (append도 유지 — 프롬프트 하위호환).
- worker.ts export 순수함수 + naviPrompt(:414 인근) 주입:

```ts
export function criteriaBlock(criteria: string[] | undefined): string {
  if (!criteria?.length) return ''
  return ['## 완료 조건 체크리스트', ...criteria.map((c) => `- [ ] ${c}`),
    '완료 보고 전에 항목별로 스스로 검증하고, 모두 충족했을 때만 done으로 보고하라. 미충족 항목은 blocked 사유에 명시하라.'].join('\n')
}
// naviPrompt 내: `${criteriaBlock(task.criteria)}` 를 lessonsBlock 옆에 추가
```

- audit.ts `auditTask`: `const criteria = task.criteria?.length ? task.criteria : extractCriteria(task.content)`.
- TaskDrawer 결재 패널: `task.criteria` 있으면 목록 표시(auditResult의 issues에 해당 기준 문구가 포함되면 ✗, 아니면 ✓ 표기 — 단순 includes 매칭, 순수 헬퍼로).

- [ ] **Step 4: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(loop): L3 완료 조건 체크리스트 — elicit criteria 영속·Navi 자기검증·심사 입력 구조화"
```

### Task 18 (L4): 리뷰 강도 다이얼 — light / standard / adversarial

**Files:**
- Modify: `src/main/audit.ts` (다중 렌즈+합의), `src/main/orchestrator.ts` (startTask opts·finishWork 분기), `src/main/manager.ts` (start_task 파라미터), `src/main/store.ts` (tasks 컬럼+기본 설정), `src/shared/types.ts`, `src/renderer/components/PrefsModal.tsx` (기본값 셀렉트)
- Test: `test/main/reviewdepth.test.ts` (신규)

**Interfaces:**
- Produces: `ReviewDepth = 'light' | 'standard' | 'adversarial'` (types.ts) · tasks 컬럼 `review_depth TEXT` · 설정 `reviewDepthDefault: ReviewDepth`(DB `review_depth_default`, 기본 `'standard'`) · `combineVerdicts(vs: AuditVerdict[]): AuditVerdict` (audit.ts 순수 — 과반 fail이면 fail, issues 합집합) · `AUDIT_LENSES: string[]` 3종 · `runAudit(task, worktreePath, depth): Promise<AuditVerdict | null>` (light→null, standard→1콜, adversarial→3콜 병렬+합의).
- Consumes: Task 14의 `auditTask` 골격 · `start_task` 도구(:726)와 `startTask` opts(:353).

- [ ] **Step 1: 실패하는 테스트 (합의 순수함수)**

`test/main/reviewdepth.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { combineVerdicts, AUDIT_LENSES } from '../../src/main/audit'

describe('combineVerdicts', () => {
  it('과반 fail이면 fail, issues 합집합', () => {
    const v = combineVerdicts([
      { pass: false, issues: ['A'] }, { pass: false, issues: ['B'] }, { pass: true, issues: [] },
    ])
    expect(v.pass).toBe(false)
    expect(v.issues).toEqual(['A', 'B'])
  })
  it('과반 pass면 pass', () => {
    expect(combineVerdicts([{ pass: true, issues: [] }, { pass: true, issues: [] }, { pass: false, issues: ['x'] }]).pass).toBe(true)
  })
  it('렌즈는 3종', () => { expect(AUDIT_LENSES.length).toBe(3) })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/main/reviewdepth.test.ts` → FAIL.

- [ ] **Step 3: audit.ts 확장**

```ts
export const AUDIT_LENSES = [
  '요구사항 대비: 지시와 다른 구현·빠진 요구가 없는지만 본다.',
  '완료 조건 대비: 완료 조건 각 항목이 실제로 충족됐는지만 본다.',
  '회귀·부작용: 변경이 기존 동작을 깨뜨릴 위험만 본다.',
]
export function combineVerdicts(vs: AuditVerdict[]): AuditVerdict {
  const fails = vs.filter((v) => !v.pass)
  const pass = fails.length <= vs.length / 2
  const issues = [...new Set(fails.flatMap((v) => v.issues))].slice(0, 10)
  return { pass, issues: pass ? [] : issues }
}
export async function runAudit(task: Task, worktreePath: string, depth: ReviewDepth): Promise<AuditVerdict | null> {
  if (depth === 'light') return null
  if (depth === 'standard') return auditTask(task, worktreePath)
  const vs = (await Promise.all(AUDIT_LENSES.map((lens) => auditTask(task, worktreePath, lens)))).filter((v): v is AuditVerdict => !!v)
  return vs.length ? combineVerdicts(vs) : null
}
```

(`auditTask`에 optional `lens?: string` 파라미터 추가 — buildAuditPrompt 서두에 `심사 렌즈: ${lens}` 한 줄 주입.)

- [ ] **Step 4: 배선**

- types.ts: `export type ReviewDepth = 'light' | 'standard' | 'adversarial'` + `Task.reviewDepth?: ReviewDepth` + LainSettings `reviewDepthDefault: ReviewDepth`.
- store.ts: tasks 컬럼 `review_depth TEXT` 마이그레이션 + rowToTask + getSettings/setSettings `review_depth_default`(기본 `'standard'`).
- orchestrator `startTask` opts에 `reviewDepth?: ReviewDepth` 추가, insertTask에 영속(미지정 시 설정 기본값).
- finishWork의 L1 호출(Task 14 Step 5)을 `runAudit(task, worktreePath, task.reviewDepth ?? s.reviewDepthDefault)` 로 교체.
- manager.ts `start_task` 도구 스키마에 `review_depth: z.enum(['light','standard','adversarial']).optional().describe('리뷰 강도 — adversarial은 3렌즈 심사(비용↑)')` 추가·전달.
- PrefsModal: 셀렉트 `기본 리뷰 강도` (경량/표준/적대) → `patch({ reviewDepthDefault })`.

- [ ] **Step 5: 검증 + Commit**

Run: 대상 테스트 PASS, `npm run typecheck` 0, `npx vitest run` 그린.

```bash
git add -A
git commit -m "feat(loop): L4 리뷰 강도 다이얼 — light/standard/adversarial 3렌즈 합의 심사"
```

**Phase P6 마감**: 변경 요약 한 줄 — `- 루프 엔지니어링: 실패 회고·독립 심사·rework·성적표·DoD 체크리스트·리뷰 다이얼 (P6)`.

---

## 마감 체크리스트 (전 Phase 완료 후)

- [ ] `npm run typecheck` 0 · `npx vitest run` 전체 그린 · `npm run build` 성공
- [ ] P2~P6 변경 요약 라인 누적 확인
- [ ] **사용자 확인 후**: 메인 체크아웃의 main 병합 → `npm run deploy` (워크트리 직접 배포 금지 — 비자손 가드)
- [ ] 라이브 검증 목록(자동 불가 — 사람): ①오버레이: 비개발 앱 무캡처·터미널 에러 조언 ②quips: task_done 말풍선 ③캐릭터 축소/부각 ④카드: 승인·CC 배지 ⑤adopt_cc_session 1건 ⑥rework 버튼 1회전 ⑦주간 성적표 통지

## 리스크 메모 (스펙 §8 대응)

- 플래너 제거는 Task 2 단독 커밋 — 문제 시 `git revert <sha>` 한 방.
- 설정키·테이블 잔존은 무해(allowlist 로드 실측 확인) — DROP 금지.
- L1/L4 judge 비용: audit는 diff stat+요약만 읽는 경량 프롬프트, adversarial은 opt-in.
- L5 폭주 방지: `REWORK_MAX=2` + 상한 도달 시 사람 결정 강제.
- 라인 앵커는 2026-07-18 실측 기준 — 실행 시점에 어긋나면 grep으로 재탐색(심볼명 우선).
