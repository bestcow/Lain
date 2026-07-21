# 레인 학습 루프 (hermes-agent 이식) — 구현 계획

> 2026-07-02 작성. hermes-agent(NousResearch) 최신본 조사 후 사용자 승인된 "다음 작업".
> 조사 원본: 클론 `%TEMP%\claude\hermes-agent-study` · 메모리 `hermes-learning-loop-survey`.
> ⚠️ **메커니즘만 lain 고유로 재구현** — hermes 코드 verbatim 복사 금지(메모리 `port-as-own-reimplementation`).
>
> ✅ **2026-07-02 T1~T7 전체 구현·배포 완료.** 플랜 대비 이탈: ①T1 Navi 전달 — worker에 lain MCP가
> 실측 존재해 본문 주입 대신 관련 스킬 인덱스 + skill_view 도구(점진 공개 일관, navichat은 미적용)
> ②T3 — 스킬 제안은 자동 저장 없이 💡 힌트만, 구 signalReview 설정 폐기·turnReviewEnabled(기본 ON) 대체
> ③T2 — sendToManager `modelText` 파라미터 신설(채팅 원문 보존) + 슬래시 인자 Enter 결함 수정.
> 라이브 검증 항목은 HANDOFF.md 참조.

## 목표

레인의 학습을 '학습'(짧은 사실) 한 층에서 hermes급 **닫힌 학습 루프**로 확장:
스스로 절차를 스킬로 저장하고(/learn 포함), 채팅 턴에서도 배우고, 과거 대화를 원문 검색하고, 사용자 프로필을 상시 기억한다.

## 우선순위 (사용자 합의: 1+2+3 묶음부터)

| Phase | 태스크 | 규모 |
|-------|--------|------|
| **A** | T1 스킬 자가 생성 + T2 /learn + T3 턴 자기개선 리뷰 | 2일 |
| **B** | T4 레인 세션 검색(FTS5) | 1일 |
| **C** | T5 USER 프로필 · T6 스킬 큐레이터 · T7 검증 넛지 | 1일 |
| 보류 | 학습 그래프 시각화 · 채널별 모델/프롬프트 오버라이드 | — |

## 설계 원칙 (PLAN.md 준수)

- **L0/L1 분리**: 스킬 파일 IO·인덱스·FTS·사용 추적 = L0(store/fs 결정론). "무엇을 저장할까" 판단 = L1(manager/judge query)만.
- IPC 추가 시 ipc.ts + preload + shared/types.ts(LainApi) 3곳 동기화.
- SDK 옵션·FTS5 지원은 **실측 후 사용**(PLAN.md §18). `settingSources`는 계속 안 씀 — 스킬은 CC Skill 도구가 아니라 **자체 인덱스+도구**로 주입(정체성 오염 회피, 메모리 `lain-sdk-skills-settingsources`).
- **성장 보존**(메모리 `lain-removal-preserves-growth`): 스킬·학습 자동 삭제 금지 — stale/보관만.
- 일회성 judge query는 **try 밖 누적 + 여유 maxTurns**(메모리 `lain-sdk-maxturns-error-max-turns`).
- 저장 전 시크릿/인젝션 스캔(§9-6) — 스킬·프로필은 시스템 프롬프트/도구 결과로 재주입되는 면이므로 hermes처럼 위협 패턴 검사.
- 텔레그램 표면 함께 설계(메모리 `mobile-telegram-first-consideration`): /learn 명령·💾 알림 폰에서도 동작.

---

## T1 — 레인 스킬 자가 생성 (절차 기억)

hermes `skill_manage` 대응. 학습(1~2문장)이 못 담는 **여러 단계 절차**를 스킬 md로 저장.

- **저장소**: `%APPDATA%\lain\skills\<name>\SKILL.md` (+ 지원 파일 가능). name = `[a-z0-9-]`, 검증 후 저장.
- **메타/사용 추적**: SQLite 테이블 `agent_skills`(name, description(≤60자), created_at, use_count, last_used_at, state active|stale|archived, pinned). lessons 테이블 관행 미러.
- **mcp__lain__ 도구 3개** (manager.ts lainServer):
  - `skill_save(name, description, content, mode: create|patch|replace)` — patch는 old/new 부분 문자열(토큰 절약, hermes patch 대응).
  - `skill_view(name)` — 본문 반환(+use_count++).
  - `skill_delete(name)` — 실제 삭제 아니라 `state=archived`(성장 보존).
- **주입 = 점진 공개**: 시스템 프롬프트가 아니라 **다이제스트 seam**(fullText의 `<status-digest>` 옆)에 `<skills-index>`로 "name — 60자 설명" 목록만 매 메시지 주입(무한세션이라 세션 고정 스냅숏은 반영 지연 큼). 본문은 skill_view로만. 인덱스 상한(예: 30개, use_count·최신순).
- **SYSTEM_PROMPT 규칙 추가**: 언제 저장하나 = 복잡한 작업 성공 후 / 막다른 길에서 답 찾은 후 / 사용자가 접근법을 교정한 후. 언제 참조하나 = 인덱스에서 관련 스킬 보이면 skill_view 먼저.
- **Navi 전달**: worker/navichat엔 lain MCP 도구가 없으므로(실측 확인) 시작 프롬프트에 관련 스킬 **본문 1회 주입**(conventions.ts 패턴 미러, 관련도는 작업 내용 키워드 매칭 — lessonsForProject 동형).
- 테스트: store CRUD·인덱스 조립 순수함수·name 검증·threat 스캔.

## T2 — /learn 명령

hermes `learn_prompt.py` 대응 — **별도 엔진 없음**이 핵심. 저작 표준을 박은 프롬프트 하나를 일반 턴으로 실행.

- `src/main/learnprompt.ts`(신규): `buildLearnPrompt(request)` 순수함수 — lain 저작 표준(설명 ≤60자·섹션 순서 When to Use/Prerequisites/절차/함정/검증·lain 도구 프레이밍·**본 것만 쓰기, 발명 금지**)을 포함한 지시문 생성 → 지시: 기존 도구(Read/Grep/WebFetch/현재 대화)로 소스 수집 → `skill_save`로 저장.
- 진입점: 렌더러 슬래시 `/learn <무엇이든>`(SLASH_COMMANDS 추가) + 텔레그램 `/learn` — 둘 다 `sendToManager(buildLearnPrompt(args))`.
- 소스 종류: 로컬 디렉터리·URL·"방금 같이 한 작업"(현재 대화)·붙여넣은 절차 — 프롬프트에 4종 안내.
- 테스트: buildLearnPrompt 순수함수(표준 포함·request 포함).

## T3 — 채팅 턴 자기개선 리뷰

hermes `background_review.py` 대응. 현 reflect는 **작업(A) 완료 시만** — 채팅에서의 교정("그게 아니라…")을 자동으로 안 배움.

- 레인 턴 result 후 fire-and-forget: judge 티어 일회성 query(briefing/title 동형)에 **최근 대화 다이제스트**(user/assistant 원문 N=10턴, listConversationDialogue 재사용) + 기존 학습/스킬 인덱스를 주고 구조화 판단: `{lessons_to_add[], lessons_to_merge[], skill_suggestion?}`.
- 결과 적용은 L0: insertLesson(scope='__lain__') / (스킬 제안은 즉시 저장하지 않고) 다음 턴 레인에게 한 줄 힌트로 전달하거나 곧바로 skill_save — **구현 시 결정**(자동 저장이면 hermes처럼 알림 필수).
- 채팅에 `💾 학습 저장 — <한 줄>` tool 라인(addMessage+relay, 압축노트 패턴 미러). 텔레그램에도 미러.
- **게이트**: 설정 `turnReviewEnabled`(기본 ON, judge=haiku라 저비용) · 스킵 조건 = 도구만 쓴 중간 턴/원문 6턴 미만/직전 리뷰 후 대화 무변화 · working 중 아닐 것(consolidate 패턴).
- 저장 승인 게이트(hermes write_approval)는 **도입 안 함**(레인 학습은 이미 자동 축적 관행 + UI flag로 사후 정리) — 대신 알림은 항상.
- 테스트: 다이제스트 조립·스킵 게이트 순수함수·구조화 파싱.

## T4 — 레인 세션 검색 (FTS5)

무한세션 압축 후 world_state 요약만 남는 갭 보완 — "지난주에 얘기한 X" 원문 회수.

- **실측 먼저**: node:sqlite(현 Node 버전)에 FTS5 컴파일 포함 여부(`CREATE VIRTUAL TABLE ... USING fts5`) 확인. 미지원이면 LIKE + 시간창 폴백.
- messages 테이블 대상 FTS5 인덱스(external content 방식, insert 트리거 or addMessage 훅에서 동기 upsert).
- `mcp__lain__search_history(query, scope?, before_id?/after_id?)` — 매치 원문 + 전후 스크롤(LLM 요약 없음 = 비용 0). 결과에 대화 id·시각 포함.
- 시크릿: 검색 결과도 채팅으로 흘러가므로 `blocksSecretPath`류 스크럽은 불필요(원문 자체가 이미 채팅에 있던 것)이나, redact 관행 확인.
- 테스트: FTS upsert·검색·스크롤, 폴백 경로.

## T5 — USER 프로필 (바운디드 상시 메모리)

- `%APPDATA%\lain\user.md` — 상한 **1,400자**. soul.md 합성 지점(personaCore/loadSoul 옆)에 `## 사용자 프로필`로 주입(시스템 프롬프트 1회).
- `mcp__lain__user_profile(action: add|replace|remove, old_text?, content?)` — hermes처럼 부분 문자열 매칭, **초과 시 에러로 반환해 레인이 같은 턴에 스스로 병합·정리 후 재시도**(자동 드롭 금지).
- 학습과 역할 구분을 SYSTEM_PROMPT에 명시: 프로필=사용자 자체(호칭·선호·습관·기술 수준), 학습=작업 규칙.
- 무한세션 주의: 시스템 프롬프트는 세션 시작 고정 — 압축(세션 교체) 시 자연 반영됨을 문서화.

## T6 — 스킬 큐레이터 (T1 위)

- lesson curator(consolidateLessons) 확장 or 동형 신규: 주기 스캔에서 idle일 때, `last_used_at` 기준 30일→stale, 90일→archived(**삭제 없음**). pinned 제외. LLM 통합 패스는 도입 안 함(옵트인 비용 — lain은 학습 curator로 충분).

## T7 — 검증 증거 넛지

hermes verification-on-stop 대응. **레인이 직접** 코드 파일을 Edit/Write한 턴이 검증 실행(Bash에 test/typecheck/build류) 없이 끝나면, 다음 이어가기 1회 넛지 주입("수정했으면 검증 돌려").

- 턴 중 도구 사용 로그에서 결정론 감지(L0): 코드 확장자 수정 있음 && 검증 명령 실행 없음. 문서류 확장자(.md/.txt/...)만 수정한 턴은 억제(hermes 오탐 수정 반영).
- 넛지는 **1회 한정**(루프 방지), 설정 킬스위치.

---

## 검증 계획

- 태스크마다: typecheck 0 · vitest 그린(+신규 단위테스트) · 커밋 → C:\lain main ff-merge → **src 변경이므로 npm run deploy**.
- 라이브 검증 항목: ①/learn으로 실제 스킬 1개 생성(예: "lain 배포 절차") ②턴 리뷰가 교정 대화에서 학습 저장 + 💾 라인 표시 ③skills-index가 다음 메시지에 주입·skill_view 사용 ④search_history로 압축 이전 대화 원문 회수 ⑤텔레그램에서 /learn·💾 확인.

## 함정 미리보기

- **다이제스트 비대화**: skills-index 주입은 상한·길이 관리 필수(학습 top-K와 합산 토큰 감시).
- **스킬 이름 충돌/한글**: name은 ascii kebab 강제, 표시용 제목은 md 안에.
- **FTS5 가용성**: node:sqlite 빌드에 없을 수 있음 — 실측 선행, 폴백 설계 포함.
- **turnReview 재귀**: 리뷰 자체가 addMessage하면 "대화 무변화" 스킵 게이트가 tool 라인을 세지 않도록 user/assistant만 계수.
- **저널/DB 이중 영속**: agent_skills 메타·user.md는 크래시 복원 대상인지 결정(학습은 DB만 — 동일 수준이면 충분).
