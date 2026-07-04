// Phase 3 주기 스캔 (§15, §10.4) — 결정론 현황을 주기적으로 재수집.
// 변화 감지: 새 TASK.md 등장 → OS 알림 (작업 출처 §7.2의 자동화 입구).
// autoPriority 켜져 있으면 다이제스트가 변했을 때만 관리자(judge 모델)가
// 우선순위 변화를 판단해 채팅으로 푸시한다 — L0 원칙(§4) 예외는 이 한 곳, 설정 opt-in.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { DATA_DIR, AGENT_CWD, CLAUDE_BIN } from './paths'
import { appendCapped } from './logfile'
import { collectStatus } from './collectors'
import { generateBriefing } from './briefing'
import {
  addMessage,
  applyConsolidation,
  applySkillLifecycle,
  getSetting,
  getSettings,
  lastChatActivityAt,
  lessonsForCuration,
  listApprovals,
  listDueRoutines,
  listProjects,
  listTasks,
  markRoutineRan,
  setSetting,
} from './store'
import { tierQueryOptions } from './agentopts'
import { buildDigest, sendToManager, setStartupBriefing } from './manager'
import { notifyUser } from './notify'
import type { ChatEvent, TestState } from '../shared/types'

let timer: ReturnType<typeof setInterval> | null = null
let running = false
let onUpdated: () => void = () => {}
let emitChat: (ev: ChatEvent) => void = () => {}
let onBriefing: (text: string) => void = () => {}

export function bindScheduler(
  push: () => void,
  chat: (ev: ChatEvent) => void = () => {},
  briefing: (text: string) => void = () => {},
): void {
  onUpdated = push
  emitChat = chat
  onBriefing = briefing
}

// B — Claude 보고 갱신(throttle). 결과는 설정에 저장(다음 시작 시 노출) + 렌더러 push.
let lastBriefAt = 0
const BRIEF_MIN_MS = 5 * 60_000
async function refreshBriefing(includePrior = false): Promise<string | null> {
  const now = Date.now()
  if (now - lastBriefAt < BRIEF_MIN_MS) return null
  lastBriefAt = now
  const text = await generateBriefing({ includePrior })
  if (text) {
    setSetting('dock_briefing', text)
    onBriefing(text)
  }
  return text ?? null
}

/** 시작 시 1회 브리핑 생성 — 프로덕션엔 startup 스캔이 없어(LAIN_SCAN_TEST 게이트) 주기 스캔 전까진
    브리핑이 안 갱신됐다. throttle을 리셋해 매 실행마다 새 브리핑을 만든다(매번 새 비서 컨셉과 일치). */
export async function briefNow(): Promise<void> {
  lastBriefAt = 0
  try {
    // 시작 브리핑만 지난 세션 맥락(재시작 연속성) 포함. 이번 생성 텍스트를 레인 본체에 1회 넘겨, 첫 대화
    // 턴에 '이번 실행 시작 시 이렇게 보고했다'(지난 세션 진행·사용자 지시 포함)를 인지시킨다. 생성 실패(null)면
    // 안 넘긴다(이전 실행의 낡은 브리핑 주입 방지). 주기 refreshBriefing엔 안 넘김 — 연속성은 시작 1회만.
    const b = await refreshBriefing(true)
    if (b) setStartupBriefing(b)
  } catch {
    /* 키 미설정·생성 실패는 generateBriefing이 로그로 남김 — 결정론 요약만 보임 */
  }
}

const DIGEST_HASH_KEY = 'auto_priority_last_digest'
const WAKE_SNAPSHOT_KEY = 'auto_priority_wake_snapshot' // 프로젝트별 '깨울 가치 신호'만 추린 prev 스냅샷(JSON)

// ── 결정론 wake-gate (i4) ──
// autoPriority의 judge(sonnet)는 다이제스트 해시가 변할 때마다 돈다 — dirty 1줄·summary 한 글자·
// 타임스탬프만 바뀌어도 비싼 판정이 켜진다. collectStatus가 status를 매번 덮어쓰므로, '깨울 가치 있는
// 신호'만 추린 작은 스냅샷을 settings에 따로 저장해 prev 역할을 시킨다. 순수 게이트 wakeJudge가 prev→next
// 전이를 보고 '진짜 신호'일 때만 judge를 통과시킨다(없으면 스냅샷만 갱신하고 judge 스킵 → 비용 0).

/** 프로젝트 1건의 '깨울 가치' 신호만 추린 최소 스냅샷. status 전체가 아니라 이 4개만 비교해 churn을 막는다. */
export interface WakeSignal {
  test: TestState // pass | fail | unknown | running
  hasTaskMd: boolean
  dirty: number // dirty_files (장기 방치 임계 비교용)
  pendingApprovals: number // 이 프로젝트에 묶인 pending 승인 수
}
export type WakeSnapshot = Record<string, WakeSignal>

// dirty가 임계 미만 → 임계 이상으로 '교차'할 때만 방치 신호로 본다(매 dirty 변동이 아니라 교차만 깨운다
// — 1줄 dirty로는 안 깨우고, 이미 임계 넘긴 상태에서 더 늘어도 재차 안 깨운다). 보수적 기본값.
const DIRTY_NEGLECT_THRESHOLD = 20

/**
 * 결정론 wake 게이트 — prev→next 전이에서 '사용자를 깨울 가치가 있는' 신호가 하나라도 있으면 true.
 * 순수 함수(LLM 없음, store 접근 없음) — 단위 테스트 대상. 신호 정의:
 *   1) test가 pass/unknown → fail 로 전이 (회귀 발생)
 *   2) hasTaskMd false → true (새 작업 입구 등장)
 *   3) pendingApprovals 증가 (신규 결재 대기)
 *   4) dirty가 임계 미만 → 임계 이상으로 교차 (장기 방치 진입)
 * prev에 없던 프로젝트(신규 등록)는 hasTaskMd/test=fail/pending이 의미 있을 때만 깨운다.
 */
export function wakeJudge(prev: WakeSnapshot, next: WakeSnapshot): boolean {
  for (const [pid, n] of Object.entries(next)) {
    const p = prev[pid]
    if (!p) {
      // 신규 프로젝트: 그 자체로는 안 깨운다(스캔이 막 본 것). 단 이미 fail/TASK.md/결재면 알릴 가치.
      if (n.test === 'fail' || n.hasTaskMd || n.pendingApprovals > 0) return true
      continue
    }
    // 1) 테스트 회귀: 통과/미상 → 실패
    if ((p.test === 'pass' || p.test === 'unknown') && n.test === 'fail') return true
    // 2) 새 TASK.md
    if (!p.hasTaskMd && n.hasTaskMd) return true
    // 3) 신규 결재 대기
    if (n.pendingApprovals > p.pendingApprovals) return true
    // 4) dirty 장기 방치 임계 교차
    if (p.dirty < DIRTY_NEGLECT_THRESHOLD && n.dirty >= DIRTY_NEGLECT_THRESHOLD) return true
  }
  return false // 깨울 신호 없음
}

/** 현재 store 상태에서 wake 스냅샷을 만든다(부수효과 — store 읽기). 프로젝트별 pending 승인은 task→project로 묶는다. */
function collectWakeSnapshot(): WakeSnapshot {
  const taskToProject = new Map(listTasks().map((t) => [t.id, t.projectId]))
  const pendingByProject = new Map<string, number>()
  for (const a of listApprovals()) {
    const pid = taskToProject.get(a.taskId)
    if (pid) pendingByProject.set(pid, (pendingByProject.get(pid) ?? 0) + 1)
  }
  const snap: WakeSnapshot = {}
  for (const p of listProjects().filter((x) => x.enabled)) {
    snap[p.id] = {
      test: p.status?.testState ?? 'unknown',
      hasTaskMd: p.status?.hasTaskMd ?? false,
      dirty: p.status?.dirtyFiles ?? 0,
      pendingApprovals: pendingByProject.get(p.id) ?? 0,
    }
  }
  return snap
}

function readWakeSnapshot(): WakeSnapshot {
  try {
    const raw = getSetting(WAKE_SNAPSHOT_KEY)
    if (!raw) return {}
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? (o as WakeSnapshot) : {}
  } catch {
    return {} // 손상된 스냅샷은 빈 prev로 — 다음 판정이 한 번 깨우고 갱신(보수적, 안전)
  }
}

// glass-box: 게이트 통과/스킵을 결정론 로그에 남긴다(LLM 0). scheduler-stderr.log와 같은 append 패턴.
function logGate(line: string): void {
  try {
    fs.appendFileSync(
      path.join(DATA_DIR, 'scheduler-gate.log'),
      `${new Date().toISOString()} ${line}\n`,
    )
  } catch {
    /* 로그 실패는 무해 */
  }
}

// ── idle 가드 일원화 (i14) ──
// autoPriority(채팅 끼어듦)는 사용자가 방금 대화 중일 땐 미룬다. urgent 알림(notifyUser)은 이 게이트 밖이라
// 영향 없음 — idle 게이트는 '채팅에 끼어드는 것'만 막는다. working 작업이 있으면 idle 아님(작업 중).

/** 순수 idle 판정(테스트 대상) — working 없음 AND 마지막 채팅 활동 후 idleMin분 경과. lastIso=null이면 idle로 본다. */
export function isIdleAt(
  lastActivityIso: string | null,
  hasWorking: boolean,
  nowMs: number,
  idleMin: number,
): boolean {
  if (hasWorking) return false
  if (!lastActivityIso) return true // 채팅 이력 없음 → 끼어들 대화가 없음, idle
  const last = Date.parse(lastActivityIso)
  if (Number.isNaN(last)) return true // 파싱 불가 → 보수적으로 idle 취급(끼어듦 차단 아님)
  return nowMs - last >= Math.max(1, idleMin) * 60_000
}

/** store 상태 기반 idle 판정 — isIdleAt 순수 코어 위 얇은 래퍼. */
function isIdle(idleMin: number): boolean {
  const hasWorking = listTasks().some((t) => t.state === 'working')
  return isIdleAt(lastChatActivityAt(), hasWorking, Date.now(), idleMin)
}

// 다이제스트 변화 시 1회 판단 — 같은 상태에 반복 호출하지 않는다 (해시 가드)
// + 결정론 wake-gate(i4): 다이제스트가 바뀌었어도 '깨울 가치 신호'가 없으면 judge를 아예 건너뛴다.
async function autoPriority(): Promise<void> {
  // 1) 결정론 wake-gate — judge(sonnet) 비용 전에 먼저 통과 여부를 가른다.
  const prevSnap = readWakeSnapshot()
  const nextSnap = collectWakeSnapshot()
  const wake = wakeJudge(prevSnap, nextSnap)
  setSetting(WAKE_SNAPSHOT_KEY, JSON.stringify(nextSnap)) // 항상 prev를 갱신(다음 전이 기준)
  if (!wake) {
    logGate('wake-gate skip — no signal (judge bypassed)')
    return // 신호 없음 → 비싼 judge 스킵, 스냅샷만 갱신
  }
  logGate('wake-gate pass — signal present')
  // 2) 디지스트 해시 가드 — 같은 다이제스트엔 반복 판정하지 않는다(기존 동작 유지).
  const digest = buildDigest(listProjects())
  const hash = crypto.createHash('sha1').update(digest).digest('hex')
  if (getSetting(DIGEST_HASH_KEY) === hash) return
  setSetting(DIGEST_HASH_KEY, hash) // 판단 실패해도 같은 상태로 재호출하지 않음
  // 판정 SDK가 무응답(네트워크 정체 등)이어도 runScanOnce의 running을 영구 점유해 주기 스캔을
  // 죽이지 않도록 60초 abort 타임아웃을 건다. 타임아웃 = 그냥 이번 보고 생략(치명적 아님).
  const ac = new AbortController()
  const killTimer = setTimeout(() => ac.abort(), 60_000)
  try {
    let last = ''
    const stream = query({
      prompt: `너는 lain의 관리자다. 아래는 주기 스캔으로 갱신된 프로젝트 현황 다이제스트다.
사용자가 지금 알아야 할 우선순위 변화(새 TASK.md, 테스트 깨짐, 방치된 dirty, 결재 대기 등)가 있으면 2-3문장으로 짚어라. 특별한 변화가 없으면 보고하지 마라.

<status-digest>
${digest}
</status-digest>

JSON 한 블록만 출력:
\`\`\`json
{"report": true|false, "urgent": true|false, "message": "<report=true일 때 사용자에게 보일 우선순위 보고>"}
\`\`\``,
      options: {
        cwd: AGENT_CWD,
        allowedTools: [],
        maxTurns: 2,
        ...tierQueryOptions(getSettings().judgeModel, getSettings()), // §9b — 짧은 판정류(local 라우팅 포함)
        abortController: ac,
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
        stderr: (d: string) =>
          appendCapped(path.join(DATA_DIR, 'scheduler-stderr.log'), d),
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) last = t
      }
    }
    const m = last.match(/```json\s*([\s\S]*?)```/)
    if (!m) return
    const obj = JSON.parse(m[1])
    if (obj.report && obj.message) {
      const text = `[자동 우선순위] ${obj.message}`
      addMessage('manager', 'assistant', text)
      emitChat({ kind: 'assistant', text })
      if (obj.urgent) notifyUser('lain — 우선순위', String(obj.message).slice(0, 120))
    }
  } catch {
    /* 판단 실패는 치명적이지 않음 — 다음 변화 때 재시도 */
  } finally {
    clearTimeout(killTimer)
  }
}

const CURATOR_HASH_KEY = 'lesson_curator_last_hash'

// §24 Phase3 — idle judge curator: 중복 교훈을 semantic 병합(미사용 폐기는 lifecycle이 결정론으로 처리).
// L0의 두 번째 LLM 예외 — autoPriority와 동일 격리: opt-in·해시가드(변화 없으면 skip)·60s abort·실패 무해.
// 보수적: agent·비핀 후보만, 그룹당 2건 이상, 한 틱 최대 3병합, 전부 soft-archive(하드삭제 없음).
async function consolidateLessons(): Promise<void> {
  if (listTasks().some((t) => t.state === 'working')) return // 작업 중엔 idle 아님 — 미룬다
  const candidates = lessonsForCuration(40)
  if (candidates.length < 4) return // 너무 적으면 병합 의미 없음
  const sig = (ls: typeof candidates) =>
    crypto.createHash('sha1').update(ls.map((l) => `${l.id}:${l.lesson}`).join('|')).digest('hex')
  const hash = sig(candidates)
  if (getSetting(CURATOR_HASH_KEY) === hash) return // 변화 없으면 재판정 안 함
  setSetting(CURATOR_HASH_KEY, hash) // 실패해도 같은 입력 반복 호출 방지
  const ac = new AbortController()
  const killTimer = setTimeout(() => ac.abort(), 60_000)
  try {
    const list = candidates
      .map(
        (l) =>
          `[L${l.id}] (scope:${l.scope}/project:${l.projectId}${l.trigger ? ` · ${l.trigger}` : ''} · use:${l.reuseCount} last:${l.lastUsedAt ? l.lastUsedAt.slice(0, 10) : 'never'}) ${l.lesson}`,
      )
      .join('\n')
    let last = ''
    const stream = query({
      prompt: `너는 lain의 교훈 큐레이터다. 아래는 Navi들이 검증된 작업에서 누적한 교훈 목록이다(use=재사용 횟수, last=마지막 주입일).
**같은 project**의 **같은 작업 클래스**(빌드·테스트·배포·도구 사용 등) 안에서, 한쪽이 다른 쪽의 하위집합이거나 같은 함정을 가리키는 교훈 군만 umbrella 후보다.
규칙:
- 정말 중복·하위집합·같은 함정일 때만 통합한다. 작업 클래스가 다르거나 무관한 교훈은 **절대** 합치지 마라.
- umbrella는 합쳐지는 모든 교훈의 핵심을 잃지 않게 구체적으로 써라. 각 그룹은 2건 이상. 합칠 게 없으면 merges는 빈 배열.
- use=0이거나 last가 오래됨은 **폐기 근거가 아니다**(미사용 폐기는 lifecycle이 결정론으로 담당한다). 효과성 신호는 어느 교훈을 umbrella의 본문 기준으로 삼을지 참고용으로만 써라.

<lessons>
${list}
</lessons>

JSON 한 블록만 출력:
\`\`\`json
{"merges": [{"archive_ids": [번호…], "umbrella": {"project_id": "<합쳐지는 교훈들의 project>", "scope": "project|global", "trigger": "<적용 힌트>", "lesson": "<통합 교훈>"}}]}
\`\`\``,
      options: {
        cwd: AGENT_CWD,
        allowedTools: [],
        maxTurns: 2,
        ...tierQueryOptions(getSettings().judgeModel, getSettings()), // §9b — 짧은 판정류(local 라우팅 포함)
        abortController: ac,
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        stderr: (d: string) => appendCapped(path.join(DATA_DIR, 'scheduler-stderr.log'), d),
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) last = t
      }
    }
    const m = last.match(/```json\s*([\s\S]*?)```/)
    if (!m) return
    const obj = JSON.parse(m[1])
    const merges = Array.isArray(obj.merges) ? obj.merges.slice(0, 3) : [] // 한 틱 최대 3병합
    const candidateIds = new Set(candidates.map((l) => l.id))
    let archivedTotal = 0
    let mergeCount = 0
    for (const mg of merges) {
      const ids: number[] = (Array.isArray(mg?.archive_ids) ? mg.archive_ids : [])
        .map(Number)
        .filter((id: number) => candidateIds.has(id))
      const u = mg?.umbrella
      if (ids.length < 2 || !u || !u.lesson) continue
      const fallbackProject = candidates.find((l) => l.id === ids[0])!.projectId
      const n = applyConsolidation(ids, {
        projectId: String(u.project_id ?? fallbackProject),
        scope: u.scope === 'global' ? 'global' : 'project',
        trigger: String(u.trigger ?? ''),
        lesson: String(u.lesson),
      })
      if (n >= 2) {
        archivedTotal += n
        mergeCount++
      }
    }
    if (mergeCount > 0) {
      const text = `[교훈 정비] ${mergeCount}개 그룹·${archivedTotal}건을 통합했다(§24 curator) — 중복 교훈을 합쳐 다음 작업 주입을 정조준한다.`
      addMessage('manager', 'assistant', text)
      emitChat({ kind: 'assistant', text })
      // 병합으로 후보가 바뀌었으니 새 상태 해시로 갱신 — umbrella를 즉시 재병합하는 churn 방지.
      setSetting(CURATOR_HASH_KEY, sig(lessonsForCuration(40)))
    }
  } catch {
    /* 판단 실패는 치명적 아님 — 다음 변화 때 재시도 */
  } finally {
    clearTimeout(killTimer)
  }
}

/** 전체 enabled 프로젝트 현황 재수집 + 변화 알림. 수동(트레이)·주기 공용. */
export async function runScanOnce(): Promise<void> {
  if (running) return // 겹침 방지 — 이전 스캔이 길어지면 이번 틱은 건너뜀
  running = true
  try {
    const before = new Map(
      listProjects()
        .filter((p) => p.enabled)
        .map((p) => [p.id, p.status?.hasTaskMd ?? false]),
    )
    const targets = listProjects().filter((p) => p.enabled)
    await Promise.all(targets.map((p) => collectStatus(p)))
    for (const p of listProjects().filter((x) => x.enabled)) {
      // muted(숨김) 내비는 선제 알림도 억제 — 수집은 위에서 정상 수행됨.
      if (!before.get(p.id) && p.status?.hasTaskMd && !p.muted) {
        notifyUser('lain — TASK.md 발견', `${p.id}: ▶로 작업을 시작할 수 있다`)
      }
    }
    onUpdated()
    void refreshBriefing() // B — Groq 비서 보고(한가하면 농담). throttle·키 없으면 no-op.
    // 교훈 자동 만료는 폐지(계속 쌓여야 개인화) — 정리는 flag·curator만. (이전: applyLessonLifecycle)
    const s = getSettings()
    // i14 — autoPriority(채팅 끼어듦)는 idle일 때만. urgent 알림은 게이트 밖(notifyUser)이라 영향 없음.
    if (s.autoPriority && isIdle(s.idleMin)) await autoPriority()
    if (s.lessonCurator) await consolidateLessons() // consolidate는 자체 working-skip 보유
    // 학습루프 T6 — 스킬 수명주기(결정론·LLM 없음): 미사용 30일→stale, 90일→archived(삭제 없음, pinned 제외).
    try {
      applySkillLifecycle()
    } catch {
      /* 스킬 정리 실패는 무해 — 다음 스캔에 재시도 */
    }
    // i16 — 선언적 routines 디스패치(opt-in). due 루틴을 markRoutineRan(중복 차단) 후 fire-and-forget.
    if (s.routinesEnabled) dispatchDueRoutines()
  } finally {
    running = false
  }
}

// i16 — listDueRoutines로 만기 루틴을 읽어 Lain에게 prompt를 보낸다(결정론 디스패치, 판단은 manager).
// 작업 중(working)이면 미룬다(consolidate 패턴). markRoutineRan은 디스패치 '직전'에 호출해 중복 실행 차단.
function dispatchDueRoutines(): void {
  if (listTasks().some((t) => t.state === 'working')) return // 작업 중엔 끼어들지 않음
  for (const r of listDueRoutines()) {
    markRoutineRan(r.id) // next_run_at 재계산·중복 방지 (디스패치 직전)
    logGate(`routine dispatch — ${r.id} "${r.title}" (${r.cron})`)
    void sendToManager(r.prompt, emitChat).catch(() => {
      /* 루틴 실행 실패는 무해 — 다음 만기 때 재시도 */
    })
  }
}

/** settings.scanIntervalMin 기준으로 타이머 재장전 (0 = 끔). 설정 변경 시마다 호출. */
export function rearmScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  const min = getSettings().scanIntervalMin
  if (min > 0) timer = setInterval(() => void runScanOnce(), min * 60_000)
}
