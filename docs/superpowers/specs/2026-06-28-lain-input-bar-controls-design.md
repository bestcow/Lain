# lain 입력창 컨트롤 바 + 사용량 팝업 — 설계

> 2026-06-28. 레인 채팅 입력창 밑에 Claude Code식 컨트롤 바(모델·권한·모드)와, 우측 상태 원 클릭 시 사용량 팝업을 둔다. 환경설정을 열지 않고도 레인의 모델/권한/추론/빠른모드·작업 기본값을 즉시 바꾸고, 컨텍스트·토큰·계정 한도를 한눈에 본다.

## 1. 범위

- **슬라이스 1 (이번)**: 입력창 컨트롤 바.
- **슬라이스 2 (다음)**: 우측 원 → 사용량 팝업(실험적 usage API 실측 후).

## 2. 배경 — 이미 있는 것 (재사용)

lain은 task(Navi) 레벨에 이 옵션들을 **이미 구현**했다 — 레인 채팅(manager)에만 안 붙어 있다:

- 타입: `TaskPermissionMode = 'default'|'acceptEdits'|'bypass'`, `ThinkingLevel = 'default'|'off'|'auto'|'high'` (`src/shared/types.ts:65,69`)
- `thinkingOption(level)` → SDK thinking config (`src/main/worker.ts:40`)
- 빠른 모드: `settings: { fastMode: true }` (`worker.ts:540`)
- bypass 절충: SDK엔 `acceptEdits`로 주고 **시크릿·spec-gaming 차단은 유지** (`worker.ts:532,654`)
- task UI 컨트롤: `TaskDrawer.tsx:302/315/334` (권한/thinking/fast 셀렉트)
- 레인 현재 고정: `manager.ts:990` `permissionMode: 'acceptEdits'`, thinking·fast 미적용
- 토큰 수집: `sumUsageTokens(msg)` (`worker.ts:54`), ChatEvent `{kind:'result', tokens, costUsd}` (`types.ts:313`)
- 모델 ID 매핑: `src/shared/models.ts` `modelId()` (2026-06-28 신설, UI에 실제 ID 표시)

## 3. 컨트롤 설계

| 컨트롤 | 적용 대상 | 저장 | 배선 지점 | 재사용/신규 |
|---|---|---|---|---|
| 모델 | 레인 채팅 | `managerModel` (기존) | `manager.ts:991` `model: modelId(...)` | 재사용 |
| 권한 모드 | 레인 채팅 | `managerPermissionMode` (신규 settings) | `manager.ts:990` permissionMode | 패턴 재사용 + **plan 신규** |
| 빠른 모드 | 레인 채팅 | `managerFastMode` (신규) | manager query `settings.fastMode` | 재사용 |
| 추론 강도 | 레인 채팅 | `managerThinkingLevel` (신규) | `thinkingOption()` (공용화) | 재사용 |
| 작업 방식(자동/대화형) | 다음 작업 기본값 | `defaultTaskMode` (신규) | `orchestrator.decideMode`/`startTask` | 신규 배선 |
| 동시 작업 수 | 전역 | `concurrencyCap` (기존) | orchestrator/navichat (기존) | UI 위치만 |

**적용 대상이 셋으로 갈림을 UI에서 흐리지 않는다**: ①레인 채팅(모델·권한·빠른·추론) ②다음 작업 기본(작업 방식) ③전역(동시 수). 슬라이스 1은 동일 바에 두되 그룹/툴팁으로 구분.

## 4. 권한 모드 4단

`요청(default) / 편집 수락(acceptEdits) / 계획(plan) / 건너뛰기(bypass)` 순환·드롭다운.

- `TaskPermissionMode`에 **`'plan'` 추가**(레인·task 공용 타입). store rowToTask 화이트리스트·insertTask·updateTask 동기화.
- **bypass**: 기존 절충 그대로 — SDK엔 `acceptEdits`, 시크릿·테스트 파일 차단은 canUseTool에서 유지(PLAN §9-6). "완전 bypass"는 채택 안 함.
- **plan (신규·실측)**: SDK `permissionMode:'plan'` → 모델이 계획을 제시하고 실행 보류. **구현 전 실측**(PLAN §18): 레인 세션에서 plan 모드가 무엇을 반환하고(ExitPlanMode 등) 어떻게 "수락 시 실행"으로 잇는지. HANDOFF "레인 plan 모드 갭" 해소.
- **요청 (default·실측)**: 레인이 도구 사용 시 승인. 레인 채팅에 인라인 승인 흐름이 있는지 실측 — 없으면 task 승인 큐(`§9-4`) 패턴 차용 여부를 plan과 함께 결정.
- "자동 모드"는 `acceptEdits`로 통합(사용자 확인됨).

## 5. 데이터 / 저장

- **store**: settings 4필드 **비파괴 추가** — `manager_permission_mode`·`manager_fast_mode`·`manager_thinking_level`·`default_task_mode`. `getSettings()`/`saveSettings()` + `LainSettings` 타입(`types.ts`). 기본값: 권한=`acceptEdits`(현행 유지), fast=off, thinking=`default`, 작업방식=`auto`(현 decideMode 자동판정 유지).
- **thinkingOption 공용화**: `worker.ts`에서 공용 모듈(`src/main/agentopts.ts` 신설 또는 manager가 worker에서 import)로 이동 — manager·worker 공유. 기존 worker 동작 회귀 0.
- **manager query 조립**: permissionMode(bypass 절충 동일 함수)·`...thinkingOption(managerThinkingLevel)`·`...(managerFastMode ? {settings:{fastMode:true}} : {})`를 `manager.ts:990` 옵션에 추가. 옵션 조립을 **순수 헬퍼**로 빼 단위 테스트 가능하게.
- **라이브 반영**: `getSettings()`는 매 턴 DB를 읽으므로(라이브) 변경은 레인 다음 턴부터 즉시 적용(재시작 불필요).

## 6. IPC

기존 `settings:get`/`settings:set` 재사용 — 새 필드는 `LainSettings`에 얹히므로 **추가 채널 불필요**. 3곳 동기화(`shared/types.ts` 필드 추가 / `store.ts` get·save / 렌더러 patch)만.

## 7. UI 레이아웃

`App.tsx` footer `input-row`(:1765~) **아래 새 행** `input-modebar`:

```
[권한 ▾]                          [모델 ▾] [⚡빠른] [🧠추론 ▾] [작업방식 ▾] [동시 ▾] [○]
└ 좌측(Claude Code 권한 자리)        └ 우측(모델·모드)                        상태원→슬라이스2
```

- 셀렉트/토글은 `TaskDrawer`의 컨트롤 패턴 재사용. 모델 드롭다운은 `modelId()`로 실제 ID 병기.
- 변경 즉시 `setSettings` IPC. 레인 전용 표면이라 NaviChatPanel엔 추가하지 않음.

## 8. 안전

- bypass는 시크릿·테스트 차단 유지(PLAN §9-6) — 기존 worker 절충 그대로, 신규 위험 0.
- plan은 실행 보류라 부작용 없음.
- 권한을 낮추는(요청→건너뛰기) 변경도 canUseTool 시크릿 가드는 항상 통과 못 함.

## 9. 테스트

- settings 4필드 저장/로드 단위(기존 `store.*.test.ts` 패턴).
- `thinkingOption` 공용화 후 기존 동작 회귀 0(worker 경유 테스트 유지).
- manager 옵션 조립 순수 헬퍼 단위(권한/thinking/fast → query options 매핑).
- plan/default 동작은 단위 불가 → dev 훅(`LAIN_*_TEST`)으로 라이브 확인.

## 10. 미결 / 실측

1. SDK `permissionMode:'plan'`·`'default'`가 레인 채팅에서 실제로 어떻게 동작하는지(계획 표시·승인 흐름) — **구현 전 실측**. 결과에 따라 plan UI의 "수락→실행" 배선이 정해짐.
2. thinkingOption 이동 위치(공용 모듈 신설 vs worker import) — plan 단계에서 확정.

## 11. 슬라이스 2 예고 — 사용량 팝업

우측 상태 원 클릭 → 팝업:
- 컨텍스트 점유 게이지(`context_tokens` / `contextCompactThreshold`) — 무한세션 압축 임계 대비.
- 세션 토큰/비용(ChatEvent 누적 + `total_cost_usd`).
- 계정 한도: 5시간·7일·Opus·Sonnet 사용률 + 크레딧 사용량/한도 — SDK `usage_EXPERIMENTAL_MAY_CHANGE...` **실측 후**. ⚠️ 실험 API.
- **불가**: 남은 잔액(US$) — SDK 미제공(사용량/한도로 대체 표시).
