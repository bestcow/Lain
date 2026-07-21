# Phase 6 — 오케스트레이터 2단계 (D2 의존성 · D13 크로스레포 · D14 병렬 · D15 되감기) 설계

> 2026-07-08 설계 세션 산출물 — **사용자 확정**: ①범위 = 이번 세션 T1~T3, **T4(D13 그룹)는 다음 세션**(설계는 본 문서 §5 확정) ②D2 의존성 충족 기준 = **선행 done(병합·keep-branch 모두)**.
> 근거 감사: [2026-07-07-ux-orchestrator-audit.md](../2026-07-07-ux-orchestrator-audit.md) D2/D13/D14/D15.
> 라인 번호는 작성 시점 기준 — **구현 전 해당 파일 현재 상태 재확인 필수.** DB 변경은 전부 additive(기존 행 무손실).

## 0. 설계 원칙

- **기존 인프라 재사용이 핵심**: D1 대기 큐(queued 상태·drainQueue·selectQueuedToLaunch)·D8 rebase 폴백·revertMergeRange가 이미 있다. Phase 6은 대부분 "그 위에 게이트/정책 하나 얹기"다.
- 결정론 배관은 코드, 판단은 Claude(PLAN §4) — 의존성 충족 판정·그룹 병합 게이트·체크포인트는 전부 L0.
- 순수 함수 우선: 큐 선별·의존성 판정은 selectQueuedToLaunch처럼 주입 가능한 순수 함수로 만들어 단위 테스트.

## 1. 구현 순서 (의존 관계 기준)

| 순서 | 항목 | 크기 | 왜 이 순서 |
|---|---|---|---|
| T1 | **D15 되감기** | M | 완전 독립. 안전장치라 먼저 깔아두면 이후 작업(레인 직접 수정)에도 보험 |
| T2 | **D2 의존성** | M | 큐(D1) 위에 게이트 하나. D13이 개념적으로 이 위에 얹힘 |
| T3 | **D14 병렬 1단계** | M | 정책 완화 + 계수 일반화. D8(rebase 폴백)이 이미 병합 경로를 해결 |
| T4 | **D13 크로스레포 그룹** | L | 가장 큼. D14(프로젝트 다름=병렬 이미 허용)·D8(revert)를 조합 |

각 T는 독립 커밋 + typecheck/테스트. T4는 별도 세션으로 넘겨도 좋게 T1~T3과 결합도를 낮춘다.

---

## 2. T1 — D15 되감기: 레인 직접 편집의 턴 단위 체크포인트

**문제**: Navi 작업은 worktree 격리+폐기로 안전하지만, 레인이 `additionalDirectories`(manager.ts:2188)로 실레포를 직접 수정한 것은 되돌릴 수단이 전무.

### 데이터

- 신규 테이블 `edit_checkpoints` (additive):
  ```sql
  CREATE TABLE IF NOT EXISTS edit_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id TEXT NOT NULL,          -- 턴 식별자(아래) — 같은 턴의 편집 묶음
    conversation_id TEXT NOT NULL,
    file_path TEXT NOT NULL,        -- 대상 절대경로
    backup_path TEXT,               -- DATA_DIR/checkpoints/<turnId>/<seq> (NULL = 편집 전 파일 없었음 → 복원=삭제)
    tool TEXT NOT NULL,             -- Edit | Write
    created_at TEXT NOT NULL
  )
  ```
- 백업 본문은 DB가 아니라 파일(`DATA_DIR/checkpoints/<turnId>/NNN.bak`) — DB 비대화 방지. 시크릿 파일은 canUseTool의 blocksSecretFile이 이미 deny하므로 체크포인트에 도달하지 않는다(§9-6 유지).

### 배선 (manager.ts canUseTool)

- Edit/Write의 **최종 allow 직전**(A6 편집승인 카드·시크릿 deny 통과 후)에: 대상 파일 현재 내용을 백업 파일로 복사(존재 않으면 backup_path=NULL) + `edit_checkpoints` insert. 실패해도 편집은 진행(체크포인트는 best-effort, 로그만).
- `turn_id`: sendToManager 턴 시작 시 `t<epoch-ms>` 하나 생성해 클로저로 사용(이어가기 라운드 포함 = 한 사용자 턴 묶음). 기존 edit diff 카드 라인(encodeEditDiffLine, manager.ts:1444 부근)에 `turnId` 필드 추가 — 렌더러가 카드에서 턴을 알 수 있게.
- 파일 크기 상한(예: 2MB) 초과는 체크포인트 생략(+카드에 '체크포인트 없음' 표기).

### 복원

- 신규 IPC 3종(3곳 동기화): `edits:turnCheckpoints(turnId)`(목록) · `edits:revertTurn(turnId)`(복원) — 렌더러는 edit diff 카드의 컨텍스트 메뉴/버튼 "이 턴의 편집 N건 되돌리기".
- 복원 = 그 턴의 체크포인트를 **역순으로**: backup_path 있으면 내용 되쓰기, NULL이면 파일 삭제. 복원 전 CRT 확인창에 파일 목록 + ⚠"이 턴 이후 그 파일에 생긴 변경도 함께 사라진다" 경고. 복원 자체도 편집이므로 복원 직전 상태를 새 턴(`revert-of-<turnId>`)으로 다시 체크포인트 → **되돌리기의 되돌리기**가 가능(실수 방어).
- 레인 도구는 v1 비제공(사용자 전용 안전장치). 레인에게는 "복원은 사용자가 카드에서 한다"만 프롬프트에 한 줄.

### 보존 정책

- 부팅+주기 스캔에서 결정론 정리: 14일 경과 or checkpoints 총합 200MB 초과 시 오래된 턴부터 삭제(테이블 행도 함께). 상수로 시작, 필요시 설정 승격.

---

## 3. T2 — D2 작업 간 의존성 (dependsOn)

**문제**: "A 병합되면 B 시작" 연쇄를 레인 세션 기억으로 챙긴다 — 압축·재시작 시 유실.

### 데이터

- tasks에 `depends_on` TEXT DEFAULT '[]' (JSON 배열, additive). Task 인터페이스 `dependsOn: string[]`.

### 의미론 (결정론)

- **충족 = 선행 task가 `done`**. done은 ①병합 완료 ②keep-branch 둘 다 포함 — "작업이 종결됐다"가 기준. (병합 여부까지 조건화하면 keep-branch 결정이 후행을 영원히 잠근다. 후행 worktree는 착수 시점 main HEAD에서 분기하므로, 병합된 경우 자연히 선행 변경 위에서 시작한다.)
- 미충족 의존이 있는 task는 **`queued`에 머문다**(D1 큐 재사용 — 새 상태 없음). start_task가 shouldQueue 판정(orchestrator.ts:293)에 `depsUnmet` 조건 추가.
- 드레인 게이트: `drainQueue`가 selectQueuedToLaunch에 넘기기 **전에** `queuedTasks().filter(depsMet)` — 순수 함수 `depsMet(task, byId: Map<id, state>)` 신설(+테스트).
- **선행 실패(cancelled/error 확정)**: 후행은 자동 착수하지 않고 queued 유지 + 1회 통지(레인 채팅 tool 라인 + notifyUser: "선행 'A' 실패 — 대기 중 'B' 처리 필요"). 결정은 레인/사용자(cancelTask 또는 의존 해제). 자동 연쇄 취소는 하지 않는다(스펙상 후행이 독립 실행 가능할 수도).
- 의존 해제 도구: 기존 `reorder_queue` 옆에 `set_task_deps(task_id, depends_on)` 추가(빈 배열=해제). 사이클·자기참조·없는 id는 insert/set 시점에 거부(DFS, N 작음).

### 착수 트리거

- done 전이 지점(resolveReview 병합/keep-branch)에서 `drainQueue()` 호출 확인(§Phase4 C2가 5곳 심었음 — done 경로 누락 시 추가).
- 크래시 복원: queued+deps는 영속이라 부팅 drainQueue가 자연 재평가.

### 도구·UI

- `start_task`에 `depends_on?: string[]` 파라미터(직전 start_task 반환 taskId로 체인 구성 — 프롬프트에 사용법 1줄: "A 끝나면 B" 요청은 B를 depends_on:[A]로 즉시 등록하라, 기억에 남기지 말고).
- list_tasks 출력에 `deps: [...] (미충족 n)` 노출. NaviTile 큐 배지 툴팁·TaskDrawer에 "⏳ 선행: <제목>(상태)" 라인.
- '플랜 영속 객체'(감사 D2 후반부)는 **비범위** — dependsOn 체인 + queued 영속으로 순차 플랜은 이미 표현된다. 조건분기 플랜은 v2.

---

## 4. T3 — D14 같은 프로젝트 병렬 (1단계)

**문제**: activeTaskForProject 검사(orchestrator.ts:290)가 프로젝트당 활성 1개를 강제. worktree는 taskId별 독립이라 기술적으론 이미 가능.

### 정책

- 설정 `projectParallelCap: number` (기본 **1** = 현행 동작 그대로, opt-in으로 2~4). 전역 concurrencyCap은 그대로 상위 한도.
- startTask 게이트: `projectBusy = activeCountForProject(projectId) >= projectParallelCap`.
- selectQueuedToLaunch 일반화: `activeProjectIds: Set` → `activeCountByProject: Map<string, number>` + cap 파라미터(순수 함수 시그니처 변경 — 콜러 1곳·테스트 갱신). 로컬 계수 방식(착수분 즉시 반영)은 유지.

### 병합·충돌

- 새 메커니즘 불필요: 먼저 결재된 게 ff 병합 → 뒤 작업은 ff 실패 → **D8 autoRebaseOnMerge**가 main 위로 rebase→verify 재실행→ff 재시도, 충돌 시에만 "브랜치만 남김"으로 사람에게. 이미 구현·테스트된 경로.
- 파일 영역 겹침 판정은 **하지 않는다**(결정론으로 불가능한 예측) — 대신 위 rebase/verify가 사후 판사. 겹치는 작업을 병렬로 던질지는 레인 판단(프롬프트에 1줄: 같은 파일을 만질 두 작업은 병렬 대신 depends_on 체인 권장).

### 파급 조사 (구현 시 전수 확인 필수)

- `activeTaskForProject` 콜러 전수 grep — 특히 **message_navi 라우팅**(프로젝트의 "그" Navi 전제)·NaviTile activeTaskOf(App.tsx)·다이제스트. 병렬 2개면: message_navi는 task_id 옵션 파라미터 추가(생략+복수면 목록 반환해 레인이 재호출), 타일은 대표 1개(최신 working)+`+n` 배지.
- 2단계(fan-out/fan-in 서브태스크 분해)는 **v2 비범위**.

---

## 5. T4 — D13 크로스레포 작업 그룹

**문제**: 공용 타입 변경+소비자 레포 2곳 수정 같은 요청은 레인이 수동 분해·수동 정합 — 한쪽만 병합되는 반쪽 상태 위험.

### 데이터

- 신규 테이블 `task_groups(id TEXT PK, title TEXT, spec TEXT, created_at TEXT)` + tasks에 `group_id TEXT NULL` (additive).

### 생성 (레인 도구)

- `start_task_group(title, spec, children:[{project_id, content}...])`: 그룹 insert → child task를 프로젝트별 startTask로 생성(content = 공유 spec + "\n\n## 이 레포 몫\n" + child content). 서로 다른 프로젝트라 병렬 착수는 현행 정책으로도 가능(cap 내). 그룹 내 순서 필요하면 children이 depends_on 조합(T2 재사용).

### 결재 — all-or-nothing

- child 각각 verify→review는 현행 그대로. **그룹 병합 게이트**: 모든 child가 `review`+verify pass여야 그룹 병합 가능. resolve_review가 group_id 있는 task를 받으면 "그룹 소속 — resolve_group을 써라" 에러(개별 병합 봉쇄; discard는 개별 허용).
- `resolve_group(group_id, 'merge'|'discard'|'keep-branch')`: merge는 child를 **순차 병합**(기존 tryMerge+D8 rebase 폴백 재사용). **중간 실패 시 이미 병합된 child를 revertMergeRange(D8)로 자동 롤백** 후 전체 실패 보고 — 반쪽 상태 원천 차단. discard/keep-branch는 전 child 일괄.
- UI: TaskDrawer에 "그룹: <title> (m/n review)" 라인 + 그룹 결재 버튼(모든 child 카드에서 접근, 결재 다이얼로그에 전 child diffStat 합산 표시). 결재함(AttentionInbox)은 그룹을 1건으로 묶어 표기.

### 한계 (명시)

- child 간 인터페이스 정합은 공유 spec 주입까지 — 교차 diff 참조·그룹 통합 verify는 v2.
- 그룹은 서로 다른 프로젝트 전제(같은 프로젝트 2 child는 T3 정책을 따름).

---

## 6. 공통 — 테스트·회귀 포인트

- 순수 함수 신설분(depsMet·selectQueuedToLaunch 일반화·그룹 병합 게이트 판정) 단위 테스트 필수.
- 기존 테스트 회귀 주의: selectQueuedToLaunch 시그니처 변경(테스트 존재), slotOccupyingCount/capRoom(불변), recoverTasks(queued 보존).
- IPC 추가 시 ipc/preload/types 3곳 동기화. DB는 CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN(기존 마이그레이션 패턴 따름).
- ⚠ 리뷰 제약: 서브에이전트 월 한도로 독립 리뷰 불가할 수 있음 — quips와 동일하게 자가리뷰+테스트로 진행하고 장부에 명시, 한도 해제 후 일괄 재리뷰.

## 7. 비범위 (v2+)

- 플랜 영속 객체(조건분기 다단계) · D14 2단계 fan-out/fan-in · 그룹 통합 verify/교차 diff · 파일 영역 겹침 예측 · 그룹의 텔레그램 전용 UI(기존 결재 버튼은 그룹 결재 1건으로 미러).
