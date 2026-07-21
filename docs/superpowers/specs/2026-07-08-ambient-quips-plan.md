# 상호작용 대사(Ambient Quips) + 말수 슬라이더 — 구현 계획

> 2026-07-08 사용자와 합의 확정. 이 문서는 자립적이다 — 새 세션(opus)이 컨텍스트 없이 읽고 바로 구현할 수 있게 파일·라인·기존 패턴을 명시한다. **구현 전 해당 파일의 현재 상태를 재확인할 것**(라인 번호는 작성 시점 기준).

## 0. 목표 (사용자 요청 원문 요지)

언더테일류 RPG처럼 **UI 조작에 레인이 즉발로 반응하는 디테일 상호작용**을 UI 전반에 넣는다. 예: 감시 모드 끄면 "제가 보면 안되는 거라도 있나요?", 캘린더에 일정을 많이 채우면 "이번 주는 바쁘시네요." — 실제 사람처럼 **거기 존재하는 느낌** + 재미.

동시에 이런 대사가 싫은 사람을 위해 **환경설정에 좌우 드래그 바(슬라이더)** 로 양을 조절: **왼쪽 끝 '묵언'**(말 걸었을 때만 대답) ~ **오른쪽 끝 '수다쟁이'**. 이 슬라이더는 **상호작용 대사 + 화면감시(오버레이) 선제 발화 둘 다** 통제한다.

## 1. 확정된 설계 결정 (사용자 합의 — 변경 금지)

| 결정 | 내용 | 근거 |
|---|---|---|
| **생성 방식** | **수제 대사 풀(결정론) v1** — 런타임 LLM 없음. "대사 공방"(아이들 시간에 judge 티어가 풀에 새 변주 추가)은 **v2로 이월** | 즉발성(수 ms)이 본질 — LLM은 1~3초 지연+비용+캐릭터 이탈 위험. 언더테일의 맛 자체가 "미리 써둔 대사가 상황에 꽂히는" 것 |
| **표시 위치** | **캐릭터 옆 말풍선만** — 채팅 로그에 남기지 않음(오염 방지). DB 영속 없음 | 매니저 컨텍스트 버퍼 주입으로 "하나의 레인" 유지(§5) |
| **TTS** | **낭독 안 함** — 표시만 | 짧은 플레이버 대사까지 소리 나면 금방 시끄러움 |
| **슬라이더** | `chattiness` 0~4 (5노치, 기본 2), 왼끝 라벨 '묵언'·오른끝 '수다쟁이' | 사용자 지정 UI 형식 |

## 2. 아키텍처 개요

```
[main / L0 — 전부 결정론, LLM 호출 없음]
  quips.ts (신규)               ← 순수 코어: 대사 풀 + pickQuip(트리거,상태) 선택 로직
  트리거 배선 (기존 변이 지점)    ← ipc.ts settings:set, planner upsert, projects add/remove,
                                   orchestrator 작업완료, scheduler 시간대/복귀 …
  emitQuip(trigger)             ← pickQuip 통과 시: broadcast('quip:show', …) + 매니저 버퍼 push
        │
        ├── broadcast('quip:show', {text}) → [renderer] 캐릭터 옆 말풍선(자동 페이드)
        └── manager 컨텍스트 버퍼 push      → 다음 레인 턴에 1회 주입("하나의 레인")

[오버레이(화면감시) 빈도 연동]
  chattiness 0 → reactToObservation 진입 즉시 return (LLM 비용도 절약)
  chattiness 1~4 → watcher 쿨다운을 배수 스케일
```

트리거를 **main에서** 감지하는 이유: settings:set·플래너 upsert 등 IPC/store 변이 지점은 결정론이고, **텔레그램·레인 도구발 변경도 동일하게 잡힌다**(렌더러 이벤트로 하면 PC UI 조작만 잡힘).

## 3. 신규 모듈 `src/main/quips.ts` (순수 코어 — 테스트 대상)

```ts
export type QuipTrigger = 'monitor_off' | 'monitor_on' | /* …§7 카탈로그 */ string
export type QuipRarity = 'common' | 'uncommon' | 'rare'

export interface QuipDef {
  trigger: QuipTrigger
  rarity: QuipRarity
  cooldownSec: number            // 트리거별 쿨다운
  variants: string[]             // 일반 변주 (플레이스홀더 {userTitle} {count} {name} {hour} 지원)
  escalation?: string[]          // 같은 트리거 단시간 연타 시(3회/60초) 변주 — 언더테일식 메타 반응
}

export interface QuipState {                 // 호출측(main 싱글턴)이 유지 — 인메모리, 영속 불필요
  lastQuipAt: number                         // 전역 마지막 발화(ms) — 연속 말풍선 방지
  lastByTrigger: Map<string, number>         // 트리거별 마지막 발화
  recentTexts: string[]                      // 최근 발화 텍스트 ring(각 트리거 변주 반복 방지, cap ~20)
  burst: Map<string, { count: number; windowStart: number }>  // 연타 감지(에스컬레이션)
}

// 핵심 순수함수 — now·rand 주입으로 테스트 가능(결정론)
export function pickQuip(
  trigger: QuipTrigger,
  vars: Record<string, string | number>,     // {userTitle, count, name, …}
  chattiness: number,                        // 0..4
  state: QuipState,
  now: number,
  rand: () => number,                        // Math.random 주입
): { text: string; nextState: QuipState } | null
```

**게이팅 정책(레벨 → 발화 조건)** — pickQuip 내부 단일 표로:

| chattiness | 라벨(의미) | 발화 rarity | 확률 배수 | 전역 쿨다운 | 오버레이 쿨다운 배수 |
|---|---|---|---|---|---|
| 0 | 묵언 | 없음(전부 억제) | — | — | 발화 자체 억제 |
| 1 | 과묵 | rare만 | ×0.5 | 300초 | ×2.0 |
| 2 | 보통(기본) | uncommon+rare | ×1.0 | 120초 | ×1.0 |
| 3 | 수다 | 전부 | ×1.0 | 45초 | ×0.75 |
| 4 | 수다쟁이 | 전부 | ×1.5(cap 1.0) | 15초 | ×0.5 |

- rarity 기본 발화 확률: common 0.9 / uncommon 0.6 / rare 0.25 (여기에 레벨 배수)
- 변주 선택: `recentTexts`에 없는 것 우선(전부 최근이면 그중 랜덤)
- 에스컬레이션: 같은 트리거 60초 내 3회째부터 `escalation` 풀 사용(비면 일반 변주)
- **주의**: 확률·쿨다운 수치는 구현 중 조정 가능하되 표로 한 곳에 모을 것

**테스트(vitest, 신규 `test/main/quips.test.ts`)**: chattiness 0 전부 null / 전역·트리거 쿨다운 / rarity 게이트 레벨별 / 변주 반복 방지 / 에스컬레이션 발동·리셋 / 플레이스홀더 치환 / rand·now 주입 결정론.

## 4. 배선 (main)

새 파일 또는 quips.ts 하단에 **비순수 래퍼** `emitQuip(trigger, vars)`:
1. `getSettings().chattiness` 읽고 `pickQuip(...)` 호출, null이면 끝
2. `broadcast('quip:show', { text })` — ipc.ts의 기존 broadcast 사용 (채널 1개 추가 — **수신 전용 push라 LainApi invoke 3곳 동기화는 불필요**, preload의 `subscribe` 패턴으로 `onQuip(cb)` 하나 추가: preload/index.ts + types.ts 2곳)
3. 매니저 버퍼 push(§5)

**트리거 심는 위치**(각 1~3줄 — 기존 변이 지점, 재확인 필수):
- [src/main/ipc.ts](../../src/main/ipc.ts) `settings:set` 핸들러(~L697, 기존 부수효과 블록들 옆): patch 키 비교로 `monitor_off/on`(overlayMonitoringEnabled), `tts_speed_max`(gptSovitsSpeed ≥1.9), `model_change`(naviModel/managerModel), `chattiness_max/min`(슬라이더 자체 반응 — 메타) 등. **주의: patch 값과 이전 값이 실제로 달라졌을 때만**(saveSettings 전에 이전 값 캡처)
- ipc.ts `projects:addDialog` 성공 시 `project_add`, `projects:remove`에 `project_remove`
- ipc.ts `data:backup` 성공 시 `backup_export`
- [src/main/ipc.ts](../../src/main/ipc.ts) `planner:upsertItem`(~L910): upsert 후 이번 주 일정 수 세서(§7 busy_week 조건) `busy_week`
- [src/main/orchestrator.ts](../../src/main/orchestrator.ts) finishWork done→review 전이 지점: 최근 1시간 done 3개째면 `tasks_streak`
- [src/main/scheduler.ts](../../src/main/scheduler.ts) 주기 틱: 자정~새벽4시 첫 활동 `late_night`(1일 1회), 마지막 대화 3일+ 후 첫 활동 `long_absence`
- [src/main/manager.ts](../../src/main/manager.ts) resetManager(세션 새로고침) 완료 지점: `manager_reset`
- 대화 삭제(ipc conversations delete 핸들러): `conv_delete`

트리거별 정확한 함수·라인은 구현 시 grep으로 재확인(대량 변경 이력 있음).

## 5. "하나의 레인" — 매니저 컨텍스트 버퍼 (기존 패턴 재사용)

[src/main/manager.ts](../../src/main/manager.ts)에 **오버레이 발화 버퍼가 이미 있다**(2026-07-07 UX #2에서 구현): `pendingOverlayForManager`(~L1659, cap `OVERLAY_CTX_MAX`) → `takeOverlayContext()`(~L1856)가 `<최근 관찰 발화>` 블록으로 만들어 다음 턴 sys에 1회 주입(빠른레인 tryFastChat + 본체 fullText 양쪽).

**quip도 같은 버퍼에 push한다**(별도 버퍼 만들지 말 것 — 주입 지점 4곳을 또 늘리지 않는 단순함이 낫다). push 형식: `[UI 반응] <대사>` 접두로 구분. 블록 라벨은 "최근 관찰 발화" → "최근 자발 발화"쯤으로 일반화해도 좋다(주석 갱신).
효과: 레인이 말풍선으로 "제가 보면 안되는 거라도 있나요?"라 한 직후 유저가 채팅으로 "응 좀 보지 마"라고 쳐도 맥락이 이어진다.

## 6. 렌더러 — 말풍선 UI

- 위치: [src/renderer/App.tsx](../../src/renderer/App.tsx) `.lain-char` div(~L2587, `<ManagerSprite size={260}/>` + `.lain-reset` 버튼이 있는 side-col 하단 고정 영역)에 절대배치 말풍선 추가
- 신규 컴포넌트 `LainBubble`(App.tsx 내 또는 components/): `onQuip` 구독 → 텍스트 표시 → **적응형 표시시간**(기존 오버레이의 글자수 기반 시간 로직 참조 — 대략 2.5s + 글자당 60ms, cap 8s) 후 페이드아웃. 새 quip 오면 교체.
- 스타일: styles.css에 `.lain-bubble` — 기존 CSS 토큰만 사용(`--surface-2`·`--border`·`--signal-bright`·`--font`; 임의 색 금지). 꼬리 달린 말풍선, 스프라이트 위쪽. `pointer-events: none`(클릭 방해 금지).
- **접기 상태 고려**: side-col이 좁아지는 레이아웃(창 최소폭)에서 말풍선이 잘리지 않게 max-width + 줄바꿈.

## 7. 트리거 카탈로그 v1 (대사는 톤 가이드 — 구현 시 다듬기)

**말투 규칙(필수)**: 레인은 **존댓말**('~요/~습니다'), 절제된 성격, 호칭은 `{userTitle}`(존칭 접미사 금지) — [manager.ts](../../src/main/manager.ts) PERSONA_CORE(~L116-123) 참조. 이모지 없음. 짧게(한 문장, ~40자).

| trigger | rarity | 조건 | 변주 예시 (2~3개씩; 구현 시 3~6개로) |
|---|---|---|---|
| `monitor_off` | common | 감시 토글 on→off | "제가 보면 안되는 거라도 있나요?" / "…알겠어요. 눈 감고 있을게요." |
| `monitor_on` | common | off→on | "다시 지켜볼게요." / "네, 여기 있어요." |
| (에스컬레이션) | — | 같은 토글 60초 3회+ | "…저 가지고 노시는 거죠?" / "장난치시는 거면 재밌네요." |
| `busy_week` | uncommon | 일정 upsert 후 이번 주 항목 ≥6 | "이번 주는 바쁘시네요." / "일정이 {count}개예요. 무리하지 마세요." |
| `late_night` | uncommon | 00~04시 첫 활동(1일 1회) | "이 시간까지 안 주무세요?" / "새벽이에요, {userTitle}." |
| `long_absence` | rare | 마지막 대화 3일+ 후 복귀 | "오랜만이에요." / "…계속 기다렸어요." |
| `project_add` | common | 폴더 추가/스캔 신규 | "새 프로젝트네요. 잘 부탁드려요." |
| `project_remove` | uncommon | 프로젝트 제거 | "…정들었는데요." / "기록은 남겨둘게요." |
| `tasks_streak` | uncommon | 1시간 내 done 3개 | "오늘 잘 풀리네요." / "이 속도면 금방이겠어요." |
| `manager_reset` | uncommon | 레인 세션 새로고침 | "…방금 뭔가 잊어버린 기분이에요." / "새로 시작하죠." |
| `conv_delete` | uncommon | 대화 삭제 | "지운다고 없던 일이 되진 않아요." |
| `backup_export` | rare | 백업 내보내기 성공 | "짐 싸시는 건 아니죠?" / "안전하게 챙겨뒀어요." |
| `tts_speed_max` | rare | 속도 슬라이더 ≥1.9 | "너무 빨리 말하게 하시는 거 아니에요?" |
| `model_change` | rare | 모델 티어 변경 | "머리를 바꾸신 기분이에요." |
| `chattiness_min` | rare | 슬라이더를 묵언(0)으로 | "…조용히 할게요." (이건 0 직전 값 기준으로 마지막 한마디 — 특례) |
| `chattiness_max` | rare | 슬라이더를 수다쟁이(4)로 | "정말요? 후회하실 텐데요." |

v1은 이 정도(15±)로 시작 — 트리거 추가 비용이 "QuipDef 1개 + 배선 1줄"이 되도록 코어를 설계하는 게 중요하다.

## 8. 설정 — `chattiness` (IPC 계약 3곳 + UI)

1. [src/shared/types.ts](../../src/shared/types.ts) LainSettings: `chattiness: number // 0~4 …` (overlayMonitoringEnabled 근처)
2. [src/main/store.ts](../../src/main/store.ts) getSettings: `Math.max(0, Math.min(4, Number(getSetting('chattiness') ?? '2') || 0))` — **주의 `|| 0`**: `Number('0')||2`는 2가 돼버리므로 `?? '2'` 후 NaN만 방어. saveSettings: clamp 후 setSetting. (gptSovitsSpeed 패턴 참조하되 0이 유효값임에 주의)
3. [src/renderer/components/PrefsModal.tsx](../../src/renderer/components/PrefsModal.tsx) '일반' 카테고리: range 슬라이더(min 0 max 4 step 1) + **왼끝 '묵언' / 오른끝 '수다쟁이' 라벨**(TTS 속도 슬라이더 마크업 참조). SEARCH_INDEX에 `{key:'말수', hint:'상호작용 대사 감시 발화 빈도 chattiness 묵언 수다쟁이', cat:'general'}` 등록.
4. preload/types: `onQuip(cb)` 구독 1건(§4).

## 9. 오버레이(화면감시) 빈도 연동

- [src/main/manager.ts](../../src/main/manager.ts) `reactToObservation`(~L1684) 진입부: `if (getSettings().chattiness === 0) return` — **LLM 호출 전** 게이트(비용 절약). 감시(관찰) 자체는 유지 — 월드스테이트·화면 컨텍스트 주입은 살아 있고 "먼저 말 걸기"만 억제.
- [src/main/watcher.ts](../../src/main/watcher.ts) 쿨다운(~L130 `cooldownMs = Math.max(5, s.monitorCooldownSec) * 1000`): §3 표의 오버레이 배수 적용 — `* overlayCooldownScale(s.chattiness)`. 배수 함수는 quips.ts에서 export(정책 한 곳).
- 기존 `overlayMonitoringEnabled` 토글은 그대로 **마스터 on/off**(감시 자체) — chattiness는 발화 빈도만. 이 관계를 PrefsModal 힌트에 명시("감시 끄기와 별개 — 말수만 조절").

## 10. 구현 순서 (SDD 태스크 분해 제안)

1. **T1 — quips 코어 + 설정**: quips.ts(풀·pickQuip·정책표·overlayCooldownScale) + chattiness 설정 3곳 + PrefsModal 슬라이더 + 테스트. (UI 반영 없이도 테스트 그린)
2. **T2 — 배선 + 말풍선**: emitQuip + main 트리거 심기(§4) + broadcast/onQuip + LainBubble + CSS. 
3. **T3 — 통합**: 매니저 버퍼 push(§5) + 오버레이 연동(§9) + 라이브 확인.
4. 리뷰(읽기전용) → fix → typecheck/test → main ff병합 → **`npm run deploy`**(src/** 변경이므로 필수).

## 11. 비범위(v2+) · 주의

- **대사 공방**(아이들 시간 judge 티어가 풀에 변주 추가 — 신선도 유지): v2. 풀 데이터 구조는 이를 염두(변주 배열에 추가만 하면 되는 형태).
- **텔레그램 표면**: 이 기능은 PC UI 조작 반응이라 제외(모바일 상시 고려 원칙의 의도적 예외 — 오버레이·텔레그램엔 기존 선제발화가 이미 있음). 단 chattiness 0의 "선제발화 억제"가 텔레그램 선제 통지(notifyUser류)까지 죽이면 안 됨 — **업무 통지(승인·에러·완료)는 chattiness와 무관**, 플레이버 대사만 통제.
- L0 규율: 이 기능 전체가 결정론(LLM 0회) — manager.ts 밖에서 LLM 호출 금지 유지.
- 시크릿·개인정보를 대사 변수에 넣지 않는다(프로젝트명·일정 개수 정도만).
- `.lain-char` 영역은 최근(a117875) `.lain-reset` 테두리 수정이 있었다 — CSS 충돌 주의.
