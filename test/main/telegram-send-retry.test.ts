// #12 — telegram send() 송신 재시도 회귀 고정: 최종 실패(HTML→평문 폴백까지 실패)가
// transient(5xx·네트워크 blip)나 429(rate limit)면 1~2회 재송신하고, 429는 텔레그램이 알려준
// retry_after 초만큼 대기한다. 성공 경로 이중 송신은 절대 없다(재시도는 실패 시에만).
// send는 모듈 프라이빗 — 얇은 공개 래퍼 sendTelegram으로 검증하고, 전송은 전역 fetch 스텁으로 관찰.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

// 실 store(임시 DATA_DIR의 격리 DB)를 쓴다 — telegram.ts의 import 그래프(manager 등)가 store 전역
// 모킹으로는 너무 넓다(manager.test.ts와 동일 선례). 매 실행 잔재 제거로 결정론 보장.
vi.mock('../../src/main/paths', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const TMP = path.join(os.tmpdir(), 'lain-tg-send-retry-test')
  fs.rmSync(TMP, { recursive: true, force: true })
  return {
    DATA_DIR: TMP,
    PROJECT_ROOT: process.cwd(),
    AGENT_CWD: process.cwd(),
    BENCH_DIR: path.join(TMP, 'bench'),
    CLAUDE_BIN: 'claude',
    SELF_SRC_DIR: null,
  }
})

import { sendTelegram } from '../../src/main/telegram'
import { initStore, saveSettings } from '../../src/main/store'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

// 텔레그램 Bot API 응답 스텁 — 성공/실패(json.ok) 형태를 그대로 흉내.
const ok = (result: unknown) => ({ json: async () => ({ ok: true, result }) }) as unknown as Response
const fail = (error_code: number, description: string, parameters?: { retry_after?: number }) =>
  ({ json: async () => ({ ok: false, error_code, description, parameters }) }) as unknown as Response

beforeAll(() => {
  initStore() // 임시 DATA_DIR에 격리 DB 생성(앱에선 index.ts가 부팅 시 호출)
  // 봇/채팅 설정 — 없으면 send가 조기 반환한다. 토큰은 무의미한 더미(시크릿 아님).
  saveSettings({ telegramBotToken: '123:TEST', telegramChatId: '42' })
})

afterEach(() => {
  vi.useRealTimers()
  fetchMock.mockReset()
})

describe('telegram send — 송신 재시도(#12)', () => {
  it('성공하면 정확히 1회 전송(이중 송신 없음)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ message_id: 7 }))
    await expect(sendTelegram('안녕')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTML 파싱 거부(400)는 평문 폴백 1회로 성공 — 재시도 루프 미진입', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(400, "Bad Request: can't parse entities"))
      .mockResolvedValueOnce(ok({ message_id: 8 }))
    await expect(sendTelegram('**굵게**')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('transient(5xx) 최종 실패면 백오프 후 재송신해 성공한다', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(fail(502, 'Bad Gateway')) // 1차 HTML
      .mockResolvedValueOnce(fail(502, 'Bad Gateway')) // 1차 평문 폴백 → 최종 실패 → 재시도
      .mockResolvedValueOnce(ok({ message_id: 9 })) // 2차 HTML 성공
    const p = sendTelegram('알림')
    await vi.advanceTimersByTimeAsync(1000) // transientBackoffMs(0)
    await expect(p).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('429는 응답의 retry_after 초만큼 대기한 뒤 재송신한다', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(fail(429, 'Too Many Requests: retry after 3', { retry_after: 3 }))
      .mockResolvedValueOnce(fail(429, 'Too Many Requests: retry after 3', { retry_after: 3 }))
      .mockResolvedValueOnce(ok({ message_id: 10 }))
    const p = sendTelegram('알림')
    await vi.advanceTimersByTimeAsync(2999) // retry_after(3s) 전 — 아직 재송신 없음
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('비일시(400 등) 최종 실패는 재시도하지 않는다', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(400, 'Bad Request: chat not found'))
      .mockResolvedValueOnce(fail(400, 'Bad Request: chat not found'))
    await expect(sendTelegram('안녕')).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('재시도 상한(2회) 소진이면 포기한다 — 무한 재송신 금지', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(fail(503, 'Service Unavailable'))
    const p = sendTelegram('알림')
    await vi.advanceTimersByTimeAsync(1000 + 2000) // transientBackoffMs(0) + (1)
    await expect(p).resolves.toBe(false)
    // 시도 3회(원시도+재시도2) × (HTML+평문) = 6회에서 멈춘다
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
})
