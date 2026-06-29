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
