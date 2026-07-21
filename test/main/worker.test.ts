import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// store — waitApproval의 만료-거절 경로(resolveApprovalRow)만 스파이로 덮는다. 나머지 export는 실제 유지
// (mcp.ts 등이 listMcpServers 실제 구현을 요구). 테스트가 쓰는 건 resolveApprovalRow뿐이고, hold 경로는
// 이 함수를 아예 안 부르므로 실제 DB를 건드리지 않는다.
const { resolveApprovalRow } = vi.hoisted(() => ({ resolveApprovalRow: vi.fn() }))
vi.mock('../../src/main/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/store')>()
  return { ...actual, resolveApprovalRow }
})

import {
  sumUsageTokens,
  sessionBaselineFor,
  lifetimeTokensFor,
  classifyDivergence,
  RISKY,
  approvalTimeoutMs,
  waitApproval,
  resolveApproval,
  isAwaitingApproval,
  abortNavi,
  isOutsideWorkspace,
  webFetchApprovalKind,
  startNaviWatchdog,
  NAVI_WATCHDOG_MIN,
} from '../../src/main/worker'
import { budgetExceeded } from '../../src/main/usage'

describe('sumUsageTokens — usage 4필드 합산', () => {
  it('input+output+cache_creation+cache_read 합산', () => {
    expect(
      sumUsageTokens({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 2,
        },
      }),
    ).toBe(20)
  })
  it('일부 필드 누락 시 0으로 처리', () => {
    expect(sumUsageTokens({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } })).toBe(17)
  })
  it('usage 없으면 0', () => {
    expect(sumUsageTokens({})).toBe(0)
    expect(sumUsageTokens(undefined)).toBe(0)
    expect(sumUsageTokens(null)).toBe(0)
  })
  it('빈 usage → 0', () => {
    expect(sumUsageTokens({ usage: {} })).toBe(0)
  })
})

// I4 — 라이프타임 토큰 누적: 다중 세션이 예산을 넘기면 발동, 동일 세션 resume은 중복계수 안 함(순수 코어).
describe('sessionBaselineFor / lifetimeTokensFor — I4 다중 세션 누적(순수)', () => {
  it('sessionBaselineFor — resume이면 저장된 baseline, 아니면 tokensTotal을 승격', () => {
    // resume(동일 세션 이어가기): 이 세션 이전 세션들 누계(sessionBaseTokens)를 유지.
    expect(sessionBaselineFor(true, 300, 500)).toBe(300)
    // 새 세션(신규/핸드오프 스왑): 이전 tokensTotal(=이전 세션 최종 누계)을 baseline으로 승격.
    expect(sessionBaselineFor(false, 300, 500)).toBe(500)
    // 신규 작업(tokensTotal=0) → baseline 0.
    expect(sessionBaselineFor(false, 0, 0)).toBe(0)
  })

  it('lifetimeTokensFor — baseline + 세션 cumulative', () => {
    expect(lifetimeTokensFor(0, 400)).toBe(400)
    expect(lifetimeTokensFor(500, 400)).toBe(900)
  })

  it('동일 세션 resume은 중복 계수하지 않는다(교체)', () => {
    // 세션1이 재개(resume)로 두 번 result를 보고: baseline은 고정(0), 세션 cumulative만 커진다.
    const base = sessionBaselineFor(false, 0, 0) // 세션1 시작(신규) → baseline 0
    const total1 = lifetimeTokensFor(base, 400) // 세션1 첫 result: cumulative 400 → total 400
    // 같은 세션 resume(verify재시도 등): baseline은 저장된 sessionBaseTokens(=0) 유지.
    const baseResume = sessionBaselineFor(true, base, total1) // resume → baseline 그대로 0
    const total2 = lifetimeTokensFor(baseResume, 650) // 세션 cumulative가 650으로 성장 → total 650(400+650 아님)
    expect(total2).toBe(650) // 400+650=1050이 아니라 650 — 세션 cumulative를 '교체'
  })

  it('다중 세션(핸드오프 스왑) 누적이 예산을 넘기면 trip', () => {
    const budget = 1000
    // 세션1: 신규, cumulative 700 → total 700 (예산 미달)
    const base1 = sessionBaselineFor(false, 0, 0)
    const total1 = lifetimeTokensFor(base1, 700)
    expect(budgetExceeded(total1, budget)).toBe(false)
    // 핸드오프 스왑 → 세션2 시작(새 세션): baseline은 이전 tokensTotal(700)로 승격.
    const base2 = sessionBaselineFor(false, base1, total1) // = 700
    // 세션2 cumulative 500 → total 700+500 = 1200 (예산 초과)
    const total2 = lifetimeTokensFor(base2, 500)
    expect(total2).toBe(1200)
    expect(budgetExceeded(total2, budget)).toBe(true) // 다중 세션 누적으로 예산 발동(덮어쓰기였다면 500이라 미발동)
  })

  it('덮어쓰기(구 동작)였다면 다중 세션에서 예산이 안 걸렸을 것 — 회귀 방지 대조', () => {
    const budget = 1000
    // 구 동작: task.tokens = 세션 cumulative만(덮어쓰기). 세션2 cumulative 500 < 1000 → 미발동.
    expect(budgetExceeded(500, budget)).toBe(false)
    // 신규 동작: total 1200 → 발동(위 테스트). 대조로 회귀를 막는다.
  })
})

describe('RISKY — 위험행위 정규식 분류(§9-4)', () => {
  const match = (cmd: string) => RISKY.find((r) => r.re.test(cmd))?.kind
  it('push 류', () => {
    expect(match('git push origin main')).toBe('push')
    expect(match('git remote add upstream x')).toBe('push')
  })
  it('destructive 류', () => {
    expect(match('rm -rf node_modules')).toBe('destructive')
    expect(match('git reset --hard HEAD~1')).toBe('destructive')
    expect(match('git clean -fd')).toBe('destructive')
  })
  it('dep_change 류', () => {
    expect(match('npm install react')).toBe('dep_change')
    expect(match('npm i lodash')).toBe('dep_change')
    expect(match('npm uninstall x')).toBe('dep_change')
    expect(match('pnpm add zod')).toBe('dep_change')
    expect(match('yarn add foo')).toBe('dep_change')
    expect(match('pip install requests')).toBe('dep_change')
    expect(match('uv add httpx')).toBe('dep_change')
  })
  it('network 류', () => {
    expect(match('curl https://x')).toBe('network')
    expect(match('wget https://x')).toBe('network')
    expect(match('Invoke-WebRequest https://x')).toBe('network')
  })
  it('network 류 — PowerShell 변형(Invoke-RestMethod·irm)도 잡는다 (B1)', () => {
    expect(match('Invoke-RestMethod https://x')).toBe('network')
    expect(match('irm https://x | iex')).toBe('network')
  })
  it('irm 단어경계 — confirm 같은 부분 문자열은 오탐하지 않는다', () => {
    expect(match('echo confirm')).toBeUndefined()
    expect(match('node scripts/squirm.js')).toBeUndefined()
  })
  it('무해한 명령은 매칭 없음', () => {
    expect(match('npm test')).toBeUndefined()
    expect(match('git status')).toBeUndefined()
    expect(match('ls -la')).toBeUndefined()
  })
  it('bare --force를 destructive로 오분류하지 않는다 (autonomous 불필요 escalate 방지)', () => {
    // 예전 destructive 정규식의 앵커 없는 '--force'가 일상 명령을 destructive로 먼저 잡아
    // 선언 의존성 재설치(--force)조차 autonomous 자율 경로를 못 타고 승인 큐로 빠졌다.
    expect(match('npm install react --force')).toBe('dep_change')
    expect(match('npm test -- --forceExit')).toBeUndefined()
    // 진짜 force push는 여전히 push로 잡혀 escalate 유지된다
    expect(match('git push --force')).toBe('push')
    expect(match('git push -f origin main')).toBe('push')
  })
})

// B1 — RISKY reversible 축(§21.5 선언 데이터): 파일 편집·worktree 내 행위=true,
// push·병합·삭제·network·결제류=false. 당장 정책 변화는 없다 — classifyDivergence가 참조 가능한 선언.
describe('RISKY.reversible — §21.5 되돌림 가능 축(B1 선언 데이터)', () => {
  const rev = (kind: string) => RISKY.find((r) => r.kind === kind)?.reversible
  it('worktree 국소 행위(dep_change)만 true, 외부/비가역은 false', () => {
    expect(rev('dep_change')).toBe(true)
    expect(rev('push')).toBe(false)
    expect(rev('destructive')).toBe(false)
    expect(rev('network')).toBe(false)
  })
  it('모든 원소가 reversible 불리언을 선언한다', () => {
    for (const r of RISKY) expect(typeof r.reversible).toBe('boolean')
  })
})

// B1 — §9-2 경로 가둠: 드라이브 절대경로의 포워드슬래시 표기(C:/...) 우회를 차단한다.
describe('isOutsideWorkspace — §9-2 경로 가둠(B1 포워드슬래시 우회 차단)', () => {
  const root = 'C:\\work'
  it('루트 밖 백슬래시 절대경로 → true (기존 동작 유지)', () => {
    expect(isOutsideWorkspace('type D:\\secrets\\a.txt', root)).toBe(true)
    expect(isOutsideWorkspace('type C:\\Windows\\System32\\x', root)).toBe(true)
  })
  it('포워드슬래시 절대경로도 잡는다(우회 차단)', () => {
    expect(isOutsideWorkspace('cat D:/secrets/a.txt', root)).toBe(true)
    expect(isOutsideWorkspace('cat C:/Windows/System32/x', root)).toBe(true)
  })
  it('루트 안 경로는 표기(백/포워드) 무관하게 false — 오탐 승인 방지', () => {
    expect(isOutsideWorkspace('type C:\\work\\proj\\a.ts', root)).toBe(false)
    expect(isOutsideWorkspace('cat C:/work/proj/a.ts', root)).toBe(false)
  })
  it('절대경로가 없으면 false', () => {
    expect(isOutsideWorkspace('npm test', root)).toBe(false)
    expect(isOutsideWorkspace('cat ./src/a.ts', root)).toBe(false)
  })
})

// B1 — WebFetch 게이트: 임의 URL 페치는 curl/wget과 같은 network 위험이라 승인 대상.
// WebSearch는 서버측 검색(임의 원격 접속 아님)이라 게이트하지 않는다.
describe('webFetchApprovalKind — B1 WebFetch 승인 게이트(network)', () => {
  it('WebFetch는 network 승인 대상', () => {
    expect(webFetchApprovalKind('WebFetch')).toBe('network')
  })
  it('WebSearch(서버측 검색)·일반 도구는 게이트하지 않는다', () => {
    expect(webFetchApprovalKind('WebSearch')).toBeNull()
    expect(webFetchApprovalKind('Read')).toBeNull()
    expect(webFetchApprovalKind('Bash')).toBeNull()
  })
})

// B1 — Navi 무활동 워치독(manager.ts 턴 워치독의 동형 이식). 무진전 임계 초과 시 abort 콜백,
// 승인/질문 hold 중엔 keep-alive(대기는 무진전이 아님), 정리는 stop(clearInterval).
describe('startNaviWatchdog — B1 무활동 워치독(fake timer)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('무진전이 임계를 넘으면 onStall 발화', () => {
    const onStall = vi.fn()
    const wd = startNaviWatchdog({ holding: () => false, onStall, thresholdMs: 60_000 })
    vi.advanceTimersByTime(59_000) // 임계 미만 — 발화 없음
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(41_000) // 100s 시점 — 80s 틱에서 임계(60s) 초과
    expect(onStall).toHaveBeenCalled()
    wd.stop()
  })

  it('touch(스트림 활동)가 이어지면 발화하지 않는다', () => {
    const onStall = vi.fn()
    const wd = startNaviWatchdog({ holding: () => false, onStall, thresholdMs: 60_000 })
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30_000)
      wd.touch()
    }
    expect(onStall).not.toHaveBeenCalled()
    wd.stop()
  })

  it('hold(승인 대기) 중엔 keep-alive — 임계를 한참 넘겨도 발화하지 않는다', () => {
    const onStall = vi.fn()
    let holding = true
    const wd = startNaviWatchdog({ holding: () => holding, onStall, thresholdMs: 60_000 })
    vi.advanceTimersByTime(10 * 60_000) // 10분 무응답 대기 — hold라 무진전 아님
    expect(onStall).not.toHaveBeenCalled()
    // hold 해제 후엔 해제 시점부터 무진전 카운트가 다시 시작된다.
    holding = false
    vi.advanceTimersByTime(59_000)
    expect(onStall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(41_000)
    expect(onStall).toHaveBeenCalled()
    wd.stop()
  })

  it('stop() 후엔 발화하지 않는다(clearInterval 정리)', () => {
    const onStall = vi.fn()
    const wd = startNaviWatchdog({ holding: () => false, onStall, thresholdMs: 60_000 })
    wd.stop()
    vi.advanceTimersByTime(10 * 60_000)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('기본 임계는 25분 — 관리자(10분)보다 길게(빌드·설치 여유)', () => {
    expect(NAVI_WATCHDOG_MIN).toBe(25)
  })
})

describe('classifyDivergence — §21.5 자율/escalate 경계', () => {
  let wt: string
  beforeEach(() => {
    wt = fs.mkdtempSync(path.join(os.tmpdir(), 'lain-wt-'))
  })
  afterEach(() => {
    fs.rmSync(wt, { recursive: true, force: true })
  })
  const setDeps = (deps: Record<string, string>) =>
    fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ dependencies: deps }))

  it('push/destructive/network는 항상 escalate(autonomous=false)', () => {
    expect(classifyDivergence('push', 'git push', wt).autonomous).toBe(false)
    expect(classifyDivergence('destructive', 'rm -rf x', wt).autonomous).toBe(false)
    expect(classifyDivergence('network', 'curl x', wt).autonomous).toBe(false)
    expect(classifyDivergence('outside_dev', 'D:\\x', wt).autonomous).toBe(false)
  })

  it('dep_change: 선언된 JS 의존성 (재)설치만 자율', () => {
    setDeps({ react: '^18' })
    expect(classifyDivergence('dep_change', 'npm install react', wt).autonomous).toBe(true)
  })

  it('dep_change: 새(novel) 패키지는 escalate', () => {
    setDeps({ react: '^18' })
    const v = classifyDivergence('dep_change', 'npm install leftpad', wt)
    expect(v.autonomous).toBe(false)
    expect(v.reason).toContain('leftpad')
  })

  it('dep_change: uninstall/remove는 escalate', () => {
    setDeps({ react: '^18' })
    expect(classifyDivergence('dep_change', 'npm uninstall react', wt).autonomous).toBe(false)
    expect(classifyDivergence('dep_change', 'npm remove react', wt).autonomous).toBe(false)
  })

  it('dep_change: pip/uv(비-JS)는 검증 불가 → escalate', () => {
    setDeps({ react: '^18' })
    expect(classifyDivergence('dep_change', 'pip install requests', wt).autonomous).toBe(false)
    expect(classifyDivergence('dep_change', 'uv add httpx', wt).autonomous).toBe(false)
  })

  it('dep_change: package.json 읽기 실패면 보수적 escalate', () => {
    // package.json 없음 → declaredDeps 빈 집합
    expect(classifyDivergence('dep_change', 'npm install react', wt).autonomous).toBe(false)
  })

  it('dep_change: 버전 지정(@scope/pkg@x)도 기본명으로 매칭', () => {
    setDeps({ '@scope/pkg': '^1' })
    expect(classifyDivergence('dep_change', 'npm install @scope/pkg@1.2.3', wt).autonomous).toBe(true)
  })

  it('dep_change: 선언+미선언 혼합이면 escalate', () => {
    setDeps({ react: '^18' })
    expect(classifyDivergence('dep_change', 'npm install react newpkg', wt).autonomous).toBe(false)
  })

  it('dep_change: devDependencies 선언도 인정', () => {
    fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1' } }))
    expect(classifyDivergence('dep_change', 'npm install vitest', wt).autonomous).toBe(true)
  })
})

describe('approvalTimeoutMs — D4 분→ms(순수)', () => {
  it('분을 ms로', () => {
    expect(approvalTimeoutMs(30)).toBe(30 * 60_000)
    expect(approvalTimeoutMs(1)).toBe(60_000)
  })
  it('0이면 0(재알림/데드라인 없음 = 무한 대기)', () => {
    expect(approvalTimeoutMs(0)).toBe(0)
  })
  it('음수/소수는 보정(0 하한·내림)', () => {
    expect(approvalTimeoutMs(-5)).toBe(0)
    expect(approvalTimeoutMs(1.9)).toBe(60_000)
  })
})

describe('waitApproval — D4 만료 동작(fake timer)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resolveApprovalRow.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('기존(포그라운드) 경로: 만료 시 자동 거절(rejected)', async () => {
    const p = waitApproval(1) // hold 없음 → 30분 후 거절
    vi.advanceTimersByTime(30 * 60_000)
    const res = await p
    expect(res.approved).toBe(false)
    expect(resolveApprovalRow).toHaveBeenCalledWith(1, 'rejected')
  })

  it('hold(무인 작업): 만료해도 거절하지 않고 재알림 1회만 — 계속 대기', async () => {
    const onRemind = vi.fn()
    let settled = false
    const p = waitApproval(2, { hold: true, timeoutMs: 30 * 60_000, onRemind }).then((v) => {
      settled = true
      return v
    })
    // 재알림 시점 통과 — 재알림은 1회 오지만 Promise는 미해결(거절 안 함).
    vi.advanceTimersByTime(30 * 60_000)
    await Promise.resolve()
    expect(onRemind).toHaveBeenCalledTimes(1)
    expect(resolveApprovalRow).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    // 한참 더 지나도 추가 재알림·거절 없음(반복 알림 금지).
    vi.advanceTimersByTime(3 * 60 * 60_000)
    await Promise.resolve()
    expect(onRemind).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    // 사용자가 응답하면 그제서야 그 지점부터 이어진다.
    resolveApproval(2, true, 'ok')
    const res = await p
    expect(res.approved).toBe(true)
    expect(res.answer).toBe('ok')
    // hold 경로는 만료 시 resolveApprovalRow(rejected)를 부르지 않는다 —
    // resolveApproval(응답)이 approved로 기록할 뿐(거절 경로 오염 없음).
  })

  it('hold + timeoutMs=0: 재알림 타이머조차 없음(무한 대기)', async () => {
    const onRemind = vi.fn()
    const p = waitApproval(3, { hold: true, timeoutMs: 0, onRemind })
    vi.advanceTimersByTime(24 * 60 * 60_000)
    await Promise.resolve()
    expect(onRemind).not.toHaveBeenCalled()
    resolveApproval(3, false)
    const res = await p
    expect(res.approved).toBe(false)
  })
})

// C1 — hold 대기 진입 시 task를 awaiting-approval로 표시하고, 모든 종료 경로에서 clear한다(누수 방지).
// 누수되면 held 작업이 슬롯·유휴 게이트를 영구 점유해 야간 무인 정지가 재발한다(안전 최우선).
describe('isAwaitingApproval — C1 hold 대기 추적 set/clear', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resolveApprovalRow.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hold+taskId 진입 시 표시, 정상 응답(승인)으로 clear', async () => {
    const p = waitApproval(101, { hold: true, timeoutMs: 0, taskId: 'c1-approve' })
    expect(isAwaitingApproval('c1-approve')).toBe(true)
    resolveApproval(101, true, 'ok')
    await p
    expect(isAwaitingApproval('c1-approve')).toBe(false)
  })

  it('거절 응답으로도 clear된다', async () => {
    const p = waitApproval(102, { hold: true, timeoutMs: 0, taskId: 'c1-reject' })
    expect(isAwaitingApproval('c1-reject')).toBe(true)
    resolveApproval(102, false)
    await p
    expect(isAwaitingApproval('c1-reject')).toBe(false)
  })

  it('abort(인터럽트/취소)로도 clear된다 — Promise 미해결이라도 누수 없음', () => {
    void waitApproval(103, { hold: true, timeoutMs: 0, taskId: 'c1-abort' })
    expect(isAwaitingApproval('c1-abort')).toBe(true)
    abortNavi('c1-abort') // 등록된 AbortController가 없어도 set은 확실히 delete
    expect(isAwaitingApproval('c1-abort')).toBe(false)
  })

  it('재알림(onRemind) 경과 후에도 대기 중이면 여전히 표시(무한 대기)', async () => {
    const onRemind = vi.fn()
    void waitApproval(104, { hold: true, timeoutMs: 60_000, taskId: 'c1-hold', onRemind })
    vi.advanceTimersByTime(60_000)
    await Promise.resolve()
    expect(onRemind).toHaveBeenCalledTimes(1)
    expect(isAwaitingApproval('c1-hold')).toBe(true) // 재알림은 clear가 아님
    resolveApproval(104, true)
  })

  it('hold=false(포그라운드) 경로는 추적하지 않는다 — 슬롯 점유 개념이 무인 작업 전용', () => {
    void waitApproval(105, { taskId: 'c1-foreground' }) // hold 없음
    expect(isAwaitingApproval('c1-foreground')).toBe(false)
    resolveApproval(105, false)
  })
})
