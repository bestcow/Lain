# Lain

**관리자 Claude(Lain)가 여러 프로젝트의 Claude Code 워커(Navi)를 지휘하는 로컬 오케스트레이터** — Electron 데스크톱 앱.

> A local orchestrator where a manager agent ("Lain") directs Claude Code workers
> ("Navi") across many projects — each Navi runs in its own isolated git worktree,
> and Lain plans, dispatches, reviews, and merges their work from one screen.
> Windows desktop app built on Electron + the Claude Agent SDK.

각 프로젝트마다 Navi Claude가 격리된 git worktree에서 작업하고, 관리자 Lain이 작업을 지휘·결재한다. "여러 Navi를 동시에 굴리는 내 개발 와이어드를 한 화면에서 관리"가 목표.

## 무엇을 하나

- **작업 실행** — `TASK.md` 또는 채팅 지시 → clarify/elicitation 게이트 → 전용 git worktree에서 Navi 실행 → 검증(verify) → 사람/Lain 결재(merge·브랜치·폐기)
- **다중 세션 채팅** — Navi·Lain 각각과 직접 대화. 한 대상에 **여러 세션**을 만들고 고를 수 있다(새로 시작 / 이어가기)
- **안전장치** — 위험 명령(push·삭제·의존성·네트워크)은 승인 큐, 비밀 파일(`.env`·키) 접근 차단, autonomous 모드의 spec-gaming 방어
- **autonomous 모드** — 자동 채점 가능한 작업은 "테스트=판사"로 사람 개입 없이 실행
- **자기개선** — 검증된 작업에서 교훈을 누적·검색 주입해 점점 효율적으로. 효과는 교훈 off/on **A/B로 측정**
- **어깨너머(over-the-shoulder)** — 메인 창을 닫아도 트레이에 상주, 화면 우하단 오버레이로 작업을 곁눈질하며 실시간 조언
- **텔레그램 원격** — 자리를 비워도 폰에서 지휘·작업 시작·승인·결재·현황 확인
- **상주** — 트레이 상주, 주기 스캔, 크래시·DB 손상 자동 복원

## 전제조건

- **Windows** (현재 Windows 전용 — PowerShell·NSIS 설치본 기반. macOS/Linux 미지원)
- **Node.js 20+**
- **Git 2.x+** (worktree 사용)
- **[Claude Code CLI](https://docs.claude.com/claude-code)** (`claude`)가 PATH에 있고 **로그인**되어 있어야 한다 — Lain/Navi는 SDK가 시스템 node로 이 CLI를 스폰해 동작한다(Claude Max 구독 또는 API 키로 인증).

## 설치 · 실행

```sh
npm install
npm run dev        # 개발 실행 (electron-vite)
```

## 설정

Navi 자동 스캔 루트는 **환경변수**로 바꿀 수 있다(기본값은 Windows 개발 폴더 가정):

| 환경변수 | 기본값 | 의미 |
|---|---|---|
| `LAIN_WORKSPACE` | `C:\workspace` | 프로젝트를 자동 스캔할 워크스페이스 루트 |
| `LAIN_SCAN_DIRS` | `apps;games;tools` | 루트 하위 스캔 폴더(`;` 구분) |
| `LAIN_EXTRA_DIRS` | (없음) | 루트 밖의 프로젝트 경로를 직접 등록(`;` 구분) |

자동 스캔에 안 걸리는 프로젝트는 앱 UI에서 **수동으로 추가**할 수도 있다. 데이터(설정·대화·작업 기록)는 `%APPDATA%\lain`에 저장되며 재설치/동기화해도 보존된다.

## 명령

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 실행 |
| `npm run typecheck` | 타입체크 |
| `npm test` | 단위 테스트 (vitest) |
| `npm run build` | 빌드 (`out/`만 갱신) |
| `npm run dist` | NSIS 설치본 생성 (`dist\Lain Setup *.exe`) |
| `npm run deploy` | 빌드 → 패키징 → **설치본(`%LOCALAPPDATA%\Programs\Lain`) 동기화** → 재시작 |

> ⚠️ **코드(`src/**`)를 바꿨으면 `npm run deploy`로 끝낸다.** 바탕화면/시작 바로가기는 전부 *설치본*을 가리키고 그 코드는 `app.asar`에 냉동돼 있어, `npm run build`만으론 아이콘을 눌러도 옛 버전이 뜬다.

## 구조

- `src/main/` — L0 결정론 코어(`store`·`ipc`·`registry`·`collectors`·`worktree`·`scheduler`) + 판단 레이어(`manager`·`worker`·`workerchat`·`orchestrator`). store는 `node:sqlite`(네이티브 모듈 아님)
- `src/preload/` — `contextBridge`로 `window.lain` API 노출
- `src/renderer/` — React UI (도트 캐릭터 작업실, 네온 테마)
- `src/shared/` — main/renderer 공용 타입 (`types.ts` = IPC 계약 단일 출처)

**원칙**: 결정론 배관은 코드, 판단은 Claude. L0에 LLM 호출을 넣지 않는다(판단 레이어만 SDK 사용). 설계 전체는 [PLAN.md](PLAN.md), 개발 컨벤션은 [CLAUDE.md](CLAUDE.md) 참조.

## 라이선스

[MIT](LICENSE). 번들된 폰트·에셋 등 제3자 구성요소의 라이선스는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 참조.
