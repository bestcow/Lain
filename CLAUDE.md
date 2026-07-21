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

- 결정론적 배관은 코드, 판단은 Claude (PLAN.md §4). L0에 LLM 호출 넣지 않는다 — manager.ts만 SDK 사용.
- IPC 채널 추가 시: ipc.ts(핸들러) + preload/index.ts + shared/types.ts(LainApi) 세 곳 동기화.
- Agent SDK 옵션은 추측 금지 — PLAN.md §18 체크리스트로 실측 후 사용.
- 시크릿·.env 값을 로그/다이제스트에 남기지 않는다 (PLAN.md §9-6).
