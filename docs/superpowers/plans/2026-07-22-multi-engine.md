# 멀티 엔진 지원(Codex 공식 지원) 구현 계획 — M0~M3

> 2026-07-22 작성. **실행자: Codex CLI(최상위 모델)** / 게이트 승인·병합·배포·push: 사용자.
> 이 문서는 자립형이다 — 이 문서 + `AGENTS.md` + 아래 참조 코드만으로 구현한다. 대화 맥락을 가정하지 않는다.
> 시작 전 필독: `AGENTS.md` 전체, `PLAN.md` §4(결정론/판단 경계)·§14(구조)·§18(실측 문화), `HANDOFF.md`(로컬 현황).
> 용어 규칙: 이 기능의 공식 명칭은 **"멀티 엔진"**이다("혼합 함대"류 표현 금지). 사용자 대면 문구는 전부 한국어.

## 0. 목표 / 비목표

### 목표 (사용자 관점)
1. **외부 Codex 세션 관찰** — 사용자가 레인 밖 터미널/IDE에서 직접 돌린 Codex 세션을 레인이 인지·표시·요약한다. 기존 Claude Code 연동(`ccHooksEnabled`, src/main/cchooks.ts)과 **대칭 구조**.
2. **멀티 엔진 UI** — Claude/Codex가 섞인 작업·세션을 한 화면에서 난해하지 않게 표기한다. 1차 축은 엔진이 아니라 **origin**(레인이 만든 작업=조작 가능 vs 밖에서 관찰된 세션=열람·이어받기만), 엔진(claude|codex)은 그 위의 배지다.
3. **프로바이더 스왑(플래그 뒤)** — 작업 Navi에 한해 kimi/deepseek 등 Anthropic 호환 엔드포인트를 claude 하네스 env 오버라이드로 태운다. **엔진 추가가 아니라 모델 스왑**이다 — 승인 큐·ask_manager·학습 주입이 전부 그대로 산다.

### 비목표 (하지 않는다 — 이유 포함)
- **외부 세션의 네이티브 resume 승격** — 외부 세션의 미커밋 변경은 프로젝트 루트에 있어 레인의 worktree 격리 계약과 충돌한다. 이어받기는 **다이제스트 핸드오프**(새 작업 생성)로만 한다.
- **codex 엔진에 승인 큐·ask_manager 재현** — `codex exec`는 비대화형이라 구조적으로 불가(src/main/engines.ts 주석 근거). 재현하려 하지 말고 **정직한 강등 표기**로 푼다.
- **제3 CLI 엔진(gemini 등) 추가** — M4로 이 계획 범위 밖.
- **매니저(레인 본체)·judge의 엔진/모델 변경** — Claude 고정(PLAN §4). 워커와 심판이 다른 모델인 것은 독립 심사로 오히려 장점.
- **시크릿 암호화 저장소 신설** — 기존 settings 저장 관례 유지(단, redact 등록은 한다 — §7 M3).

## 1. 절대 안전 규칙 (전 구간 공통 — 위반 커밋은 폐기 대상)

1. **main 무접촉**: 모든 작업은 브랜치 `feat/multi-engine`에서. main 체크아웃에 커밋 금지, **push 금지**, `npm run deploy` 금지. 병합·배포는 게이트에서 사용자가 한다. → 롤백 = 브랜치 삭제로 항상 가능.
2. **기능 플래그 기본 OFF**: 새 런타임 동작(연동 설치·관찰·프로바이더)은 전부 설정 토글 뒤에 두고 기본값 off. OFF면 기존 동작과 관측 가능한 차이가 없어야 한다(다크 론치).
3. **사용자 홈 파일 수정은 런타임 기능으로만**: `~/.codex/config.toml` 편집 코드는 앱의 옵트인 토글 핸들러로 구현한다. **구현·테스트 과정에서 실제 `~/.codex`·`~/.claude`를 읽고 쓰지 않는다** — 전부 임시 디렉터리 픽스처 + 경로 주입(기존 관례: codex.ts `LAIN_CODEX_AUTH`, ccsessions.ts `root` 인자).
4. **DB는 additive만**: `safeAlter('ALTER TABLE … ADD COLUMN …')` 패턴(store.ts:369 부근 관례)만 허용. DROP/RENAME/데이터 변형 마이그레이션 금지 → 롤백 후 구버전 코드가 새 컬럼을 무시해도 무해해야 한다.
5. **IPC는 additive만**: 채널 추가만 하고 기존 시그니처는 불변. 채널 추가 시 ipc.ts + preload/index.ts + shared/types.ts(LainApi) **3곳 동기화**(AGENTS.md 컨벤션).
6. **시크릿 취급**: `auth.json`류는 존재 확인만(내용 읽기 금지 — codexStatus 관례). 토큰·키를 로그·이벤트·다이제스트·테스트 픽스처에 남기지 않는다.
7. **실측 우선**: M0 결과가 이 문서의 가정과 다르면 **구현을 중단**하고 부록 A에 결과를 기록한 뒤 §8 축소선을 적용해 보고한다. 통과를 위한 임의 우회·테스트 주석 처리 금지.
8. **파일 쓰기는 Node(fs)로**: PowerShell `Set-Content`는 PS5.1에서 BOM을 붙여 JSON/TOML을 파괴한 전례가 있다.
9. **테스트 원칙**: vitest(`npm test`), 태스크마다 TDD. 실 codex CLI 설치·실 네트워크·실 홈 디렉터리에 의존하는 테스트 금지(스크립트 spawn 실측 테스트는 test/main/cchook-script.test.ts 관례처럼 자체 픽스처로).
10. **외부 세션 데이터는 사용자의 사적 대화다**: 실측 기록·주석·픽스처에 실제 세션 **내용을 인용 금지** — 필드명·구조만 기록한다.

## 2. 설계 원칙과 기존 자산 지도

원칙 4개 — 렌더러·문구 전반에 일관 적용:
- **origin × engine 축 분리**: 목록을 엔진별로 쪼개지 않는다. 단일 목록 + 엔진 배지 + 필터.
- **capability 기반 렌더링**: 렌더러에서 `if (engine==='codex')` 분기 금지. engines.ts의 capability를 IPC로 받아 분기한다. 새 엔진 추가 시 UI가 자동 적응해야 한다.
- **동일 동사, 정직한 강등**: 지시·중단·이어받기 같은 사용자 동사는 엔진 불문 같은 자리·같은 이름. 안 되는 기능은 **숨기지 말고 비활성(회색) + 이유 한 줄**(문구는 engines.ts에 단일 출처로 둔다).
- **모바일 동시 반영**: 표기 변경은 텔레그램 카드(telegramcards.ts)에도 같이 간다.

| 자산 | 파일 | 재사용 포인트 |
|---|---|---|
| 엔진 capability 레지스트리 | src/main/engines.ts | `ENGINE_CAPABILITIES`·`engineCapabilities()` — UI 노출·강등 문구의 단일 출처로 확장 |
| Codex 실행 어댑터 | src/main/codex.ts | exec/resume·`mapCodexLine`·`codexStatus` — 스키마 지식·경로 탐지 재사용 |
| CC 연동(대칭 원본) | src/main/cchooks.ts | 훅 멱등 설치·inbox 이벤트·projects.json cwd 매칭·judge 요약 지점 — codexlink.ts가 동형 복제 |
| CC 세션 열람 | src/main/ccsessions.ts | 방어적 JSONL 파서·head/tail 대용량 방어·root 인자 주입 — codexsessions.ts가 동형 |
| 실행 계약 | src/main/worker.ts·orchestrator.ts | NaviReport·RunNaviOpts — **변경 금지** |
| DB | src/main/store.ts | `cc_events`(:1587 부근)·`safeAlter`(:369)·settings 매핑(:3227/:3375) |
| IPC 계약 | src/main/ipc.ts·src/preload/index.ts·src/shared/types.ts | 토글 반영 관례(ipc.ts:748)·`ccHooksEnabled`(types.ts:349) |
| 부팅/종료 | src/main/index.ts | `bootStep`(:448)·shutdown 등록(:109) |
| 렌더러 | SessionList·ActivityPanel·TaskDrawer·NaviTile·InputModeBar·PrefsModal·lib/activityFeed.ts | 표기 지점(정확 위치는 구현 시 탐색) |
| 시크릿 마스킹 | src/main/safety.ts | M3 토큰 redact 등록 |

※ 줄 번호는 2026-07-22 기준 근사치 — 밀렸으면 심볼로 찾는다.

## 3. 마일스톤 흐름과 게이트

```
M0 실측 → ⛔게이트0(보고·사용자 승인) → M1 관찰 → ⛔게이트1 → M2 UI → ⛔게이트2 → M3 프로바이더 → ⛔최종
```

- 브랜치는 `feat/multi-engine` 하나. 태스크 단위로 커밋(한국어 컨벤션: `feat(scope): …`), 커밋 메시지 성실히(AGENTS.md — 커밋이 도구 간 공유 맥락).
- **각 게이트에서 정지**하고: `npm run typecheck` 0에러 + `npm test` 전체 그린(기존 스위트 무회귀) + 플래그 OFF 스모크(§10) + `HANDOFF.md` 갱신(마일스톤 요약·다음 할 일) 후 사용자 보고. 다음 마일스톤은 승인 후 진행.
- `UPDATE.md` 한 줄 추가는 main 병합 시점의 일(사용자 측)이므로 하지 않는다.

## 4. M0 — 실측 (코드 작성 전 필수)

방법: **임시 디렉터리를 CODEX_HOME 삼아**(A에서 오버라이드 가능성부터 확인) 격리 실행. 실 `~/.codex/config.toml`을 건드려야만 확인 가능한 항목은 원본 백업 → 확인 → 즉시 복원. 결과는 **부록 A 표에 기입하고 커밋**(codex --version 명시). 세션 내용 인용 금지(§1-10).

| # | 항목 | 확인할 것 |
|---|---|---|
| A | 홈 오버라이드 | `CODEX_HOME`(또는 동등 env)로 config/세션 루트를 옮길 수 있는가 — 이후 모든 실측·테스트의 격리 수단 |
| B | notify | 설정 방법(config.toml 문법), 발화 이벤트 종류, payload 필드(**cwd·thread/session id 유무가 핵심**), 전달 방식(argv JSON? stdin?), TUI 세션에서 발화하는가 |
| C | rollout 세션 파일 | `~/.codex/sessions/` 경로 규칙(날짜 하위 구조), **라이브 append 여부**(세션 진행 중 파일이 자라는가), 첫 줄/메타에 cwd·id가 있는가, user/assistant 이벤트 스키마 |
| D | exec JSON 드리프트 | 현 설치 버전에서 `codex exec --json` 이벤트가 codex.ts 실측(0.142.5: thread.started/item.completed/turn.completed…)과 같은가 |
| E | config.toml 실구조 | 최상단에 마커 블록(top-level 키) 삽입이 유효한가, 기존 사용자 설정과의 충돌 지점 |
| F | (참고 기록만) | `codex exec resume <thread_id>`가 TUI가 만든 스레드에도 듣는가 — 비목표지만 후속 판단용으로 기록 |

**게이트0**: B·C 결과에 따라 §8 축소선 중 무엇이 적용되는지 명시해 보고. 승인 전 M1 코드 착수 금지.

## 5. M1 — 외부 Codex 세션 관찰 (cc-link 대칭)

구조: notify(실시간 신호) → inbox 이벤트 + rollout 열람(내용 다이제스트) — cchooks(신호)·ccsessions(열람)의 2단 구조를 그대로 복제한다.

- **1.1 `src/main/codexsessions.ts` (신규)** — ccsessions.ts 동형: 방어적 JSONL 파서, head/tail 대용량 방어, 루트 경로는 인자 주입(기본 `~/.codex/sessions`). 프로젝트 매칭은 세션 메타의 cwd(실측 C 확정 필드). 산출: 프로젝트별 세션 목록 + `codexSessionDigest`(이어받기용 결정론 발췌). 세션 상태는 단정하지 말고 3상태(진행 중 추정/최근/종료 추정 — mtime 정지 기준)로.
- **1.2 `src/main/codexlink.ts` (신규)** — 토글 설치기 + inbox:
  - notify 스크립트 `lain-codex-notify.cjs`(DATA_DIR/codex-link) — cchooks `HOOK_SCRIPT_SOURCE` 관례(문자열 export + spawn 실측 테스트). cwd를 projects.json과 대조해 등록 프로젝트의 세션만 이벤트로 떨군다. **피드백 루프 방지**: 레인이 띄운 codex exec는 cwd가 worktree(DATA_DIR 하위)라 등록 루트 매칭에서 자연 제외된다(cchooks와 동일 원리) — 테스트로 고정.
  - config.toml 편집: **TOML 파서 금지.** 파일 최상단에 마커 블록(`# lain-codex-link begin` ~ `end`) 삽입/제거만 한다. 기존에 사용자 자신의 `notify` 키가 있으면 **설치 거부 + 사유 반환**(fail-closed, 사용자 설정을 절대 덮지 않는다). 최초 수정 전 `config.toml.lain-bak` 백업(있으면 덮지 않음). 언인스톨 = 마커 블록 제거. 파일이 없으면 마커 블록만으로 생성.
  - inbox 워처는 cchooks의 events 디렉터리 감시 패턴 복제(공용화는 additive 소규모만 허용).
- **1.3 store.ts** — `safeAlter("ALTER TABLE cc_events ADD COLUMN engine TEXT")`(NULL=claude로 해석), `addCcEvent`에 engine 옵션 인자(기본 'claude'). 설정 `codexLinkEnabled`/`codex_link_enabled`(기본 off) — types.ts:349·store.ts:3227/:3375 관례.
- **1.4 IPC 3곳 동기화** — 토글 반영(ipc.ts:748 관례로 `applyCodexLink()`), 세션 목록/다이제스트 조회 채널(기존 CC 세션 조회 채널을 탐색해 engine 매개변수화가 가능하면 additive로, 아니면 신규 채널).
- **1.5 index.ts** — `bootStep('codexLink', …)` + shutdown 등록.
- **1.6 렌더러 최소 표기** — SessionList·ActivityPanel에 codex 세션/이벤트 노출(엔진 라벨 텍스트 수준 — 본격 배지는 M2). activityFeed.ts 병합에 engine 전달.
- **LLM 호출 없음**: M1은 전부 결정론 배관이다. SessionEnd류 이벤트가 없으므로 CC의 종료 요약 같은 judge 호출을 신설하지 않는다(요약은 M2 이어받기 시점에만).

## 6. M2 — 멀티 엔진 UI

- **2.1 capability IPC 노출** — engines.ts `ENGINE_CAPABILITIES` + 강등 사유 문구(`capabilityNotes` — 예: "승인 큐 없음 — Codex 샌드박스가 보호")를 신규 채널로 렌더러에 제공. 문구 단일 출처는 engines.ts.
- **2.2 배지·강등 표기** — TaskDrawer·NaviTile·ActivityPanel·SessionList에 엔진 배지(CRT 테마 안에서 아이콘/라벨 우선, 색 남발 금지). origin 구분은 기존 UI 구획을 유지하되 관찰 세션 라벨을 '관찰'로 통일. 승인 큐 등 안 되는 요소는 capability로 분기해 **회색 + 이유 툴팁**(숨김 금지).
- **2.3 이어받기(핸드오프 승격)** — 관찰 세션 항목에 "이어받기" 액션: 다이제스트(ccSessionDigest/codexSessionDigest) → **judge.ts 러너 경유** 요약(60s abort·실패 시 원문 꼬리 폴백 — 판단 지점 규칙 준수) → 기존 작업 생성 흐름에 핸드오프 블록으로 전달. 엔진 선택 가능(기본 claude). 신규 IPC 1개.
- **2.4 텔레그램 카드** — telegramcards.ts 작업 카드에 엔진 1단어 표기.
- **2.5 엔진 선택 노출** — 현재 start_task의 engine 인자 사용 경로를 탐색한 뒤, InputModeBar의 작업 위임 그룹 관례(이름표 병기)로 엔진 선택을 추가. codex 선택 시 강등 고지 1줄(capabilityNotes 재사용).

## 7. M3 — 프로바이더 스왑 (플래그 뒤, 라이브 검증은 사용자)

전제: kimi·deepseek의 Anthropic 호환 엔드포인트는 **구현 시점에 공식 문서로 재확인**한다(추측 금지). 여기서 만드는 것은 배관과 UI뿐이고, 실 API 라이브 검증은 부록 B 절차로 사용자가 한다.

- **3.1 설정** — `providerProfiles`(settings 저장 관례): `{id, label, baseUrl, authToken, modelId}`. 플래그 `providerSwapEnabled` 기본 off(OFF면 UI 전체 숨김). **safety.ts redact에 authToken 마스킹 등록**(로그·다이제스트 유출 차단).
- **3.2 tasks 컬럼** — `safeAlter`로 `provider TEXT` 추가(NULL=기본 Anthropic).
- **3.3 env 주입** — agentopts.ts의 **worker 세션 옵션에만** `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/모델ID 오버라이드 주입. `judgeQueryOptions`·manager 경로 불변을 테스트로 어서션(심판·본체는 Anthropic 고정).
- **3.4 UI** — PrefsModal 프로필 관리(플래그 뒤), 작업 위임 모델 선택에 프로필 노출, 작업 카드 모델 배지. **'설정 표시 = 실제 적용' 원칙**: 별칭이 아니라 실제 전달되는 고정 modelId를 표기.
- **3.5 테스트** — 옵션 빌더의 env 전파 단위 테스트만(실 네트워크·실 키 금지). 부록 B에 사용자용 라이브 검증 절차서 작성(kimi 스모크 → deepseek 스모크 → 실패 시 §8).

## 8. 축소선 (사전 선언 — 해당 조건이 확인되면 재설계 없이 이대로 축소하고 부록 A에 기록)

| 조건(실측/구현 중 확인) | 축소 |
|---|---|
| rollout이 라이브 append가 아님 | 실시간 진행 표시 제거 — notify 신호 + 사후 열람으로 축소 |
| notify payload에 cwd/스레드 식별 없음 | 프로젝트 매칭을 rollout 스캔으로 대체(약간의 지연 허용) |
| notify 자체 불가·불안정 | M1은 온디맨드 열람 전용(프로젝츠 창을 볼 때 갱신) — config.toml을 아예 건드리지 않게 됨 |
| CODEX_HOME 오버라이드 불가 | 테스트는 파서 픽스처만으로, 설치기는 부록 B에 수동 검증 절차로 |
| exec JSON 스키마 드리프트(D) | mapCodexLine 보수 태스크를 M1 앞에 삽입(별도 커밋) |
| deepseek 호환 조악(라이브 검증) | kimi 단독 + '실험' 라벨 |
| kimi도 불안정 | M3 플래그 OFF 유지 — 배관만 merge(다크), UI 미노출 |

축소로도 해소가 안 되고 계획 밖 재설계가 필요하면: **중단하고 질의**(임의 진행 금지).

## 9. 롤백 절차

- **병합 전**(기본 상태): `feat/multi-engine` 브랜치 삭제로 완전 원복 — main 무접촉이 §1-1로 보장됨.
- **병합 후 1차**: 설정 토글/플래그 OFF — 런타임 즉시 무력화(재배포 불요). `codexLinkEnabled` OFF는 언인스톨(마커 블록 제거)까지 수행(cchooks OFF 관례와 동일하게).
- **병합 후 2차**: `git revert` — DB 신규 컬럼은 남지만 additive라 구코드에 무해.
- **`~/.codex` 복구**: 언인스톨 = 마커 블록 제거. 비상시 `config.toml.lain-bak` 복원(절차를 부록 B에 명기).
- 관찰로 쌓인 `cc_events`(engine='codex') 행은 사용자 데이터이므로 **자동 삭제하지 않는다**(요청 시에만).

## 10. 완료 정의(DoD) — 마일스톤 공통

- `npm run typecheck` 0에러, `npm test` 전체 그린(기존 스위트 무회귀).
- **플래그 OFF 스모크**: 토글을 켜지 않은 상태에서 부팅·작업 생성·기존 CC 연동(on/off 각각)에 관측 가능한 변화 없음. `~/.codex`는 토글 전까지 어떤 경로에서도 접근되지 않음.
- 신규 모듈 전부 테스트 동반(TDD), notify 스크립트는 spawn 실측 테스트 포함.
- 부록 A 실측 기록 완성, 게이트마다 HANDOFF.md 갱신.
- 이 문서의 결정(비목표·축소선 포함)을 임의 변경하지 않았음 — 변경이 필요했다면 질의 기록이 있음.

## 부록 A. 실측 기록 (M0에서 Codex가 기입)

- codex 버전: `codex-cli 0.142.5` (2026-07-22, Windows 번들 CLI)
- | # | 결과 | 근거(명령/관찰 — 세션 내용 인용 금지) |
  |---|---|---|
  | A | 통과 | 임시 `CODEX_HOME`에서 `codex login status`가 별도 미로그인 상태를 보였고, `config.toml`·`sessions/`가 모두 그 루트 아래에 생성됐다. 실 사용자 홈은 읽거나 쓰지 않았다. |
  | B | 통과 | top-level `notify = ["node", "…/notify.cjs"]`로 exec와 TUI 모두 `agent-turn-complete`를 발화했다. 스크립트는 JSON argv 1개를 받았고 payload 키는 `client`, `cwd`, `input-messages`, `last-assistant-message`, `thread-id`, `turn-id`, `type`였다. cwd와 스레드 식별자가 모두 있다. |
  | C | 통과 | 경로는 `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`. 한 정상 턴에서 진행 중 `37,162B` → 완료 후 `38,394B`로 증가해 라이브 append를 확인했다. 첫 줄 `session_meta.payload`에 `id`·`cwd`·`source`·`cli_version`·`model_provider`가 있고, 대화는 `response_item/message`의 `role=user|assistant` + `input_text|output_text`; 신호는 `event_msg`의 `user_message`·`agent_message`·`task_started`·`task_complete` 구조다. |
  | D | 통과 | 격리 `codex exec --json`에서 `thread.started(thread_id)` → `turn.started` → `item.completed(agent_message)` → `turn.completed(usage.input_tokens/cached_input_tokens/output_tokens/reasoning_output_tokens)`를 관찰했다. `src/main/codex.ts`의 0.142.5 계약과 일치해 보수 태스크가 필요 없다. |
  | E | 통과 | 파일 최상단 마커 주석 사이에 `notify`를 넣은 config로 exec/TUI가 모두 정상 구동했다. 기존 top-level `notify`가 있는 격리 config에 같은 키를 추가하면 CLI가 `duplicate key`로 거부하므로, M1 설치기는 계획대로 기존 키 감지 시 fail-closed 해야 한다. |
  | F | 통과 | TUI가 만든 스레드 ID를 `codex exec resume <thread_id> --json -`로 재개했고, 같은 `thread_id`의 턴이 정상 완료됐다. 참고 결과이며 외부 세션 승격 비목표는 유지한다. |
- 적용된 축소선: 없음

## 부록 B. 사용자 라이브 검증 절차 (구현 완료 후 Codex가 작성)

- M1: 실제 `~/.codex`에 토글 설치 → 외부 codex 세션 1개 → 레인 표기 확인 → 토글 OFF → config.toml 원상 확인.
- M3: kimi/deepseek 키 입력 → 등록 프로젝트에서 소형 작업 1개 스모크 → 실패 시 §8 축소선.
- `config.toml.lain-bak` 수동 복원 절차.
