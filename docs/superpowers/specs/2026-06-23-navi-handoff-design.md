# lain Navi 유한세션 핸드오프 + Lain A/B 위임 판단 — 설계 (Spec)

> 작성: 2026-06-23 · 상태: 설계 확정(구현 전) · 후속: writing-plans → 구현
> 관련: [HANDOFF.md](../../../HANDOFF.md), PLAN.md §5.6(Navi 직접 채팅)·§21(autonomous)·§9b, compact.ts/compactgate.ts(Lain 무한세션 — 본 작업과 **별개**)

## 1. 목표 / 비목표

**목표**
1. **Navi 유한세션 핸드오프** — 일하는 Navi 세션의 컨텍스트 점유가 임계에 닿으면, Navi가 *자기 손으로* 핸드오프 md를 작성하고 → 세션을 교체하고 → 새 세션이 그 md를 읽어 이어간다. 사용자가 매번 "기록하고 새로 시작해"를 반복 지시하지 않아도 여러 Navi가 세션을 깔끔히 유지한다.
2. **Lain의 A/B 위임 판단** — Lain이 일을 위임할 때 **격리·검토형 자율작업(A: `start_task`)** 과 **대화형 직접작업(B: `message_navi`)** 중 적절한 쪽을 스스로 판단해 고른다.

**비목표 / 명시적 경계**
- **무한세션(침묵 월드모델 압축)은 오직 Lain(매니저) 전용이다.** 본 작업은 Navi를 무한세션으로 만들지 않는다. Navi는 *구체적 맥락을 그대로 쥔 유한세션*을 유지하다가, 차면 **명시적 md 핸드오프로 교체**한다(침묵 요약 아님). 코드 주석·문서에서 이 둘을 절대 혼동하지 않는다.
- 1차 슬라이스는 **B(navichat 직접 대화 세션)** 만 구현한다. A(worker 자율작업)의 핸드오프는 메커니즘을 공유하도록 설계하되 **후속 슬라이스**로 미룬다.
- Lain A/B 판단에 새 결정론 배관/판사 호출을 추가하지 않는다 — Lain 프롬프트 지침으로만(판단=LLM 컨벤션).

## 2. 확정된 결정

| # | 항목 | 결정 |
|---|---|---|
| 1 | 용어 분리 | 무한세션(침묵 압축)=Lain 전용 / 본 작업=Navi **유한세션 명시적 md 핸드오프**. 별개. |
| 2 | md 작성자 | **Navi 자신**. 곧 버릴 세션의 마지막 1회 질의에서, 맥락을 가진 당사자가 직접 핸드오프를 쓴다(외부 판사 요약보다 비싸지만 품질 최선). |
| 3 | 트리거 | **자동 오케스트레이션**(Lain의 상시 방침). Lain을 매 교체마다 호출하지 않음 — 자동 수행 후 Lain/UI에 *일어났음*만 알림. (사용자 반복작업 제거가 목표) |
| 4 | 감지 지표 | 기존 `contextOccupancyTokens`(input+캐시, output 제외) 재사용. 대화별 `conversations.context_tokens`(기존 컬럼) 갱신. |
| 5 | 임계값 | 신규 설정 `naviHandoffThreshold`(기본 150000, **0=완전 비활성** 킬스위치). Lain 무한세션 임계(`contextCompactThreshold`)와 별도. |
| 6 | 감지 게이트 | 기존 순수함수 `shouldCompact(tokens, threshold)` 재사용(경계 포함, 0=off). |
| 7 | 핸드오프 시점 | **새 사용자/Lain 턴 진입 시**(턴 도중 아님). manager 무한세션과 동형 — 진행 중 작업 resume을 끊지 않게. |
| 8 | md 저장 | `conversations.handoff_md`(신규 컬럼, **저널링**으로 크래시·WAL 폐기에도 보존) + 사람이 볼 파일 미러 `%APPDATA%\lain\handoffs\<proj>-<conv>.md`. |
| 9 | 프로젝트 repo | 핸드오프 연속성 산출물은 **lain 관리**(DB+미러). 프로젝트 repo를 오염시키지 않는다. |
| 10 | 프로젝트 컨벤션 존중 | Navi는 프로젝트 폴더에서 작업하므로 그 프로젝트의 md-기록 컨벤션(CLAUDE.md 등)을 이미 맥락으로 가진다. 핸드오프 프롬프트는 "프로젝트 기록 컨벤션이 있으면 그에 맞춰 작성"하도록 지시. |
| 11 | Lain의 직접 지시 | Lain이 위임(`message_navi`/`start_task`) 시 "기록은 여기에/이 형식으로" 같은 지침을 본문에 담아 Navi에 직접 짚어줄 수 있다(프롬프트 제어라 신규 배관 불필요). |
| 12 | 세션 교체 | `setConversationSdkSession(conv,'')` + `resetConversationContextTokens(conv)`. 다음 질의는 새 세션. |
| 13 | 재주입 | 새 세션 첫 프롬프트에 `<handoff>…</handoff>` 블록 주입(manager의 `<world-state>` seam과 동형). 임계 0이면 주입도 안 함(대칭). |
| 14 | 가시화 | `🔄 세션 교체 — 핸드오프 md로 맥락 이어감` 회색 tool 라인 영속+emit. 재로드 시에도 세션 경계 흔적 유지. |
| 15 | A/B 판단 | Lain SYSTEM_PROMPT에 "격리·검토(A `start_task`) vs 같이·이어감(B `message_navi`)" 기준 + 타이브레이커 추가. 신규 코드 없음. |

## 3. 아키텍처

### Part 1 — Lain A/B 위임 판단 (프롬프트 only)
`manager.ts`의 `SYSTEM_PROMPT`에 위임 판단 지침 추가:

> 프로젝트에 일을 위임할 때 두 길이 있다:
> - **`start_task`(A)** — 격리된 worktree에서 혼자 끝까지 하고 **검토(병합/폐기)로 마무리**할 일. 명확한 산출물·위험/대규모·테스트로 검증 가능·병렬 가능.
> - **`message_navi`(B)** — 그 프로젝트 Claude와 **대화하며 같이 이어갈** 일. 탐색·디버깅·반복 질의·누적 맥락 의존·턴마다 방향 조정·사소한 즉시 수정.
> 타이브레이커: 검증가능(verify_cmd)+무개입 → A · 위험/대규모/병렬 → A · 이 세션 이어온 맥락 의존 → B · 사소·일회성 → B.

### Part 2 — Navi 유한세션 핸드오프 (navichat 슬라이스)

**신규 순수 모듈 `src/main/handoff.ts`** (compact.ts의 형제이되 Navi 전용·의미 분리):
- `summarizeNaviHandoff(projectPath, recentMsgs, prevHandoff): Promise<string|null>` — 현 세션에 1회 query()로 Navi가 핸드오프 md 작성. judge가 아니라 **Navi 모델(naviModel)**·프로젝트 cwd(`projectPath`)로 띄워, 프로젝트 컨벤션을 맥락에 두고 당사자 시점으로 쓰게 한다. 실패/빈응답이면 null.
- 핸드오프 md 섹션(고정): `## 지금 하던 일` / `## 진행 상황(완료·진행중)` / `## 다음 단계` / `## 핵심 맥락·결정·함정` / `## 막힌 점`. 프로젝트에 기록 컨벤션(CLAUDE.md 등)이 있으면 그에 맞춰 보강하라고 지시(§2-10).
- 파일 미러(`handoffs/<proj>-<conv>.md`) best-effort.
- 감지 게이트는 기존 `compactgate.ts`의 `shouldCompact`/`contextOccupancyTokens` 재사용(중복 구현 금지).

**`navichat.ts` 배선** (sendToNavi):
```
새 턴 진입(인터럽트/blocked/review 분기 통과 후, idle 신규/resume 직전):
  if naviHandoffThreshold>0 and shouldCompact(getConversationContextTokens(conv), threshold):
     prev = getConversationHandoff(conv)
     recent = listConversationDialogue(conv, 40)        # user/assistant 원문만(manager와 동일)
     md = await summarizeNaviHandoff(project.path, recent, prev)   # 현 resume 세션 사용
     if md:    setConversationHandoff(conv, md)         # 새 핸드오프 저장
     # 교체 가드: 다음 세션에 줄 다리(md 또는 직전 핸드오프)가 있을 때만 끊는다.
     if md or prev:
        setConversationSdkSession(conv, '')             # 세션 끊기
        resetConversationContextTokens(conv)
        resume = undefined
        addNaviMessage(...'🔄 세션 교체 …') + emit(tool)
     # md 실패 + 직전 핸드오프도 없음 → 끊지 않고 이번 턴 진행(다음 턴 재시도). 맥락 0 세션 방지.
  ...
  # 본 질의 프롬프트에 handoff 주입(threshold>0 일 때만):
  body = `${handoffBlock}${body}`                      # <handoff>…</handoff>
  ...
  # result 핸들러: setConversationContextTokens(conv, contextOccupancyTokens(msg))  # 신규
```
⚠️ 핸드오프 작성 질의는 **현 세션(resume=현 sdk)** 에서 — 맥락을 가진 상태로. 그 다음에 끊는다. **교체 가드(확정)**: 새 md 작성 성공이거나 직전 핸드오프가 있을 때만 세션을 끊는다(다음 세션에 줄 *다리*가 있을 때만). md 실패 + 직전 핸드오프 없음이면 끊지 않고 이번 턴을 현 세션으로 진행하고 다음 턴 재시도 — *맥락 0 새 세션*을 막는다.

**`store.ts`**
- 마이그레이션: `ALTER TABLE conversations ADD COLUMN handoff_md TEXT`(try/catch, 부팅 보호).
- `getConversationHandoff(id)` / `setConversationHandoff(id, md)`(journalConvState로 저널 — world_state와 동급 보존).
- `getSettings()`에 `naviHandoffThreshold`(기본 150000), `saveSettings` 라운드트립.
- `context_tokens`/`reset`은 기존 함수 그대로 재사용(대화 id 기준, target 무관).

**설정 UI `PrefsModal.tsx`**: `naviHandoffThreshold` 입력 한 줄(무한세션 입력 아래) — "Navi 대화가 이 토큰 넘으면 핸드오프 md 기록 후 새 세션 — 0이면 끔".

**`shared/types.ts`**: `LainSettings`에 `naviHandoffThreshold: number`. IPC 3곳 동기화 규칙 준수(설정은 기존 settings 채널 재사용).

## 4. 데이터 흐름 (B, 한 턴)

```
사용자/Lain → sendToNavi(conv)
  ├─ 인터럽트/blocked/review 분기 (기존)
  ├─ [감지] context_tokens ≥ naviHandoffThreshold ?
  │     예 → Navi 현 세션에 핸드오프 질의 → md 저장(DB+미러) → 세션 끊기·점유 0 → 🔄 라인
  ├─ 프롬프트 = <handoff>(있으면)</handoff> + 본문
  ├─ query(resume = 교체됐으면 undefined / 아니면 현 세션)
  └─ result → setConversationContextTokens(점유)   # 다음 턴 감지 재충전
```

## 5. 에러 처리 / 엣지

- **핸드오프 질의 실패(null)**: 직전 핸드오프를 덮어쓰지 않는다. **교체 가드**(§3) — 직전 핸드오프가 있으면 그걸 다리 삼아 교체, 없으면 *끊지 않고* 이번 턴은 현 세션으로 진행하고 다음 턴 재시도(맥락 0 세션 방지). 어느 경우든 작업물은 디스크에 있어 안전.
- **인터럽트/blocked/review 경로에서는 핸드오프 안 함** — working 세션 resume을 끊으면 작업 유실. 오직 idle 신규/resume 진입에서만(§2-7).
- **파일 미러 실패**: 무시(DB가 진실원본).
- **DB 손상/WAL 폐기**: handoff_md는 저널링되어 resume과 동급으로 복원(world_state 패턴 재사용).
- **킬스위치**: `naviHandoffThreshold=0`이면 감지·주입 모두 off → 오늘과 100% 동일 동작.
- **부팅 시 context_tokens=0**: 비저널 단순 카운터라 다음 result에서 재충전(자가치유) — manager와 동일.

## 6. 테스트

- `test/handoffgate.test.ts`(또는 기존 compactgate 테스트 확장) — `shouldCompact` 경계·0=off 재확인(이미 커버면 생략).
- `test/handoff.test.ts` — `<handoff>` 주입 블록 합성 순수헬퍼, 핸드오프 프롬프트 직렬화(원문만·길이상한), null 폴백.
- `store` — handoff_md set/get·저널 보존, naviHandoffThreshold 설정 라운드트립.
- typecheck + `npm test` 그린, **`npm run deploy`로 설치본 동기화**.

## 7. 구현 순서(개략)

1. store: 컬럼 마이그레이션 + get/set handoff + 설정 필드.
2. handoff.ts: `summarizeNaviHandoff` + 미러 + 주입 헬퍼.
3. navichat.ts: 감지·교체·주입·result 점유 기록 배선.
4. types/PrefsModal: 설정 노출.
5. manager.ts SYSTEM_PROMPT: A/B 판단 지침.
6. 테스트 + typecheck + deploy.
7. (후속) worker.ts A 슬라이스 — continuation 경계에서 동일 핸드오프 적용.
