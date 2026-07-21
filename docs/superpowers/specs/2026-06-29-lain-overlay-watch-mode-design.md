# 레인 "어깨너머" 모드 — 실시간 감시 + 오버레이 설계

- 날짜: 2026-06-29
- 상태: 설계 승인 대기 → (승인 시) writing-plans 로 인계
- 후속: 2026-07-18 개발 오케스트레이터 전향으로 관찰 범위가 **개발 컨텍스트 화이트리스트(devfocus)** 로 재조준됨 — 터미널·에디터·개발 관련 창만 관찰 대상이며, 그 외 앱은 아예 수집하지 않는다. 아래 본문의 "기본 전부 관찰" 전제는 이 화이트리스트로 대체해 읽는다.
- 관련 원칙: PLAN.md §4(L0 결정론/ L1 판단 분리), §5.5(능동 비동기 보고), §10.1(컬렉터 무 LLM), §10.4(갱신 주기)

## 0. 한 줄 요약

레인 메인 UI를 안 보고 있을 때(닫기→트레이/최소화/포커스 상실) 우하단에 작은 오버레이 창이 떠서, 레인이 개발 컨텍스트 화면 작업(에디터·터미널·개발 문서)을 **어깨너머로** 실시간 관찰하고 도움될 때만 먼저 짧게 조언한다. 메인 UI에 토글로 on/off. 오버레이에서 오간 대화는 레인 본 대화에 **하나의 타임라인으로 실시간 통합**된다.

## 1. 용어

- **어깨너머 모드** (표시명) = 이 기능 전체. 내부 식별자 `overlay`, 설정 키 `overlayMonitoringEnabled`. "오버레이 모드"는 허용 동의어.
- **감시 루프(watcher)** = 화면을 싸게 관찰하는 L0 결정론 모듈.
- **반응 생성(reaction)** = 관찰을 받아 레인이 침묵/조언을 판단하는 L1(LLM, manager.ts).
- **오버레이 창** = 우하단 프레임리스 상주 창.
- 주의: 상태줄의 "감시 N"은 **프로젝트 감시**로 이미 쓰임 — 본 기능과 별개.

## 2. 확정된 결정 (브레인스토밍 합의)

1. **보는 방식 = 하이브리드.** 가장 싸고 정확한 소스를 작업별로 자동 선택:
   - 항상(배경): 포그라운드 앱·창 제목·유휴 감지 (결정론, 토큰 0)
   - 문서/개발: 해당 **파일을 직접 읽음** (정확·저렴·안 잘림)
   - 파일 직독이 불가능한 GUI 앱: **적응형 다운스케일 스크린샷 → 비전**
   - ("실시간 영상"은 LLM에 라이브 스트림 불가 → 변화 시에만 프레임 샘플링하는 게 현실형)
2. **반응 주기 = 능동 이벤트기반.** 항상 보되, 트리거(유휴/앱전환/제목변화/사용자 질문) + 쿨다운일 때만 입을 연다. 모델이 침묵을 직접 게이팅.
3. **오버레이 표시 = 최신 1개만.** 길이는 자연스럽게 짧게 유도(하드 줄수 미명시). 토큰 스트리밍 + 폰트 오토핏 + 안 들어오면 카드 높이 확장(스크롤 없음·안 잘림). 보기 전용(v1).
4. **프라이버시 = 관찰 범위 최소화.** 원 설계는 블랙리스트(지정 민감 앱 포그라운드 시 자동 일시정지)였고, 2026-07-18 재조준 이후에는 **개발 컨텍스트 화이트리스트(devfocus)** 가 1차 게이트다 — 화이트리스트 밖 앱은 콘텐츠를 수집하지 않으며, 블랙리스트는 화이트리스트 내부의 추가 예외로만 남는다.
5. **토글 위치 = 입력창 바(InputModeBar)** 의 기존 `.imb-switch` 패턴 재사용.
6. **활성 조건 = 토글 ON 그리고 메인창이 비활성/숨김일 때만.** 메인창을 띄우면 감시·오버레이 자동 정지.
7. **단일 대화 통합.** 오버레이 발화는 별도 대화가 아니라 **레인 메인 대화(동일 conversationId)** 에 실시간 기록. 오버레이는 그 타임라인 꼬리의 라이브 뷰.

## 3. 아키텍처 — L0/L1 분리 (PLAN.md §4 준수)

```
[L0 결정론: src/main/watcher.ts]  ── 관찰 꾸러미 ──▶  [L1 판단: manager.reactToObservation()]
   포그라운드 앱/제목 (PowerShell|패키지)                     경량 query(judge 모델, 도구 0~소량)
   유휴 (powerMonitor.getSystemIdleTime)                     "<<SILENT>>" 또는 짧은 한마디
   트리거 규칙 + 쿨다운 + 민감앱 스킵                          ↓
   콘텐츠 수집(파일직독 | desktopCapturer 스크린샷)      addMessage(메인 대화) + chat:event(proactive)
                                                              ↓
                                          [오버레이 창]  +  [메인창]  ← 같은 conversationId 한 타임라인
```

- L0(watcher)에는 **LLM 호출 금지**. 결정론적 관찰·트리거만. 판단은 manager.ts(L1)에서.
- 반응 LLM 호출은 **manager.ts에만** 존재 (프로젝트 규칙: SDK는 manager.ts만).

## 4. 컴포넌트 명세

### 4.1 `src/main/watcher.ts` (신규, L0)
- **폴링 ~1.5s** (설정 `monitorPollMs`): 포그라운드 {앱, 창 제목}, 유휴 초.
  - 유휴: Electron 내장 `powerMonitor.getSystemIdleTime()` (검증됨).
  - 포그라운드 창: Electron 내장 API 없음. **1순위 PowerShell(Win32 Add-Type) 호출**(네이티브 모듈 회피 — node:sqlite 채택 이유와 동일), 대안 `get-windows`(active-win 후속) 패키지. → **§18식 실측 후 확정** (추측 금지, 패키징/asar 리스크 있음).
- **트리거 규칙(결정론)**: ①타이핑 후 유휴 N초 진입 ②앱 전환 ③제목 유의미 변화 ④오버레이로부터 사용자 질문. 모두 **쿨다운**(설정 `monitorCooldownSec`, 기본 30s) 통과 시에만. 민감앱 포그라운드면 무조건 스킵.
- **콘텐츠 수집(트리거 시에만, 가장 싼 소스 선택)**:
  - 개발/에디터(제목이 알려진 repo/파일) → 소스 파일 직접 읽기(상한 바이트)
  - 문서 앱 → 제목에서 파일명 파싱 → 경로 해석되면 직독, 아니면 스크린샷
  - 그 외 GUI(파일 직독 경로 없음) → `desktopCapturer` 다운스케일 스크린샷
- 수집물을 `manager.reactToObservation(observation)` 으로 전달.
- `startWatcher()/stopWatcher()` export. 토글·창 상태에 따라 main에서 제어.

### 4.2 `manager.reactToObservation()` (manager.ts 추가, L1)
- `voiceQuickReply`(manager.ts:720) 패턴 재사용: 경량 `query()`, **judge 모델**, 적은 턴, 기본 도구 없음.
- 시스템 프롬프트 요지: *"어깨너머로 개발 작업을 본다. 진짜 도움될 게 있을 때만 짧고 친근하게 한마디. 없으면 정확히 `<<SILENT>>` 출력."* → **소음을 모델이 직접 걸러냄**(대다수 침묵).
- 비침묵 결과: `addMessage('manager', ...)` 로 **메인 대화에 기록** + proactive 플래그 단 `chat:event` emit (스트리밍).
- **에스컬레이션("스스로 사용법 찾기")**: 빠른 경로는 속도 위해 도구 없음. 레인이 "더 알아봐야겠다" 판단하면 도구(WebSearch/문서조회 등) 붙은 한 턴으로 승격해 후속 한마디 게시. (외부 도구 사용법 조회 등)
- 동시성: 기존 무한세션과 별개 경량 호출(voiceQuickReply가 이미 그러함). 쿨다운으로 빈도 제한.

### 4.3 `src/main/overlay-window.ts` (신규)
- BrowserWindow: `frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true`, 포커스 비탈취(`focusable:false` 또는 inactive show — 실측 확정), `resizable:false`.
- 위치: `screen.getPrimaryDisplay().workArea` 로 우하단 계산(마진 포함). 디스플레이 변경 대응은 v1 최소(주 디스플레이).
- 로드: **별도 경량 렌더러 엔트리** `src/renderer/overlay/index.html`(전용 번들, 속도/메모리 절감).
- `showOverlay()/hideOverlay()` export. 초기 hidden 생성.

### 4.4 오버레이 렌더러 `src/renderer/overlay/` (신규)
- `index.html` + `overlay.tsx` + `overlay.css` (최소 의존).
- 구독: 기존 preload `window.lain.onChatEvent` 재사용 → proactive(또는 메인 대화) 이벤트의 **최신 1개**만 표시. 초기엔 `conversationMessages`로 꼬리 1개 시드.
- 레이아웃: 좌측 픽셀 얼굴 `public/overlay-face.png`(소형, 생각 중 은은한 펄스 애니메이션) + 우측 텍스트. 반투명 둥근 카드, CRT 보라 테마 변수(`--signal`, `--surface`, `--border`) 재사용.
- 표시 로직: 토큰 스트리밍 → **폰트 오토핏**(컨테이너 맞춰 단계적 축소) → 최소 폰트로도 넘치면 **카드 높이 확장**(스크롤 금지·절대 안 잘림). 새 발화 오면 이전 건 페이드아웃.
- 클릭 → 메인창 복귀(IPC: 메인창 show+focus). v1 입력 없음.

### 4.5 설정 (`shared/types.ts` + `store.ts` 2곳)
- `overlayMonitoringEnabled: boolean` (키 `overlay_monitoring_enabled`)
- `monitorSensitiveApps: string[]` (블랙리스트; csv 직렬화)
- `monitorCooldownSec: number` (기본 30)
- `monitorPollMs: number` (기본 1500)
- preload/ipc는 settings:get/set 제네릭이라 자동 노출.

### 4.6 IPC (`ipc.ts`)
- `settings:set` 사이드이펙트에 `if (patch.overlayMonitoringEnabled !== undefined) syncOverlayMode()` 추가 → 토글 변경 시 watcher start/stop + 오버레이 show/hide 재평가.
- proactive 반응 브로드캐스트: 기존 `chat:event`에 `proactive?: true`(또는 origin) 필드만 추가해 재사용(새 채널 최소화). 오버레이용 "메인창 복귀" 채널 1개 추가.

### 4.7 창 와이어링 (`index.ts`)
- 앱 시작 시 `createOverlayWindow()`(hidden).
- 메인창 `hide`/`minimize`/`blur` + 토글 ON → `showOverlay()` + `startWatcher()`.
- 메인창 `show`/`focus`/`restore` → `hideOverlay()` + `stopWatcher()`.
- 단일 평가 함수 `syncOverlayMode()` 로 (토글 ON) && (메인 비활성) 조건 일원화.

### 4.8 빌드 (`electron.vite.config.ts`)
- renderer 멀티 입력: 기존 `index.html` + 신규 `overlay/index.html` 2nd entry.

### 4.9 토글 UI (`InputModeBar.tsx`)
- 우측 그룹에 "어깨너머" 토글 1개(기존 `.imb-switch`/`.imb-foot` 패턴). `onPatch({ overlayMonitoringEnabled })`.

### 4.10 에셋
- `src/renderer/public/overlay-face.png` (레인 픽셀 얼굴 소형 에셋). Vite public → 빌드/asar 자동 포함.

## 5. 데이터 흐름 — 단일 대화 통합

오버레이/어깨너머 발화는 **새 대화를 만들지 않는다.** 레인 메인 대화의 동일 `conversationId`로:
1. `manager.reactToObservation` → `addMessage(메인 대화)` (영속) + `chat:event` emit(실시간).
2. 오버레이 창: 이벤트 수신 → 최신 1개 렌더.
3. 메인창: 동일 이벤트 수신 → 채팅 로그에 그대로 append. 나중에 켜도 `conversationMessages`로 전부 이어짐.
→ **소스 하나, 표시 둘.** 통일 보장.

## 6. 프라이버시·안전

- 1차 게이트는 **devfocus 화이트리스트**: 개발 컨텍스트(터미널·에디터·개발 관련 창)가 아니면 폴링은 돌아도 **콘텐츠 수집·반응 스킵**.
- 블랙리스트(`monitorSensitiveApps`)의 앱이 포그라운드면 동일하게 **콘텐츠 수집·반응 스킵**.
- 시크릿: 스크린샷/파일 내용·앱 제목을 **로그·다이제스트에 남기지 않음**(PLAN §9-6 / 글로벌 규칙). 반응 발화 텍스트만 대화에 저장.
- 토글 OFF가 기본값(opt-in). OFF면 watcher 미기동.

## 7. 성능·비용 타협

- 포그라운드/유휴 폴링: 결정론, 토큰 0, 경부하.
- 비싼 비전 호출: 트리거 + 쿨다운 통과 시에만, 다운스케일 후 전송.
- 모델: judge 티어(빠름·저렴), `managerFastMode` 반영.
- 침묵 게이팅으로 대다수 관찰이 무발화 → 토큰 절약.

## 8. 미해결 리스크 (writing-plans에서 실측)

- **포그라운드 창 감지 방식** (PowerShell vs `get-windows`): 패키징/asar에서 동작·성능 실측 후 확정. **최우선 검증 항목.**
- 투명 always-on-top 창의 포커스 비탈취/클릭 동작 OS 실측(Windows).
- 문서 앱의 "현재 편집 파일 경로" 해석 신뢰도(제목 파싱) — 실패 시 스크린샷 폴백으로 안전.
- electron-vite 멀티 렌더러 엔트리 dev/build 양쪽 경로 확인.

## 9. v1 범위 밖

- 오버레이 인라인 입력(클릭→메인창으로 충분). 멀티 디스플레이 정밀 배치. 음성. 텔레그램 표면 노출(별도 deferred).

## 10. 신규/수정 파일

- 신규: `src/main/watcher.ts`, `src/main/overlay-window.ts`, `src/renderer/overlay/{index.html,overlay.tsx,overlay.css}`, `src/renderer/public/overlay-face.png`
- 수정: `src/main/index.ts`, `src/main/manager.ts`, `src/main/ipc.ts`, `src/shared/types.ts`, `src/main/store.ts`, `electron.vite.config.ts`, `src/renderer/components/InputModeBar.tsx`

## 11. 구현 순서 (점진 검증)

1. 설정 필드 + 토글(UI, 안전 선반영)
2. 오버레이 창 + 더미 텍스트 (창 생성·우하단 위치·show/hide·메인창 연동 검증)
3. watcher L0 (포그라운드/유휴/트리거 — 콘솔 로그만)
4. `reactToObservation` L1 연결 (침묵 게이팅, 메인 대화 기록·스트리밍)
5. 콘텐츠 수집 (파일직독 → 스크린샷 폴백)
6. 에스컬레이션 (도구 리서치 후속 발화)
7. 프라이버시 블랙리스트 차단
8. `npm run deploy` (설치본 동기화 — build만으론 미반영)
