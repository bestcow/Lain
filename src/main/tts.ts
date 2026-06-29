// src/main/tts.ts
// Edge TTS(무료, 키 불필요) ko-KR 합성. msedge-tts 래퍼.
// OUTPUT_FORMAT: MP3(audio-24khz-48kbitrate-mono-mp3) — 패키지에 raw PCM 포맷 없음.
// 출력은 MP3(24kHz)임. Discord 재생 측에서 MP3 디코딩 필요 (raw PCM 아님).
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

export const DEFAULT_VOICE = 'ko-KR-SunHiNeural'

export async function synthesize(text: string, voice: string = DEFAULT_VOICE): Promise<Buffer> {
  const tts = new MsEdgeTTS()
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    const { audioStream } = tts.toStream(text)
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      audioStream.on('data', (c: Buffer) => chunks.push(c))
      audioStream.on('end', () => resolve())
      audioStream.on('error', reject)
    })
    return Buffer.concat(chunks)
  } finally {
    tts.close()
  }
}

// 로컬 GPT-SoVITS(api_v2.py) 합성 — POST /tts → WAV. 한국어 빠른 출력·음성 복제용.
// 참조 음성(ref_audio_path)+전사(prompt_text)로 그 목소리를 복제해 읽는다. 서버 미가동/오류 시 throw(호출측 Edge 폴백).
export type GptSovitsOpts = {
  url: string
  refAudio: string
  refText: string
  refLang?: string // 참조 클립 언어(prompt_lang). 일본 성우 음색은 'ja'(교차언어). 기본 'ko'.
  speed?: number
}
export async function synthesizeGptSovits(text: string, opts: GptSovitsOpts): Promise<Buffer> {
  const base = opts.url.replace(/\/+$/, '')
  const resp = await fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      text_lang: 'ko', // 출력은 항상 한국어
      ref_audio_path: opts.refAudio,
      prompt_text: opts.refText,
      prompt_lang: opts.refLang || 'ko',
      media_type: 'wav',
      streaming_mode: false,
      text_split_method: 'cut5',
      speed_factor: opts.speed ?? 1.0,
    }),
  })
  if (!resp.ok) {
    const err = await resp.text().catch(() => '')
    throw new Error(`gpt-sovits ${resp.status} ${err.slice(0, 160)}`)
  }
  return Buffer.from(await resp.arrayBuffer())
}
