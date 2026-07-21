// src/main/tts.ts
// Edge TTS(무료, 키 불필요) ko-KR 합성. msedge-tts 래퍼.
// OUTPUT_FORMAT: MP3(audio-24khz-48kbitrate-mono-mp3) — 패키지에 raw PCM 포맷 없음.
// 출력은 MP3(24kHz)임. Discord 재생 측에서 MP3 디코딩 필요 (raw PCM 아님).
import path from 'node:path'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { koreanizeForTTS } from './koreanize'
import { DATA_DIR } from './paths'
import { appendCapped } from './logfile'

export const DEFAULT_VOICE = 'ko-KR-SunHiNeural'

// 외부 서버(gpt-sovits/supertonic) fetch 타임아웃 — 서버가 응답을 영원히 안 주면(행/좀비 프로세스) 호출측
// 음성 경로가 무한 대기하게 된다. AbortController로 상한을 두고, 시간 초과 시 명확한 에러로 던져
// synthesizeBackend의 로컬 엔진 실패 처리(edge 폴백)가 정상적으로 걸리게 한다.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(t)
  }
}

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
const GPT_SOVITS_TIMEOUT_MS = 30_000
export async function synthesizeGptSovits(text: string, opts: GptSovitsOpts): Promise<Buffer> {
  const base = opts.url.replace(/\/+$/, '')
  let resp: Response
  try {
    resp = await fetchWithTimeout(
      `${base}/tts`,
      {
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
      },
      GPT_SOVITS_TIMEOUT_MS,
    )
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new Error(`gpt-sovits 응답 시간 초과(${GPT_SOVITS_TIMEOUT_MS}ms)`)
    }
    throw e
  }
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

// 폴백 사유 기록 — '왜 edge 목소리로 바뀌었는지'가 어디에도 안 남던 것 보강(설정 표시=실제 일치 진단용).
// 스트리밍은 청크마다 합성하므로 서버가 죽어 있으면 매 청크 실패한다 → 쿨다운으로 로그 폭주를 막는다.
// 엔진명과 에러 메시지만 남긴다(§9-6 — 경로·시크릿 금지).
let lastFallbackLogAt = 0
const FALLBACK_LOG_COOLDOWN_MS = 60_000
function logTtsFallback(engine: string, e: unknown): void {
  const now = Date.now()
  if (now - lastFallbackLogAt < FALLBACK_LOG_COOLDOWN_MS) return
  lastFallbackLogAt = now
  try {
    appendCapped(
      path.join(DATA_DIR, 'tts.log'),
      `${new Date().toISOString()} ${engine} 합성 실패 — edge 폴백: ${(e as Error)?.message ?? e}\n`,
    )
  } catch {
    /* 로그 실패는 무시 — 음성 재생을 막지 않는다 */
  }
}
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
  } catch (e) {
    // 로컬 엔진(gpt-sovits/supertonic) 실패 → edge 폴백. 설정이 애초에 edge면 폴백이 아니다(정상 경로).
    logTtsFallback(cfg.ttsBackend, e)
    return edge(true)
  }
  return edge()
}

// ── TTS 스트리밍 — 문장 단위 분할 합성으로 첫 소리까지의 침묵을 줄인다 ──

// 문장 분할(순수) — 첫 청크는 첫 문장 하나(빠른 재생 시작), 이후는 이어지는 문장들을 mergeLen까지 병합
// (합성 호출 횟수·per-call 오버헤드 절감). 문장 구분자 없는 초장문은 hardLen에서 공백 기준 강제 분할.
export function splitForTts(text: string, mergeLen = 200, hardLen = 300): string[] {
  const clean = text.trim()
  if (!clean) return []
  // 문장 경계: 종결부호(.!?…) 또는 줄바꿈. 부호는 앞 문장에 붙인다.
  const sentences = clean
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    // 초장문(구분자 없음)은 hardLen 근처 공백에서 강제 분할 — 한 청크가 무한정 길어지지 않게.
    .flatMap((s) => {
      const parts: string[] = []
      let rest = s
      while (rest.length > hardLen) {
        const cut = rest.lastIndexOf(' ', hardLen)
        const at = cut > hardLen / 2 ? cut : hardLen
        parts.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      if (rest) parts.push(rest)
      return parts
    })
  if (sentences.length === 0) return []
  const chunks: string[] = [sentences[0]]
  for (const s of sentences.slice(1)) {
    const last = chunks[chunks.length - 1]
    // 첫 청크(인덱스 0)는 홀로 둔다 — 첫 재생 지연 최소화. 이후는 mergeLen까지 병합.
    if (chunks.length > 1 && last.length + s.length + 1 <= mergeLen) {
      chunks[chunks.length - 1] = `${last} ${s}`
    } else {
      chunks.push(s)
    }
  }
  return chunks
}

// 스트리밍 청크 — seq 순서 보장(합성이 순차라 자연 보장), last=마지막 청크 표식.
export type TtsStreamChunk = { seq: number; audio: Buffer; mime: TtsResult['mime']; fallback?: boolean; last: boolean }

// 청크별 순차 합성 — emit은 합성 완료 즉시 호출(재생측이 큐잉). isCancelled가 true를 돌려주면 중단.
// 로컬 엔진(gpt-sovits/supertonic)이 한 번 edge로 폴백하면 이후 청크는 곧장 edge로 합성한다 —
// 죽은 서버에 청크마다 20~30초 타임아웃을 반복 지불하지 않기 위해(폴백 통보는 해당 청크에 1회).
export async function synthesizeBackendStream(
  text: string,
  cfg: TtsBackendConfig,
  emit: (chunk: TtsStreamChunk) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const chunks = splitForTts(text)
  let effective = cfg
  for (let i = 0; i < chunks.length; i++) {
    if (isCancelled()) return
    const r = await synthesizeBackend(chunks[i], effective)
    if (isCancelled()) return
    if (r.fallback) effective = { ...effective, ttsBackend: 'edge' }
    emit({ seq: i, audio: r.audio, mime: r.mime, fallback: r.fallback, last: i === chunks.length - 1 })
  }
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
  // 시도 1회당 상한(전체 데드라인보다 짧게) — 사이드카가 응답을 영영 안 주면(행) fetch 자체가 무한 대기해
  // 바깥 데드라인 루프가 재시도할 기회조차 못 얻는다. 8초면 20초 예산 안에서 최소 2회는 재시도 가능.
  const ATTEMPT_TIMEOUT_MS = 8000
  let lastErr = 'init'
  while (Date.now() < deadline) {
    try {
      const resp = await fetchWithTimeout(
        `http://127.0.0.1:${port}/tts`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        ATTEMPT_TIMEOUT_MS,
      )
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
