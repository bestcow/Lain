// #8 — judge 공용 러너 단위 테스트. query→assistant 텍스트 누적→60초 abort→maxTurns 2 골격의
// 단일 출처(runJudge)와 ```json 블록 관대 파싱(parseJsonBlock). 실패·타임아웃·파싱 불능은 전부
// null(무해 폴백 관례 — 호출부는 '판정 불능 = 진행을 막지 않음'으로 처리). 실제 SDK/DB는 안 쓴다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { query } from '@anthropic-ai/claude-agent-sdk'

// agentopts — 실제 judgeQueryOptions는 getSettings()로 DB를 읽는다(테스트에선 미초기화) → 빈 옵션으로 대체.
vi.mock('../../src/main/agentopts', () => ({ judgeQueryOptions: () => ({}) }))

import { runJudge, parseJsonBlock, isJsonObject } from '../../src/main/judge'
import { resetUsage, recentUsageTokens } from '../../src/main/usage'

// query 목 헬퍼 — 주어진 메시지들을 순서대로 yield하는 스트림.
function mockStream(msgs: unknown[]): void {
  vi.mocked(query).mockImplementation((() =>
    (async function* () {
      for (const m of msgs) yield m
    })()) as any)
}
const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

beforeEach(() => {
  vi.mocked(query).mockReset()
  resetUsage()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('runJudge — judge 1콜 러너(#8)', () => {
  it('assistant 텍스트를 누적해 마지막 텍스트를 반환한다', async () => {
    mockStream([assistant('중간 생각'), assistant('최종 답')])
    expect(await runJudge('p')).toBe('최종 답')
  })

  it('텍스트가 전혀 없으면 빈 문자열(기존 runAuditJudge 관례 — null 아님)', async () => {
    mockStream([{ type: 'system' }])
    expect(await runJudge('p')).toBe('')
  })

  it('스트림 throw → null(무해 폴백)', async () => {
    vi.mocked(query).mockImplementation((() =>
      (async function* () {
        throw new Error('boom')
      })()) as any)
    expect(await runJudge('p')).toBeNull()
  })

  it('무응답 60초(기본 timeoutMs) → abort → null', async () => {
    vi.mocked(query).mockImplementation(((args: any) => {
      const signal: AbortSignal | undefined = args?.options?.abortController?.signal
      return (async function* () {
        // abortController가 실제로 전달되지 않으면 이 Promise가 절대 안 풀려 테스트가 타임아웃으로 실패한다.
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
        yield assistant('절대 안 나옴')
      })()
    }) as any)

    vi.useFakeTimers()
    let result: string | null = 'unset'
    const p = runJudge('p').then((r) => {
      result = r
    })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(result).toBe('unset') // 아직 타임아웃 전 — pending 유지
    await vi.advanceTimersByTimeAsync(2_000)
    await p
    expect(result).toBeNull()
  })

  it('result 메시지의 usage를 recordUsage로 적재한다(#7 judge 몫 — 전역 사용량 가드가 judge 소비를 본다)', async () => {
    mockStream([
      assistant('답'),
      { type: 'result', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } },
    ])
    expect(await runJudge('p')).toBe('답')
    expect(recentUsageTokens()).toBe(17)
  })

  it('기본 옵션 — maxTurns 2·allowedTools []·abortController 전달, timeoutMs/maxTurns 오버라이드 가능', async () => {
    mockStream([assistant('ok')])
    await runJudge('p')
    let opts = vi.mocked(query).mock.calls[0][0].options as any
    expect(opts.maxTurns).toBe(2)
    expect(opts.allowedTools).toEqual([])
    expect(opts.abortController).toBeInstanceOf(AbortController)

    mockStream([assistant('ok')])
    await runJudge('p', { maxTurns: 5 })
    opts = vi.mocked(query).mock.calls[1][0].options as any
    expect(opts.maxTurns).toBe(5)
  })

  it('stderr 옵션이 query 옵션으로 전달된다(scheduler 진단 로그 싱크)', async () => {
    mockStream([assistant('ok')])
    const sink = vi.fn()
    await runJudge('p', { stderr: sink })
    const opts = vi.mocked(query).mock.calls[0][0].options as any
    expect(opts.stderr).toBe(sink)
  })
})

describe('parseJsonBlock — ```json 블록 관대 파싱', () => {
  interface V {
    pass: boolean
  }
  const guard = (x: unknown): x is V => typeof (x as any)?.pass === 'boolean'

  it('유효 블록 + guard 통과 → 타입 값', () => {
    expect(parseJsonBlock('앞말 ```json\n{"pass": true}\n``` 뒷말', guard)).toEqual({ pass: true })
  })
  it('블록 없음 → null', () => {
    expect(parseJsonBlock('그냥 산문', guard)).toBeNull()
  })
  it('비JSON 블록 → null', () => {
    expect(parseJsonBlock('```json\n{oops}\n```', guard)).toBeNull()
  })
  it('guard 불통과 → null', () => {
    expect(parseJsonBlock('```json\n{"pass": "yes"}\n```', guard)).toBeNull()
  })
  it('null 텍스트(runJudge 실패 폴백) → null', () => {
    expect(parseJsonBlock(null, guard)).toBeNull()
  })
  it('isJsonObject — 객체·배열 허용(기존 호출부의 속성 즉시 접근 관례), 원시값·null 거부', () => {
    expect(parseJsonBlock('```json\n{"a": 1}\n```', isJsonObject)).toEqual({ a: 1 })
    expect(parseJsonBlock('```json\n[1]\n```', isJsonObject)).toEqual([1])
    expect(parseJsonBlock('```json\n"str"\n```', isJsonObject)).toBeNull()
    expect(parseJsonBlock('```json\nnull\n```', isJsonObject)).toBeNull()
  })
})
