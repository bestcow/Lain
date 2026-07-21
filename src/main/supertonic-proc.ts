// Supertonic 사이드카 프로세스 매니저 (메인 프로세스).
// onnxruntime-node는 node-ABI 프리빌드라 Electron에 직접 못 올린다 → 시스템 node로 사이드카(server.js)를 띄워
// 127.0.0.1:PORT 로컬 HTTP(POST /tts)로 통신한다(파이썬 없음). 모델(약 398MB)은 사이드카가 첫 기동 때 HF에서 1회 다운로드.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DATA_DIR, PROJECT_ROOT } from './paths'
import { appendCapped } from './logfile'

const PORT = 8920
let child: ChildProcess | null = null
let starting: Promise<number> | null = null

function slog(m: string): void {
  try {
    appendCapped(path.join(DATA_DIR, 'supertonic.log'), `${new Date().toISOString()} ${m}\n`)
  } catch {
    /* ignore */
  }
}

// dev=레포의 sidecar/, 패키징본=extraResources로 풀린 resources/sidecar/.
function sidecarDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sidecar', 'supertonic')
    : path.join(PROJECT_ROOT, 'sidecar', 'supertonic')
}

// 헬스체크 타임아웃 — dead handle 판정(아래 ensureSupertonic)의 근거라 짧게 잡는다. 이게 무한 대기하면
// '핸들은 안 죽었는데 응답이 없는' 프로세스를 영영 dead로 판정 못 해 재기동이 막힌다.
const HEALTH_TIMEOUT_MS = 3000
async function health(): Promise<{ ready: boolean } | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), HEALTH_TIMEOUT_MS)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: ac.signal })
    if (!r.ok) return null
    return (await r.json()) as { ready: boolean }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** 사이드카를 보장(이미 떠 있으면 그대로). 스폰만 하고 모델 준비 완료는 기다리지 않는다 — 준비 전 /tts는 503. */
export async function ensureSupertonic(): Promise<number> {
  if (child && !child.killed) {
    // dead handle 방어 — child.killed는 우리가 kill()을 호출했을 때만 true가 된다. 프로세스가 멎어(응답
    // 불가) 있는데 OS상 아직 살아 있으면(exit 이벤트 미발생) 이 가드만으로는 영영 재기동을 못 한다.
    // 짧은 헬스체크로 실제 응답 여부를 확인하고, 무응답이면 죽은 것으로 간주해 정리 후 재기동한다.
    if (await health()) return PORT
    slog('dead handle 감지(헬스체크 무응답) — 기존 프로세스 정리 후 재기동')
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    child = null
  }
  if (starting) return starting
  starting = (async () => {
    const h = await health()
    if (h) return PORT // 외부/기존 인스턴스 재사용
    const dir = sidecarDir()
    const server = path.join(dir, 'server.js')
    // dev 클론 등에서 사이드카 의존성(onnxruntime-node 등)이 미설치면 server.js가 import 단계에서 즉사한다.
    // 20초 재시도(매 발화 지연) 대신 여기서 즉시 실패 → 호출측(synthesizeSupertonic)이 곧바로 edge로 폴백한다.
    if (!fs.existsSync(server) || !fs.existsSync(path.join(dir, 'node_modules'))) {
      const msg = `supertonic 사이드카 미설치 (${dir}) — 'npm run setup:supertonic' 실행 후 사용. 지금은 edge로 대체.`
      slog(msg)
      throw new Error(msg)
    }
    const cache = path.join(DATA_DIR, 'supertonic')
    // 개인 보이스(로컬) 디렉터리 — 사용자가 직접 가져온 스타일 JSON만 둔다(배포 미포함). 사이드카가 화이트리스트 밖 보이스를 여기서 로드.
    const voices = path.join(DATA_DIR, 'voices')
    try {
      fs.mkdirSync(voices, { recursive: true })
    } catch {
      /* ignore */
    }
    slog(`spawn node ${server} (cache=${cache})`)
    const c = spawn('node', [server], {
      cwd: dir,
      env: {
        ...process.env,
        LAIN_SUPERTONIC_PORT: String(PORT),
        LAIN_SUPERTONIC_CACHE: cache,
        LAIN_SUPERTONIC_VOICES: voices,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    c.stderr?.on('data', (d: Buffer) => slog(`[sidecar] ${String(d).trim()}`))
    c.on('error', (e) => slog(`spawn error ${e}`))
    c.on('exit', (code) => {
      slog(`sidecar exit ${code}`)
      if (child === c) child = null
    })
    child = c
    return PORT
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

export function stopSupertonic(): void {
  if (child && !child.killed) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    child = null
  }
}
