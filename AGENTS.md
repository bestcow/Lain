# lain

여러 레포를 가진 개발자의 로컬 AI 오케스트레이터 — Claude Code 작업을 지휘·검증·병합하는 관제탑(얼굴은 레인). 일정관리·음성대화·범용 감시 같은 컴패니언 기능은 비목표(PLAN.md §2).
설계 전체는 `PLAN.md` 참조 — **코드 작업 전 PLAN.md의 해당 섹션을 먼저 읽는다.**

## 현재 단계

Phase 0~3 + autonomous 첫 슬라이스(§21)까지 구현됨 — 작업 실행(worktree Navi)·승인 큐·Navi 직접 채팅·전체 broadcast(§5.6)·작업 중 인터럽트(§5.7)·설정/티어링·주기 스캔·트레이 상주·크래시 복원(§15b)·관리자 자동 우선순위·autonomous 모드(hands-off + spec-gaming 방어). 남은 것과 진행 상태는 `HANDOFF.md` 참조.

## 명령

- `npm run dev` — 개발 실행 (electron-vite)
- `npm run build` — 빌드 (out/ 만 갱신)
- `npm run typecheck` — 타입체크
- `npm run dist` — NSIS 설치본 생성 (`dist\lain Setup *.exe`)
- **`npm run deploy`** — 빌드 → 패키징(--dir) → 실행 중 lain 종료 → **설치본(`%LOCALAPPDATA%\Programs\lain`) 동기화** → 재시작

## ⚠️ 배포: 코드 변경은 반드시 `npm run deploy` 로 끝낸다

바탕화면/시작/시작프로그램 바로가기는 전부 **설치본** `%LOCALAPPDATA%\Programs\lain\lain.exe`를 가리킨다. 그 안의 코드는 `resources\app.asar`에 **냉동**돼 있다. `npm run dev`/`npm run build`는 `C:\lain\out\` 만 갱신할 뿐 이 설치본 asar에는 **절대 반영되지 않는다** — 그래서 빌드만 하면 사용자는 아이콘을 눌러도 영원히 옛 버전을 본다(과거 실제로 반복된 문제).

**규칙: lain 코드(src/**)를 수정했으면, 응답을 끝내기 전에 `npm run deploy` 를 실행해 설치본까지 밀어 넣는다.** typecheck/build만으로 "반영됐다"고 보고하지 말 것. 데이터는 `%APPDATA%\lain`에 있어 재설치/동기화해도 보존된다(부팅 시 `recoverTasks`로 작업 재개).

## 레포 운영 · 릴리스

- 원격은 `bestcow/Lain` 하나다. **여기서 직접 개발하고, 커밋·push가 곧 공개다.** 사적인 것은 애초에 레포에 들어오지 않는 구조로 막는다(아래).
- **레포에 들어가지 않는 것**: 개인 작업 기록(`HANDOFF.md`·`UPDATE.md` — gitignore, 틀은 `*.example.md`로 추적하고 `npm install` postinstall이 없을 때만 복사), 로컬 지침(`CLAUDE.local.md`), 데이터(`data/`·`%APPDATA%\lain`), 로컬 도구 상태(`.claude/`·`.remember/`), `.env`.
- **커밋 신원**: 레포 로컬 `user.name`/`user.email`을 GitHub noreply로 고정해 둔다(전역 실이메일이 커밋에 박히는 것 방지).
- 개인 식별자·시크릿을 막는 pre-push 훅이 있으면 설치해 두면 좋다 — 훅은 클론에 복제되지 않으므로 셋업마다 1회 설치가 필요하다(설치 방법은 로컬 `CLAUDE.local.md` 참조, 있는 경우).
- **릴리스 절차**: ① `package.json` 버전 bump → ② **`CHANGELOG.md`에 해당 버전 섹션 작성**(사용자 관점 요약 — 커밋 로그 복붙 금지; 근거는 로컬 `UPDATE.md`의 해당 버전 섹션) → ③ `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-gate.ps1` 통과(현재 버전 섹션 없으면 거부) → ④ push → ⑤ 설치본 릴리스가 필요하면 `npm run dist -- --publish` → ⑥ **`UPDATE.md`에 다음 버전 빈 섹션 생성**.
- **작업 기록(UPDATE.md, 로컬 전용)**: 코드 변경을 main에 병합할 때마다 `UPDATE.md`의 "(작업 중)" 버전 섹션에 제목 한 줄을 추가한다 — 다음 릴리스 때 무슨 작업이 쌓였는지 여기서 확인.

## 구조 (PLAN.md §14)

- `src/main/` — L0 결정론 코어 (Electron Main). store(`node:sqlite` — 네이티브 모듈 아님)·registry·collectors·manager(L1 래퍼)·ipc
- `src/preload/` — contextBridge로 `window.lain` API 노출
- `src/renderer/` — React UI (CRT 그린 테마)
- `src/shared/` — main/renderer 공용 타입 (`types.ts`가 IPC 계약의 단일 출처)
- `data/` — SQLite (.gitignore)

## 컨벤션

- 결정론적 배관은 코드, 판단은 Claude (PLAN.md §4). LLM 호출은 ① 세션 본체(manager·worker·navichat) ② judge 지점(judge.ts 러너 경유 — 60s abort·maxTurns 2·실패 무해 폴백)만 허용. 결정론 배관 모듈(store·worktree·registry·collectors·safety·ipc·usage 등)엔 금지.
- IPC 채널 추가 시: ipc.ts(핸들러) + preload/index.ts + shared/types.ts(LainApi) 세 곳 동기화.
- Agent SDK 옵션은 추측 금지 — PLAN.md §18 체크리스트로 실측 후 사용.
- 시크릿·.env 값을 로그/다이제스트에 남기지 않는다 (PLAN.md §9-6).

## 서브에이전트·병렬 작업 (모든 AI 도구 공통)

작업을 안전하게 독립적인 하위 작업으로 나눌 수 있고 병렬화가 속도·품질·검증 신뢰도를 실질적으로 높인다고 판단되면, 에이전트는 사용자에게 **별도로 요청·승인받지 않고 스스로 서브에이전트(subagents)·병렬 에이전트(parallel agent work)·작업 위임(delegation)을 사용한다.** 단순·강하게 순차적·긴밀히 결합된 작업이나 병렬화 비용이 이득보다 큰 작업은 단일 에이전트로 진행한다. 사용 여부·분할 방식·에이전트 수는 주 에이전트가 작업 성격에 맞게 판단하고, 위임하는 각 작업은 구체적·독립적 범위로 좁힌다. 주 에이전트가 결과 통합·충돌 확인·최종 검증·사용자 보고를 책임진다. **멀티에이전트를 쓴다고 기존 승인·안전·파괴적 작업·commit/push 규칙이 확장·완화되지 않는다** — 각 서브에이전트에도 그대로 적용된다. 기능이 없거나 병렬화가 부적절하면 단일 에이전트로 계속하며, 멀티에이전트를 쓴다는 이유만으로 사전 승인을 다시 묻지 않는다.

## 세션 절차 (모든 AI 도구 공통)

Claude Code에서는 훅이 이 절차를 자동 보조하지만, Codex 등 다른 도구에서는 이 텍스트가 규칙의 전부다.

- **시작**: `HANDOFF.md`(로컬 전용, gitignore)를 먼저 읽는다 — 마지막 작업 / 다음 할 일 / 막힌 것. 로컬 지침 `CLAUDE.local.md`가 있으면 함께 읽는다.
- **종료 (코드·기능을 수정했다면 필수)**: `HANDOFF.md`를 갱신하고, main에 병합한 변경은 `UPDATE.md`의 "(작업 중)" 섹션에 제목 한 줄을 추가한다 (위 "레포 운영 · 릴리스" 참조).
- **HANDOFF 위생(갱신하는 세션의 의무)**: `HANDOFF.md`의 날짜 엔트리는 **최근 2주(최대 8개)만 전문 유지** — 초과분은 갱신하는 세션이 그 자리에서 하단 '이전 세션 (아카이브 — 한 줄 요약)'으로 압축한다. 상태 문서에 이력을 무한 누적하지 않는다.
- **commit/push는 명시 요청 시에만.** 이 레포는 push가 곧 공개다.
- 커밋 히스토리가 도구 간 공유 맥락이다 — 커밋 메시지를 성실히 쓴다.
