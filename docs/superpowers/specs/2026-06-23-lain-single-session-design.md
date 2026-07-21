# lain — Lain 단일 총괄 세션 (대화 목록 제거) 설계 (Spec)

> 작성: 2026-06-23 · 상태: 설계 확정(구현 전) · 후속: writing-plans → 구현
> 관련: HANDOFF.md, compact.ts(무한세션), 2026-06-18 다중세션, 2026-06-23 Navi 핸드오프

## 1. 목표 / 비목표

**목표**: Lain(매니저)은 **나뉜 대화·세션 개념이 없는 단일 총괄 세션** 하나다. 늘 최신으로 압축되고(무한세션 기존 동작), 화면은 적절히 정리되어 무한히 안 쌓인다. 말 걸면 답할 뿐 — 목록·드릴다운·"새 대화" 없음. **폰(텔레그램)·PC가 같은 하나의 Lain 대화를 공유**한다.

**비목표/경계**:
- **Navi(프로젝트)는 그대로** 다중세션 + 유한 핸드오프 유지. 이번 변경은 manager(Lain) 한정.
- **무한세션 압축 로직 자체는 안 건드림**(이미 동작). 추가는 '화면 정리'(아래 §3-C)만.
- 텔레그램 세션 UI(키보드 버튼·picker)의 **깊은 정리는 라우팅만 단일로 맞추고**, 잔여 UI 정돈은 후속(사용자가 "나중에 UI 추가" 의사).

## 2. 확정 결정

| # | 항목 | 결정 |
|---|---|---|
| 1 | Lain dock 클릭 | 드릴다운 대신 **단일 대화 바로 엶**(`switchTarget('manager')`). manager용 SessionList·"새 대화"·이름변경/삭제 목록 제거 |
| 2 | 단일 canonical | manager 대화 행 **하나(현재 active)** 고정. 기존 나머지는 DB 보존하되 UI 경로 제거로 안 보이게(하드삭제 X) |
| 3 | manager 대화 생성 경로 제거 | 명령팔레트 "새 대화"는 manager면 no-op / 슬래시 `/projects`·명령팔레트 openDrill('manager')은 단일 채팅 열기로 / 텔레그램 생성 전부 `ensureActiveConversation`으로 |
| 4 | 폰·PC 통합 | 텔레그램 대화 해석을 `ensureActiveConversation('manager')`로 → 폰·PC가 **같은 하나** 공유. `TG_CONV_KEY` 분리 세션 폐기 |
| 5 | 과거 정리 = **비파괴 뷰 워터마크** | 메시지 하드삭제 X(부팅 `reconcileFromJournal`이 저널에서 되살림). 대신 `conversations.visible_from_id`로 **화면에 최근 N개만**(압축 시 갱신). DB·저널은 보존(크래시 안전). 최근 보존 **N=40** |
| 6 | 압축 시 트리거 | manager 무한세션 압축 직후 `setManagerViewWindow(conv, 40)` 호출 → 워터마크 전진 |
| 7 | Navi | 불변 |

## 3. 아키텍처(파일별)

**A. store.ts**
- 마이그레이션: `ALTER TABLE conversations ADD COLUMN visible_from_id INTEGER NOT NULL DEFAULT 0`(try/catch).
- `setManagerViewWindow(convId, keepRecent)`: 그 대화의 (keepRecent)번째 최근 메시지 id를 floor로 `visible_from_id`에 기록. 메시지가 keepRecent 이하면 no-op.
- `listConversationMessages` 필터에 `AND id >= COALESCE((SELECT visible_from_id FROM conversations WHERE id=?),0)` 추가. (Navi는 0이라 무영향)
- 비파괴 — 메시지·저널 보존. visible_from_id는 비저널(유실돼도 더 보임뿐, 자가치유).

**B. manager.ts**
- 무한세션 압축 블록(setConversationWorldState·세션 리셋 직후)에 `setManagerViewWindow(conversationId, 40)` 추가.

**C. renderer/App.tsx**
- Lain dock `onClick`: `openDrill('manager')` → `switchTarget('manager')`. title 갱신.
- `SessionList` 렌더: drillTarget는 이제 프로젝트만 → manager 특수분기 제거(프로젝트 전용).
- 명령팔레트 `act:newconv`: `chatTarget==='manager'`면 no-op(Navi는 그대로).
- 슬래시 `/projects`(859) `openDrill('manager')` → `switchTarget('manager')`.

**D. telegram.ts** (라우팅만 단일로 — 깊은 UI 정리는 후속)
- `tgConv()`: `getSetting(TG_CONV_KEY)` → **`ensureActiveConversation('manager')`** 반환(폰·PC 통합).
- 4곳 `createConversation('manager')` → `ensureActiveConversation('manager')`(새로 안 만듦).
- 키보드 버튼 "➕ 새 세션"·"📋 세션 목록" 핸들러 + `c|` 콜백 + `/new`·`/sessions` → 단일 세션 안내로 중립화(메시지: "Lain은 단일 세션 — 그냥 보내면 이어진다"). REPLY_KEYBOARD에서 두 버튼 제거(💬 현재 세션 유지). 봇 명령 목록서 /sessions·/new 제거.

## 4. 데이터 흐름

PC: Lain dock 클릭 → `switchTarget('manager')` → `getActiveConversation`(=`ensureActiveConversation`) → 단일 대화 채팅. 압축 임계 도달 → world_state 압축 + 세션 리셋 + `visible_from_id` 전진 → 화면은 최근 40개 + world_state 기억.
폰: 평문 → `tgConv()`=`ensureActiveConversation('manager')` → **PC와 같은 대화**로 전송·미러.

## 5. 에러/엣지
- visible_from_id 유실(WAL 폐기) → 0으로 폴백 = 더 보임(무해, 다음 압축에 재설정).
- 메시지 < 40 → 워터마크 no-op(전부 보임).
- 기존 다수 manager 대화: active 외엔 UI 미노출(보존). active_conv:manager가 canonical.
- `getActiveConversation` IPC는 실제 `ensureActiveConversation`이라 null 안전.

## 6. 테스트
- store: `setManagerViewWindow` + `listConversationMessages` 워터마크 필터(경계: 40개 미만 no-op, 초과 시 최근 40만), visible_from_id 기본 0.
- UI/telegram: typecheck + 적대적 리뷰 워크플로 + 수동 검증(Lain dock→단일 채팅, 목록 없음).
- `npm run deploy`.

## 7. 후속(이번 범위 밖)
- 텔레그램 세션 UI 완전 제거(키보드·picker·명령 깔끔히).
- 진짜 DB-레벨 과거 메시지 삭제(저널 정리 동반 — 지금은 비파괴 워터마크).
- 무한세션에 맞춘 추가 UI(사용자가 직접 진행 예정).
