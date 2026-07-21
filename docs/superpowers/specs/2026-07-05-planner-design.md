# Lain 플래너(Planner) 설계 — 통합 일정 + 체크리스트

> 2026-07-05 브레인스토밍 확정(사용자 승인). 명칭: **플래너** (UI 헤더 `[ wired://planner ]`).
> 배경: hermes의 cron 잡(에이전트 실행 예약)과 달리, 이건 **사용자 일정·할일**을 레인이 비서로서
> 관리하는 기능. 레인의 대응물(Routines)은 이미 있으므로 중복 없음 — 플래너는 사용자 도메인.

## 결정 요약 (브레인스토밍 Q&A)

| 결정 | 내용 |
|---|---|
| 범위 | 통합 캘린더: 사용자 일정(시간 있음) + 체크리스트(시간 없음·링크 첨부, "해커톤 탐색" 같은 작은 것) + 레인 루틴·프로젝트 작업 읽기 전용 오버레이 |
| 외부 연동 | 없음 (Google Calendar 등 불필요 — 레인 DB로 완결) |
| 능동성 | 4종 전부 구현: 리마인드 알림 · 브리핑 포함 · 체크리스트 대신 처리 제안 · 방치 항목 넛지 — **전부 환경설정 토글**, 단 사용자가 직접 요청하면 설정 무관 실행 |
| 레이아웃 | A안: 풀스크린 캘린더 패널(월 그리드 + 체크리스트 사이드바, 월/주/일 전환) |
| 커스텀 | 5축 전부: ①뷰 구성 ②태그·색 ③체크리스트 섹션 ④레이아웃(사이드바 위치·폭·밀도) ⑤동작(리마인드 시점·방치 기준·넛지 빈도·폰 알림) |
| 모바일 | 전용 앱 없음(플레이스토어 취소) — 텔레그램 표면을 1급으로: `/plan` 조회, 자연어 등록, 리마인드 푸시+완료 버튼 |
| 반복 일정 | 1차 포함 — 단순 4종만(none/daily/weekly:<0-6>/monthly:<일>), 루틴 cron 표현 재사용 |
| 드래그 재배치 | 1차 제외 — 사이드바 위치·폭 설정으로 대체 |

## 1. 데이터 모델 (L0 · node:sqlite, store.ts)

새 테이블 3개. 기존 routines/tasks는 건드리지 않는다(플래너에선 읽기 전용 오버레이).

```sql
CREATE TABLE plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'event' | 'todo'
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',   -- 메모·링크 (md)
  start_at TEXT,                   -- ISO. event 필수. todo는 선택(=마감일, 있으면 캘린더에 표시·리마인드 대상)
  end_at TEXT,                     -- ISO. NULL 허용(점 이벤트)
  all_day INTEGER NOT NULL DEFAULT 0,
  recur TEXT NOT NULL DEFAULT 'none', -- none | daily | weekly:<0-6> | monthly:<1-31>
  tag_id INTEGER,                  -- plan_tags FK (NULL=무태그)
  section_id INTEGER,              -- plan_sections FK (todo 전용, NULL=기본)
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  remind_offset_min INTEGER,       -- NULL=설정 기본값 사용. start_at 있는 항목(event·마감 todo)에 적용
  remind_sent_at TEXT,             -- 마지막 리마인드 발송 시각(반복이면 발생 회차별 재무장)
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'user', -- user | lain | telegram
  archived INTEGER NOT NULL DEFAULT 0, -- 보관(하드삭제 없음 — 성장 보존 관행)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE plan_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,             -- #rrggbb
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE plan_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0
);
```

설정 키(전부 getSettings/saveSettings + PrefsModal '플래너' 섹션 — 표시=적용 일치 원칙):

- `plannerShowEvents/Todos/Routines/Tasks` (bool, 기본 전부 on) — 뷰 구성 ①
- `plannerDefaultView` ('month'|'week'|'day', 기본 month) · `plannerWeekStart` (0|1, 기본 1=월)
- `plannerShowDone` (bool, 기본 on)
- `plannerSidebarSide` ('left'|'right', 기본 right) · `plannerSidebarWidth` (px) · `plannerDensity` ('cozy'|'compact') — 레이아웃 ④
- `plannerRemindDefaultMin` (기본 10) · `plannerStaleDays` (기본 7) · `plannerNudge` ('off'|'daily'|'weekly', 기본 weekly) — 동작 ⑤
- `plannerInBriefing` (bool, 기본 on) — 브리핑 포함
- `plannerOfferHelp` (bool, 기본 on) — 체크리스트 대신 처리 제안
- `plannerTelegramRemind` (bool, 기본 on) — 폰 리마인드

## 2. 결정론 배관 (LLM 호출 0 — §4 원칙)

`src/main/planner.ts` (신규, L0 순수 로직 + 스케줄러 훅):

- **순수함수(단위테스트 대상)**:
  - `nextOccurrence(item, now)` — recur 4종의 다음 발생 시각(ISO). none이면 start_at.
  - `dueReminders(items, now, defaultMin)` — 리마인드 발송 대상(start_at 있는 미완료 항목 — event·마감 todo). 반복 항목은 `remind_sent_at < 이번 발생의 리마인드 시각`이면 재무장.
  - `staleTodos(items, now, staleDays)` — 미완료 && 비핀 && updated_at이 기준일 초과.
- **스케줄러 통합**: 기존 scheduler tick에서 1분 주기로 `dueReminders` → `notifyUser`(PC 토스트) + 텔레그램 푸시(아래 §5) + `remind_sent_at` 갱신. 방치 항목 수·오늘 일정 요약은 buildDigest에 한 줄로 주입(레인이 읽는 status-digest — 넛지·브리핑의 재료, 설정 토글).
- 넛지 발화 자체는 레인의 판단(기존 idle/브리핑 경로) — L0는 데이터만 공급한다.

## 3. 레인 도구 (manager.ts lain MCP — 판단은 Claude)

- `plan_manage(action, ...)` — add/update/done/undone/remove(=archive)/reorder. 일정·todo 공용.
  자연어 시각("내일 3시")→ISO 변환은 **레인이 수행**해 도구엔 ISO만 전달(도구는 결정론 검증만).
- `plan_view(range?, section?, tag?)` — 기간·섹션·태그 조회(브리핑·질문 답변·대신 처리 판단용).
- `plan_tag_manage` / `plan_section_manage` — 태그·섹션 CRUD(레인 경유로도, UI로도 가능).
- SYSTEM_PROMPT 규칙 추가:
  - 사용자가 일정·할일을 말하면 plan_manage로 등록하고 한 줄 확인. 등록 여부가 애매한 잡담은 묻지 말고 넘어간다.
  - `plannerOfferHelp` on일 때: 방치·대기 todo 중 레인이 대신 할 수 있는 것(조사·탐색·정리류)은 한가할 때 "내가 해줄까?" 1회 제안 — 수락 시 수행 결과를 항목 body에 붙이고 done 제안. 사용자가 직접 시키면 설정 무관 즉시 수행.
  - 브리핑(plannerInBriefing on): 오늘 일정·임박 마감·방치 n건을 브리핑에 포함.

## 4. UI — PlannerPanel (renderer, A안)

- **진입**: 상단 버튼 + `/plan` 슬래시. 기존 패널 관례(LessonsPanel·RoutinesPanel)와 동일한 오버레이 패널.
- **캘린더**: 월/주/일 전환 탭. 셀에 일정(태그색)·todo 마감·루틴(노랑 계열)·작업 상태(청록 계열, 읽기 전용)가 겹침 — 표시 토글 4종 반영. 오늘 하이라이트. 주간·일간 뷰는 시간축 레인.
- **사이드바**: plan_sections 순서대로 체크리스트(접기·핀·완료 토글·링크 클릭). 좌/우 배치·폭 조절(드래그 핸들)·완료 표시 토글.
- **편집**: 셀 빈 공간 클릭=신규, 항목 클릭=인라인 편집 폼(제목·kind 전환·시간·종일·반복·태그·섹션·리마인드·메모/링크 md). 삭제=보관.
- **태그 관리**: 사이드바 하단 '태그' 행 — 이름+색 피커로 생성·수정.
- **IPC** (3곳 동기화 관례: ipc.ts + preload/index.ts + shared/types.ts):
  - `planner:list(rangeStart, rangeEnd)` → { items, tags, sections, routines요약, tasks요약 }
  - `planner:upsertItem / deleteItem / upsertTag / deleteTag / upsertSection / deleteSection / reorder`
  - 브로드캐스트 `planner:updated` (레인 도구·텔레그램 경유 변경도 라이브 반영)
- 테마: 기존 보라 네온 CRT(styles.css 변수) 그대로.

## 5. 텔레그램 표면 (1급 — mobile-first 관행)

- `/plan` — 오늘+이번 주 일정 요약 + 미완료 체크리스트(섹션별). 명령 메뉴 등록.
- 자연어 등록·완료는 기존 채팅 경로 그대로(폰 채팅 → 레인 → plan_manage).
- 리마인드 푸시: `⏰ 19:00 약속 (10분 전)` + 인라인 버튼 `[✓ 완료]` `[+10분]` — 기존 approvals 버튼 패턴(callback_data) 재사용.

## 6. 검증

- 단위테스트: `nextOccurrence`(4종·월말 엣지) · `dueReminders`(재무장·기본 오프셋) · `staleTodos` · store CRUD(태그/섹션 FK·보관) — tmp DB 패턴(store.hide.test.ts 동형).
- typecheck + 기존 스위트(611) 그린 유지. UI는 기존 패널 관례라 별도 e2e 없음.

## 범위 밖 (명시적 보류)

- 외부 캘린더 연동(Google 등) — 필요 시 2차
- 전용 모바일 앱/플레이스토어 — 취소(텔레그램으로 대체)
- 텔레그램 미니앱(그래픽 캘린더 웹뷰) — 장기 카드
- 드래그로 항목 날짜 이동·패널 재배치 — 1차 제외
