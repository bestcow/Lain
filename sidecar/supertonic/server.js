// Lain Supertonic 사이드카 — plain Node에서 도는 상주 로컬 TTS 서버.
// onnxruntime-node는 node-ABI 프리빌드라 Electron 메인엔 못 올린다 → 시스템 node 자식 프로세스로 격리 실행.
// helper.js는 Supertone Inc.의 MIT 코드(벤더링, LICENSE 동봉). 큰 .onnx(약 398MB)는 첫 기동 시 HF에서 1회 다운로드.
//
// 사용: node server.js [port] [cacheDir]
//   env: LAIN_SUPERTONIC_PORT, LAIN_SUPERTONIC_CACHE
// 엔드포인트: GET /health → {ready,downloading,progress}  |  POST /tts {text,voice,lang,speed,step} → audio/wav
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTextToSpeech, loadVoiceStyle, writeWavFile } from './helper.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.LAIN_SUPERTONIC_PORT || process.argv[2] || 8920)
const CACHE = process.env.LAIN_SUPERTONIC_CACHE || process.argv[3] || path.join(__dirname, 'cache')
const ONNX_DIR = path.join(CACHE, 'onnx')
const VOICE_DIR = path.join(__dirname, 'voice_styles')
const VENDOR_ONNX = path.join(__dirname, 'vendor-onnx')
const HF_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/main/onnx'
const BIG_ONNX = ['duration_predictor.onnx', 'text_encoder.onnx', 'vector_estimator.onnx', 'vocoder.onnx']
const SMALL_VENDOR = ['tts.json', 'unicode_indexer.json']

function log(m) {
  process.stderr.write(`[supertonic] ${m}\n`)
}

let state = { ready: false, downloading: false, progress: 0, error: '' }

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download ${res.status} ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  const tmp = `${dest}.part`
  const out = fs.createWriteStream(tmp)
  let got = 0
  let lastPct = -1
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    got += value.length
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
    if (total) {
      const pct = Math.floor((got / total) * 100)
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct
        state.progress = pct
        log(`${path.basename(dest)} ${pct}%`)
      }
    }
  }
  await new Promise((r) => out.end(r))
  fs.renameSync(tmp, dest)
}

async function ensureAssets() {
  fs.mkdirSync(ONNX_DIR, { recursive: true })
  // 벤더링된 소형 설정(다운로드 불필요)을 작업 onnxDir로 복사
  for (const f of SMALL_VENDOR) {
    const d = path.join(ONNX_DIR, f)
    if (!fs.existsSync(d)) fs.copyFileSync(path.join(VENDOR_ONNX, f), d)
  }
  // 대형 onnx — 없으면 HF에서 1회 다운로드
  const missing = BIG_ONNX.filter((f) => !fs.existsSync(path.join(ONNX_DIR, f)))
  if (missing.length) {
    state.downloading = true
    for (const f of missing) {
      log(`downloading ${f} …`)
      await download(`${HF_BASE}/${f}`, path.join(ONNX_DIR, f))
    }
    state.downloading = false
    state.progress = 100
  }
}

let tts = null
const styleCache = new Map()
function getStyle(voice) {
  const v = /^[FM][1-9]$/.test(voice) ? voice : 'F5' // 화이트리스트(경로주입 방지)
  if (!styleCache.has(v)) {
    const p = path.join(VOICE_DIR, `${v}.json`)
    if (!fs.existsSync(p)) throw new Error(`unknown voice ${v}`)
    styleCache.set(v, loadVoiceStyle([p], false))
  }
  return styleCache.get(v)
}

async function init() {
  try {
    await ensureAssets()
    log('loading model …')
    tts = await loadTextToSpeech(ONNX_DIR, false)
    state.ready = true
    log('ready')
  } catch (e) {
    state.error = String((e && e.stack) || e)
    log(`init fail ${state.error}`)
  }
}

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length })
  res.end(b)
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, state)
    return
  }
  if (req.method === 'POST' && req.url === '/tts') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1e6) req.destroy() // 과대 입력 차단
    })
    req.on('end', async () => {
      let tmp = ''
      try {
        if (!state.ready) return sendJson(res, 503, { error: state.error || 'not ready', ...state })
        const { text, voice = 'F5', lang = 'ko', speed = 1.05, step = 8 } = JSON.parse(body || '{}')
        if (!text || !String(text).trim()) return sendJson(res, 400, { error: 'no text' })
        const style = getStyle(voice)
        const safeStep = Math.max(2, Math.min(16, Number(step) || 8))
        const safeSpeed = Math.max(0.5, Math.min(2.0, Number(speed) || 1.05))
        const { wav, duration } = await tts.call(String(text), lang, style, safeStep, safeSpeed)
        const len = Math.floor(tts.sampleRate * duration[0])
        const samples = wav.slice(0, len)
        // 검증된 helper.writeWavFile로 16-bit PCM WAV 생성(메모리 인코더 자작 위험 회피) → 읽어서 반환
        tmp = path.join(CACHE, `out_${process.pid}_${Date.now()}.wav`)
        writeWavFile(tmp, samples, tts.sampleRate)
        const out = fs.readFileSync(tmp)
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': out.length })
        res.end(out)
      } catch (e) {
        log(`tts error ${(e && e.stack) || e}`)
        sendJson(res, 500, { error: String((e && e.message) || e) })
      } finally {
        if (tmp) {
          try {
            fs.unlinkSync(tmp)
          } catch {
            /* ignore */
          }
        }
      }
    })
    return
  }
  sendJson(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${PORT} (cache=${CACHE})`))
void init()
