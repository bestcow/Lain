# 어깨너머 모드 (실시간 감시 + 오버레이) Implementation Plan

> **For agentic workers:** 본 계획은 Task 1부터 **순차 실행**한다.

**Goal:** 레인 메인창을 안 볼 때 우하단 오버레이가 떠서 화면 작업을 어깨너머로 관찰하고 도움될 때만 짧게 먼저 조언하며, 그 대화는 레인 본 대화에 단일 타임라인으로 통합된다.

**Architecture:** L0 결정론 watcher(포그라운드/유휴/트리거) → L1 manager.reactToObservation(judge 모델, 침묵 게이팅) → addMessage(메인 대화)+chat:event → 오버레이 창 & 메인창이 같은 conversationId를 공유. 별도 경량 렌더러 엔트리로 오버레이 UI.

**Tech Stack:** Electron(BrowserWindow, screen, powerMonitor, desktopCapturer), electron-vite 멀티 렌더러 엔트리, React(오버레이), node:sqlite(store), @anthropic-ai/claude-agent-sdk(manager만).

## Global Constraints (스펙·프로젝트 규칙 verbatim)

- L0(watcher)에 **LLM 호출 금지**. SDK는 `manager.ts`에서만 사용 (PLAN.md §4, CLAUDE.md).
- IPC 채널 추가 시 `ipc.ts` + `preload/index.ts` + `shared/types.ts` **3곳 동기화** (CLAUDE.md). 단 settings 필드는 settings:get/set 제네릭이라 types.ts+store.ts만.
- Agent SDK 옵션 **추측 금지** — 기존 voiceQuickReply 패턴을 그대로 따른다.
- 시크릿/스크린샷/파일내용/창 제목을 **로그·다이제스트에 남기지 않는다** (PLAN §9-6).
- 검증 = `npm run typecheck` + `npm run build` (이 프로젝트엔 JS 단위테스트 없음). 런타임 스모크는 가능 범위에서.
- 코드 변경 마무리 = `npm run deploy` (단 파괴적 — 사용자 확인 후 마지막에).
- commit/push = 명시 요청 시에만.
- 표시명 "어깨너머", 내부 식별자 `overlay`, 설정 키 `overlayMonitoringEnabled`.

---

## File Structure

- 신규 `src/main/watcher.ts` — L0 관찰 루프. 포그라운드/유휴/트리거/콘텐츠수집. `startWatcher/stopWatcher`.
- 신규 `src/main/overlay-window.ts` — 오버레이 BrowserWindow 생성/위치/show/hide.
- 신규 `src/renderer/overlay/index.html`, `overlay.tsx`, `overlay.css` — 오버레이 UI.
- 신규 `src/renderer/public/overlay-face.png` — (사용자 제공 예정) 폴백 manager.png.
- 수정 `src/shared/types.ts` — LainSettings 필드, ChatEvent proactive 플래그, LainApi 오버레이 메서드.
- 수정 `src/main/store.ts` — getSettings/saveSettings 신규 필드.
- 수정 `src/main/manager.ts` — `reactToObservation()` + relay에 proactive 전달.
- 수정 `src/main/ipc.ts` — settings:set 사이드이펙트(syncOverlayMode), overlay:open 핸들러.
- 수정 `src/main/index.ts` — 오버레이 창 생성 + 메인창 hide/minimize/blur/show/focus 와이어링 + syncOverlayMode.
- 수정 `src/preload/index.ts` — onChatEvent는 기존; overlay용 openMain 추가(필요 시).
- 수정 `electron.vite.config.ts` — renderer rollup 2nd input.
- 수정 `src/renderer/components/InputModeBar.tsx` — 어깨너머 토글.

---

## Task 1: 설정 필드 + 토글 (안전 선반영)

**Files:** `src/shared/types.ts`, `src/main/store.ts`, `src/renderer/components/InputModeBar.tsx`, `src/renderer/App.tsx`(props 전달 확인)

**Produces:** `LainSettings.overlayMonitoringEnabled:boolean`, `.monitorSensitiveApps:string[]`, `.monitorCooldownSec:number`, `.monitorPollMs:number`. 토글 UI.

- [ ] types.ts: LainSettings에 4필드 추가 (기본 위치: managerFastMode 근처).
- [ ] store.ts getSettings(): `overlayMonitoringEnabled: (getSetting('overlay_monitoring_enabled') ?? '0')==='1'` 등 4필드 역직렬화. sensitiveApps는 csv split.
- [ ] store.ts saveSettings(): 4필드 직렬화 setSetting.
- [ ] InputModeBar.tsx: 우측 그룹에 "어깨너머" `.imb-switch` 토글, `onPatch({overlayMonitoringEnabled})`.
- [ ] 검증: `npm run typecheck`.

## Task 2: 오버레이 창 + 더미 + 빌드 멀티엔트리

**Files:** `electron.vite.config.ts`, `src/renderer/overlay/{index.html,overlay.tsx,overlay.css}`, `src/main/overlay-window.ts`, `src/main/index.ts`

**Produces:** `createOverlayWindow()`, `showOverlay()`, `hideOverlay()`, `getOverlayWin()`.

- [ ] electron.vite.config.ts: renderer `build.rollupOptions.input = { index: '.../index.html', overlay: '.../overlay/index.html' }`.
- [ ] overlay/index.html: #root + overlay.tsx 로드.
- [ ] overlay.tsx: 더미 "어깨너머 대기중" 카드(얼굴 img overlay-face.png onError→manager.png).
- [ ] overlay-window.ts: BrowserWindow {frame:false,transparent:true,alwaysOnTop:true,skipTaskbar:true,resizable:false,focusable:false,show:false}, preload 동일, 로드 경로 dev=`${ELECTRON_RENDERER_URL}/overlay/index.html` prod=file `out/renderer/overlay/index.html`. 위치=screen.getPrimaryDisplay().workArea 우하단.
- [ ] index.ts: 앱 ready 후 createOverlayWindow(). 임시로 showOverlay() 호출해 육안 확인 가능하게.
- [ ] 검증: typecheck + build. (런타임 위치/투명 실측은 deploy 후 사용자와.)

## Task 3: 창 상태 와이어링 + syncOverlayMode

**Files:** `src/main/index.ts`, `src/main/ipc.ts`

**Produces:** `syncOverlayMode()` — (overlayMonitoringEnabled && 메인 비활성) ⇒ showOverlay()+startWatcher(), else hideOverlay()+stopWatcher().

- [ ] index.ts: mainWin on 'hide'/'minimize'/'blur' → syncOverlayMode(); on 'show'/'focus'/'restore' → syncOverlayMode().
- [ ] ipc.ts settings:set 사이드이펙트: `if(patch.overlayMonitoringEnabled!==undefined) syncOverlayMode()`.
- [ ] overlay:open 핸들러(클릭 시 메인 show+focus) + preload openMain.
- [ ] watcher start/stop는 Task4 전까지 no-op 스텁.
- [ ] 검증: typecheck + build.

## Task 4: watcher L0 (포그라운드/유휴/트리거, 로그만)

**Files:** `src/main/watcher.ts`

**Produces:** `startWatcher(onObserve)`, `stopWatcher()`. 트리거 시 `onObserve(observation)` 호출(아직 콘솔 로그).

- [ ] 포그라운드 감지: PowerShell(Win32 Add-Type GetForegroundWindow+GetWindowText) child_process로 1.5s 폴링. 실패/지연 대비 타임아웃·에러 무시.
- [ ] 유휴: `powerMonitor.getSystemIdleTime()`.
- [ ] 트리거 규칙 + 쿨다운(monitorCooldownSec) + 민감앱 스킵(monitorSensitiveApps 부분일치).
- [ ] observation = {app,title,idleSec,reason}. 콘솔 로그.
- [ ] 검증: typecheck + build. 런타임: dev로 폴링 로그 육안(가능 시).

## Task 5: reactToObservation L1 + 단일 대화 통합

**Files:** `src/main/manager.ts`, `src/main/watcher.ts`(연결), `src/main/ipc.ts`(proactive 브로드캐스트), `src/shared/types.ts`(ChatEvent proactive), 오버레이 구독

**Produces:** `reactToObservation(obs)` — judge 모델 경량 query, `<<SILENT>>`면 무발화, 아니면 addMessage(메인 대화)+relay({kind:'assistant',text,proactive:true}).

- [ ] manager.ts: voiceQuickReply 패턴 복제해 reactToObservation. 시스템 프롬프트=어깨너머 관찰자, 짧게/침묵 규칙. 컨텍스트 버퍼 소량.
- [ ] 메인 대화 conversationId로 addMessage('manager',...) — 별도 대화 금지.
- [ ] ChatEvent에 `proactive?:boolean`. relay→broadcast 그대로.
- [ ] 오버레이 renderer: window.lain.onChatEvent 구독, kind==='assistant' 최신 1개 표시(스트리밍 누적). 폰트 오토핏 + 카드 높이 확장.
- [ ] watcher.onObserve = reactToObservation 연결.
- [ ] 검증: typecheck + build.

## Task 6: 콘텐츠 수집 (파일직독 → 스크린샷 폴백)

**Files:** `src/main/watcher.ts`, `src/main/manager.ts`(이미지 입력)

- [ ] 에디터/개발: 제목 파싱 → repo/파일 경로 해석되면 파일 텍스트(상한) 첨부.
- [ ] 문서: 제목 파일명 → 경로 추정 직독, 실패 시 스크린샷.
- [ ] 그 외: `desktopCapturer.getSources({types:['screen'],thumbnailSize})` 다운스케일 → base64 → reactToObservation에 이미지 블록으로.
- [ ] 검증: typecheck + build.

## Task 7: 에스컬레이션 + 프라이버시 마감

**Files:** `src/main/manager.ts`, `src/main/watcher.ts`

- [ ] reactToObservation 결과가 "리서치 필요" 신호면 도구(WebSearch 등) 붙은 한 턴으로 승격해 후속 발화.
- [ ] 민감앱 차단 최종 점검: 포그라운드가 블랙리스트면 콘텐츠수집·반응 전부 스킵(로그에도 내용 미기록).
- [ ] 검증: typecheck + build.

## Task 8: 통합 검증 / 배포 게이트

- [ ] 전체 `npm run typecheck` + `npm run build` 클린.
- [ ] 변경 요약 + 런타임 실측 필요 항목(포그라운드 감지, 투명창 포커스, 위치) 사용자에게 보고.
- [ ] (사용자 확인 후) main 병합 → `npm run deploy`.

---

## Self-Review

- **Spec coverage:** §2 결정 1~7 → Task1(설정/토글/통합키), Task2~3(오버레이/활성조건), Task4(이벤트기반/프라이버시 스킵), Task5(반응/침묵/단일대화), Task6(하이브리드 수집), Task7(에스컬레이션/프라이버시). 누락 없음.
- **Placeholder scan:** 각 Task에 파일·접근법 명시. 단위테스트 코드블록은 프로젝트에 테스트 하네스 없어 의도적으로 typecheck/build 게이트로 대체(Global Constraints에 근거 명시).
- **Type consistency:** 설정 키(overlay_monitoring_enabled 등), 함수명(startWatcher/stopWatcher/syncOverlayMode/showOverlay/hideOverlay/reactToObservation), ChatEvent.proactive 일관.
- **Risk:** 포그라운드 감지(PowerShell vs 패키지)와 투명 always-on-top 포커스는 런타임 실측 항목 — Task4/Task8에서 다룸.
