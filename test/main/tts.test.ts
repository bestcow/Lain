// test/main/tts.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'

let capturedFormat: string | undefined

vi.mock('msedge-tts', () => {
  return {
    MsEdgeTTS: class {
      async setMetadata(_voice: string, format: string) {
        capturedFormat = format
      }
      toStream() {
        const s = new Readable({ read() {} })
        s.push(Buffer.alloc(1000)); s.push(null)
        return { audioStream: s, metadataStream: null }
      }
      close() {}
    },
    OUTPUT_FORMAT: {
      AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3',
      AUDIO_24KHZ_96KBITRATE_MONO_MP3: 'audio-24khz-96kbitrate-mono-mp3',
      WEBM_24KHZ_16BIT_MONO_OPUS: 'webm-24khz-16bit-mono-opus',
    },
  }
})

describe('synthesize — Edge TTS', () => {
  it('텍스트를 오디오 버퍼로 합성한다', async () => {
    const { synthesize } = await import('../../src/main/tts')
    const buf = await synthesize('안녕')
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(0)
  })

  it('MP3 포맷(audio-24khz-48kbitrate-mono-mp3)을 사용한다', async () => {
    capturedFormat = undefined
    const { synthesize } = await import('../../src/main/tts')
    await synthesize('포맷 확인')
    expect(capturedFormat).toBe('audio-24khz-48kbitrate-mono-mp3')
  })
})

describe('synthesizeBackend — 로컬 엔진 실패 시 edge 폴백 (B7-2)', () => {
  const baseCfg = {
    ttsBackend: 'gpt-sovits' as const,
    gptSovitsUrl: 'http://127.0.0.1:9880',
    gptSovitsRefAudio: 'ref.wav',
    gptSovitsRefText: '참조 문장',
    gptSovitsRefLang: 'ko',
  }

  it('설정 엔진이 정상이면 fallback 플래그 없이 해당 엔진 결과를 반환한다', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Buffer.from('wav-bytes').buffer,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { synthesizeBackend } = await import('../../src/main/tts')
    const r = await synthesizeBackend('안녕', baseCfg)
    expect(r.mime).toBe('audio/wav')
    expect(r.fallback).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('gpt-sovits 실패 시 edge로 폴백하고 fallback:true를 반환한다', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'server error',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { synthesizeBackend } = await import('../../src/main/tts')
    const r = await synthesizeBackend('안녕', baseCfg)
    expect(r.mime).toBe('audio/mpeg') // edge 컨테이너
    expect(r.fallback).toBe(true)
    vi.unstubAllGlobals()
  })

  it('설정 자체가 edge면 폴백이 아니다(정상 경로)', async () => {
    const { synthesizeBackend } = await import('../../src/main/tts')
    const r = await synthesizeBackend('안녕', { ...baseCfg, ttsBackend: 'edge' as const })
    expect(r.mime).toBe('audio/mpeg')
    expect(r.fallback).toBeUndefined()
  })
})
