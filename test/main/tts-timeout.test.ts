// test/main/tts-timeout.test.ts
// 외부 IO 행 버그 사냥 — TTS(gpt-sovits/supertonic) fetch가 응답을 영원히 안 주는 서버를 만나면
// 타임아웃 없이는 음성 경로가 무한 대기한다. 실제 네트워크는 절대 안 쓰고, fetch를 "서버가 응답을
// 영원히 안 준다"로 모킹(AbortSignal이 abort될 때만 reject)한 뒤 fake timers로 시간을 흘려보내
// 타임아웃이 실제로 걸리는지 확인한다.
import { describe, it, expect, vi, afterEach } from 'vitest'

// synthesizeSupertonic은 './supertonic-proc'을 동적 import하므로, 실제 사이드카 스폰 없이
// ensureSupertonic만 즉답하도록 모킹한다(이 파일의 관심사는 tts.ts의 fetch 타임아웃이지 사이드카 자체가 아님).
vi.mock('../../src/main/supertonic-proc', () => ({
  ensureSupertonic: vi.fn(async () => 8920),
}))

// 서버가 응답을 영원히 주지 않는 상황(행) — signal이 abort될 때만 AbortError로 reject한다.
// 실제 undici fetch의 abort 동작과 동일한 계약이라, tts.ts가 AbortController를 진짜로 연결했는지 검증된다.
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined
      signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
      // 그 외에는 절대 resolve/reject하지 않는다 — 행 상태 재현.
    })
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('synthesizeGptSovits — 서버 무응답(행) 시 타임아웃', () => {
  it('30초 내 응답이 없으면 시간 초과 에러로 종료된다(무한 대기하지 않는다)', async () => {
    // 모듈을 fake timers 활성화 전에 먼저 로드해 캐시해 둔다 — vite 변환 파이프라인이 내부적으로
    // setImmediate 등을 쓰는데, 첫 로드가 fake timers 아래서 일어나면 멈춰버리는 vitest 알려진 함정 회피.
    const { synthesizeGptSovits } = await import('../../src/main/tts')
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())

    const p = synthesizeGptSovits('안녕', {
      url: 'http://127.0.0.1:9880',
      refAudio: 'ref.wav',
      refText: '참조 문장',
    })
    // 아직 타임아웃 전 — pending 상태여야 한다(즉시 resolve/reject되면 안 됨).
    let settled = false
    p.then(
      () => (settled = true),
      () => (settled = true),
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(30_000)
    await expect(p).rejects.toThrow(/시간 초과/)
  })
})

describe('synthesizeSupertonic — 사이드카 무응답(행) 시 개별 시도 타임아웃', () => {
  it('전체 20초 데드라인 안에서 멈추지 않고 시간 초과로 종료된다', async () => {
    // store.ts 등 동적 import 대상도 fake timers 전에 미리 로드해 캐시해 둔다(위와 동일한 이유).
    const { synthesizeSupertonic } = await import('../../src/main/tts')
    await import('../../src/main/store').catch(() => {
      /* 로드만 되면 됨 — DB 미초기화로 인한 부수 실패는 무관 */
    })
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())

    const p = synthesizeSupertonic('안녕')
    let settled = false
    p.then(
      () => (settled = true),
      () => (settled = true),
    )
    // 데드라인(20s) + 마지막 시도의 재시도 간격까지 흘려보낸다. 개별 시도 타임아웃이 없으면 첫 fetch가
    // 영원히 pending이라 이 시점에도 settled=false로 남아 버그를 드러낸다.
    await vi.runAllTimersAsync()
    expect(settled).toBe(true)
    await expect(p).rejects.toThrow(/준비 시간 초과/)
  })
})
