// test/main/discord-login-retry.test.ts
// 외부 IO 행/복구 버그 사냥 — 부팅 시 네트워크가 잠깐 죽어 있으면 discord.js client.login()이 한 번
// 실패하고 끝(재시도 없음)이라, 그날 내내 음성통화가 먹통이었다(기존 버그). 지수 백오프 재시도를
// 붙이되, 토큰 자체가 잘못된 영구 실패(TokenInvalid 등)는 재시도해도 절대 안 풀리므로 제외해야 한다.
// 실제 네트워크·디스코드 게이트웨이는 전혀 안 쓰고 discord.js/@discordjs/voice/prism-media를 모두 모킹한다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'

const loginMock = vi.fn()
const destroyMock = vi.fn()

vi.mock('discord.js', () => {
  class FakeClient {
    on = vi.fn()
    login = loginMock
    destroy = destroyMock
    guilds = { fetch: vi.fn(async () => ({ voiceAdapterCreator: {} })) }
    channels = { fetch: vi.fn(async () => null) }
  }
  return {
    Client: FakeClient,
    GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 },
  }
})

vi.mock('@discordjs/voice', () => ({
  joinVoiceChannel: vi.fn(),
  getVoiceConnection: vi.fn(() => null),
  EndBehaviorType: { Manual: 0 },
  createAudioPlayer: vi.fn(() => ({
    on: vi.fn(),
    play: vi.fn(),
    stop: vi.fn(),
    state: { status: 'idle' },
  })),
  createAudioResource: vi.fn(),
  AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' },
  VoiceConnectionStatus: { Ready: 'ready' },
  entersState: vi.fn(async () => {}),
}))

vi.mock('prism-media', () => {
  class FakeDecoder {
    on = vi.fn()
    pipe = vi.fn()
  }
  return { default: { opus: { Decoder: FakeDecoder } }, opus: { Decoder: FakeDecoder } }
})

const settings = {
  discordEnabled: true,
  discordBotToken: 'fake-token',
  discordGuildId: 'guild1',
  discordVoiceChannelId: 'vc1',
  discordUserId: 'user1',
  discordVoiceMode: 'always' as const,
}
vi.mock('../../src/main/store', () => ({
  getSettings: vi.fn(() => settings),
  saveSettings: vi.fn(),
  ensureActiveConversation: vi.fn(() => 'conv1'),
  addMessage: vi.fn(),
}))
vi.mock('../../src/main/notify', () => ({ setVoiceNotifyHook: vi.fn() }))
vi.mock('../../src/main/manager', () => ({
  sendToManager: vi.fn(),
  voiceQuickReply: vi.fn(),
  resetVoiceContext: vi.fn(),
}))
vi.mock('../../src/main/paths', () => ({
  DATA_DIR: path.join(os.tmpdir(), 'lain-discord-retry-test'),
}))
vi.mock('../../src/main/logfile', () => ({ appendCapped: vi.fn() }))

import { startDiscord, stopDiscord, discordStatus } from '../../src/main/discord'

function permanentTokenError(): Error {
  return Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' })
}
function transientNetworkError(): Error {
  return new Error('fetch failed') // 코드 없음 — 네트워크 단절 등 일시적 장애를 대표
}

beforeEach(() => {
  loginMock.mockReset()
  destroyMock.mockReset()
  vi.useFakeTimers()
})
afterEach(() => {
  stopDiscord() // 모듈 전역상태(client/running/재시도 타이머) 초기화
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('startDiscord — 로그인 실패 재시도', () => {
  it('일시적 실패(네트워크 단절)는 지수 백오프로 재시도해 결국 성공한다', async () => {
    loginMock
      .mockRejectedValueOnce(transientNetworkError())
      .mockRejectedValueOnce(transientNetworkError())
      .mockResolvedValueOnce(undefined)

    await startDiscord()
    expect(loginMock).toHaveBeenCalledTimes(1)
    expect(discordStatus().running).toBe(false)

    // 재시도 없이는(버그) 아무리 시간이 지나도 loginMock이 2번째 호출되지 않는다 — 여기가 재현 지점.
    await vi.advanceTimersByTimeAsync(5_000) // 1차 백오프(5s)
    expect(loginMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(10_000) // 2차 백오프(10s, 지수 증가)
    expect(loginMock).toHaveBeenCalledTimes(3)
    expect(discordStatus().running).toBe(true) // 3번째 시도는 resolve → 성공
  })

  it('영구 실패(TokenInvalid)는 재시도하지 않는다', async () => {
    loginMock.mockRejectedValue(permanentTokenError())

    await startDiscord()
    expect(loginMock).toHaveBeenCalledTimes(1)

    // 아무리 시간이 지나도(10분) 추가 로그인 시도가 없어야 한다 — 재시도해도 절대 안 풀리는 실패이므로.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(loginMock).toHaveBeenCalledTimes(1)
    expect(discordStatus().running).toBe(false)
  })

  it('stopDiscord()는 예약된 자동 재시도를 취소한다', async () => {
    loginMock.mockRejectedValue(transientNetworkError())

    await startDiscord()
    expect(loginMock).toHaveBeenCalledTimes(1)

    stopDiscord() // 사용자가 명시적으로 끔 — 예약된 재시도가 살아있으면 안 됨
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(loginMock).toHaveBeenCalledTimes(1) // 재시도가 취소돼 추가 호출 없음
  })
})
