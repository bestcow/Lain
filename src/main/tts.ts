// src/main/tts.ts
// Edge TTS(무료, 키 불필요) ko-KR 합성. msedge-tts 래퍼.
// OUTPUT_FORMAT: MP3(audio-24khz-48kbitrate-mono-mp3) — 패키지에 raw PCM 포맷 없음.
// 출력은 MP3(24kHz)임. Discord 재생 측에서 MP3 디코딩 필요 (raw PCM 아님).
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { koreanizeForTTS } from './koreanize'

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
  refLang?: string // 참조 클립 언어(prompt_lang). 교차언어 가능(ja/en/zh 등). 기본 'ko'.
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

// 설정 백엔드로 한 덩이 합성 — PC 음성(tts:speak·tts:test) 공용 디스패처. 엔진 설정(ttsBackend)을
// 단일 출처로 존중한다(예전엔 PC 경로가 Supertonic 고정이라 gpt-sovits 설정이 PC 창 음성에 안 먹었다).
// 반환은 오디오 바이트 + 실제 컨테이너 mime(gpt-sovits/supertonic=audio/wav, edge=audio/mpeg). 호출측이
// mime을 그대로 붙여 재생하게 해 'MP3를 wav로 라벨' 같은 오재생을 막는다. 로컬 엔진 실패 시 edge로 폴백
// (discord synthOne과 동일한 회복성 — 서버 다운/모델 준비중이어도 음성이 끊기지 않게).
export type TtsBackendConfig = {
  ttsBackend: 'edge' | 'gpt-sovits' | 'supertonic'
  supertonicVoice?: string
  supertonicCustomVoice?: string
  supertonicSpeed?: number
  supertonicStep?: number
  gptSovitsUrl: string
  gptSovitsRefAudio: string
  gptSovitsRefText: string
  gptSovitsRefLang: string
  gptSovitsSpeed?: number // 말 속도(speed_factor) 0.5~2.0, 기본 1.0
  discordTtsVoice?: string
}
// fallback: true면 설정한 로컬 엔진(gpt-sovits/supertonic)이 실패해 edge 목소리로 대체됐다는 뜻
// (B7-2) — 호출측(렌더러)이 '설정 표시=실제 일치' 위배를 사용자에게 통보할 수 있게 반환에 싣는다.
export type TtsResult = { audio: Buffer; mime: 'audio/wav' | 'audio/mpeg'; fallback?: boolean }
export async function synthesizeBackend(text: string, cfg: TtsBackendConfig): Promise<TtsResult> {
  const edge = async (fallback?: boolean): Promise<TtsResult> => ({
    audio: await synthesize(text, cfg.discordTtsVoice || undefined),
    mime: 'audio/mpeg',
    ...(fallback ? { fallback: true } : {}),
  })
  try {
    if (cfg.ttsBackend === 'gpt-sovits' && cfg.gptSovitsRefAudio) {
      return {
        audio: await synthesizeGptSovits(text, {
          url: cfg.gptSovitsUrl,
          refAudio: cfg.gptSovitsRefAudio,
          refText: cfg.gptSovitsRefText,
          refLang: cfg.gptSovitsRefLang,
          speed: cfg.gptSovitsSpeed, // 미설정이면 synthesizeGptSovits가 1.0
        }),
        mime: 'audio/wav',
      }
    }
    if (cfg.ttsBackend === 'supertonic') {
      return {
        audio: await synthesizeSupertonic(text, {
          voice: resolveSupertonicVoice(cfg.supertonicVoice, cfg.supertonicCustomVoice),
          speed: cfg.supertonicSpeed,
          step: cfg.supertonicStep,
        }),
        mime: 'audio/wav',
      }
    }
  } catch {
    // 로컬 엔진(gpt-sovits/supertonic) 실패 → edge 폴백. 설정이 애초에 edge면 폴백이 아니다(정상 경로).
    return edge(true)
  }
  return edge()
}

// Supertonic(로컬 ONNX 사이드카) 합성 — 한국어 내장 보이스(파이썬 없음). 사이드카 미기동이면 띄우고 POST /tts → WAV.
// 모델 다운로드/준비 전엔 사이드카가 503 → throw → 호출측이 Edge로 폴백(음성 끊김 방지).
export type SupertonicOpts = { voice?: string; speed?: number; step?: number }

// 개인 보이스(로컬) 해석 — 'custom'이면 데이터폴더 voices/의 사용자 JSON 파일명을 사이드카로 보낸다.
// 그 파일은 배포에 포함되지 않고(사용자가 직접 가져옴), 사이드카가 화이트리스트 밖이면 voices/에서 로드한다.
export function resolveSupertonicVoice(voice: string | undefined, customVoice: string | undefined): string {
  if (voice === 'custom') return (customVoice || '').trim() || 'F5'
  return voice || 'F5'
}
export async function synthesizeSupertonic(text: string, opts: SupertonicOpts = {}): Promise<Buffer> {
  const { ensureSupertonic } = await import('./supertonic-proc')
  const port = await ensureSupertonic()
  // 한국어 발음 필터(설정, 기본 on) — 영어/숫자를 한글 음차로 바꿔 한국어 억양으로 발음(화면 텍스트는 불변).
  let synthText = text
  try {
    const { getSettings } = await import('./store')
    if (getSettings().koreanizeTts !== false) synthText = koreanizeForTTS(text)
  } catch {
    /* 설정 못 읽으면 원문 그대로 */
  }
  const body = JSON.stringify({
    text: synthText,
    voice: opts.voice || 'F5',
    lang: 'ko', // 출력은 항상 한국어
    speed: opts.speed ?? 1.05,
    step: opts.step ?? 8,
  })
  // 사이드카 콜드스타트(spawn~listen 갭) + 모델 로드(준비 전 503)를 흡수 — 준비될 때까지 재시도.
  // 모델이 캐시에 있으면 ~1초 내 준비. 미캐시면 다운로드 중 → 데드라인 후 throw(호출측 edge 폴백/안내).
  const deadline = Date.now() + 20000
  let lastErr = 'init'
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      if (resp.ok) return Buffer.from(await resp.arrayBuffer())
      if (resp.status !== 503) {
        const err = await resp.text().catch(() => '')
        throw new Error(`supertonic ${resp.status} ${err.slice(0, 160)}`)
      }
      lastErr = '준비 중(503)' // 모델 로딩/다운로드 중 — 재시도
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('supertonic ')) throw e // 실제 HTTP 에러는 즉시
      lastErr = String((e as Error)?.message || e) // fetch failed(아직 미기동) — 재시도
    }
    await new Promise((r) => setTimeout(r, 450))
  }
  throw new Error(`supertonic 준비 시간 초과 — ${lastErr} (모델 다운로드 중이면 잠시 후 다시)`)
}
