# 레인 단일세션 레이아웃 (상하분할 + 4열 타일) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(권장) 또는 superpowers:executing-plans 로 태스크 단위 실행. 체크박스(`- [ ]`)로 추적.

**Goal:** 레인이 단일 총괄 세션이 된 것에 맞춰, `보드/리스트` 토글을 없애고 화면을 위(프로젝트 타일 4열)·아래(레인 채팅 고정)로 분할한다.

**Architecture:** `.body`를 좌우 컬럼/뷰토글 구조에서 **세로 2분할**(top-zone / 드래그 divider / lain-zone)로 재편한다. top-zone은 기본 = 4열 `NaviTile` 그리드, Navi 클릭 시 = 그 Navi 워크스페이스(세션목록+NaviChatPanel, A안). lain-zone은 **항상 레인**(브리프 헤더 + `ChatPanel`(manager) + 레인 입력)으로 하단 고정. 보드 전용(`BoardField`)과 리스트 카드(`ProjectCard`)는 단일 `NaviTile`로 대체.

**Tech Stack:** React 18 + TypeScript, electron-vite, 기존 CSS(`styles.css`, CRT 보라 네온), vitest.

## Global Constraints

- 단일세션 변경은 **레인(manager) 전용**. Navi는 다중세션 그대로 — `SessionList`/`NaviChatPanel`/drill 유지.
- L0(store/ipc/collectors)에 LLM 호출 금지 — 이 작업은 전부 `src/renderer/`만 건드린다(IPC 계약 변경 없음).
- 검증: 변경마다 `npm run typecheck`(워크트리는 메인 체크아웃의 `node_modules/typescript/bin/tsc --noEmit`을 직접 실행) + `npm test`. 레이아웃은 단위테스트 불가 → **Electron capturePage 목업 캡처**(`shot2.js` 패턴, 실 `styles.css` 링크)로 시각 검증.
- 코드 끝내기 전 `npm run deploy`로 설치본 반영(build만으론 아이콘 옛버전). 워크트리 작업은 배포 전 메인 체크아웃의 main에 ff 병합.
- 색·상태는 기존 `--st-*`/`naviStatus()` 단일 출처 재사용. 새 색 도입 금지.

---

## 파일 구조

- **신규** `src/renderer/components/NaviTile.tsx` — 프로젝트 1개 = 아이콘(좌, 상태색 `ProjectSprite`) + 텍스트(우: 이름·상태 / 메타 / 액션). 클릭 → `onFocus(projectId)`. 우클릭 메뉴·호버 제거·unread dot 포함.
- **신규** `src/renderer/lib/useSplitRatio.ts` — top/bottom 분할 비율 상태 훅(localStorage 영속, 드래그 핸들러 제공). 순수 로직은 `clampRatio` 분리해 단위테스트.
- **수정** `src/renderer/App.tsx` — `.body` 세로 2분할로 재편, `view` 토글 제거, top-zone(그리드/Navi워크스페이스 분기) + lain-zone(고정 레인), 입력 라우팅 분리(하단=manager, top Navi=navi).
- **수정** `src/renderer/styles.css` — `.body`/`.body-board` grid-areas 제거 → 세로 flex 2분할 + `.split-divider` + `.top-zone`/`.lain-zone` + `.navi-tile*` + 4열 그리드.
- **제거** `src/renderer/components/BoardField.tsx`(보드 전용), `src/renderer/components/ProjectCard.tsx`(리스트 카드) — `NaviTile`로 대체. `StageView.tsx`의 `naviStatus`는 유지(NaviTile이 사용).
- **수정** `test/renderer/` — 제거 컴포넌트 관련 테스트 정리, `clampRatio`/`NaviTile` 순수부 테스트 추가.

> top-zone의 Navi 워크스페이스는 기존 `SessionList`(드릴다운)+`NaviChatPanel`을 그대로 재배치(신규 컴포넌트 없이 위치만 이동).

---

### Task 1: `useSplitRatio` 훅 + `clampRatio` 순수함수

**Files:**
- Create: `src/renderer/lib/useSplitRatio.ts`
- Test: `test/renderer/useSplitRatio.test.ts`

**Interfaces:**
- Produces: `clampRatio(r: number): number` (0.2~0.8 클램프), `useSplitRatio(key='lain.splitRatio'): { ratio:number; onDragStart:(e)=>void }` — ratio=top 영역 비율.

- [ ] **Step 1: 실패 테스트**

```ts
import { describe, it, expect } from 'vitest'
import { clampRatio } from '../../src/renderer/lib/useSplitRatio'
describe('clampRatio', () => {
  it('범위 안은 그대로', () => expect(clampRatio(0.5)).toBe(0.5))
  it('하한 0.2', () => expect(clampRatio(0.05)).toBe(0.2))
  it('상한 0.8', () => expect(clampRatio(0.95)).toBe(0.8))
})
```

- [ ] **Step 2: 실패 확인** — `node <메인 체크아웃>/node_modules/vitest/vitest.mjs run test/renderer/useSplitRatio.test.ts` → FAIL(미정의).

- [ ] **Step 3: 구현**

```ts
import { useCallback, useEffect, useState } from 'react'

export function clampRatio(r: number): number {
  return Math.max(0.2, Math.min(0.8, r))
}

// top-zone이 차지하는 세로 비율(0.2~0.8). 드래그로 조절, localStorage 영속.
export function useSplitRatio(key = 'lain.splitRatio') {
  const [ratio, setRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? clampRatio(v) : 0.5
  })
  useEffect(() => { localStorage.setItem(key, String(ratio)) }, [key, ratio])

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const body = (e.currentTarget as HTMLElement).parentElement
    if (!body) return
    const rect = body.getBoundingClientRect()
    const move = (ev: MouseEvent) => setRatio(clampRatio((ev.clientY - rect.top) / rect.height))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  return { ratio, onDragStart }
}
```

- [ ] **Step 4: 통과 확인** — 위 vitest → PASS.

- [ ] **Step 5: 커밋** — `git add src/renderer/lib/useSplitRatio.ts test/renderer/useSplitRatio.test.ts && git commit -m "feat(ui): top/bottom 분할 비율 훅 + clampRatio"`

---

### Task 2: `NaviTile` 컴포넌트 (아이콘좌 / 텍스트우)

**Files:**
- Create: `src/renderer/components/NaviTile.tsx`
- Reference(읽기): `src/renderer/components/ProjectCard.tsx`(현 카드가 쓰는 props·필드·핸들러 그대로 차용), `src/renderer/components/StageView.tsx`(`naviStatus`), `src/shared/types.ts`(`ProjectView`/status 필드명 확인)

**Interfaces:**
- Consumes: `naviStatus(p, task)` → `{cls,label,prio,kind}`; `ProjectSprite`(아이콘); `ProjectView`, `Task`.
- Produces: `NaviTile` props = `{ project, task, focused, unread, preview, onFocus(id), onOpenTask(id), onStartTask(id), onContextMenu(e,p), onRequestRemove(p) }` — ProjectCard와 동일 시그니처(라우팅 재사용).

- [ ] **Step 1: 컴포넌트 작성** (실 데이터 필드는 ProjectCard에서 확인해 일치시킬 것)

```tsx
import type { ProjectView, Task } from '../../shared/types'
import { ProjectSprite } from './projectSprite'
import { naviStatus } from './StageView'

interface Props {
  project: ProjectView
  task: Task | null
  focused: boolean
  unread: boolean
  onFocus: (id: string) => void
  onOpenTask: (taskId: string) => void
  onStartTask: (id: string) => void
  onContextMenu?: (e: React.MouseEvent, p: ProjectView) => void
  onRequestRemove?: (p: ProjectView) => void
}

export function NaviTile({ project: p, task, focused, unread, onFocus, onOpenTask, onStartTask, onContextMenu, onRequestRemove }: Props) {
  const st = naviStatus(p, task)
  const s = p.status
  const meta = [s?.stack, s?.branch, s ? `변경 ${s.dirtyFiles}` : null].filter(Boolean).join(' · ')
  return (
    <div
      className={`navi-tile ${st.cls} sw-${st.kind}${focused ? ' navi-tile-focused' : ''}`}
      onClick={() => onFocus(p.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, p) : undefined}
      title={`${p.name} — 클릭해 직통 대화 (${st.label})`}
    >
      {onRequestRemove && (
        <button className="navi-remove" aria-label={`${p.name} 제거`} onClick={(e) => { e.stopPropagation(); onRequestRemove(p) }}>✕</button>
      )}
      <span className="nt-icon"><ProjectSprite project={p} px={4} /></span>
      <div className="nt-body">
        <div className="nt-row1">
          <span className="nt-name">{p.name}{unread && <span className="unread-dot" />}</span>
          <span className={`nt-state ${st.cls}`}><span className="status-dot" />{st.label}</span>
        </div>
        <div className="nt-meta">{meta || '미수집'}</div>
        <div className="nt-acts">
          <button onClick={(e) => { e.stopPropagation(); task ? onOpenTask(task.id) : onStartTask(p.id) }} disabled={!task && !s?.hasTaskMd}>
            {task ? '콘솔' : '▶ 작업'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: CSS 추가** — `src/renderer/styles.css` 끝에:

```css
.top-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 10px; overflow-y: auto; align-content: start; }
.navi-tile { position: relative; display: flex; gap: 8px; min-width: 0; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); padding: 8px 9px; cursor: pointer; transition: border-color .12s, background .12s; }
.navi-tile:hover { border-color: var(--border-strong); background: var(--surface-2); }
.navi-tile-focused { border-color: var(--signal); box-shadow: 0 0 8px rgba(177,140,240,.35); }
.nt-icon { flex: 0 0 auto; align-self: center; }
.nt-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.nt-row1 { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.nt-name { font-size: 12px; color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nt-state { font-size: 9.5px; display: flex; align-items: center; gap: 3px; white-space: nowrap; }
.nt-meta { font-size: 9.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nt-acts { display: flex; gap: 4px; margin-top: 3px; }
.nt-acts button { font-size: 9.5px; border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; background: transparent; color: var(--text-3); }
.nt-acts button:disabled { opacity: .35; }
```

- [ ] **Step 3: typecheck** — `node <메인 체크아웃>/node_modules/typescript/bin/tsc --noEmit` → 0. (ProjectView 필드명 불일치 시 `shared/types.ts` 보고 수정.)

- [ ] **Step 4: 시각 확인** — `shot2.js` 패턴으로 NaviTile 4열 그리드를 실 `styles.css` 링크해 capturePage → PNG 확인(아이콘좌·텍스트우·상태색·4열).

- [ ] **Step 5: 커밋** — `git commit -m "feat(ui): NaviTile(아이콘좌/텍스트우) + 4열 그리드 CSS"`

---

### Task 3: `.body` 세로 2분할 + 드래그 divider + 토글 제거

**Files:**
- Modify: `src/renderer/App.tsx` — `view` state(80) 제거, 타이틀바 토글(1041~1049) 제거, `act:board`/`act:list` 팔레트(820~821) 제거, `.body`(1109) 구조 교체.
- Modify: `src/renderer/styles.css` — `.body`/`.body-board`/grid-areas/`.sidebar`/`.lain-dock`/`.chat-col` → 세로 flex 2분할로 교체.

**Interfaces:**
- Consumes: `useSplitRatio`(Task 1).
- Produces: `.body`= `flex-direction:column`; 자식 `.top-zone`(flex: ratio) · `.split-divider`(드래그) · `.lain-zone`(flex: 1-ratio).

- [ ] **Step 1:** `App.tsx`에서 `view`/`setView`(80) 및 타이틀바 토글 버튼(1041~1049)·팔레트 뷰항목(820~821) 삭제. `const { ratio, onDragStart } = useSplitRatio()` 추가.

- [ ] **Step 2:** `.body` JSX를 세로 2분할로 교체 — 골격:

```tsx
<div className="body">
  <section className="top-zone" style={{ flexBasis: `${ratio * 100}%` }}>
    {/* Task 4: 그리드 ↔ Navi 워크스페이스 분기 */}
  </section>
  <div className="split-divider" onMouseDown={onDragStart} title="드래그로 높이 조절" />
  <section className="lain-zone" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
    {/* Task 5: 레인 헤더 + ChatPanel(manager) + 입력 */}
  </section>
</div>
```

- [ ] **Step 3:** `styles.css` — 기존 `.body`(grid)·`.body-board`·grid-areas 규칙 제거 후:

```css
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.top-zone { min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.lain-zone { min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-top: 1px solid var(--border); }
.split-divider { height: 6px; flex: 0 0 6px; cursor: row-resize; background: transparent; border-top: 1px solid var(--border-strong); }
.split-divider:hover { background: rgba(177,140,240,.18); }
```

- [ ] **Step 4: typecheck + 빌드** — tsc 0; `npm run build`로 렌더 번들 에러 0(JSX/제거 잔재 확인).

- [ ] **Step 5: 커밋** — `git commit -m "feat(ui): body 세로 2분할 + 드래그 divider, 보드/리스트 토글 제거"`

---

### Task 4: top-zone — NaviTile 4열 그리드 + Navi 포커스 분기

**Files:**
- Modify: `src/renderer/App.tsx` — top-zone 내부. `focusNavi` state 신설(= 위에서 연 Navi, null이면 그리드). 기존 `drillTarget`/`openDrill`/`closeDrill`을 top-zone 기준으로 재사용.

**Interfaces:**
- Produces: `const [focusNavi, setFocusNavi] = useState<string|null>(null)`; 그리드 타일 `onFocus={(id)=>setFocusNavi(id)}`.

- [ ] **Step 1:** top-zone 렌더: `focusNavi == null`이면 `NaviTile` 그리드(`enabled` 정렬 + `＋내비추가` 타일 + 대기실), 아니면 그 Navi 워크스페이스(`SessionList` 헤더 ◄뒤로(`setFocusNavi(null)`) + `NaviChatPanel` + Navi 입력). 기존 list-grid(1154~1216)·`BoardField`(1143~1152) 블록을 이 분기로 대체.

```tsx
{focusNavi == null ? (
  <div className="top-grid">
    {projects.filter(p=>p.enabled)
      .map(p=>({p,prio:naviStatus(p,activeTaskOf(p.id)).prio})).sort((a,b)=>a.prio-b.prio)
      .map(({p})=>(
        <NaviTile key={p.id} project={p} task={activeTaskOf(p.id)} focused={false}
          unread={unread.has(p.id)} onFocus={setFocusNavi}
          onOpenTask={openTask} onStartTask={startTask}
          onContextMenu={openNaviMenu} onRequestRemove={requestRemove} />
      ))}
    <button className="add-navi-tile" onClick={()=>window.lain.addProjectDialog()}>＋ 내비 추가</button>
    {/* 대기실: 기존 wait-room 블록 유지(NaviTile로 렌더) */}
  </div>
) : (
  /* Navi 워크스페이스 — Task 5에서 NaviChatPanel + 입력 이동 */
)}
```

- [ ] **Step 2: typecheck** → 0.

- [ ] **Step 3: 시각 확인** — capturePage 목업으로 4열 그리드 + 포커스 시 워크스페이스 전환 확인.

- [ ] **Step 4: 커밋** — `git commit -m "feat(ui): top-zone NaviTile 그리드 + Navi 포커스 분기(A안)"`

---

### Task 5: lain-zone 고정(레인 헤더+ChatPanel+입력) + 입력 라우팅 분리

**Files:**
- Modify: `src/renderer/App.tsx` — 핵심 재배선. 현 `lain-dock`(1222~1268, 브리프) → lain-zone 헤더로 이동. `chat-col`(1271~)의 `ChatPanel`(manager) → lain-zone. Navi용 `NaviChatPanel`·입력 → top-zone 워크스페이스(Task 4). 입력 핸들러(`sendMessage`/`onInputChange`, 639~728)를 **하단=manager 전용 / top Navi=navi 전용**으로 분리.

**Interfaces:**
- Consumes: 기존 `ChatPanel`/`NaviChatPanel`/`SessionList`/브리프 변수(`briefing`,`enabled`,`workingCount`,`dirtyCount`,`attnTotal`…).
- 불변식: 하단 입력 → 항상 `sendToManager`(manager). top Navi 입력 → `sendToNavi`(focusNavi). `chatTarget` 전환식 단일 패널 모델 폐기.

- [ ] **Step 1:** lain-zone에 레인 헤더(아바타+브리프, 기존 mgr-* 마크업 이동) + `<ChatPanel … target="manager">` + 하단 입력(manager 고정) 배치. `mgr-avatar` 클릭으로 대화 여는 동작 제거(이미 하단 상주).

- [ ] **Step 2:** top-zone 워크스페이스(focusNavi≠null)에 `NaviChatPanel`(focusNavi) + 그 Navi 전용 입력 + `SessionList` 드릴다운 헤더 배치.

- [ ] **Step 3:** 입력/이벤트 재배선 — `chatTarget` 의존 분기를 두 표면으로 분리: 하단 sendMessage→manager(openConv=manager 대화), top sendMessage→navi(focusNavi). 드래프트 키(`draftKey` 139~)·unread(191,328)·event 라우팅(260~328)을 두 표면 기준으로 갱신. `@all` 브로드캐스트는 하단(레인) 입력의 슬래시/명령으로 유지.

- [ ] **Step 4: typecheck + build** → 0. 런타임 회귀(이벤트 미수신·이중표시) 점검: `npm run build` 후 dev 훅으로 매니저 1턴·Navi 1턴 메시지 수신 확인.

- [ ] **Step 5: 커밋** — `git commit -m "feat(ui): lain-zone 하단 고정(레인 헤더+채팅+입력), 입력 라우팅 2표면 분리"`

---

### Task 6: 죽은 코드 제거 + 테스트 정리

**Files:**
- Remove: `src/renderer/components/BoardField.tsx`, `src/renderer/components/ProjectCard.tsx`.
- Modify: `src/renderer/App.tsx`(import·잔여 참조 제거), `src/renderer/components/StageView.tsx`(naviStatus 유지 확인), `test/renderer/*`(제거 컴포넌트 테스트 정리).
- Modify: `src/renderer/styles.css` — `.board-*`/`.navi-corner`/`.nframe-*`/구 `.grid`·`.card*`·`.lain-dock`·`.chat-col` 등 미사용 규칙 제거.

- [ ] **Step 1:** `BoardField`/`ProjectCard` import·사용 0 확인 후 파일 삭제. `tsc --noUnusedLocals` 로 잔재 정리.
- [ ] **Step 2:** 관련 테스트(`test/renderer/projectSprite.test.ts`는 유지; ProjectCard/BoardField 의존 테스트 있으면 제거/이관).
- [ ] **Step 3: typecheck 0 · `npm test` 그린.**
- [ ] **Step 4: 커밋** — `git commit -m "chore(ui): BoardField·ProjectCard 제거(NaviTile 대체) + 미사용 CSS/테스트 정리"`

---

### Task 7: 통합 검증 + 배포

- [ ] **Step 1:** `node <메인 체크아웃>/node_modules/typescript/bin/tsc --noEmit` → 0 · `node <메인 체크아웃>/node_modules/vitest/vitest.mjs run` → 그린.
- [ ] **Step 2: 시각 검증** — 메인 체크아웃 main에 ff 병합 후 `npm run dev`(또는 capturePage)로 실제 화면 확인: 상하분할·4열 타일·드래그 divider·레인 하단 고정·Navi 클릭 시 위에서 열림.
- [ ] **Step 3:** `HANDOFF.md` 엔트리 추가(2026-06-24 레이아웃 재구성) + 커밋.
- [ ] **Step 4:** `C:\lain` main ff 병합 → `npm run deploy`(설치본 갱신·재시작) → lain 실행 확인.

---

## Self-Review

- **Spec 커버리지:** 상하분할(T3)·레인 하단 고정(T5)·4열 타일(T2,T4)·아이콘좌/텍스트우(T2)·토글 제거(T3)·Navi직통 A안(T4,T5)·드래그 divider(T1,T3)·죽은코드 정리(T6)·검증/배포(T7). 누락 없음.
- **위험(중요):** T5가 핵심·고위험 — `chatTarget` 단일패널 모델을 2표면으로 쪼개는 재배선이라 이벤트 라우팅/드래프트/unread 회귀 가능. 실행 시 해당 핸들러(App.tsx 139~,191~,260~328,639~728)를 먼저 정독하고 표면별로 분리. 회귀 시 dev 훅으로 매니저/Navi 메시지 수신 실측.
- **타입 일관성:** `NaviTile` props는 `ProjectCard` 시그니처 차용 — 실행 시 ProjectCard·ProjectView 필드명 대조 필수(`status.stack/branch/dirtyFiles/testState/hasTaskMd`).
- **플레이스홀더:** T5 Step3은 "재배선" 서술 — 실행자가 해당 라인 정독 후 표면별 분리(현 코드 의존이라 사전 코드 박제 불가, 앵커 명시함).
