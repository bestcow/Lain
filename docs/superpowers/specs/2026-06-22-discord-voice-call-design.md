# lain 디스코드 음성 통화 — 설계 (Spec)

> 작성: 2026-06-22 · 상태: 설계 확정(구현 전) · 후속: writing-plans → 구현
> 관련: [HANDOFF.md](../../../HANDOFF.md) 2026-06-22 엔트리, PLAN.md §20.3(채널 어댑터)·§21.8(음성 채널 주의), telegram.ts handleVoice(STT 전신)

## 1. 목표 / 비목표

**목표** — 폰(메인)·데스크에서 디스코드 음성채널을 통해 레인(매니저)과 **실시간 양방향 음성 통화**를 하며 현황을 듣고 작업을 지휘한다. 음성은 또 하나의 채널 어댑터(§21.8)이며, 발화 1턴 = 매니저 채팅 1턴, 응답을 음성으로 돌려준다.

**비목표** — 다중 화자 회의, Navi와의 직접 음성 통화(대상은 매니저뿐), 음성으로 비가역 결재·위험명령 승인, 통화 전용 별도 앱. 이들은 범위 밖.

## 2. 확정된 결정

| # | 항목 | 결정 |
|---|---|---|
| 1 | 전송 채널 | **디스코드** (`discord.js` + `@discordjs/voice`). 모바일급 AEC·노이즈억제·NAT·지터를 디스코드 클라가 처리 — 무료로 빌려쓰는 유일한 길. (대안: 커스텀 WebRTC PWA=lain 인터넷 노출+AEC 직접구현 리스크 / Twilio=유료, 둘 다 기각) |
| 2 | 상호작용 | 실시간 양방향. STT로 듣고 TTS로 답. barge-in(레인 말 자르기) 포함 |
| 3 | 턴테이킹 | 오픈마이크 + VAD. 발화 후 침묵 ~0.8s 엔드포인팅으로 턴 종료 |
| 4 | STT | **Groq Whisper 재사용**(무료). VAD로 끊긴 구간만 배치 전송(telegram.ts handleVoice 패턴) |
| 5 | TTS | **Edge TTS**(무료, 키 불필요). Microsoft 신경망 ko-KR(SunHi/InJoon 등) |
| 6 | 대상 | 매니저(레인)만. 발화 1턴 = 매니저 턴 |
| 7 | 통화 시작/종료 | **자동 따라입장** — 내가 지정 VC에 들어가면 봇이 `voiceStateUpdate` 감지해 따라 입장(통화 시작), 내가 나가면 봇 퇴장(통화 종료). 별도 명령 불필요 |
| 8 | 권한 범위 | 음성으로 현황보고·질의·작업시작·Navi 지시 OK. **결재(merge/폐기)·위험명령 승인만 텔레그램/PC 버튼으로** 빼서 손 확인(승인 큐·resolve_review와 일관) |
| 9 | barge-in | ON — 재생 중 내 발화(VAD) 감지 시 TTS 즉시 중단하고 청취 전환 |
| 10 | 화자 | **단일 화자** — 내 디스코드 user ID만 청취. 다른 사람이 같은 VC에 들어와 말해도 무시 |
| 11 | 잡음 게이트 | VAD 임계값 + 최소 발화길이 ~0.3s로 기침·생활소음 걸러냄. 그래도 새면 레인이 STT 결과 보고 되물음 |
| 12 | 비용 예산 | ≈ 0 (STT Groq 무료 + TTS Edge 무료). 키 추가 없음(Groq 키 재사용) |
| 13 | transcript 동기화 | 통화 = 매니저 대화 1세션. 발화/응답을 `messages`에 `origin='discord'`로 저장, 앱/텔레그램 라이브 미러(`rendererMirror` 재사용) |
| 14 | 설정 | PrefsModal에 봇 토큰·길드 ID·전용 음성채널 ID·내 디스코드 user ID 입력. 토큰은 시크릿 처리(§9-6, 로그 비노출) |

## 3. 아키텍처

새 어댑터 **`src/main/discord.ts`** — telegram.ts의 형제. 매니저 코어(handleMessage류)·store·rendererMirror는 그대로 재사용하고, 음성 I/O만 이 파일이 담당한다. L0 배관에 LLM 호출 금지 원칙 유지(판단은 매니저가).

### 통화 파이프라인 (한 턴)

```
[봇 VC 입장]
   → 내 opus 스트림 수신 (voice receive, user ID 필터)
   → PCM 디코드 (48kHz stereo → 16kHz mono)
   → VAD 엔드포인팅 (발화 시작 감지 → 침묵 0.8s에 턴 종료)
   → 발화 구간 버퍼 → Groq Whisper (배치 STT)
   → transcript → 매니저 턴 (origin='discord', 통화 세션)
   → 텍스트 응답
   → Edge TTS (ko-KR 합성) → PCM → opus 인코드
   → VC 재생
[barge-in: 재생 중 내 발화 VAD 감지 → 재생 중단 → 청취 전환]
```

### 모듈 경계 (단위테스트 가능 단위로 분리)

- **`vad.ts`(또는 discord.ts 내 순수함수)** — PCM 프레임 입력 → 발화 시작/종료 이벤트. 입력: 프레임·임계값·침묵타임아웃. 출력: 발화 구간 경계. **순수·테스트 가능.**
- **transcript→턴 라우팅** — transcript 문자열 → 매니저 턴 호출 + messages 저장(origin/conversation). **테스트 가능.**
- **TTS 인코딩** — 텍스트 → Edge TTS → opus. 인코딩 파이프 검증 **테스트 가능.**
- **디스코드 I/O(부수효과)** — VC join/leave·voice receive·player. voiceStateUpdate 핸들러. 라이브, 수동 검증.

## 4. 데이터 / 설정

- **settings**(시크릿): `discordBotToken`, `discordGuildId`, `discordVoiceChannelId`, `discordUserId`. 토큰은 telegram 토큰과 동일하게 로그 비노출·UI 마스킹.
- **messages**: 기존 `origin` 컬럼에 `'discord'` 값 추가(현 `'telegram'`/null 패턴 확장). conversation_id = 통화 세션.
- **conversation**: 통화 시작 시 매니저의 활성 대화(또는 통화 전용 1세션)에 매핑. 통화 종료 후에도 기록 보존 → 앱/텔레그램에서 이어보기.

## 5. 권한 / 안전

- 음성 입력은 **명세 정의 금지**(§21.8) — 막힌(blocked) 작업의 clarify 답변으로 음성이 새지 않게 한다. 통화 중 명세 답변이 필요하면 레인이 "텔레그램으로 보냈다"고 안내.
- **비가역 게이트**: 통화 중 "그거 머지해/승인해" → 레인은 직접 실행하지 않고 기존 승인 큐/`resolve_review` 카드를 텔레그램·PC로 띄워 손 확인 요청.
- 비밀파일 데노리스트(safety.ts)는 음성 경로에도 동일 적용(레인이 음성 지시로 .env 등 접근 불가).

## 6. 검증 전략

- **단위(vitest)**: VAD 엔드포인팅(프레임→구간), transcript→턴 라우팅(origin·conversation 저장), TTS 인코딩 파이프.
- **라이브(수동)**: 실제 통화는 자동 E2E 어려움 → 폰으로 VC 입장→발화→응답 들림→barge-in→퇴장 수동 시나리오 점검.
- typecheck·`npm test`·`npm run deploy`로 마무리(설치본 동기화).

## 7. 리스크 / 구현 전 실측 필요 (§18 체크리스트)

1. **voice receive 스트림** — `@discordjs/voice`의 per-user opus 수신 안정성·user ID 필터.
2. **opus 인코딩/디코딩** — 재생용 opus 인코드, 수신 opus→PCM 디코드(`@discordjs/opus`/`prism-media`).
3. **VAD 라이브러리** — Silero(WASM/onnx) vs node-vad vs 디스코드 `speaking` 이벤트 + 침묵 타이머. 정확도·지연·의존 무게로 결정.
4. **Edge TTS 노드 클라** — 무공식 API, 안정 라이브러리(`msedge-tts` 등) 실측 또는 직접 WebSocket.
5. **지연 예산** — STT(배치)+매니저 턴+TTS 합산 체감지연. 너무 길면 "생각 중" 짧은 음성 필러 검토.

## 8. 미해결(추후)

- 음성 필러/스트리밍 TTS로 체감지연 축소.
- 통화 중 긴 응답의 음성 요약 vs 전문 낭독 정책.
- 데스크에서 통화 시 앱 transcript와의 포커스 동기화 디테일.
