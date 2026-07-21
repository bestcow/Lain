# 디스코드 음성 통화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 폰/데스크에서 디스코드 음성채널로 레인(매니저)과 실시간 양방향 음성 통화하며 작업을 지휘한다.

**Architecture:** 새 `src/main/discord.ts` 어댑터(telegram.ts의 형제). 매니저 코어(`sendToManager`)·store·rendererMirror를 재사용하고 음성 I/O만 담당. 봇이 지정 VC에 자동 입장 → 내 opus 수신·PCM 디코드 → VAD 엔드포인팅 → Groq Whisper STT → 매니저 턴 → Edge TTS → opus 재생. barge-in으로 재생 중 내 발화 감지 시 재생 중단. 순수 로직(VAD·라우팅)은 vitest 단위테스트, 라이브 통화는 수동 검증.

**Tech Stack:** TypeScript, Electron 42(Node 내장), `discord.js`@14 + `@discordjs/voice` + `@discordjs/opus` + `prism-media`(opus↔PCM), Edge TTS(`msedge-tts` 또는 직접 WS), Groq Whisper(기존 재사용), vitest.

## Global Constraints

- 의존 추가는 무료만 — STT=Groq(기존 키 재사용), TTS=Edge TTS(키 불필요). 유료 API 금지.
- 봇 토큰·디스코드 ID는 시크릿 — 로그/메시지/UI에 평문 노출 금지(§9-6, telegram.ts tlog redact 패턴 준수).
- better-sqlite3 금지 → node:sqlite. `app.getAppPath()` 금지 → `paths.ts`.
- 새 IPC는 `src/main/ipc.ts` + `src/preload/index.ts` + `src/shared/types.ts` 3곳 동기화.
- L0 배관(store/ipc/collectors)에 LLM 호출 금지 — 판단은 manager만.
- `src/**` 수정 마무리는 반드시 `npm run deploy`(build만으론 설치본 미반영).
- 검증 명령: `npm run typecheck`, `npm test`(vitest), `npm run build`.
- 단일 화자 — 내 디스코드 user ID만 청취. 비가역 결재/위험명령 승인은 음성 금지(텔레그램/PC 버튼).

---

## Task 0: 라이브러리 실측 스파이크 (§18 체크리스트)

> 음성 I/O 라이브러리(voice receive·opus·Edge TTS)는 실측 전 API가 불확실하다. 이 태스크는 throwaway 스크립트로 실제 동작을 확인하고 버전·API를 잠근다. **이후 Task 5~8의 코드는 이 스파이크 결과로 확정/조정한다.**

**Files:**
- Create: `scratch/discord-spike.mjs` (throwaway, 커밋 안 함)
- Create: `docs/superpowers/plans/discord-spike-findings.md` (결과 기록, 커밋)

- [ ] **Step 1: 라이브러리 설치(실측용)**

```bash
npm i discord.js @discordjs/voice @discordjs/opus prism-media msedge-tts
```

- [ ] **Step 2: voice receive + opus 디코드 확인 스크립트 작성**

`scratch/discord-spike.mjs`에 작성: 봇 로그인 → 지정 길드의 전용 VC join → `VoiceReceiver`로 특정 user ID의 opus 스트림 구독 → `prism-media`/`@discordjs/opus`로 48kHz stereo PCM 디코드 → 첫 5초 PCM 바이트 수·샘플레이트를 콘솔 출력. 토큰/길드/채널/userID는 `process.env`로 주입(하드코딩·커밋 금지).

- [ ] **Step 3: Edge TTS 합성 확인**

같은 스크립트에 ko-KR 음성("테스트입니다")을 Edge TTS로 합성해 PCM/오디오 버퍼 길이를 출력. `msedge-tts`의 실제 export·옵션(voice locale, output format)을 확인.

- [ ] **Step 4: TTS → VC 재생 + voiceStateUpdate 확인**

합성 오디오를 `createAudioPlayer`/`createAudioResource`로 VC에 재생되는지, 내가 VC에 입장/퇴장할 때 `voiceStateUpdate` 이벤트가 봇에 도달하는지 콘솔로 확인.

- [ ] **Step 5: 결과 기록 + 커밋**

`discord-spike-findings.md`에 다음을 확정 기록: 설치된 버전, voice receive 구독 API 시그니처, opus 디코드 호출법(샘플레이트/채널), Edge TTS export·옵션·출력 포맷, AudioResource 입력 포맷, voiceStateUpdate 페이로드(oldState/newState channelId). Task 5~8은 이 문서를 참조한다.

```bash
git add docs/superpowers/plans/discord-spike-findings.md && git commit -m "docs: 디스코드 음성 라이브러리 실측 결과"
```

---

## Task 1: VAD 엔드포인팅 순수 함수 (`vad.ts`)

> PCM 프레임 시퀀스 → 발화 구간(utterance)으로 분할. 외부 라이브러리 의존 없는 순수 로직 → 완전 TDD. 에너지 기반 게이트(임계 초과=발화) + 침묵 타임아웃(0.8s) 엔드포인팅 + 최소 발화길이(0.3s) 잡음 게이트.

**Files:**
- Create: `src/main/vad.ts`
- Test: `test/main/vad.test.ts`

**Interfaces:**
- Produces:
  - `frameEnergy(frame: Int16Array): number` — RMS 에너지(0~1 정규화).
  - `type VadConfig = { energyThreshold: number; silenceMs: number; minUtteranceMs: number; frameMs: number }`
  - `createEndpointer(cfg: VadConfig)` → `{ push(frame: Int16Array): UtteranceEvent | null; flush(): UtteranceEvent | null }`
  - `type UtteranceEvent = { kind: 'utterance-end'; frames: Int16Array[]; durationMs: number } | { kind: 'speech-start' }`
- Consumes: 없음(순수).

- [ ] **Step 1: 실패 테스트 작성 — frameEnergy**

```ts
// test/main/vad.test.ts
import { describe, it, expect } from 'vitest'
import { frameEnergy, createEndpointer } from '../../src/main/vad'

describe('frameEnergy — RMS 에너지', () => {
  it('무음 프레임은 0에 가깝다', () => {
    const silent = new Int16Array(480) // 0으로 채워짐
    expect(frameEnergy(silent)).toBeLessThan(0.01)
  })
  it('최대 진폭 프레임은 1에 가깝다', () => {
    const loud = new Int16Array(480).fill(32767)
    expect(frameEnergy(loud)).toBeGreaterThan(0.9)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/vad.test.ts`
Expected: FAIL — `frameEnergy is not a function`.

- [ ] **Step 3: frameEnergy 구현**

```ts
// src/main/vad.ts
// VAD 엔드포인팅 — 에너지 기반 발화 감지 + 침묵 타임아웃. 순수 로직(테스트 가능).
export function frameEnergy(frame: Int16Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768
    sum += v * v
  }
  return Math.sqrt(sum / frame.length)
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/main/vad.test.ts`
Expected: PASS (frameEnergy 2건).

- [ ] **Step 5: 엔드포인터 실패 테스트 추가**

```ts
describe('createEndpointer — 발화 구간 분할', () => {
  const cfg = { energyThreshold: 0.1, silenceMs: 800, minUtteranceMs: 300, frameMs: 20 }
  const loud = () => new Int16Array(320).fill(10000)   // 에너지≈0.3 > 0.1
  const quiet = () => new Int16Array(320)               // 에너지 0

  it('발화 시작 시 speech-start 이벤트', () => {
    const ep = createEndpointer(cfg)
    expect(ep.push(loud())).toEqual({ kind: 'speech-start' })
  })

  it('충분한 발화 후 침묵 800ms면 utterance-end', () => {
    const ep = createEndpointer(cfg)
    for (let i = 0; i < 20; i++) ep.push(loud())  // 400ms 발화 (>300 최소)
    let end = null
    for (let i = 0; i < 40; i++) { const e = ep.push(quiet()); if (e) end = e } // 800ms 침묵
    expect(end?.kind).toBe('utterance-end')
    expect((end as any).durationMs).toBeGreaterThanOrEqual(300)
  })

  it('너무 짧은 발화(잡음)는 utterance-end를 내지 않는다', () => {
    const ep = createEndpointer(cfg)
    for (let i = 0; i < 5; i++) ep.push(loud())   // 100ms < 300 최소
    let end = null
    for (let i = 0; i < 40; i++) { const e = ep.push(quiet()); if (e?.kind === 'utterance-end') end = e }
    expect(end).toBeNull()
  })
})
```

- [ ] **Step 6: 실패 확인**

Run: `npx vitest run test/main/vad.test.ts`
Expected: FAIL — `createEndpointer is not a function`.

- [ ] **Step 7: createEndpointer 구현**

```ts
// src/main/vad.ts (이어서)
export type VadConfig = {
  energyThreshold: number // 발화 판정 RMS 임계
  silenceMs: number       // 이 시간 침묵 지속 시 턴 종료(엔드포인팅)
  minUtteranceMs: number  // 이보다 짧은 발화는 잡음으로 폐기
  frameMs: number         // 프레임 1개의 길이(ms)
}
export type UtteranceEvent =
  | { kind: 'speech-start' }
  | { kind: 'utterance-end'; frames: Int16Array[]; durationMs: number }

export function createEndpointer(cfg: VadConfig) {
  let speaking = false
  let buf: Int16Array[] = []
  let silenceMs = 0
  return {
    push(frame: Int16Array): UtteranceEvent | null {
      const active = frameEnergy(frame) >= cfg.energyThreshold
      if (active) {
        const started = !speaking
        speaking = true
        silenceMs = 0
        buf.push(frame)
        return started ? { kind: 'speech-start' } : null
      }
      if (!speaking) return null
      // 발화 중 침묵 — 꼬리도 포함해 버퍼링하다 타임아웃이면 종료 판정
      buf.push(frame)
      silenceMs += cfg.frameMs
      if (silenceMs < cfg.silenceMs) return null
      const frames = buf
      const durationMs = frames.length * cfg.frameMs - silenceMs
      speaking = false
      buf = []
      silenceMs = 0
      if (durationMs < cfg.minUtteranceMs) return null // 잡음 폐기
      return { kind: 'utterance-end', frames, durationMs }
    },
    flush(): UtteranceEvent | null {
      if (!speaking || buf.length === 0) return null
      const frames = buf
      const durationMs = frames.length * cfg.frameMs - silenceMs
      speaking = false
      buf = []
      silenceMs = 0
      if (durationMs < cfg.minUtteranceMs) return null
      return { kind: 'utterance-end', frames, durationMs }
    },
  }
}
```

- [ ] **Step 8: 통과 확인**

Run: `npx vitest run test/main/vad.test.ts`
Expected: PASS (전체 5건).

- [ ] **Step 9: 커밋**

```bash
git add src/main/vad.ts test/main/vad.test.ts && git commit -m "feat(discord): VAD 엔드포인팅 순수함수 + 테스트"
```

---

## Task 2: 디스코드 설정 필드 (시크릿) — store + types

> `LainSettings`에 디스코드 봇 토큰·길드·VC·내 userID·enabled를 추가. telegram 토큰과 동일한 시크릿 패턴.

**Files:**
- Modify: `src/shared/types.ts` (LainSettings 타입)
- Modify: `src/main/store.ts:1643-1698` (getSettings/saveSettings)
- Test: `test/main/store-discord-settings.test.ts`

**Interfaces:**
- Produces: `LainSettings`에 `discordEnabled: boolean`, `discordBotToken: string`, `discordGuildId: string`, `discordVoiceChannelId: string`, `discordUserId: string` 추가.
- Consumes: 기존 `getSetting`/`setSetting`(store 내부).

- [ ] **Step 1: 타입 추가**

`src/shared/types.ts`의 `LainSettings` 인터페이스(telegramChatId 근처)에 추가:

```ts
  discordEnabled: boolean
  discordBotToken: string
  discordGuildId: string
  discordVoiceChannelId: string
  discordUserId: string
```

- [ ] **Step 2: getSettings에 읽기 추가**

`store.ts` getSettings 반환객체의 `groqApiKey` 줄 다음에 추가:

```ts
    discordEnabled: (getSetting('discord_enabled') ?? '0') === '1',
    discordBotToken: getSetting('discord_bot_token') ?? '',
    discordGuildId: getSetting('discord_guild_id') ?? '',
    discordVoiceChannelId: getSetting('discord_voice_channel_id') ?? '',
    discordUserId: getSetting('discord_user_id') ?? '',
```

- [ ] **Step 3: saveSettings에 쓰기 추가**

`store.ts` saveSettings의 `groqApiKey` 처리 다음에 추가:

```ts
  if (patch.discordEnabled !== undefined)
    setSetting('discord_enabled', patch.discordEnabled ? '1' : '0')
  if (patch.discordBotToken !== undefined)
    setSetting('discord_bot_token', patch.discordBotToken.trim())
  if (patch.discordGuildId !== undefined)
    setSetting('discord_guild_id', patch.discordGuildId.trim())
  if (patch.discordVoiceChannelId !== undefined)
    setSetting('discord_voice_channel_id', patch.discordVoiceChannelId.trim())
  if (patch.discordUserId !== undefined)
    setSetting('discord_user_id', patch.discordUserId.trim())
```

- [ ] **Step 4: 테스트 작성**

```ts
// test/main/store-discord-settings.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { saveSettings, getSettings } from '../../src/main/store'

describe('디스코드 설정 저장/조회', () => {
  it('기본값은 비활성·빈 문자열', () => {
    const s = getSettings()
    expect(typeof s.discordEnabled).toBe('boolean')
    expect(typeof s.discordBotToken).toBe('string')
  })
  it('저장 후 trim되어 조회된다', () => {
    saveSettings({ discordGuildId: '  123  ', discordEnabled: true })
    const s = getSettings()
    expect(s.discordGuildId).toBe('123')
    expect(s.discordEnabled).toBe(true)
  })
})
```

- [ ] **Step 5: 검증**

Run: `npx vitest run test/main/store-discord-settings.test.ts && npm run typecheck`
Expected: 테스트 PASS, typecheck 0 에러.

- [ ] **Step 6: 커밋**

```bash
git add src/shared/types.ts src/main/store.ts test/main/store-discord-settings.test.ts && git commit -m "feat(discord): 설정 필드(토큰·길드·VC·userID) 추가"
```

---

## Task 3: messages origin='discord' 배관

> 발화/응답을 `messages.origin='discord'`로 저장해 앱/텔레그램에서 통화 기록을 구분·미러. 기존 origin union('pc'|'telegram')을 'discord'로 확장.

**Files:**
- Modify: `src/main/store.ts:713,728-741` (addMessage origin)
- Modify: `src/main/manager.ts:530,562,583` (sendToManager origin union + 라벨)
- Modify: `src/shared/types.ts` (ChatEvent user origin union이 있으면 동기화)
- Test: `test/main/store-discord-origin.test.ts`

**Interfaces:**
- Produces: `addMessage(..., origin?: 'pc'|'telegram'|'discord')` 및 조회 시 `origin: 'telegram'|'lain'|'discord'|undefined`. `sendToManager(..., origin: 'pc'|'telegram'|'discord')`.
- Consumes: Task 4의 라우터가 `sendToManager(text, emit, false, [], 0, convId, 'discord')` 호출.

- [ ] **Step 1: addMessage origin 확장**

`store.ts` addMessage 시그니처(라인 728)와 매핑(736):

```ts
  origin?: 'pc' | 'telegram' | 'discord', // 폰發/디스코드發 출처 표식
```
```ts
  const org = origin === 'telegram' ? 'telegram' : origin === 'discord' ? 'discord' : null
```

조회 매핑(라인 713):

```ts
    origin: r.origin === 'telegram' ? 'telegram' : r.origin === 'lain' ? 'lain' : r.origin === 'discord' ? 'discord' : undefined,
```

- [ ] **Step 2: sendToManager origin 확장**

`manager.ts:530`:

```ts
  origin: 'pc' | 'telegram' | 'discord' = 'pc',
```

`manager.ts:562` 미러 조건을 telegram·discord 둘 다 미러하도록:

```ts
      if (origin === 'telegram' || origin === 'discord')
        rendererMirror?.({ kind: 'user', text, origin, conversationId })
```

`manager.ts:583` 라벨:

```ts
  const originLabel = origin === 'telegram' ? '📱 모바일(텔레그램)' : origin === 'discord' ? '📞 음성통화(디스코드)' : '🖥 PC'
```

- [ ] **Step 3: 타입 동기화**

`src/shared/types.ts`에서 `ChatEvent`의 user 이벤트 `origin` 필드 union을 찾아 `'telegram'`이 있으면 `| 'discord'` 추가. (grep으로 `origin?: 'telegram'` 위치 확인 후 수정.)

- [ ] **Step 4: 테스트 작성**

```ts
// test/main/store-discord-origin.test.ts
import { describe, it, expect } from 'vitest'
import { addMessage, listConversationMessages, ensureActiveConversation } from '../../src/main/store'

describe("messages origin='discord'", () => {
  it('discord 출처로 저장하면 조회 시 origin=discord', () => {
    const conv = ensureActiveConversation('manager')
    addMessage('manager', 'user', '통화테스트', conv, [], 'discord')
    const msgs = listConversationMessages(conv)
    expect(msgs.at(-1)?.origin).toBe('discord')
  })
})
```

> 주의: `addMessage`/`listConversationMessages`의 정확한 export 시그니처를 store.ts에서 확인해 인자 순서를 맞춘다(라인 728·396 참조).

- [ ] **Step 5: 검증**

Run: `npx vitest run test/main/store-discord-origin.test.ts && npm run typecheck`
Expected: PASS, typecheck 0 에러.

- [ ] **Step 6: 커밋**

```bash
git add src/main/store.ts src/main/manager.ts src/shared/types.ts test/main/store-discord-origin.test.ts && git commit -m "feat(discord): messages origin=discord 배관 + 통화 라벨"
```

---

## Task 4: 발화→매니저 턴 라우팅 + STT 함수 (`discord-route.ts`)

> transcript 문자열을 매니저 턴으로 라우팅하는 순수 배선 + Groq Whisper STT 헬퍼(telegram handleVoice에서 추출·재사용). VC 어댑터(Task 6~8)가 이 함수들을 호출한다.

**Files:**
- Create: `src/main/discord-route.ts`
- Modify: `src/main/telegram.ts:591-610` (Groq STT를 공용 함수로 추출하면 재사용 — 선택, 아래는 독립 구현)
- Test: `test/main/discord-route.test.ts`

**Interfaces:**
- Produces:
  - `transcribePcm(pcm: Buffer, groqKey: string): Promise<string>` — 16kHz mono PCM → WAV 래핑 → Groq Whisper → 텍스트.
  - `routeUtterance(transcript: string, deps: RouteDeps): Promise<void>` — transcript를 매니저 통화 세션으로 라우팅.
  - `type RouteDeps = { conversationId: string; send: (ev: ChatEvent) => void; sendToManager: typeof import('./manager').sendToManager }`
  - `pcmToWav(pcm: Buffer, sampleRate: number): Buffer` — 순수, 테스트 가능.
- Consumes: Task 1 `createEndpointer`, Task 3 sendToManager origin='discord'.

- [ ] **Step 1: pcmToWav 실패 테스트**

```ts
// test/main/discord-route.test.ts
import { describe, it, expect } from 'vitest'
import { pcmToWav } from '../../src/main/discord-route'

describe('pcmToWav — WAV 헤더 래핑', () => {
  it('RIFF/WAVE 헤더와 올바른 길이', () => {
    const pcm = Buffer.alloc(3200) // 0.1s @16kHz mono 16bit
    const wav = pcmToWav(pcm, 16000)
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.subarray(8, 12).toString()).toBe('WAVE')
    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.readUInt32LE(24)).toBe(16000) // sample rate
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/discord-route.test.ts`
Expected: FAIL — `pcmToWav is not a function`.

- [ ] **Step 3: pcmToWav 구현**

```ts
// src/main/discord-route.ts
import type { ChatEvent } from '../shared/types'

/** 16bit mono PCM → WAV 컨테이너(Groq Whisper 입력용). 순수. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1, bitsPerSample = 16
  const byteRate = sampleRate * numChannels * bitsPerSample / 8
  const blockAlign = numChannels * bitsPerSample / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)            // PCM
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/main/discord-route.test.ts`
Expected: PASS.

- [ ] **Step 5: transcribePcm + routeUtterance 추가**

```ts
// src/main/discord-route.ts (이어서)

/** PCM → Groq Whisper STT. 빈 결과면 '' 반환. (telegram handleVoice와 동일 엔드포인트) */
export async function transcribePcm(pcm: Buffer, groqKey: string): Promise<string> {
  const wav = pcmToWav(pcm, 16000)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utt.wav')
  form.append('model', 'whisper-large-v3')
  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}` },
    body: form,
  })
  if (!resp.ok) throw new Error(`groq-whisper ${resp.status}`)
  const { text } = (await resp.json()) as { text: string }
  return (text ?? '').trim()
}

export type RouteDeps = {
  conversationId: string
  emit: (ev: ChatEvent) => void
  sendToManager: (
    text: string, emit: (ev: ChatEvent) => void, isRetry?: boolean,
    attachments?: never[], continueRound?: number, conversationId?: string,
    origin?: 'pc' | 'telegram' | 'discord',
  ) => Promise<void>
}

/** transcript를 매니저 통화 세션으로 라우팅(origin='discord'). 빈 transcript는 무시. */
export async function routeUtterance(transcript: string, deps: RouteDeps): Promise<void> {
  if (!transcript.trim()) return
  await deps.sendToManager(transcript, deps.emit, false, [], 0, deps.conversationId, 'discord')
}
```

- [ ] **Step 6: routeUtterance 테스트 추가**

```ts
// test/main/discord-route.test.ts (이어서)
import { routeUtterance } from '../../src/main/discord-route'

describe('routeUtterance — 매니저 라우팅', () => {
  it('빈 transcript는 sendToManager를 호출하지 않는다', async () => {
    let called = false
    const sendToManager = async () => { called = true }
    await routeUtterance('   ', { conversationId: 'c1', emit: () => {}, sendToManager: sendToManager as any })
    expect(called).toBe(false)
  })
  it('transcript를 origin=discord로 전달한다', async () => {
    const calls: any[] = []
    const sendToManager = async (...args: any[]) => { calls.push(args) }
    await routeUtterance('현황 보고해', { conversationId: 'c1', emit: () => {}, sendToManager: sendToManager as any })
    expect(calls[0][0]).toBe('현황 보고해')
    expect(calls[0][6]).toBe('discord') // origin 위치
  })
})
```

- [ ] **Step 7: 통과 확인**

Run: `npx vitest run test/main/discord-route.test.ts && npm run typecheck`
Expected: PASS, typecheck 0 에러.

- [ ] **Step 8: 커밋**

```bash
git add src/main/discord-route.ts test/main/discord-route.test.ts && git commit -m "feat(discord): STT(PCM→WAV→Groq) + 매니저 라우팅 + 테스트"
```

---

## Task 5: Edge TTS 래퍼 (`tts.ts`)

> 텍스트 → ko-KR 음성 PCM. **Task 0 스파이크의 msedge-tts API 확정 결과로 구현 세부 조정.** 실패 시 throw(어댑터가 잡아 무음 처리).

**Files:**
- Create: `src/main/tts.ts`
- Test: `test/main/tts.test.ts`

**Interfaces:**
- Produces: `synthesize(text: string, voice?: string): Promise<Buffer>` — 24kHz/48kHz mono PCM(스파이크에서 확정한 포맷). `DEFAULT_VOICE = 'ko-KR-SunHiNeural'`.
- Consumes: 없음(외부 Edge TTS).

- [ ] **Step 1: 인터페이스 테스트(모킹)**

```ts
// test/main/tts.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('msedge-tts', () => {
  return {
    MsEdgeTTS: class {
      async setMetadata() {}
      toStream() {
        const { Readable } = require('node:stream')
        const s = new Readable({ read() {} })
        s.push(Buffer.alloc(1000)); s.push(null)
        return { audioStream: s }
      }
    },
    OUTPUT_FORMAT: { RAW_24KHZ_16BIT_MONO_PCM: 'raw-24khz-16bit-mono-pcm' },
  }
})

describe('synthesize — Edge TTS', () => {
  it('텍스트를 PCM 버퍼로 합성한다', async () => {
    const { synthesize } = await import('../../src/main/tts')
    const pcm = await synthesize('안녕')
    expect(Buffer.isBuffer(pcm)).toBe(true)
    expect(pcm.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/tts.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현(스파이크 API 기준)**

```ts
// src/main/tts.ts
// Edge TTS(무료, 키 불필요) ko-KR 합성. 정확한 API는 Task0 스파이크 결과로 확정.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

export const DEFAULT_VOICE = 'ko-KR-SunHiNeural'

export async function synthesize(text: string, voice: string = DEFAULT_VOICE): Promise<Buffer> {
  const tts = new MsEdgeTTS()
  await tts.setMetadata(voice, OUTPUT_FORMAT.RAW_24KHZ_16BIT_MONO_PCM)
  const { audioStream } = tts.toStream(text)
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    audioStream.on('data', (c: Buffer) => chunks.push(c))
    audioStream.on('end', () => resolve())
    audioStream.on('error', reject)
  })
  return Buffer.concat(chunks)
}
```

> ⚠️ Task 0 결과로 `setMetadata`/`toStream` 시그니처·OUTPUT_FORMAT 상수명이 다르면 여기와 테스트 mock을 함께 맞춘다.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/main/tts.test.ts && npm run typecheck`
Expected: PASS, typecheck 0 에러.

- [ ] **Step 5: 커밋**

```bash
git add src/main/tts.ts test/main/tts.test.ts && git commit -m "feat(discord): Edge TTS 래퍼(ko-KR) + 테스트"
```

---

## Task 6: 디스코드 어댑터 — 로그인·자동 입퇴장 라이프사이클 (`discord.ts`)

> 봇 로그인, `voiceStateUpdate`로 내 입장 감지→봇 자동 VC 입장, 내 퇴장→봇 퇴장. start/stop 라이프사이클. **Task 0 스파이크 API 기준.** 음성 수신·재생은 Task 7~8에서 채운다.

**Files:**
- Create: `src/main/discord.ts`
- Modify: `src/main/index.ts:15,165,322` (startDiscord/stopDiscord 배선)

**Interfaces:**
- Produces: `startDiscord(): Promise<void>`, `stopDiscord(): void`, `discordStatus(): { running: boolean; inCall: boolean; error: string | null }`.
- Consumes: Task 2 getSettings(discord*), Task 7~8 핸들러(onUserJoin/onUserLeave 내부 호출).

- [ ] **Step 1: 어댑터 스켈레톤 작성**

```ts
// src/main/discord.ts
// §20.3 디스코드 음성 채널 어댑터 — 실시간 양방향 통화로 레인 지휘.
// 봇 토큰·길드/VC/userID는 시크릿(로그 비노출). 단일 화자(내 userID만 청취).
import path from 'node:path'
import fs from 'node:fs'
import { Client, GatewayIntentBits } from 'discord.js'
import {
  joinVoiceChannel, getVoiceConnection, type VoiceConnection,
} from '@discordjs/voice'
import { DATA_DIR } from './paths'
import { getSettings } from './store'

const LOG = path.join(DATA_DIR, 'discord.log')
function dlog(m: string): void {
  try {
    const safe = m.replace(/[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, '<token-redacted>')
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${safe}\n`)
  } catch { /* 무시 */ }
}

let client: Client | null = null
let running = false
let inCall = false
let lastError: string | null = null

export function discordStatus() {
  return { running, inCall, error: lastError }
}

export async function startDiscord(): Promise<void> {
  const s = getSettings()
  if (!s.discordEnabled) return
  if (!s.discordBotToken || !s.discordGuildId || !s.discordVoiceChannelId || !s.discordUserId) {
    lastError = '디스코드 설정 미완(토큰·길드·VC·userID 필요)'
    return
  }
  if (running) return
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  })
  client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== s.discordUserId) return // 단일 화자
    const joinedTarget = newState.channelId === s.discordVoiceChannelId
    const leftTarget = oldState.channelId === s.discordVoiceChannelId && newState.channelId !== s.discordVoiceChannelId
    if (joinedTarget) void onUserJoin()
    else if (leftTarget) onUserLeave()
  })
  try {
    await client.login(s.discordBotToken)
    running = true
    lastError = null
    dlog('logged in')
  } catch (e) {
    lastError = (e as Error).message
    dlog(`login fail: ${lastError}`)
  }
}

export function stopDiscord(): void {
  onUserLeave()
  client?.destroy()
  client = null
  running = false
  inCall = false
}

// Task 7~8에서 본문 구현
async function onUserJoin(): Promise<void> {
  const s = getSettings()
  if (!client) return
  const guild = await client.guilds.fetch(s.discordGuildId)
  const conn = joinVoiceChannel({
    channelId: s.discordVoiceChannelId,
    guildId: s.discordGuildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // 수신 필요
  })
  inCall = true
  dlog('joined VC')
  void startCallSession(conn) // Task 7
}

function onUserLeave(): void {
  const s = getSettings()
  const conn = getVoiceConnection(s.discordGuildId)
  conn?.destroy()
  inCall = false
  endCallSession() // Task 7
  dlog('left VC')
}
```

> ⚠️ `startCallSession`/`endCallSession`는 Task 7에서 정의. 이 태스크에서는 그 두 함수를 빈 stub(`function startCallSession(_c: VoiceConnection){}` / `function endCallSession(){}`)으로 두고 컴파일만 통과시킨다.

- [ ] **Step 2: 빈 stub 추가 후 index.ts 배선**

`index.ts:15` 임포트 추가:

```ts
import { startDiscord, stopDiscord } from './discord'
```

`index.ts:165`(startTelegram 옆)에:

```ts
  void startDiscord()
```

`index.ts:322`(stopTelegram 옆)에:

```ts
  stopDiscord()
```

- [ ] **Step 3: 컴파일 검증**

Run: `npm run typecheck`
Expected: 0 에러(stub 포함).

- [ ] **Step 4: 커밋**

```bash
git add src/main/discord.ts src/main/index.ts && git commit -m "feat(discord): 어댑터 라이프사이클 + 자동 입퇴장(voiceStateUpdate)"
```

---

## Task 7: 음성 수신 → VAD → STT → 매니저 (통화 세션)

> 봇이 내 opus를 받아 PCM 디코드 → Task1 엔드포인터 → Task4 STT/라우팅. 매니저 응답은 emit으로 받아 Task8에서 TTS. **Task 0 스파이크의 voice receive/opus 디코드 API로 확정.**

**Files:**
- Modify: `src/main/discord.ts` (startCallSession/endCallSession 본문)

**Interfaces:**
- Consumes: Task1 `createEndpointer`, Task4 `transcribePcm`/`routeUtterance`, Task3 `sendToManager(origin='discord')`, manager `setRendererMirror`/통화 세션 conversationId.
- Produces: `startCallSession(conn: VoiceConnection)`, `endCallSession()` 실제 구현 + `currentCallConv` 통화 세션 id.

- [ ] **Step 1: 통화 세션 + 수신 파이프 구현**

```ts
// discord.ts 상단 import 보강
import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice'
import prism from 'prism-media'
import { createEndpointer, frameEnergy } from './vad'
import { transcribePcm, routeUtterance } from './discord-route'
import { sendToManager } from './manager'
import { ensureActiveConversation } from './store'
import type { ChatEvent } from '../shared/types'

let currentCallConv: string | null = null
let speaking = false // 봇이 TTS 재생 중인지(barge-in 판정용, Task8)

function startCallSession(conn: VoiceConnection): void {
  const s = getSettings()
  currentCallConv = ensureActiveConversation('manager')
  const receiver = conn.receiver
  // 내 userID의 opus만 구독
  const opus = receiver.subscribe(s.discordUserId, {
    end: { behavior: EndBehaviorType.Manual },
  })
  // opus(48kHz stereo) → PCM s16le
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
  const ep = createEndpointer({ energyThreshold: 0.06, silenceMs: 800, minUtteranceMs: 300, frameMs: 20 })
  const emit = (_ev: ChatEvent) => {} // 텍스트 응답 처리는 Task8 ttsEmit이 대체
  opus.pipe(decoder)
  decoder.on('data', (chunk: Buffer) => {
    // 48kHz stereo s16le → 16kHz mono 다운샘플
    const mono16k = downsampleTo16kMono(chunk)
    // barge-in: 봇 재생 중 내 발화 감지 시 재생 중단(Task8 stopPlayback)
    if (speaking && frameEnergy(mono16k) >= 0.06) stopPlayback()
    const ev = ep.push(mono16k)
    if (ev?.kind === 'utterance-end') {
      const pcm = Buffer.concat(ev.frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength)))
      void handleUtterance(pcm)
    }
  })
}

function endCallSession(): void {
  currentCallConv = null
}

async function handleUtterance(pcm: Buffer): Promise<void> {
  const s = getSettings()
  if (!currentCallConv || !s.groqApiKey) return
  try {
    const transcript = await transcribePcm(pcm, s.groqApiKey)
    if (!transcript) return
    dlog(`utt: ${transcript.length} chars`)
    await routeUtterance(transcript, {
      conversationId: currentCallConv,
      emit: ttsEmit,           // Task8: 매니저 result를 TTS로
      sendToManager,
    })
  } catch (e) {
    dlog(`utt fail: ${(e as Error).message}`)
  }
}
```

- [ ] **Step 2: 다운샘플 헬퍼 + vad.ts에 단위테스트 가능 함수로 추가**

`src/main/vad.ts`에 추가(48kHz stereo s16le Buffer → 16kHz mono Int16Array):

```ts
/** 48kHz stereo s16le Buffer → 16kHz mono Int16Array (3:1 데시메이션 + 채널 평균). */
export function downsampleTo16kMono(buf: Buffer): Int16Array {
  const stereo = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
  const monoLen = Math.floor(stereo.length / 2 / 3)
  const out = new Int16Array(monoLen)
  for (let i = 0; i < monoLen; i++) {
    const src = i * 3 * 2
    out[i] = (stereo[src] + stereo[src + 1]) / 2
  }
  return out
}
```

`discord.ts`는 `import { createEndpointer, frameEnergy, downsampleTo16kMono } from './vad'`로 가져온다.

- [ ] **Step 3: downsample 테스트 추가**

```ts
// test/main/vad.test.ts (이어서)
import { downsampleTo16kMono } from '../../src/main/vad'
describe('downsampleTo16kMono', () => {
  it('48k stereo → 16k mono 길이 1/6', () => {
    const buf = Buffer.alloc(36 * 2) // 36 stereo samples = 18 frames... 
    const out = downsampleTo16kMono(buf)
    expect(out.length).toBe(Math.floor(36 / 2 / 3))
  })
})
```

- [ ] **Step 4: 검증**

Run: `npx vitest run test/main/vad.test.ts && npm run typecheck`
Expected: PASS. (단 `ttsEmit`/`stopPlayback`/`speaking`은 Task8에서 정의 — 이 태스크에서는 임시 stub: `function ttsEmit(_:ChatEvent){}` `function stopPlayback(){}`로 컴파일 통과.)

- [ ] **Step 5: 커밋**

```bash
git add src/main/discord.ts src/main/vad.ts test/main/vad.test.ts && git commit -m "feat(discord): 음성 수신→VAD→STT→매니저 라우팅"
```

---

## Task 8: TTS 재생 + barge-in

> 매니저 텍스트 응답(result 이벤트)을 Task5 synthesize로 합성해 VC 재생. 재생 중 내 발화 감지 시 중단(barge-in). Task7의 stub(ttsEmit/stopPlayback/speaking) 실제 구현.

**Files:**
- Modify: `src/main/discord.ts` (ttsEmit/stopPlayback/재생 플레이어)

**Interfaces:**
- Consumes: Task5 `synthesize`, `@discordjs/voice` AudioPlayer, Task7 `currentCallConv`/`speaking`.
- Produces: `ttsEmit(ev: ChatEvent)` — result/assistant 텍스트를 음성으로. `stopPlayback()`.

- [ ] **Step 1: 플레이어 + ttsEmit/stopPlayback 구현**

```ts
// discord.ts import 보강
import {
  createAudioPlayer, createAudioResource, StreamType, getVoiceConnection,
  AudioPlayerStatus,
} from '@discordjs/voice'
import { Readable } from 'node:stream'
import { synthesize } from './tts'

const player = createAudioPlayer()
player.on(AudioPlayerStatus.Idle, () => { speaking = false })

function stopPlayback(): void {
  if (speaking) { player.stop(true); speaking = false; dlog('barge-in stop') }
}

async function speak(text: string): Promise<void> {
  const s = getSettings()
  const conn = getVoiceConnection(s.discordGuildId)
  if (!conn) return
  try {
    const pcm = await synthesize(text)
    conn.subscribe(player)
    const resource = createAudioResource(Readable.from(pcm), { inputType: StreamType.Raw })
    speaking = true
    player.play(resource)
  } catch (e) {
    dlog(`tts fail: ${(e as Error).message}`)
    speaking = false
  }
}

// 매니저 응답 이벤트 → 음성. result(최종 텍스트)만 읽는다(중간 도구로그 제외).
function ttsEmit(ev: ChatEvent): void {
  if (ev.kind === 'result' && typeof (ev as any).text === 'string') {
    void speak((ev as any).text)
  }
}
```

> ⚠️ `ChatEvent`의 최종 응답 이벤트 종류·텍스트 필드명을 `src/shared/types.ts`에서 확인해 `ev.kind === 'result'`/`ev.text`를 실제 형태에 맞춘다. StreamType.Raw 입력 샘플레이트(24kHz)가 디스코드 48kHz와 다르면 Task0 결과대로 리샘플 또는 Edge TTS 출력 포맷을 48kHz로 변경.

- [ ] **Step 2: Task7의 stub 제거**

Task7에서 임시로 둔 `function ttsEmit(){}`·`function stopPlayback(){}` stub을 삭제(이제 실제 구현이 대체).

- [ ] **Step 3: 검증**

Run: `npm run typecheck && npm test`
Expected: typecheck 0 에러, 기존+신규 테스트 전부 PASS.

- [ ] **Step 4: 커밋**

```bash
git add src/main/discord.ts && git commit -m "feat(discord): TTS 재생 + barge-in"
```

---

## Task 9: 설정 UI(PrefsModal) + IPC + 상태 노출

> PrefsModal에 디스코드 토큰·길드·VC·userID·enabled 입력. 토큰은 password 마스킹. discordStatus를 IPC로 노출.

**Files:**
- Modify: `src/renderer/.../PrefsModal.tsx` (디스코드 섹션)
- Modify: `src/main/ipc.ts` (settings 저장 경로는 기존 saveSettings 재사용 — discord* 자동 포함 / discordStatus 핸들 추가)
- Modify: `src/preload/index.ts` + `src/shared/types.ts` (discordStatus IPC 3곳 동기화)

**Interfaces:**
- Consumes: Task2 saveSettings/getSettings(discord*), Task6 discordStatus.
- Produces: `discordStatus` IPC 채널, PrefsModal 디스코드 폼.

- [ ] **Step 1: PrefsModal에 디스코드 섹션 추가**

기존 텔레그램 섹션을 패턴으로, discord enabled 체크박스 + 토큰(type=password) + 길드 ID + VC ID + 내 userID 입력 필드 추가. 저장 시 기존 `saveSettings` 호출에 discord* 필드 포함(텔레그램과 동일 흐름). 정확한 컴포넌트 경로·폼 패턴은 PrefsModal.tsx의 텔레그램 블록을 Read해 그대로 따른다.

- [ ] **Step 2: discordStatus IPC 추가**

`ipc.ts`에 핸들 추가(telegramStatus 패턴):

```ts
  ipcMain.handle('discord:status', () => discordStatus())
```
`import { discordStatus } from './discord'` 추가. `preload/index.ts`에 `discordStatus: () => ipcRenderer.invoke('discord:status')`, `shared/types.ts`의 preload API 타입에 동기화.

- [ ] **Step 3: 검증(typecheck + build)**

Run: `npm run typecheck && npm run build`
Expected: 0 에러, 빌드 성공.

- [ ] **Step 4: 커밋**

```bash
git add -A && git commit -m "feat(discord): PrefsModal 설정 UI + discordStatus IPC"
```

---

## Task 10: 통합 검증 + 라이브 통화 수동 점검 + deploy

> 자동 테스트 전체 통과 확인 후, 실제 디스코드로 라이브 통화 수동 시나리오 점검, deploy로 설치본 동기화.

**Files:** 없음(검증 전용). 발견된 버그는 해당 태스크 파일 수정.

- [ ] **Step 1: 전체 자동 검증**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0, 모든 테스트 PASS, 빌드 성공.

- [ ] **Step 2: 시크릿 로그 비노출 확인**

`%APPDATA%\lain\discord.log`에 봇 토큰이 평문으로 남지 않는지 확인(redact 정규식 동작). 통화 1회 후 grep으로 토큰 패턴 부재 확인.

- [ ] **Step 3: 라이브 통화 수동 시나리오**

설정 입력(봇 토큰·길드·전용 VC·내 userID) → 폰 디스코드로 전용 VC 입장 → 봇 자동 입장 확인 → "현황 보고해" 발화 → 레인 음성 응답 들림 확인 → 레인 말 도중 끼어들기(barge-in) → 재생 중단 확인 → VC 퇴장 → 봇 퇴장 확인. 앱/텔레그램에 통화 transcript가 origin='discord'로 미러되는지 확인.

- [ ] **Step 4: deploy**

```bash
npm run deploy
```
Expected: 설치본 동기화 완료(lain 재시작).

- [ ] **Step 5: HANDOFF.md 갱신 커밋**

HANDOFF.md의 2026-06-22 디스코드 엔트리를 "구현 완료"로 갱신, "다음 할 일 1" 제거.

```bash
git add HANDOFF.md && git commit -m "docs: 디스코드 음성 통화 구현 완료 반영"
```

---

## Self-Review 메모

- **스펙 커버리지**: 결정 1~14 전부 태스크에 매핑됨 — 전송(T6)·양방향(T7/T8)·VAD(T1)·STT(T4)·TTS(T5)·대상매니저(T4)·자동입퇴장(T6)·권한게이트(기존 승인큐 재사용·코드변경 없음, 스펙§5)·barge-in(T8)·단일화자(T6)·잡음게이트(T1)·비용0(T4/T5)·transcript(T3)·설정(T2/T9).
- **권한 게이트(스펙 결정8)**: 음성으로 비가역 금지는 신규 코드 불필요 — 매니저가 기존 승인큐/resolve_review를 텔레그램·PC로 띄우는 현 동작을 그대로 따른다. 추가 차단 로직이 필요하면 별도 태스크로 분리(현재 범위 밖).
- **라이브러리 불확실성**: voice receive·opus·Edge TTS API는 Task0 스파이크가 잠근다. T5~T8 코드는 가장 유력한 API(discord.js@14·msedge-tts) 기준 작성, 스파이크 결과로 시그니처 조정.
- **타입 일관성**: origin union 'pc'|'telegram'|'discord'를 store/manager/types/route 전반 동일 사용. createEndpointer/frameEnergy/downsampleTo16kMono 명칭 일관.
