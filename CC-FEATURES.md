# lain — Claude Code 기능 흡수 로드맵 (CC-FEATURES)

Claude Code에서 확인/사용 가능한 기능을 lain에 단계적으로 흡수하는 계획서.
**사용자가 승인한 항목만** 담는다. 각 항목은 착수 시점에 개별 스펙(brainstorm→spec→plan)으로 내려간다.
"가능할 때마다 하나씩" 구현 — 아래 순서는 권장이지 강제가 아니다.

> 마스터 설계는 `PLAN.md`. 이 문서는 그 위에 얹는 기능 백로그다.

---

## 0. 백본 원칙 (모든 항목이 따르는 규칙)

세션에서 합의한 2축 모델. 새 기능은 반드시 이 틀에 맞춰 붙인다.

- **① 흐르는 것 (cascade 행동 — 너 → Lain → Navi):** 명령·툴·모드처럼 "행동" 성격. 위에서 발동하면 아래로 권한이 흐른다. 실제 호출은 기존 `canUseTool` 승인 게이트(시크릿·위험명령·spec-gaming 방어, `safety.ts`/`worker.ts`)를 **그대로 통과**한다.
- **② 머무는 것 (너 전용 뷰/설정):** 화면·조작 표면은 최상단인 사용자만. UI 추가는 `ipc.ts` + `preload/index.ts` + `shared/types.ts` 3곳 동기화(CLAUDE.md 규칙).
- **③ 두 축 다 (등록=위, 사용=아래, 관측=다이제스트):** MCP·플러그인은 "등록"은 너 전용 UI(신뢰·보안 결정), "사용"은 cascade. Lain은 raw 화면이 아니라 **다이제스트로** 관측(PLAN.md §10 그대로).

**SDK 게이트:** Agent SDK 옵션 동작은 추측 금지 — `*실측*` 태그가 붙은 항목은 PLAN.md §18 체크리스트로 실측 후 확정한다.

---

## 1. 권장 구현 순서

| 단계 | 클러스터 | 왜 이 순서 |
|---|---|---|
| P1 | 외부 MCP 소켓 | cascade 배관의 증명 + 가장 큰 빈칸. 이후 다수 기능이 이 위에 얹힘 |
| P2 | 실행 제어 cascade | Lain이 Navi 실행방식(모드·예산·툴)을 지정 — 기존 permissionMode 확장 |
| P3 | 명령·자동화 | 슬래시·에이전트·hooks·loop |
| P4 | Navi 툴 확장 | 이미지·브라우저(P1 의존)·web·서브에이전트 가시화 |
| P5 | Git/GitHub | commit/PR·리뷰·코멘트 |
| P6 | 너 전용 뷰 | 토큰·컨텍스트·diff·transcript 관측 |
| P7 | 세션·표면 | resume·테마·백그라운드·fast |
| P8 | 정체성 안전 슬라이스 | project 규칙 흡수 + lain 메모리 확장 |

---

## 2. 클러스터별 백로그

상태: ☐ 미착수 · ◐ 진행 · ☑ 완료

### P1 — 외부 MCP 소켓 (③ 등록=위 / 사용=아래)
- ☑ **외부 MCP 서버 연결** — stdio/SSE/HTTP. 등록은 너 전용 UI, 사용은 per-Navi/Lain 할당 → `canUseTool` 통과. 켠 서버만 주입(토큰 게이팅). 구현(2026-06-25, 커밋 7b0e1c3): `store.ts` mcp_servers 테이블+CRUD, `mcp.ts` 빌더, manager/worker/navichat query 머지, IPC 5채널, PrefsModal UI. SDK transport 3종 실측 확정. ⚠ 미검증: 실제 외부 서버 라이브 핸드셰이크(빌드·타입·테스트·배포만 확인) — 스모크 테스트 필요. OAuth 흐름은 후속.
- ☑ **플러그인 마켓 설치/관리 UI** — 구현(2026-06-25): `plugins.ts`(번들 claude CLI 셸아웃 `plugin list/install/uninstall` — 설치 재구현 대신 위임), `skills.ts` 하드코딩 CURATED → 사용자 설정 `curatedPlugins`(파라미터 주입, 순환 import 회피), IPC/preload/types, PrefsModal "클로드 플러그인" 섹션(설치목록 할당토글·제거 / 검색 설치). MCP는 `skipMcpDiscovery` 유지(lain이 MCP 소유). ⚠ 미검증: 실제 install/uninstall 셸아웃 라이브 실행(빌드·타입·테스트만).
- ☑ **MCP 리소스/프롬프트 사용** — 실측 결과 SDK에 별도 옵션 없음: 외부 MCP 서버 연결(item 1) 시 에이전트가 리소스 툴·프롬프트 슬래시를 **자동 수신**. 즉 item 1로 자동 충족, 별도 코드 불필요 — 스모크 테스트로 확인 권장.

### P2 — 실행 제어 cascade (①)
- ☑ **권한모드 전환 + Lain의 Navi별 모드 지정** — 구현(2026-06-25): Task에 `permissionMode {default|acceptEdits|bypass}`(기본 acceptEdits). Lain은 `start_task` 툴 `permission_mode` 파라미터로, 사용자는 TaskDrawer 셀렉터로 지정. **bypass=lain-네이티브**(승인 큐만 자동통과 — 시크릿 차단·spec-gaming·루프가드는 유지). raw SDK `bypassPermissions`는 그 방어까지 다 꺼서 **의도적으로 안 씀**(실측 확정). autonomous/interactive 모드 지정은 §21로 이미 있었음. ⚠ 진행 중 변경은 다음 재개부터 적용 · 미검증: 라이브 bypass 실동작.
- ☐ **plan 모드 강제** — 다음 슬라이스. 단순 permissionMode 값이 아니라 **plan→승인→실행 워크플로**(SDK 'plan'은 도구 미실행)라 worker 실행루프를 바꿔야 함. 승인 큐(§9-4)·elicitation(§21.3)과 맞물림.
- ☑ **thinking 예산 지정** — 구현(2026-06-25): Task `thinkingLevel {default|off|auto|high}` → SDK `thinking` 옵션(adaptive/enabled/disabled, deprecated maxThinkingTokens 대신 신형). Lain=start_task `thinking` 파라미터, 사용자=TaskDrawer 셀렉터. default=미설정(현행). ⚠ 미검증: 라이브 사고량 변화.
- ☑ **allow/deny 툴 명시제어** — 구현(2026-06-25): Task `disallowedTools[]` → SDK `disallowedTools`(블랙리스트). Lain=start_task `disallowed_tools`, 사용자=TaskDrawer 입력. **allowedTools(화이트리스트)는 ask_manager 등 필수 도구를 실수로 날리는 footgun이라 의도적으로 미노출.** canUseTool 가드와 별개 SDK 필터.

### P3 — 명령·자동화 (① + ③)
- ☐ **커스텀 슬래시 커맨드** — `.claude/commands` 류. 너→Lain→Navi가 같은 명령 실행. cascade로 발동.
- ☐ **커스텀 에이전트 정의** — `.claude/agents` 역할별 서브에이전트 정의를 Navi가 호출. `*실측*`: SDK agent 정의 주입.
- ☐ **hooks 자동화** — PreToolUse/PostToolUse/Stop 등 규칙. 등록=너, 발동=시스템, 관측=다이제스트. `*실측*`: SDK `hooks` 지원 범위(현재 "hooks"는 내부 콜백 이름으로만 사용 중 — 충돌 주의). 닿는 곳: query 옵션 + 규칙 저장/관리 UI.
- ☐ **loop 모드** — 프롬프트/커맨드 주기 반복. 기존 `scheduler.ts`와 통합 검토.

### P4 — Navi 툴 확장 (①)
- ☐ **이미지 입력(멀티모달)** — 스크린샷·이미지를 작업 입력으로(UI 버그 재현 등). `*실측*`: SDK 이미지 입력 경로. 닿는 곳: 작업 입력 + Navi 채팅(`navichat.ts`).
- ☐ **컴퓨터유즈/브라우저 자동화** — 데스크톱·브라우저 조작 MCP로 Navi가 실화면 검증. **P1(MCP 소켓) 의존.** 메모리 학습 `capturePage ≠ 실화면`/`렌더 검증 주의`의 정공 해법.
- ☐ **Web검색/페치 제어** — 이미 켜져 있음(allowedTools 미제한). UI 가시화 + on/off 제어만 추가.
- ☐ **서브에이전트 dispatch 가시화** — Navi 내부 Task 분기(병렬 서브에이전트)를 화면·다이제스트에 노출.

### P5 — Git/GitHub (① 행동 / ② 표면)
- ☐ **commit/PR 생성 흐름** — 지금 bash `gh`로만 가능 → 전용 흐름·승인 카드로 격상. 워크트리(`worktree.ts`)·배포 규칙과 정합.
- ☐ **PR 리뷰(/review)** — Navi/Lain이 PR 구조적 리뷰.
- ☐ **PR 코멘트 처리(pr-comments)** — PR 인라인 코멘트 읽고 대응.

### P6 — 너 전용 뷰 (②)
- ☐ **토큰·cost 표시** — Navi별·전체 누적 토큰/비용(/cost 대응). 닿는 곳: SDK result usage 수집 → `collectors.ts`/UI.
- ☐ **컨텍스트 사용량 미터** — 현재 컨텍스트 창 점유율(compaction 임박 표시). `compactgate.ts`와 연동.
- ☐ **diff 뷰어** — Navi 변경을 diff로 시각화. 커밋·미커밋 diff(orchestrator의 검증 로직 재활용).
- ☐ **transcript 열람/검색** — Navi 세션 원본 열람·검색. `journal.ts`(이벤트 소싱 §21.4)와 연동.

### P7 — 세션·표면 (② / ③)
- ☐ **resume/continue 조작** — 종료된 Navi 세션을 사용자가 직접 이어서 재개. 기존 `recoverTasks` 복원과 구분되는 수동 표면.
- ☐ **status line / 테마(output style)** — 상태줄·출력 스타일 등 lain 화면 커스터마이징(CRT 그린 테마 확장).
- ☐ **백그라운드 작업 가시화** — 백그라운드 bash·장기 프로세스를 화면에 노출.
- ☐ **fast 모드 토글** — Opus 빠른 출력 모드를 작업별 on/off. §9b 티어링과 결합.

### P8 — 정체성 안전 슬라이스 (③, 제한적)
- ☐ **Navi가 project CLAUDE.md 따르기** — 작업 Navi가 *대상 프로젝트 폴더의* CLAUDE.md만 읽고 따름. **`project` 계층 한정**, 글로벌(user) 페르소나·설정은 제외. `*실측*`: `settingSources:['project']` 동작(§18). 닿는 곳: `worker.ts` query 옵션.
- ☐ **lain 자체 메모리 확장** — CC auto-memory를 붙이지 않고 lain 고유 학습(`selfimprove.ts`/lessons §22·§22.4)을 키운다. 정체성 보존.

---

## 3. 명시적 제외 (정체성 보존 — 넣지 않기로 확정)

- ✗ **Lain에 글로벌 `~/.claude/CLAUDE.md` 로딩** — 매니저 정체성 오염.
- ✗ **블랭킷 `settingSources` 노출** — 전 계층(스킬·hooks·설정) 통째 주입 → 예측불가·토큰폭증. `skills.ts`가 큐레이션만 쓰는 이유.

---

## 4. 항목 착수 규칙

1. 한 항목을 집을 때 PLAN.md 해당 §를 먼저 읽는다.
2. SDK 옵션 `*실측*` 태그는 §18 체크리스트로 실측 후 확정 — 추측 금지.
3. UI 추가 = `ipc.ts` + `preload/index.ts` + `shared/types.ts` 동기화.
4. 코드 변경은 `npm run typecheck` 통과 + `npm run deploy`로 설치본까지 반영하고 끝낸다.
5. 완료 시 이 문서 체크박스(☐→☑) + `HANDOFF.md` 갱신.
