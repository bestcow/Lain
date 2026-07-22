<p align="center">
  <img src="assets/lain.png" width="340" alt="Lain">
</p>

<h1 align="center"><img src="assets/lain-face.png" width="34" alt="" align="top"> Lain</h1>

<p align="center">
  <a href="https://github.com/bestcow/Lain/releases/latest"><img src="https://img.shields.io/github/v/release/bestcow/Lain?label=%EC%B5%9C%EC%8B%A0%20%EB%A6%B4%EB%A6%AC%EC%8A%A4&color=00c853" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D6" alt="Windows only">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
</p>

<p align="center">
  <a href="https://github.com/bestcow/Lain/releases/latest"><b>⬇️ 설치 파일 다운로드</b></a>
</p>

**내 PC에 상주하며 나에게 길들여지는 개인 AI 매니저**입니다 — 대화하고, 여러 프로젝트의 코딩 작업을 지휘하고, 화면을 어깨너머로 지켜보다 필요할 때만 조언하며, 쓸수록 사용자를 학습합니다. Windows 데스크톱 앱(Electron + Claude Agent SDK)입니다.

> A local orchestrator where a manager agent ("Lain") directs Claude Code workers
> ("Navi") across many projects — each Navi runs in its own isolated git worktree,
> and Lain plans, dispatches, reviews, and merges their work from one screen.
> Lain also learns its user over time: lessons, a user profile, and a customizable persona.

**🇰🇷 한국어 전용** — Lain의 대화·UI·문서는 한국어 기준으로 만들어졌습니다. (Korean-only for now. [Read this in English](README.en.md))

## Lain이 하는 일

- **대화** — 토큰 스트리밍과 빠른 대화 레인으로 사람과 말하듯 응답합니다. 앱을 껐다 켜도 종료 전 맥락을 기억하고 브리핑합니다
- **코딩 작업 지휘** — 채팅으로 지시하면 프로젝트별 워커(Navi, Claude Code)가 격리된 git worktree에서 작업 → 검증 → 결재(merge/폐기)까지 진행합니다. 여러 프로젝트를 동시에 운용할 수 있습니다
- **학습(길들이기)** — 대화·작업에서 학습을 자동 추출해 다음 판단에 반영하고, 사용자에 대한 사실(선호·습관·수준)을 프로필로 축적합니다. 쓸수록 내 방식에 맞춰집니다
- **유저 감시** — (opt-in) 터미널·에디터·개발 브라우저 탭 등 개발 화면일 때만 지켜보고, 에러·빌드 실패처럼 진짜 도움이 될 때만 우하단에 잠깐 떠서 조언합니다. 그 외 화면은 캡처하지 않고, 대부분은 침묵합니다
- **음성** — TTS 3종(Edge/Supertonic/GPT-SoVITS)과 디스코드 음성통화를 지원합니다
- **모바일** — 텔레그램으로 어디서든 대화·작업 지시·승인·현황 확인이 가능합니다
- **안전장치** — 위험 명령 승인 큐, 시크릿 파일 접근 차단, autonomous 모드 spec-gaming 방어를 갖췄습니다

## 빠른 시작

**전제조건**

1. **Windows** (현재 Windows 전용 — macOS/Linux 미지원)
2. **[Claude Code](https://docs.claude.com/claude-code) 로그인** — Lain의 두뇌는 Claude입니다. 터미널에서 `claude`를 실행해 로그인되어 있어야 합니다(Claude 구독 또는 API 키). 로그인이 안 되어 있으면 Lain이 응답 대신 🔑 인증 안내를 띄웁니다.

**설치**

**방법 A — 설치 파일(권장)**: [**Releases에서 `Lain Setup x.y.z.exe` 다운로드**](https://github.com/bestcow/Lain/releases/latest) 후 실행. 이후 새 버전은 앱이 알아서 받아 갱신을 제안합니다(electron-updater).

**방법 B — 소스 빌드**: Node.js 20+ (LTS 20/22 권장), Git 2.x+ 필요

```sh
git clone https://github.com/bestcow/Lain.git
cd Lain
npm install
npm run dev        # 개발 실행
npm run dist       # 설치본 생성 (dist\Lain Setup *.exe)
```

> 디스코드 음성용 네이티브 opus는 선택 사항이라, 빌드 도구가 없어도 `npm install`은 정상 완료됩니다(순수 JS opusscript로 자동 대체).

**첫 5분**

1. 실행하면 Lain이 인사합니다 — 그냥 대화부터 해보세요.
2. 프로젝트 등록: 프로젝츠 창에서 관리할 프로젝트 폴더를 추가하세요. (환경변수로 자동 스캔 루트를 지정할 수도 있습니다 — 아래 [설정](#설정) 참고)
3. 등록된 프로젝트에 채팅으로 작업을 시켜보세요 — "○○ 프로젝트에 ~~ 기능 추가해줘".
4. 환경설정(⚙)에서 호칭·모델·텔레그램 등을 취향대로 바꾸세요.

## 길들이기 (개인화)

Lain은 쓰는 사람에 맞춰 자라는 것을 전제로 설계되었습니다. 개인화 데이터는 전부 로컬(`%APPDATA%\lain`)에 저장되며 어디로도 전송되지 않습니다.

| 방법 | 하는 법 |
|---|---|
| **호칭** | 채팅에서 "나를 ○○라고 불러" 한마디면 됩니다 (또는 환경설정 → 내 호칭) |
| **학습 학습** | 자동입니다. 대화·작업에서 배운 규칙이 쌓여 다음 판단에 반영됩니다. 좌측 **학습** 메뉴에서 열람·비활성화할 수 있고, 틀린 행동은 그 자리에서 정정하면 반영됩니다 |
| **사용자 프로필** | 자동입니다. Lain이 대화 중 알게 된 나에 대한 사실을 스스로 정리해 기억합니다 |
| **정체성 커스텀** | `%APPDATA%\lain\soul.md` 파일을 만들면 Lain의 성격·말투 자체를 바꿀 수 있습니다 (자유 서식 마크다운) |
| **외부 표시명** | 환경설정 → 외부 표시명에 내 디스코드 닉네임 등을 등록하면, 유저 감시가 화면 속 채팅에서 나를 남으로 오인하지 않습니다 |
| **절차 스킬** | 자주 하는 절차를 Lain이 스킬로 저장해 재사용합니다 (`/learn`으로 직접 가르칠 수도 있습니다) |

## 설정

폴더를 하나씩 추가하는 대신, **본인 작업 폴더**를 자동 스캔 루트로 지정하면 그 아래 프로젝트들을 자동 등록합니다(선택 사항 — UI 수동 추가만으로도 충분합니다). 스캔 루트·하위 폴더는 **환경설정 → 일반**에서 지정하거나, 아래 환경변수로 덮어쓸 수 있습니다(환경변수가 우선). 지정하지 않으면 기본값 경로를 살펴보고, 해당 폴더가 없으면 조용히 무시합니다.

| 환경변수 | 기본값 | 의미 |
|---|---|---|
| `LAIN_WORKSPACE` | `C:\workspace` | 프로젝트 자동 스캔 루트 — 본인 작업 폴더로 지정 (예: `D:\dev`) |
| `LAIN_SCAN_DIRS` | `apps;games;tools` | 루트 아래에서 스캔할 하위 폴더 이름(`;` 구분) — 본인 폴더 구조에 맞게 변경 |
| `LAIN_EXTRA_DIRS` | (없음) | 루트 밖 프로젝트 경로 직접 등록(`;` 구분) |
| `LAIN_SELF_DIR` | (자동 탐지) | Lain 자기 소스 클론 경로 — 지정하면 Lain이 스스로 자기 코드를 수정·배포(`deploy_lain`)할 수 있습니다. 미지정·미탐지면 자기-업데이트는 안전하게 비활성화됩니다 |

텔레그램·디스코드·TTS·모델 티어 등 나머지는 전부 앱 내 환경설정(⚙)에서 지정합니다. 데이터(설정·대화·학습)는 `%APPDATA%\lain`에 저장되며 재설치해도 보존됩니다.

### 백업 · PC 이사

Lain에 쌓인 개인화 데이터(설정·대화·학습)는 전부 `%APPDATA%\lain\lain.sqlite` 한 파일에 담깁니다. **환경설정 → 일반 → 데이터**에서 `백업 내보내기`를 누르면 이 파일을 원하는 위치로 저장합니다(WAL을 합친 완전한 스냅샷).

복원하거나 다른 PC로 옮기려면 **Lain을 완전히 종료한 뒤**:

1. 대상 PC의 `%APPDATA%\lain` 폴더에서 `lain.sqlite`, **`lain.sqlite-wal`, `lain.sqlite-shm`** 파일을 (있으면) 모두 삭제합니다. ⚠️ `-wal`/`-shm`을 지우지 않고 덮어쓰면 이전 설치가 남긴 저널이 새 데이터에 잘못 병합돼 조용히 손상될 수 있습니다.
2. 내보낸 백업 파일을 그 자리에 `lain.sqlite`로 복사합니다.
3. Lain을 다시 실행합니다.

`데이터 폴더 열기` 버튼으로 이 폴더를 바로 열 수 있습니다.

## 로컬 모델 (실험적)

Claude 대신 로컬 [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server`(Anthropic Messages API 네이티브)로 라우팅하는 **`local`** 티어(기본 매핑: Qwen3.6-35B-A3B)가 있습니다. Python·Ollama·프록시가 필요 없습니다. 다만 **v1.1.3부터 모델 선택 목록에서는 숨겨져 있습니다** — 서버 없이 고르면 응답이 실패하던 함정을 없애기 위해서로, 라우팅 배관은 그대로 남아 있고 트랙만 보류(재개 예정)한 상태입니다.

```powershell
powershell -File scripts\setup-qwen.ps1   # llama.cpp + GGUF(~22GB) 다운로드 (1회)
powershell -File scripts\start-llama.ps1  # 서버 기동 (기본 :8080 — 환경설정 '로컬 모델 서버'와 일치)
```

**정직한 기대치 (메인테이너 실측, RTX 3060 Ti 8GB 기준):**

| 경로 | 실측 |
|---|---|
| Anthropic API 직접 호출(판정형) | 10~17초 — 한국어·툴콜 정상 |
| Claude Code 하네스 경유(Lain/Navi/판정의 실제 경로) | **턴당 수 분~수십 분** — 거대 시스템 프롬프트 prefill이 CPU 오프로드 속도에 지배됨 |

즉 **8GB급 VRAM에서는 배관은 동작하지만 실용적이지 않습니다.** 대용량 VRAM(24GB+, 모델 전체 GPU 상주)에서는 실용권으로 예상되나 메인테이너 환경에서는 검증할 수 없었습니다 — 이 기능은 **community-supported**이며, 해당 하드웨어에서의 이슈 리포트는 환영하지만 재현 지원이 제한적입니다. 이것이 선택 목록에서 숨긴 이유이기도 합니다 — 지금 쓰이는 모델은 전부 Claude 티어입니다.

## 개발

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 실행 |
| `npm run typecheck` | 타입체크 |
| `npm test` | 단위 테스트 (vitest) |
| `npm run build` | 빌드 (`out/`만 갱신) |
| `npm run dist` | NSIS 설치본 생성 (`dist\Lain Setup *.exe`) |
| `npm run deploy` | 빌드 → 패키징 → **설치본(`%LOCALAPPDATA%\Programs\Lain`) 동기화** → 재시작 |

> ⚠️ **코드(`src/**`)를 바꿨으면 `npm run deploy`로 끝내야 합니다.** 바탕화면/시작 바로가기는 전부 *설치본*을 가리키고 그 코드는 `app.asar`에 냉동되어 있어, `npm run build`만으로는 아이콘을 눌러도 옛 버전이 뜹니다.

**구조**

- `src/main/` — L0 결정론 코어(`store`·`ipc`·`registry`·`collectors`·`worktree`·`scheduler`) + 판단 레이어(`manager`·`worker`·`workerchat`·`orchestrator`). store는 `node:sqlite`(네이티브 모듈 아님)
- `src/preload/` — `contextBridge`로 `window.lain` API 노출
- `src/renderer/` — React UI (도트 캐릭터 작업실, 네온 테마)
- `src/shared/` — main/renderer 공용 타입 (`types.ts` = IPC 계약 단일 출처)

**원칙**: 결정론 배관은 코드가, 판단은 Claude가 담당합니다. L0에 LLM 호출을 넣지 않습니다(판단 레이어만 SDK 사용). 릴리스 이력은 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

## 라이선스

[MIT](LICENSE)입니다. 번들된 폰트·에셋 등 제3자 구성요소의 라이선스는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)를 참고하세요.

자기개선·저널링 구조는 **Hermes** 에이전트(MIT)에서 영감을 받아 독립적으로 재구현했습니다(코드 복사 없음).
