# lain — Lain 스킬 할당 + Navi 자율 사용 설계 (Spec)

> 작성: 2026-06-23 · 상태: 설계 확정(구현 전) · 후속: writing-plans → 구현
> 관련: `settingSources` 미지정이라 클로드 스킬이 로드되지 않는 문제(manager.ts·worker.ts·navichat.ts query())

## 1. 목표 / 비목표

**목표**: Lain이 **자신·Navi에게 클로드 스킬(SKILL.md)을 할당**할 수 있고, Navi/Lain이 노출된 스킬을 **스스로 판단해 사용**(Skill 도구)한다. 현재 세 query()(manager·worker·navichat)는 `settingSources`·`skills`·`plugins` 미지정이라 스킬이 전혀 안 들어간다 — 이를 켠다.

**비목표/경계**:
- **컨텍스트 오염 회피가 1순위** — `settingSources`(CLAUDE.md·슬래시·서브에이전트까지 로드, 사용자 전역 `~/.claude/CLAUDE.md`가 Lain/Navi 정체성에 섞임)는 **안 쓴다**. `plugins`로 스킬-플러그인만 로드.
- 스킬 풀은 **lain 코딩 오케스트레이션에 맞춘 큐레이션 세트** 고정(클라우드 서비스 계열 atlassian·supabase·huggingface 등 제외).
- 슬라이스 1은 **start_task 기반 per-task 할당** + 전역 온오프 + 부여 스킬 읽기 표시까지. 사용자 수동 할당 UI·per-project 기본값·message_navi 할당 파라미터는 후속.
- 안전 모델 불변 — 스킬은 Skill 도구+본문만 더할 뿐, 실제 위험동작(push·파괴·네트워크)은 기존 canUseTool·승인큐 그대로 통과.

## 2. 실측 근거 (SDK `@anthropic-ai/claude-agent-sdk` 0.3.173 타입)

> 추측금지 규칙(CLAUDE.md) — `sdk.d.ts` 직접 확인. 단, **런타임 실측은 스파이크 T0**에서.

- **`plugins?: SdkPluginConfig[]`** — `SdkPluginConfig = { type:'local', path:string, skipMcpDiscovery?:boolean }`. 플러그인의 스킬/명령/에이전트/훅을 **세션에 직접 로드**(settingSources 독립). `skipMcpDiscovery:true`면 그 플러그인의 `.mcp.json`/manifest mcpServers를 **안 읽음** → 우리가 `mcpServers:{lain}` 자체 소유하므로 MCP 오염 차단.
- **`skills?: string[] | 'all'`** — 노출 **필터**(컨텍스트 필터, 샌드박스 아님). 생략은 **"off"가 아님**(SDK 경고: CLI 기본 적용) → **항상 명시**. `'all'`=발견된 전부, `string[]`=이름 매칭(`SKILL.md` name/디렉터리명 또는 `plugin:skill`). `skills` 주면 `Skill` 도구가 allowedTools에 **자동 추가**(수동 X).
- 노출 비용 = listing(이름+설명)만, 본문(SKILL.md)은 Skill 호출 시 1회 로드 → 다수 노출 저렴(`'all'` 기본이 정당).
- `settingSources` 생략 시 CLI 기본이 모든 소스 로드일 수 있음 → **명시적으로 `settingSources:[]`(격리)** 줘서 CLAUDE.md/슬래시 오염을 확정 차단.

**스파이크 T0 결과(2026-06-23, 라이브 실측 — `.superpowers/sdd/skill-spike-findings.md`)**: ✅ `settingSources:[]` + `plugins:[superpowers]` + `skills:'all'` → init 메시지에 `Skill` 도구 추가·스킬 노출 확인, **사용자 오염 0**(사용자 개인 스킬 미노출; settingSources:['user']면 오염 재현). ⚠️ **`plugins`는 훅도 로드** — 6개 중 superpowers만 SessionStart 훅(using-superpowers 선언문 주입), `skills` 필터로도 훅은 못 막음. **사용자 결정: superpowers 풀 포함 + Task 8 라이브로 자율 Navi 거동 검증**(문제 시 비대칭 분리 후속).

## 3. 확정 결정

| # | 항목 | 결정 |
|---|---|---|
| 1 | 핵심 방향 | Lain이 Navi에 할당 **+** Navi/Lain 자율 사용(풀세트) |
| 2 | 로딩 방식 | **`plugins`로 깨끗하게** — `settingSources:[]`로 오염 확정 차단. 정체성 보존 |
| 3 | 스킬 풀 | **큐레이션 코딩 세트** = 설치된 플러그인 중 superpowers·feature-dev·commit-commands·skill-creator·code-review·code-simplifier. ⚠️ pdf/docx 등 anthropic-skills는 **설치 플러그인이 아님**(`installed_plugins.json`·캐시에 없음 — 앱 내장 추정) → `plugins` 경로로 못 줌, **이번 풀서 제외**(필요 시 별도 조사: 내장 스킬 로딩). 나중에 설정 확장 여지 |
| 4 | 기본 할당 | Lain이 미지정이면 **풀 전체**(`skills:'all'`). Lain은 작업별로 좁히거나 풀 밖 스킬 추가 |
| 5 | 할당 surface | **`start_task` MCP 도구의 optional `skills:string[]`** → `tasks.skills` 저장 → worker query() `skills` |
| 6 | message_navi / 일반 navichat | 슬라이스1은 **`'all'` 기본**(채팅엔 풀 노출). 할당 파라미터는 후속 |
| 7 | Lain 자신 | manager.ts query()에 같은 `plugins` + `skills:'all'` |
| 8 | 킬스위치 | `skillsEnabled` **기본 OFF**(신설 기능 안전 시작) — off면 `plugins`/`skills`/Skill 도구 안 붙임 = 현 동작. 스파이크·E2E로 거동 검증 후 사용자가 PrefsModal에서 ON(검증 뒤 기본 ON 전환은 후속) |
| 9 | 안전·비용 | 불변(§1 경계). 노출은 listing만 |

## 4. 아키텍처(파일별)

**A. 신규 `src/main/skills.ts`** (순수+경로해석)
- `CURATED_PLUGIN_NAMES: string[]` 상수 — `['superpowers','feature-dev','commit-commands','skill-creator','code-review','code-simplifier']`(설치 실측 확인됨).
- `resolveInstalledPlugin(name)` — **`~/.claude/plugins/installed_plugins.json`** 읽어 `<name>@claude-plugins-official` → `plugins[key][0].installPath` 반환(버전 디렉터리가 `6.0.3`·`unknown` 등 제각각이라 글로빙 대신 권위 매니페스트 사용). installPath는 `.claude-plugin/plugin.json` 보유 디렉터리 = SDK `path`로 그대로 사용. 미발견·파싱실패 플러그인은 스킵(부분 풀 허용).
- `curatedPlugins()` → `CURATED_PLUGIN_NAMES`를 resolve해 `{type:'local', path, skipMcpDiscovery:true}[]`(미발견 제외).
- ⚠️ plugins로 실제 스킬 로딩·Skill 도구 동작은 **스파이크 T0 실측**.

**B. `src/main/skills.ts`** (신규, 순수+조립)
- `skillOptions(assigned: string[] | null, enabled: boolean)` → `{ plugins?, skills?, settingSources? }` 부분 옵션 객체. enabled=false면 `{}`(아무것도 안 붙임). enabled=true면 `{ plugins: curatedPlugins(), settingSources: [], skills: (assigned && assigned.length ? assigned : 'all') }`. (curatedPlugins() 빈 배열이면 plugins 생략·skills도 생략 → 무해 폴백)
- 순수 함수 → 단위테스트 용이(세 query()가 동일 조립 사용).

**C. `src/main/store.ts`**
- 마이그레이션: `ALTER TABLE tasks ADD COLUMN skills TEXT`(JSON 배열 문자열 or NULL, try/catch).
- `start_task` 생성 경로에서 `skills` 받아 저장. 접근자에서 파싱(`JSON.parse` or null).
- 비저널이어도 무방(유실 시 'all' 폴백 — 자가치유, world_state/handoff처럼 원자성 불필요).

**D. `src/main/worker.ts`**
- query() options에 `...skillOptions(task.skills, getSettings().skillsEnabled)` 스프레드.
- naviPrompt에 (할당분이 있으면) "사용 가능한 스킬: …" 한 줄 안내는 **불필요**(SDK가 Skill 도구 listing 자동 제공). 단 자율 사용 권장 한 줄은 검토(후속).

**E. `src/main/navichat.ts`**
- query() options에 `...skillOptions(null, getSettings().skillsEnabled)`(='all').

**F. `src/main/manager.ts`**
- query() options에 `...skillOptions(null, getSettings().skillsEnabled)`(='all').
- SYSTEM_PROMPT에 A/B 위임 지침 옆에 **스킬 할당 한 줄**: "Navi에 작업 줄 때 `start_task`의 `skills`로 그 작업에 맞는 스킬만 좁혀줄 수 있다(미지정=전체). 큐레이션 풀: brainstorming·systematic-debugging·test-driven-development·feature-dev·commit·pdf/docx/xlsx 등."

**G. `src/main/worker.ts` MCP 도구 정의(`start_task`)**
- 입력 스키마에 optional `skills: string[]`(스킬 이름 배열) 추가. 핸들러가 store에 전달.

**H. 설정/IPC**
- `LainSettings`에 `skillsEnabled: boolean` 추가(store getSettings/saveSettings 기본값 + types 동기화).
- `Task` 타입(shared/types.ts)에 `skills?: string[]` 추가 → IPC로 렌더에 전달.

**I. `src/renderer/`**
- **PrefsModal**: `skillsEnabled` 토글(킬스위치).
- **TaskDrawer**: 그 작업의 `skills` 읽기 표시(있으면 칩/목록, 없으면 "전체" 또는 미표시). 사용자 편집은 후속.

## 5. 데이터 흐름

Lain이 작업 위임 → `start_task(project, instructions, skills?)` → orchestrator가 task 생성 시 `tasks.skills` 저장 → worktree Navi 스폰 시 worker.ts가 `skillOptions(task.skills, enabled)`로 query() `plugins`+`skills` 구성 → Navi가 노출된 스킬을 Skill 도구로 자율 호출. 렌더는 `tasks.skills`를 TaskDrawer에 표시.
Lain 자신/Navi 채팅: 항상 `'all'`(enabled 시) → 풀 전체 자율 사용.

## 6. 미결 질문 (구현 중 확정)

- **풀 정확 멤버**: §3#3 목록 확정(superpowers 어느 스킬까지? 전부 vs 코어만). 스파이크 T0에서 실제 발견 결과 + §7 process-gating 리스크 검토로 조정.

## 7. 에러/엣지 · 리스크

- ⚠️ **process-gating 스킬 ↔ 자율 Navi 흐름**: superpowers `brainstorming`(HARD-GATE: 설계 승인 전 구현 금지)·`test-driven-development`·`writing-plans` 같은 프로세스 스킬이 노출되면, TASK.md를 받아 **바로 구현**해야 할 자율 Navi가 "설계부터 하자"며 멈출 수 있다(orchestrator의 무개입 verify 흐름 교란). 완화: ①`using-superpowers`의 `<SUBAGENT-STOP>`·brainstorming의 "creative work 시작 전" 트리거상 *구체 작업 실행* Navi엔 안 걸릴 가능성 — **스파이크/E2E로 실측** ②위험하면 기본 풀에서 프로세스-게이팅 스킬 제외(capability 스킬 pdf/docx/debugging/code-review 위주), Lain이 필요 시 `skills`로 명시 부여 ③킬스위치 OFF 기본이 1차 방어.
- 플러그인 경로 미발견(버전 갱신·미설치) → 그 플러그인 스킵, 나머지 풀로 진행(부분 허용). 전부 실패 시 `skills` 안 붙임 = 현 동작(무해).
- `task.skills` 파싱 실패/NULL → `'all'` 폴백.
- 패키징 설치본: 플러그인은 `%USERPROFILE%\.claude\plugins`(asar 밖) → 접근 가능 예상, **스파이크 T0 실측**.
- 워크트리 cwd 무관 — 플러그인 경로는 절대(사용자 홈).
- `skillsEnabled` off → `skillOptions`가 `{}` 반환 → 기존 동작 100% 동일(회귀 0).

## 8. 테스트

- **단위**: `skillOptions` 순수함수(enabled on/off, assigned null/빈배열='all' vs 배열, curatedPlugins 빈배열 폴백). store `tasks.skills` 왕복(저장·파싱·NULL). `resolveInstalledPlugin` 경로 해석(installed_plugins.json 픽스처).
- **스파이크 T0(라이브)**: ①plugins로 settingSources:[] 상태에서 스킬 listing 노출 ②Skill 도구 자동 추가·실제 호출 동작 ③skipMcpDiscovery로 lain MCP만 ④`skills` 필터 이름 해석(`plugin:skill`) ⑤설치본 경로 접근. findings 문서화.
- **라이브 E2E**: webapp fresh Navi에 `skills:['systematic-debugging']`로 작업 → Navi가 그 스킬 호출 + 미할당 스킬 미노출 확인. enabled off 회귀(스킬 없음) 확인.
- typecheck · `npm test` · `npm run deploy`.

## 9. 후속(이번 범위 밖)

- 사용자 수동 스킬 할당 UI(작업/Navi별 체크박스), per-project 기본 스킬.
- `message_navi`에 `skills` 파라미터(B-모드 채팅별 할당).
- 풀을 설정 allowlist로(PrefsModal에서 멤버 튜닝).
- 스킬 사용 telemetry(어느 스킬이 실제 도움됐는지 → 학습 폐루프 연계, §22~24).
