# lain 전체 안정성 감사 리포트 — 2026-06-29

8개 서브시스템 병렬 읽기전용 감사(opus ×8) → **55 findings** (critical 1 / high 7 / medium 15 / low 32).
작동 중인 앱을 망치지 않게 **안전·고확신** 수정만 적용하고, 회귀 위험이 있는 것은 아래 "보류"로 남겼다.
검증: `typecheck` 0 · `vitest` **498** · `build` 0.

## ✅ 적용한 수정 (안전·고확신)

### 크래시 복원력
- **렌더러 ErrorBoundary**(`renderer/main.tsx`) — CRITICAL. 렌더 중 예외 1건이 앱 전체를 '빈 화면'으로 만들던 근본(렌더러 크래시 → 자동 reload로 화면이 비던 이슈). 폴백 UI + 복구 버튼.
- **전역 `process.on('unhandledRejection'|'uncaughtException')`**(`index.ts`) — HIGH×2. 메인의 fire-and-forget(텔레그램 폴러·스케줄러·watcher·broadcast) 한 곳이 새면 데몬 전체가 죽던 것 차단. `crash.log`에 message/stack만(시크릿 미노출) 남기고 생존.
- **Discord `client.on('error')`+`shardError`**(`discord.ts`) — HIGH. EventEmitter 'error' 미등록 시 게이트웨이/WS 오류가 미처리 예외→메인 크래시.
- **`broadcast()` 파괴 webContents 가드**(`ipc.ts`) — MED. 렌더러 reload/destroy 찰나의 send throw가 비동기 콜백에서 미처리 예외 되던 것 차단.

### 종료/생애주기 (어깨너머 도입으로 생긴 회귀 포함)
- **`before-quit`에 `stopWatcher()`+`destroyOverlayWindow()`**(`index.ts`) — HIGH. 상주 PowerShell 감시 프로세스가 종료/배포 반복마다 고아로 쌓이던 것 차단.
- **메인 `closed`에 `stopWatcher()`** 추가(`index.ts`).
- **`activate` 판정을 `mainWin` 기준으로**(`index.ts`) — 상주 오버레이 때문에 `getAllWindows().length`가 0이 안 돼 메인 복구 실패하던 것.
- **`notifyUser` 메인창 선택(`isFocusable()`)**(`notify.ts`) — 오버레이가 [0]일 때 알림 포커스/클릭 복귀/인박스 열기가 오작동하던 것.
- **`close`/`window-all-closed`의 `getSettings()` try/catch**(`index.ts`) — 손상 DB throw 시 '종료 불능' 차단(기본=트레이 상주).

### 미처리 거부 (unhandled rejection)
- **`message_navi` 타임아웃 패자 `done` 거부 흡수**(`manager.ts`) — MED.
- **`broadcast_navis` `.catch`**(`manager.ts`) — MED.
- **Discord `captureUserId` try/catch · Ready 실패 시 `conn.destroy()`**(`discord.ts`) — voice 연결 누수·재연결 churn 차단.

### 무한 성장 (디스크/메모리)
- **저널 회전 — 고빈도 churn 키를 `JOURNAL_SKIP_SETTINGS`에 추가**(`store.ts`) — HIGH. `dock_briefing`·`auto_priority_wake_snapshot`·`auto_priority_last_digest`·`lesson_curator_last_hash`·`wake_gate_snapshot`·`db_corrupt_streak`·`db_corrupt_pending_notify`. 부팅마다 전량 replay되는 `history.ndjson`의 단조 성장 억제(이들은 부팅 재생성·변화감지용이라 복구 가치 0).
- **회전 있는 로그 헬퍼 `logfile.appendCapped()`** 신설 + 적용(MED×다수): manager-stderr·worker-stderr·workerchat-stderr·scheduler-stderr·manager-turns·watcher·overlay·recovery·renderer-crash·telegram·discord. 5MB 초과 시 `.1` 회전 → DATA_DIR 무한 잠식 차단.
- **`taskEvents` 상한(최근 2000)**(`App.tsx`) — 드로어 열린 채 장시간 작업 시 무한 누적.

### watcher 견고화 (어깨너머)
- stderr drain(파이프 버퍼 블록 방지)·stdoutBuf 8KB 가드·캡처 직렬화(`capturing`)·**비정상 종료 시 자동 재시작(5s backoff·연속5회 cap·출력 받으면 리셋)**(`watcher.ts`).

### 기타 안전
- `closeStore` `if(!db) return` 가드(`store.ts`) · `gcWorktrees` 항목별 `rmSync` try/catch(`worktree.ts`).

## ⏸ 보류 (회귀 위험 — 별도 careful 작업 필요)

- **(HIGH) 인터럽트 후 cancelTask 레이스**(`orchestrator.ts:399`) — 취소 작업이 resume으로 부활 가능. 코어 작업 루프라 신중한 테스트 후 수정(가드: cancelTask에 `interruptMsgs.delete` + 재실행 전 terminal-state 체크).
- **(MED) error_max_turns throw 경로에서 `context_tokens` 미갱신**(`manager.ts:1216~`) — 매 턴 maxTurns 닿는 작업의 무한세션 압축 게이트가 영영 안 걸려 트랜스크립트 무한 성장. compact 코어라 보류.
- **(MED) `answerClarify` 재진입**·**동시성 cap이 clarifying 미포함** — 두 채널 동시 답/다발 startTask 시 cap 초과·중복 launch. 상태머신 원자 가드 필요(중간 위험).
- **(MED) `verify_cmd` 프로세스 트리 kill**(`orchestrator.ts:495`) — timeout 시 셸 손자 프로세스 잔존(Windows). `taskkill /T /F` 래퍼 필요.
- **(MED) journal 컴팩션**(부팅 후 현 DB로 재작성) — 과거 누적분 회수. skip 키 추가로 성장은 멎었으나 기존 파일은 안 줄어듦.
- **(LOW) cchooks 원자적 쓰기**(temp+rename)·**telegram 409 능동 통지**·**forceStopTurn 워치독 clearInterval/스테일 정리**·**messages/events 보존 정책** 등 — 리포트의 나머지 low들.

> 전체 55 findings 원본은 세션 산출물(비공개)에 있다. 보류 항목은 다음 작업 때 systematic-debugging으로 개별 재현·검증 후 수정 권장.
