// §20.3 디스코드 음성 채널 어댑터 — 실시간 양방향 통화로 레인 지휘.
// 봇 토큰·길드/VC/userID는 시크릿(로그 비노출). 단일 화자(내 userID만 청취).
// telegram.ts의 형제 — 매니저 코어(sendToManager)·store·rendererMirror를 재사용하고 음성 I/O만 담당.
import path from 'node:path'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { Client, GatewayIntentBits } from 'discord.js'
import {
  joinVoiceChannel,
  getVoiceConnection,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
} from '@discordjs/voice'
import prism from 'prism-media'
import { DATA_DIR } from './paths'
import { appendCapped } from './logfile'
import { getSettings, saveSettings, ensureActiveConversation, addMessage } from './store'
import { createEndpointer, frameEnergy, downsampleTo16kMono, type UtteranceEvent } from './vad'
import { transcribePcm, routeUtterance } from './discord-route'
import { sendToManager, voiceQuickReply, resetVoiceContext } from './manager'
import { setVoiceNotifyHook } from './notify'
import type { ChatEvent, DiscordCallState, DiscordStateEvent } from '../shared/types'

const LOG = path.join(DATA_DIR, 'discord.log')
function dlog(m: string): void {
  try {
    // 봇 토큰 형태(xxxx.xxxx.xxxx)는 평문 로그에 남기지 않는다(§9-6 redact).
    const safe = m.replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, '<token-redacted>')
    appendCapped(LOG, `${new Date().toISOString()} ${safe}\n`)
  } catch {
    /* 무시 */
  }
}

let client: Client | null = null
let running = false
let inCall = false
let lastError: string | null = null

// #3 통화 파이프라인 단계 — 렌더러 배지로 라이브 표시. ipc가 bindDiscordState로 broadcast에 연결.
let callState: DiscordCallState = 'idle'
let stateCb: ((ev: DiscordStateEvent) => void) | null = null
export function bindDiscordState(cb: (ev: DiscordStateEvent) => void): void {
  stateCb = cb
}
function setCallState(state: DiscordCallState, error?: string): void {
  callState = state
  try {
    stateCb?.({ state, error })
  } catch {
    /* 무시 */
  }
}

// 통화 세션 상태
let currentCallConv: string | null = null
let speaking = false // 봇이 TTS 재생 중인지(barge-in 판정용)
const speakQueue: string[] = [] // 매니저 assistant 텍스트 발화 큐(순차 재생)
let pendingAction: string | null = null // #5 파괴적 작업 — 확인("네") 대기 중인 원 발화
let recvFlushTimer: ReturnType<typeof setTimeout> | null = null // 수신 프레임 끊김 감지 → 발화 마감(flush)

// #5 확인 답변이 긍정인지 — '네/예/응/그래/진행/해/맞아/ok/yes' 등.
function isAffirmative(t: string): boolean {
  return /(^|\s)(네|예|응|어|그래|좋아|해|진행|맞아|확인|ok|okay|yes|예스)([\s.!~]|$)/i.test(t.trim())
}

const player = createAudioPlayer()
player.on(AudioPlayerStatus.Playing, () => dlog('player: playing(송출 시작)'))
player.on(AudioPlayerStatus.Idle, () => {
  speaking = false
  void drainSpeakQueue()
})
player.on('error', (e) => {
  speaking = false
  dlog(`player error: ${e.message}`)
  void drainSpeakQueue()
})

export function discordStatus(): {
  running: boolean
  inCall: boolean
  error: string | null
  callState: DiscordCallState
} {
  return { running, inCall, error: lastError, callState }
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
  // EventEmitter는 'error' 리스너가 없으면 throw → 게이트웨이/WS 단절·토큰 무효가 메인 프로세스 크래시로 직결.
  // 어댑터 내부에서 흡수(로그만)한다.
  client.on('error', (e) => {
    lastError = (e as Error).message
    dlog(`client error: ${lastError}`)
  })
  client.on('shardError', (e) => dlog(`shard error: ${(e as Error)?.message ?? e}`))
  client.on('voiceStateUpdate', (oldState, newState) => {
    const cfg = getSettings() // 매 이벤트 최신 설정(#2로 userID가 방금 등록됐을 수 있음)
    const target = cfg.discordVoiceChannelId
    // 입장/퇴장 '전환'만 본다 — voiceStateUpdate는 음소거·말하기·서버 이벤트마다 발생하므로
    // '지금 채널 안'(newState.channelId===target)만 보면 상태 변화마다 onUserJoin이 재호출돼
    // 디코더·구독이 중복 생성되고 같은 발화가 여러 번 처리된다(중복 세션 버그).
    const joinedTarget = oldState.channelId !== target && newState.channelId === target
    const leftTarget = oldState.channelId === target && newState.channelId !== target
    // #2: userID 미설정 + 사람(봇 아님)이 타깃 VC 입장 → 그 사람을 청취 대상으로 자동 등록.
    if (!cfg.discordUserId) {
      if (joinedTarget && newState.member && !newState.member.user.bot) void captureUserId(newState.id)
      return
    }
    if (newState.id !== cfg.discordUserId) return // 단일 화자 — 내 userID만
    if (joinedTarget) void onUserJoin()
    else if (leftTarget) onUserLeave()
  })
  try {
    await client.login(s.discordBotToken)
    running = true
    lastError = null
    dlog('logged in')
    // #4: 이미 타깃 유저가 VC에 있으면(앱 재시작 등으로 입장 transition을 놓친 경우) 즉시 따라 들어간다.
    void joinIfUserAlreadyIn()
  } catch (e) {
    lastError = (e as Error).message
    dlog(`login fail: ${lastError}`)
    client?.destroy()
    client = null
  }
}

export function stopDiscord(): void {
  onUserLeave()
  client?.destroy()
  client = null
  running = false
  inCall = false
}

/** 설정 변경 시 어댑터 재기동 — 끈 뒤 다시 로그인(미설정/비활성이면 startDiscord가 즉시 no-op). */
export function restartDiscord(): void {
  stopDiscord()
  lastError = null
  void startDiscord()
}

async function onUserJoin(): Promise<void> {
  const s = getSettings()
  if (!client) return
  if (inCall) return // 이미 통화 중 — 전환 가드를 뚫고 중복 진입해도 세션 중복 생성 방지(방어)
  try {
    const guild = await client.guilds.fetch(s.discordGuildId)
    const conn = joinVoiceChannel({
      channelId: s.discordVoiceChannelId,
      guildId: s.discordGuildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // 수신 필요
      selfMute: false,
    })
    // 연결이 Ready(UDP·암호화 수립)될 때까지 대기한 뒤 수신 구독을 건다 —
    // 재로그인/재연결 직후 connection이 Ready 전에 subscribe하면 수신이 죽는 레이스를 막는다.
    await entersState(conn, VoiceConnectionStatus.Ready, 15_000)
    inCall = true
    dlog('joined VC (ready)')
    startCallSession(conn)
    setCallState('waiting')
  } catch (e) {
    lastError = (e as Error).message
    dlog(`join fail: ${lastError}`)
    // Ready 대기 실패 시 연결을 정리하지 않으면 @discordjs/voice가 백그라운드 재연결을 무한 churn한다.
    try {
      getVoiceConnection(s.discordGuildId)?.destroy()
    } catch {
      /* 이미 끊김 */
    }
    inCall = false
    setCallState('error', lastError)
  }
}

// #4: 로그인 시점에 타깃 유저가 이미 음성채널에 있으면 입장(transition 이벤트가 안 오는 케이스 보강).
async function joinIfUserAlreadyIn(): Promise<void> {
  const s = getSettings()
  if (!client || inCall) return
  try {
    const ch = await client.channels.fetch(s.discordVoiceChannelId)
    const members = (ch as { members?: { has?: (id: string) => boolean } } | null)?.members
    if (members?.has?.(s.discordUserId)) void onUserJoin()
  } catch (e) {
    dlog(`presence check fail: ${(e as Error).message}`)
  }
}

// #2: userID 미설정 시 타깃 VC에 처음 들어온 사람을 청취 대상으로 등록(설정 영속 + 채팅 알림 + 즉시 입장).
// 재기동 없이 onUserJoin이 새 userID로 구독한다(설정 변경은 getSettings로 즉시 반영됨).
async function captureUserId(id: string): Promise<void> {
  // void로 호출되는 fire-and-forget — saveSettings/addMessage가 손상 DB로 throw하면 미처리 거부가 된다.
  try {
    saveSettings({ discordUserId: id })
    dlog(`auto-captured userID: ${id}`)
    addMessage(
      'manager',
      'tool',
      `[디스코드] 음성 사용자 자동 등록(user ID ${id}) — 이제 이 사용자의 발화를 듣습니다.`,
      ensureActiveConversation('manager'),
    )
  } catch (e) {
    dlog(`captureUserId fail: ${(e as Error)?.message ?? e}`)
  }
  void onUserJoin()
}

function onUserLeave(): void {
  const s = getSettings()
  try {
    const conn = getVoiceConnection(s.discordGuildId)
    conn?.destroy()
  } catch {
    /* 이미 끊김 */
  }
  inCall = false
  endCallSession()
  setCallState('idle')
  dlog('left VC')
}

function startCallSession(conn: VoiceConnection): void {
  const s = getSettings()
  currentCallConv = ensureActiveConversation('manager')
  speakQueue.length = 0
  speaking = false
  pendingAction = null // 새 통화 — 확인 대기 초기화
  resetVoiceContext() // #6 새 통화는 빈 대화 맥락에서 시작
  const receiver = conn.receiver
  // 내 userID의 opus만 구독(수동 종료 — 통화 내내 유지)
  const opus = receiver.subscribe(s.discordUserId, {
    end: { behavior: EndBehaviorType.Manual },
  })
  dlog(`수신 구독: user ${s.discordUserId}`)
  opus.once('data', () => dlog('opus 첫 패킷 도착(디스코드가 내 오디오를 보냄)'))
  // opus(48kHz stereo) → PCM s16le
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
  // silenceMs 500: 발화 끝 반응 속도(체감 지연)와 문장 중간 쉼 오절단의 절충 (음성 통화 §C 경량화).
  const ep = createEndpointer({ energyThreshold: 0.06, silenceMs: 500, minUtteranceMs: 300, frameMs: 20 })
  let firstFrame = true
  const finalize = (ev: UtteranceEvent | null): void => {
    if (ev?.kind !== 'utterance-end') return
    if (recvFlushTimer) {
      clearTimeout(recvFlushTimer)
      recvFlushTimer = null
    }
    setCallState('transcribing')
    const pcm = Buffer.concat(ev.frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength)))
    void handleUtterance(pcm)
  }
  opus.pipe(decoder)
  decoder.on('data', (chunk: Buffer) => {
    // 48kHz stereo s16le → 16kHz mono 다운샘플
    const mono16k = downsampleTo16kMono(chunk)
    const e = frameEnergy(mono16k)
    if (firstFrame) {
      firstFrame = false
      dlog(`디코드 첫 프레임(energy ${e.toFixed(3)}, 임계 0.06)`)
    }
    // barge-in: 봇 재생 중 내 발화 감지 시 재생 중단
    if (speaking && e >= 0.06) stopPlayback()
    const ev = ep.push(mono16k)
    if (ev?.kind === 'speech-start') {
      setCallState('listening')
      dlog(`speech-start(energy ${e.toFixed(3)})`)
    } else if (ev?.kind === 'utterance-end') {
      finalize(ev)
    }
    // ⚠️ 디스코드는 발화가 끝나면 opus 패킷 전송을 끊는다 — 트레일링 무음 프레임이 안 와서 push()가
    // utterance-end를 못 내는 경우가 잦다. 프레임이 도착할 때마다 타이머를 미루고, 무프레임이 일정 시간
    // 지속되면(=발화 종료) flush()로 마감한다. (없으면 발화가 영영 처리 안 됨 — utt 미발생 버그)
    if (recvFlushTimer) clearTimeout(recvFlushTimer)
    recvFlushTimer = setTimeout(() => {
      recvFlushTimer = null
      finalize(ep.flush())
    }, 700)
  })
  decoder.on('error', (e: Error) => dlog(`decoder error: ${e.message}`))
}

function endCallSession(): void {
  currentCallConv = null
  speakQueue.length = 0
  if (recvFlushTimer) {
    clearTimeout(recvFlushTimer)
    recvFlushTimer = null
  }
  stopPlayback()
}

async function handleUtterance(pcm: Buffer): Promise<void> {
  const s = getSettings()
  if (!currentCallConv || !s.groqApiKey) return
  try {
    const transcript = await transcribePcm(pcm, s.groqApiKey)

    // #5 확인 대기 중이면 이번 발화는 그 답변 — 긍정이면 실행, 아니면 취소.
    // (노이즈 게이트보다 먼저 — 짧은 "네"도 통과시켜야 한다.)
    if (pendingAction !== null) {
      const act = pendingAction
      pendingAction = null
      if (isAffirmative(transcript)) {
        setCallState('thinking')
        await sendToManager(act, ttsEmit, false, [], 0, currentCallConv, 'discord')
      } else {
        ttsEmit({ kind: 'assistant', text: '알겠습니다. 취소했습니다.' })
      }
      if (!speaking && inCall) setCallState('waiting')
      return
    }

    // #7 노이즈 게이트 — 구두점·공백 제거 후 2자 미만이면 잡음 환청으로 보고 버린다.
    if (transcript.replace(/[\s.,!?…~]+/g, '').length < 2) {
      if (inCall) setCallState('waiting')
      return
    }
    dlog(`utt: ${transcript.length} chars`)

    // #7 웨이크워드 모드 — '레인' 호출로 시작할 때만 처리(나머지 발화는 무시).
    let text = transcript
    if (s.discordVoiceMode === 'wake') {
      const m = /^[\s,]*(레인|라인|lain)[\s,.!?~]*/i.exec(text)
      if (!m) {
        if (inCall) setCallState('waiting')
        return
      }
      text = text.slice(m[0].length).trim()
      if (!text) {
        if (inCall) setCallState('waiting')
        return
      }
    }

    setCallState('thinking')
    await routeUtterance(text, {
      conversationId: currentCallConv,
      emit: ttsEmit, // 매니저 assistant 텍스트를 음성으로
      voiceQuickReply, // 하이브리드 빠른 경로(문답 즉답 / 실행이면 승격 / 파괴적이면 확인)
      requestConfirm: (t) => {
        pendingAction = t
        ttsEmit({ kind: 'assistant', text: '되돌리기 어려운 작업입니다. 진행하려면 "네"라고 답해주세요.' })
      },
      sendToManager,
    })
    if (!speaking && inCall) setCallState('waiting') // 응답이 음성으로 안 나온 경우 대기 복귀
  } catch (e) {
    dlog(`utt fail: ${(e as Error).message}`)
    setCallState('error', (e as Error).message)
  }
}

// 매니저 응답 이벤트 → 음성. assistant(최종/중간 텍스트)만 읽는다(result는 턴 종료 신호라 무시).
function ttsEmit(ev: ChatEvent): void {
  if (ev.kind === 'assistant' && typeof ev.text === 'string' && ev.text.trim()) {
    speakQueue.push(ev.text.trim())
    void drainSpeakQueue()
  }
}

async function drainSpeakQueue(): Promise<void> {
  if (speaking) return
  const text = speakQueue.shift()
  if (!text) {
    if (inCall) setCallState('waiting') // 큐 비고 재생 끝 → 대기
    return
  }
  await speak(text)
}

async function speak(text: string): Promise<void> {
  const s = getSettings()
  const conn = getVoiceConnection(s.discordGuildId)
  if (!conn) {
    dlog('speak: no voice connection (skip)')
    return
  }
  try {
    // 백엔드 분기 — gpt-sovits(로컬, 참조음성 설정 시) 우선, 실패하면 Edge로 폴백(음성 끊김 방지).
    const cfg = getSettings()
    const tts = await import('./tts')
    let audio: Buffer
    const t0 = Date.now()
    if (cfg.ttsBackend === 'gpt-sovits' && cfg.gptSovitsRefAudio) {
      try {
        audio = await tts.synthesizeGptSovits(text, {
          url: cfg.gptSovitsUrl,
          refAudio: cfg.gptSovitsRefAudio,
          refText: cfg.gptSovitsRefText,
          refLang: cfg.gptSovitsRefLang,
        })
        dlog(`synth gpt-sovits ${audio.length}B in ${Date.now() - t0}ms`)
      } catch (e) {
        dlog(`gpt-sovits fail → edge 폴백: ${(e as Error).message}`)
        audio = await tts.synthesize(text, cfg.discordTtsVoice || undefined)
        dlog(`synth edge(폴백) ${audio.length}B`)
      }
    } else {
      audio = await tts.synthesize(text, cfg.discordTtsVoice || undefined)
      dlog(`synth edge ${audio.length}B in ${Date.now() - t0}ms`)
    }
    conn.subscribe(player)
    const resource = createAudioResource(Readable.from(audio))
    speaking = true
    setCallState('speaking')
    player.play(resource)
    dlog(`play() 호출 (${audio.length}B)`)
  } catch (e) {
    dlog(`tts fail: ${(e as Error).message}`)
    speaking = false
    void drainSpeakQueue()
  }
}

function stopPlayback(): void {
  if (speaking) {
    player.stop(true)
    speaking = false
    dlog('barge-in stop')
  }
}

// §C #8 아웃바운드 알림 — 통화 중이면 능동 보고(승인·결재·에러·질문 등 notifyUser)를 음성으로도 읽어준다.
// notifyUser의 모든 호출을 자동 커버. 통화 아니면 무시(텔레그램·OS 토스트는 그대로 동작).
function announceVoice(title: string, body: string): void {
  if (!inCall || !running) return
  const text = (body ? `${title}. ${body}` : title).slice(0, 200)
  speakQueue.push(text)
  void drainSpeakQueue()
}
setVoiceNotifyHook((title, body) => announceVoice(title, body))
