# 2026-07-11 클론 관점 전수 감사 — 실행 추적 문서

> 출처: 멀티에이전트 감사(클론 관점 8렌즈 finder 병렬 → 의미 병합 → 발견마다 독립 3표 적대검증 → 완결성 비평 → 보강 라운드 → 종합). 에이전트 76·토큰 4.87M·오류 0.
> 흐름: 원시 15건 → 병합 13건 → 1차 확정 6건 → 비평이 미점검 5영역 지목 → 보강 신규 7건 중 3건 확정 → **최종 9건**.
> 근거의 파일:줄 번호는 **감사 시점(커밋 `649d0cc`, 2026-07-11) 기준** — 구현 전 반드시 현재 코드로 재확인할 것.
>
> **클론 관점** = 개발자 머신 셋업(계정명·이메일 등 개인 식별자 포함)·하드코딩·기존 `%APPDATA%\lain` 데이터가 전혀 없는, 공개 레포 `bestcow/Lain`을 방금 `git clone`한 신규 사용자. 공개본은 dev 레포에서 공개 스냅샷 스크립트(비공개 전용)가 만든 클린 스냅샷(git 추적 & 제외목록 밖 파일만 실림).
>
> **실행 규칙**: 항목 완료 시 `[x]` 체크. 근거 코드 확인 → 구현 → `npm run typecheck` + 테스트 → 체크 순. IPC 추가 시 ipc.ts+preload/index.ts+shared/types.ts 3곳 동기화(CLAUDE.md). src/** 변경 세션은 `npm run deploy`로 마감.
>
> **범위 밖(적대검증 탈락)**: B(머신 하드코딩)·G(라이선스) 렌즈의 후보는 3표 적대검증에서 반증돼 확정 목록에 없다. 예 — `paths.ts`의 `C:\lain` 폴백(패키징본은 .git 부재로 자기-업데이트 안전 비활성), Supertonic 화자 임베딩의 OpenRAIL-M 라이선스 건(검증자 다수 기각). 재개 시 참고만.

## 경영진 요약

클론 사용자가 지금 이 공개본을 받으면 부딪히는 가장 큰 벽은 다음과 같다.

**1. `npm install`이 첫 단계에서 죽는다 (E1 / 상·L).** 현행 LTS인 Node 24+ 환경에서 `@discordjs/opus`가 프리빌트를 못 찾고 네이티브 빌드 폴백으로 넘어가는데, README는 Visual Studio 빌드 툴체인을 요구하지 않는다. 결과적으로 신규 사용자는 의존성 설치조차 완료하지 못하고, 앱을 한 번도 띄워보지 못한 채 이탈한다. 다른 모든 결함보다 앞서는 하드 블로커다.

**2. 비개발자용 설치 경로가 죽은 페이지로 이어진다 (A1 / 상·S).** README/문서가 권장하는 Releases 페이지가 비어 있어(gh API로 실측: releases 0건, `/latest` 404), 소스 빌드를 할 줄 모르는 사용자는 다운로드 대상이 없는 빈 페이지에 도달한다. 1번을 회피할 능력이 없는 사용자층에게는 사실상 유일한 진입로가 막혀 있는 셈이다.

**3. 첫 실행 후에도 곳곳에서 오작동한다 (E 다수).** 설정 UI에 미출시 모델 `fable(claude-fable-5)`이 정상 선택지로 노출돼, 고르면 전 턴이 실패한다. Supertonic 로컬 TTS는 사이드카 의존성이 클론에 설치되지 않아 죽어 있다. 즉 설치를 통과하더라도 "정상처럼 보이는" 선택지가 조용히 앱을 망가뜨린다.

**4. 안전 경계가 문서 기대보다 약하다 (D1 / 중·M).** 매니저(레인) 셸 게이트에 RISKY 승인 계층이 없어, Navi보다 약한 가드로 push·install·curl을 무승인 실행한다. 신규 사용자가 hands-off로 돌릴 때 예기치 않은 파괴적/네트워크 동작이 승인 없이 나갈 수 있다.

**5. 내부 정보 유출 (A2·C1 / 하·S).** CLAUDE.md가 공개본에 그대로 실려 신규 사용자를 메인테이너 전용 배포 절차로 오도하고, PLAN.md는 개발자의 실제 비공개 프로젝트 명단을 노출한다. 둘 다 하드게이트 정규식을 통과해 버린 유출이라 클론 사용자에게 그대로 보인다.

## 실행 순서

| 단계 | 성격 | 처리 묶음 | 근거 |
|------|------|-----------|------|
| **1단계 — 배포 차단급 (설치 자체가 불가)** | 릴리스 게이트 | E1: Node 24+ `@discordjs/opus` 네이티브 빌드 폴백 사망(opus를 프리빌트/선택적 의존성으로 전환하거나 README에 툴체인 명시) → A1: Releases 자산 채우기 | 이 둘이 막히면 그 아래 모든 결함은 사용자가 도달조차 못 하므로 최우선. 두 진입로(소스 설치·바이너리 다운로드)를 동시에 복구해야 실효 |
| **2단계 — 유출 차단 (되돌릴 수 없는 노출)** | 공개 전 필수 | C1: PLAN.md 비공개 프로젝트 명단 제거 → A2: CLAUDE.md 공개 제외/재작성. 아울러 하드게이트 정규식에 해당 패턴 추가 | 유출은 한 번 push되면 회수 불가. 1단계와 독립이며 다음 공개 스냅샷 전에 반드시 선행 |
| **3단계 — 첫 실행 오작동 (설치는 됐으나 조용히 깨짐)** | 런타임 정합성 | E2: fable 미출시 모델 UI 노출 제거/게이팅 → E3: Supertonic 사이드카 의존성 설치 경로 정비 | 설치 통과 사용자가 곧바로 만나는 "정상처럼 보이는 함정". 1·2단계 완료 후 첫 사용 경험 안정화 |
| **4단계 — 안전·건전성** | 강화 | D1: 매니저 셸 게이트 RISKY 승인 계층 추가 → F1: history.ndjson 회전/압축·부팅 전량 재재생 완화 | 즉시 크래시는 아니나 hands-off 운영 시 위험·장기 성능 저하. 앞 단계 안정화 후 |
| **5단계 — 마감 품질** | 폴리시 | H1: buildResources 아이콘 경로 수정(존재하는 디렉터리로) 및 앱/설치본 아이콘 지정 | 사용자 대면 인상 문제, 기능 무영향. 마지막 |

## A. 첫 실행·온보딩

- [x] **A1. 권장 설치 경로(Releases)가 비어 있어 비개발 신규 사용자가 죽은 페이지에 도달** `상·S`
  - 현재: README '설치 (권장)'은 대다수 신규 사용자에게 소스 빌드 대신 Releases에서 .exe를 받으라 안내하고(README.md:41, README.en.md:55) '한 번 설치하면 자동 업데이트'를 약속한다(README.md:42, README.en.md:56). electron-builder.yml:38-41은 그 자동 업데이트 피드를 github/bestcow/Lain으로 건다. 그러나 해당 릴리스 피드에 게시된 배포물이 없으면 releases/latest는 빈/404가 되어, 1순위 설치 경로를 따른 사용자는 설치 자체가 불가능하고 자동 업데이트 약속도 뒷받침이 없다.
  - 개선: 실제 설치본 릴리스를 게시하거나(`npm run dist -- --publish`로 .exe·latest.yml 첨부), 릴리스가 생기기 전까지 README '설치 (권장)' 블록을 소스 빌드 우선으로 바꾸고 'Releases 준비 중' 문구로 대체한다.
  - 근거: README.md:41, README.md:42, README.en.md:55, README.en.md:56, electron-builder.yml:38
  - 검증: 3표 중 반증 0 — 인증 gh CLI로 실측 `gh api repos/bestcow/Lain/releases` length 0, `/releases/latest` HTTP 404 확인.

- [x] **A2. CLAUDE.md가 공개본에 그대로 실려 신규 사용자를 메인테이너 전용 절차로 오도** `하·S`
  - 현재: README.md:137이 신규 사용자에게 '개발 컨벤션은 CLAUDE.md 참고'라고 안내하는데, CLAUDE.md는 공개 스냅샷 제외 목록에 없어 클론본에 포함된다. 그 안엔 클론 환경에 무의미·유해한 지시가 있다: '레포 운영·공개 배포' 절이 'origin(비공개)만 push', '공개 레포 bestcow/Lain 직접 push 금지', '공개 스냅샷 스크립트 실행'을 지시하지만 그 스크립트는 공개 제외라 클론본에 없다. 또 '⚠️ 코드 변경은 반드시 npm run deploy로 끝낸다'를 강제하는데(README.md:126 개발 표에도 일반 명령처럼 등재), 클론 사용자가 npm run deploy를 돌리면 설치본이 없어 deploy.ps1:24-26 'throw 설치본이 없음'으로 즉시 실패한다.
  - 개선: 공개 스냅샷 제외 목록에 CLAUDE.md를 추가하거나, 공개용으로는 '레포 운영·공개 배포'·'npm run deploy 강제' 등 메인테이너 전용 절을 제거한 클론-안전 버전으로 대체한다.
  - 근거: README.md:137, README.md:126, 공개 스냅샷 제외 목록, scripts/deploy.ps1:24
  - 검증: 3표 중 반증 1 — 오도·불일치 실재 확인(코드 크래시·유출 아님, deploy 실패도 우아한 throw라 심각도 하).

## C. 시크릿·개인정보 유출

- [x] **C1. PLAN.md가 개발자의 실제 비공개 프로젝트 명단을 공개본에 노출 — 하드게이트 정규식 밖** `하·S`
  - 현재: PLAN.md는 공개 스냅샷 제외 목록에 없어 공개 스냅샷에 실린다. PLAN.md:15의 '여러 프로젝트를 동시에 개발 중' 예시 열거와 PLAN.md:346-352의 무대 목업 카드가 모두 개발자가 병행 중인 개인 프로젝트명 로스터(구체 명단은 사설 기록 참조)를 그대로 드러낸다. 하드게이트의 패턴(개인 식별자·계정명·실경로·시크릿 형식)은 이런 프로젝트명을 매칭하지 않아 무사통과한다. 시크릿은 아니나 클론 사용자가 개발자의 사적 작업 목록을 알게 되는 개인정보 노출이다.
  - 개선: 릴리스용 PLAN.md에서 실제 프로젝트 로스터를 중립화(예: 'projectA, projectB …' 또는 '여러 프로젝트')하거나 PLAN.md를 공개 스냅샷 제외 목록에 추가한다.
  - 근거: PLAN.md:15, PLAN.md:346, PLAN.md:352, 공개 스냅샷 제외 목록·하드게이트
  - 검증: 3표 중 반증 1 — 프로젝트명이 소문자라 계정명용 대소문자 구분 단어경계 패턴에 안 걸려 무사통과 확인(코드·자격증명 아닌 코드네임뿐이라 심각도 하).

## D. 무설정 안전 강등

- [x] **D1. 매니저 셸 게이트에 RISKY 승인 계층 부재 — 레인은 Navi보다 약한 셸 가드로 push·install·curl 무승인 실행** `중·M`
  - 현재: worker(Navi) canUseTool은 push·rm -rf·의존성 설치·네트워크 등 개발 위험 명령을 RISKY 매칭 시 승인 큐로 보낸다(worker.ts:778, worker.ts:807). 반면 매니저(레인) canUseTool은 시크릿 파일/경로(manager.ts:2289-2299)와 OS 파괴(classifySystemDestructive, manager.ts:2303-2331)만 게이트하고 RISKY 계층이 전혀 없다(manager.ts에 RISKY/outside 참조 0건). sysrisk.ts의 isRootDelete는 루트급 대상만 잡으므로(sysrisk.ts:51-79) `rm -rf ./src` 같은 하위 삭제, `git push --force`, `npm install <임의패키지>`, `curl … | sh`는 매니저에서 아무 승인 없이 즉시 실행된다. 결과적으로 전 레포 접근권을 가진 더 강력한 에이전트(레인)가 격리된 worktree Navi보다 셸 가드가 약하다. 클론 사용자가 첫날 '정리해줘' 류 요청만 해도 무승인 파괴·네트워크 명령이 자기 머신에서 돈다.
  - 개선: 매니저 canUseTool에도 worker의 RISKY 판정을 적용해 acceptEdits/기본 모드에서 위험 셸 명령을 동일하게 승인 큐로 보낸다(bypass에서만 자동통과). sysrisk(OS 파괴) 위에 개발 위험 계층을 겹친다.
  - 근거: src/main/manager.ts:2287, src/main/manager.ts:2303, src/main/worker.ts:778, src/main/worker.ts:807, src/main/sysrisk.ts:51
  - 검증: 3표 중 반증 0 — worker RISKY 배열(worker.ts:79-87)과 매니저 미보유(grep 0건) 대조 확인. 정렬된 매니저 LLM이 개시해야 하고 OS 파괴는 여전히 게이트되므로 심각도 중.

## E. 외부 의존 전제

- [x] **E1. Node 24+(현행 LTS) 클론에서 `npm install`이 @discordjs/opus 네이티브 빌드 폴백으로 죽는다 — README는 툴체인을 요구하지 않는다** `상·L`
  - 현재: package.json:28의 `@discordjs/opus`(^0.10.0)는 optionalDependencies가 아닌 하드 dependency이고, 그 설치 스크립트는 `node-pre-gyp install --fallback-to-build`(node_modules/@discordjs/opus/package.json:10)다. 이 패키지는 프리빌트 바이너리를 GitHub 릴리스에서 받아 오지만, 릴리스 에셋은 실행 중인 Node의 정확한 node_abi로 키가 매겨진다(napi-v3 태그가 붙어 있어도 버전 간 재사용 안 됨). v0.10.0 릴리스가 발행한 win32 에셋은 node-v72~node-v127뿐, 즉 최대 Node 22(ABI 127)까지다. 매칭 에셋이 없으면 `--fallback-to-build`가 발동해 node-gyp로 C++ 컴파일을 시도한다. 그런데 README.md:44의 소스 빌드 전제조건은 'Node.js 20+, Git 2.x+'만 요구하고 MSVC/Windows Build Tools·Python을 언급하지 않는다. 2026년 현재 신규 사용자가 'Node 20+' 안내를 보고 자연스럽게 설치하는 현행 LTS는 Node 24/25(ABI 137+)인데, 이 ABI에는 프리빌트 opus 바이너리가 없으므로 빌드 폴백 → 툴체인 부재 → `npm install` 자체가 컴파일 실패로 죽는다. Releases가 비어 있어(A1) 소스 빌드가 유일 경로인데 그 입구가 막힌다. 부차적으로 win32-arm64 에셋은 어떤 node_abi에도 없어 ARM64 Windows(Copilot+ PC 등) 클론은 Node 버전과 무관하게 항상 같은 방식으로 실패한다. 메인테이너 머신은 Node v24.14.0(ABI 137)에서 로컬 컴파일이 성공(MSVC 설치돼 있음)해 이 결함이 가려져 있다.
  - 개선: 세 가지 중 택 — (1) @discordjs/opus를 optionalDependencies로 내리고 순수 JS인 opusscript(이미 deps에 있음, package.json:34)로 런타임 폴백해 install 실패가 치명적이지 않게 한다(@discordjs/voice는 둘 중 하나만 있으면 동작). (2) 최소한 README.md:44 소스 빌드 전제에 'Node 20 또는 22 LTS 권장(Node 24+는 프리빌트 opus 미제공, MSVC C++ Build Tools 필요), win32-arm64 미지원'을 명시하고 `.nvmrc`/engines 상한을 둔다. (3) opus 프리빌트가 커버하는 Node 버전으로 engines를 조이거나 opus 상위 버전으로 올려 현행 LTS를 커버한다. 가장 견고한 건 (1).
  - 근거: package.json:28(하드 dependency), node_modules/@discordjs/opus/package.json:10(node-pre-gyp --fallback-to-build), README.md:44(전제에 C++ 툴체인·Python 미언급), GitHub API v0.10.0 에셋(win32 node-v72~127만, node-v137·win32-arm64 전무), node_modules/@discordjs/opus/prebuild/node-v137-...(메인테이너 머신 로컬 컴파일로 생성 — 빌드 폴백 직접 증거)
  - 검증: 3표 중 반증 0 — gh api로 릴리스 에셋 실측, 메인테이너 node_modules의 node-v137 프리빌드가 업스트림엔 없어 로컬 빌드로만 생성 가능함을 확인(실패 메커니즘 독립 확증).

- [x] **E2. 미출시 모델 fable(claude-fable-5)이 설정 UI에 정상 선택지로 노출 — 선택 시 전 턴 실패** `중·M`
  - 현재: MODEL_IDS.fable = claude-fable-5로, 코드 주석 자체가 곧 출시라며 아직 존재하지 않는 모델임을 명시한다(src/shared/models.ts:16). 그런데 이 티어는 MODEL_TIERS(models.ts:9)에 포함돼 렌더러의 3개 모델 선택 UI 전부에 나온다: 입력창 바(InputModeBar.tsx:97), 작업 드로어(TaskDrawer.tsx:491), 환경설정 PrefsModal(PrefsModal.tsx:23,216-221). PrefsModal은 각 옵션을 `fable — claude-fable-5`로 렌더링하되 local 티어에만 '(실험적 — 로컬 서버 필요)' 꼬리표를 붙이고(PrefsModal.tsx:219) fable에는 아무 경고가 없어, 클론 사용자에게 sonnet/opus와 동등한 사용 가능 모델처럼 보인다. 클론 사용자가 Lain(manager)/Navi/judge 중 어느 티어든 fable을 고르면 tierQueryOptions가 model=claude-fable-5를 그대로 SDK query()에 넘기고(agentopts.ts:36-37), 시작 시 모델 유효성 검사가 없어(store.ts:3174 asTier는 티어명 소속만 확인) 매 턴이 실패한다. 실패는 manager.ts 에러 처리에서 전용 안내가 없어 원 SDK 에러가 그대로 노출되거나(manager.ts:2604-2605), claude.exe가 process exited with code 1로 죽는 경우 인증 실패 분기(manager.ts:2595-2603)에 오분류돼 토큰 만료/재로그인 같은 엉뚱한 처방으로 안내될 수 있다. 원인이 모델 선택임을 사용자가 알 길이 없다.
  - 개선: fable을 실제 출시 전까지 MODEL_TIERS/선택 UI에서 제외하거나, 최소한 local처럼 명시적 '(미출시 — 선택 불가)' 꼬리표 + 선택 시 비활성(disabled) 처리로 오인을 막는다. 병행하여 store.ts asTier가 아직 사용 불가 티어를 기본 폴백(sonnet)으로 강등하도록 하면 무설정/오선택 크래시를 막을 수 있다.
  - 근거: src/shared/models.ts:16, src/shared/models.ts:9, src/main/agentopts.ts:36, src/renderer/components/PrefsModal.tsx:219, src/renderer/components/InputModeBar.tsx:97, src/renderer/components/TaskDrawer.tsx:491, src/main/manager.ts:2595
  - 검증: 3표 중 반증 1 — UI 3곳 노출·SDK 전달·에러 오분류 경로 확인(기본값 아닌 능동 선택 발동이라 심각도 중).

- [x] **E3. Supertonic 로컬 TTS가 dev 클론에서 죽어 있음 — 사이드카 의존성이 설치되지 않음** `중·S`
  - 현재: Supertonic 사이드카는 시스템 node로 server.js를 띄우고(supertonic-proc.ts:62) 그 server가 onnxruntime-node/fft.js/js-yaml을 import한다(sidecar/supertonic/package.json:11-14). 이 의존성 설치는 오직 dist/deploy 경로에서만 실행되고(package.json:23, deploy.ps1:56), `npm run dev`(package.json:17)에는 없다. sidecar node_modules는 gitignore라 스냅샷에도 없다(sidecar/supertonic/.gitignore). 따라서 클론 사용자가 npm run dev로 띄운 뒤 TTS 백엔드를 Supertonic으로 고르면 사이드카가 import 단계에서 즉시 exit → synthesizeSupertonic이 20초 데드라인까지 재시도(tts.ts:147-168)한 뒤 throw → synthesizeBackend가 조용히 Edge로 폴백(tts.ts:110-113). 결과: 매 발화마다 20초 지연 + 선택한 목소리가 무시됨('설정 표시=실제 일치' 위배). 기본은 edge라 opt-in 시에만 발현.
  - 개선: 루트 package.json에 postinstall로 'npm --prefix sidecar/supertonic install --omit=dev'를 추가하거나, ensureSupertonic이 사이드카 node_modules 부재를 감지하면 20초 재시도 대신 즉시 명확한 사유로 실패해 Edge로 즉답 폴백하게 한다. 최소한 설정 UI에 dev에서 Supertonic 미가용임을 표기.
  - 근거: package.json:17, package.json:23, src/main/supertonic-proc.ts:62, sidecar/supertonic/package.json:11, src/main/tts.ts:147, src/main/tts.ts:110
  - 검증: 3표 중 반증 1 — README.md:47-50이 클론 사용자에게 명시적으로 `npm run dev`를 안내(사이드카 install 건너뛰는 정규 경로)임이 결정적. App.tsx:559가 폴백 힌트를 띄워 '완전 침묵'은 아니나 20초/발화 지연·선택 목소리 무시는 실재.

## F. 데이터·스토리지 신뢰성

- [x] **F1. 진실원천 저널(history.ndjson)이 회전·압축 없이 무한 증가하고 매 부팅 전량 재재생된다** `하·M`
  - 현재: 저널은 append-only + per-write fsync로만 쓰이고(journal.ts:55-68) 회전/압축/상한 로직이 없다(rotate/compact/truncate grep 0건 확인). 부팅마다 initStore가 reconcileFromJournal()을 호출하고(store.ts:593), 이 함수는 readJournalEntries()로 파일 전체를 읽어 JSON.parse한 뒤(journal.ts:88-108) 모든 msg 엔트리를 INSERT OR IGNORE로 재재생한다(store.ts:961-979). 즉 저널 크기에 대해 O(전체 이력)의 읽기·파싱·statement 실행이 매 부팅 반복된다. 메시지는 삭제 톰스톤이 있어도 원본 라인이 남는다(append-only). 정상 사용만으로 수만~수십만 줄이 되어 부팅이 느려지고 디스크를 잠식한다.
  - 개선: 부팅 시 reconcile 성공 후, 이미 DB에 반영된 오래된 msg를 제외하고 최신 conv/set 스냅샷 + 최근 구간만 남긴 새 history.ndjson으로 원자적 재작성(temp+rename)하거나, 크기/줄수 상한 초과 시 컴팩션을 도입해 재재생 비용과 디스크 사용을 유계화한다.
  - 근거: src/main/journal.ts:55, src/main/journal.ts:88, src/main/store.ts:593, src/main/store.ts:961
  - 검증: 3표 중 반증 1 — 신규 클론은 빈 저널로 시작해 수개월 정상 사용 후에야 체감되는 완만한 성장 결함이라 심각도 하.

## H. 빌드·패키징 무결성

- [x] **H1. 앱·설치본 아이콘 미설정 — buildResources가 존재하지 않는 build/를 가리켜 기본 Electron 아이콘으로 배포** `하·S`
  - 현재: electron-builder.yml:5가 buildResources: build를 지정하지만 레포에 build/ 디렉터리가 없고(git ls-files·ls 확인), yml 어디에도 icon이나 nsis installerIcon이 없다. 메인 프로세스도 창 아이콘을 설정하지 않고 트레이만 인라인 base64를 쓴다(tray.ts:8-19). 결과적으로 클론 사용자가 npm run dist로 만든 NSIS 설치본·설치된 exe·바탕화면 바로가기가 모두 productName 'Lain'이 아닌 일반 Electron 기본 아이콘으로 뜬다(기능은 정상, 완성도 결함).
  - 개선: 이미 추적되는 assets/lain.png(또는 lain-face.png)를 256px .ico로 변환해 build/icon.ico로 두거나 electron-builder.yml win 섹션에 icon: 경로를 명시한다.
  - 근거: electron-builder.yml:5, electron-builder.yml:27, src/main/tray.ts:8
  - 검증: 3표 중 반증 0 — build/ 디렉터리·추적 .ico 부재 확인(순수 완성도 결함이라 심각도 하).

## 처리 현황 (2026-07-11 세션 — 실행 순서대로 구현)

전 9건 구현·검증 완료(typecheck 클린, 전체 테스트 1264 통과). 워크트리 편집 상태 — 커밋·배포 대기.

| 항목 | 상태 | 조치 |
|------|------|------|
| **E1** | ✅ | `@discordjs/opus`→optionalDependencies(package.json). 빌드 실패해도 install 안 죽고 opusscript(순수 JS) 자동 폴백. README 양본 안내 |
| **A1** | ⚠ 부분 | README 양본을 소스빌드 우선 + '설치본 준비 중'으로. **실제 Releases 게시는 배포 액션(미완)** — E1 반영 dist 후 `npm run dist -- --publish` |
| **C1** | ✅ | PLAN.md를 publish 제외목록에 추가. 코드/프롬프트 잔여 개인 프로젝트명 중립화(`webapp`). 스프라이트 테마 키워드는 위장돼 유지 |
| **A2** | ✅ | CLAUDE.md를 publish 제외목록에 추가. README:138 dangling 링크 정리 |
| **E2** | ✅ | fable을 MODEL_TIERS에서 제외(선택 3곳 사라짐), PrefsModal이 단일출처 사용. `asTier`가 저장된 fable→sonnet 자동 강등 |
| **E3** | ✅ | `ensureSupertonic` 사이드카 node_modules 부재 fast-fail(20초 행 제거→즉답 edge). `setup:supertonic` 스크립트 |
| **D1** | ✅ | 매니저 canUseTool에 RISKY 승인 게이트(worker와 동형, bypass만 자동통과). push·rm-rf·의존성설치·curl 무승인 실행 차단 |
| **F1** | ✅ | 부팅 시 `compactJournal` — 삭제대화·톰스톤·설정중복·msg중복 제거(reconcile 동등성 테스트 추가). 진실원천이라 저널 자체 dedup |
| **H1** | ✅ | `build/icon.png`(lain-face 1024²) — buildResources 기본 조회로 앱·설치본 아이콘 자동 적용 |

> 배포 절차: 워크트리 → C:\lain main 병합 → `npm run deploy`(설치본 갱신·앱 재시작). 공개본 반영(C1·A2·A1)은 다음 릴리스 시점.

## 감사 방법

- 감사 자체는 멀티에이전트(76 에이전트) 워크플로. 스크립트: `workflows/scripts/clone-perspective-audit-wf_fee0df7e-2cc.js` (resumeFromRunId `wf_fee0df7e-2cc`로 후처리 재실행 가능).
