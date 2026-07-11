// D6 — 장기 작업 체크포인트(중간보고) 순수 로직.
// Navi 작업은 종료 시 report.summary만 다이제스트에 닿는다. 진행 중 상태를 인터럽트 없이 파악하려면
// N턴/M분마다 결정론 스냅샷(경과 턴·커밋 수·diffStat)을 남긴다. 트리거 판정·콘텐츠 포맷은 부작용 없는
// 순수 함수라 여기서 분리해 단위 테스트한다(git 실행·DB 기록은 worker.ts가 담당).

// 기본 임계 — 설정 없이 상수. 근거: Navi maxTurns=60(worker.ts)이라 10턴이면 세션당 ~6회로 과하지 않고,
// 5분은 사람이 "멈춘 것 같다"고 느끼기 시작하는 대략적 하한이라 조기 이상감지(턴만 늘고 diff 0)에 충분.
// 둘 중 먼저 닿는 쪽이 트리거(OR) — 도구 왕복이 잦으면 턴이, 오래 걸리는 단일 도구면 시간이 먼저 온다.
export const CHECKPOINT_EVERY_TURNS = 10
export const CHECKPOINT_EVERY_MS = 5 * 60 * 1000

export interface CheckpointOpts {
  turnsSoFar: number // 세션 중 근사 경과 턴(assistant 메시지 계수)
  lastCheckpointTurn: number // 마지막 체크포인트를 남긴 시점의 turnsSoFar(초기 0)
  elapsedMs: number // 마지막 체크포인트 이후 벽시계 경과(ms)
  everyTurns?: number // 기본 CHECKPOINT_EVERY_TURNS
  everyMs?: number // 기본 CHECKPOINT_EVERY_MS
}

/**
 * 이번 턴에 체크포인트를 남길지 결정(순수). N턴 경계 또는 M분 경과 중 하나라도 충족하면 true.
 * 같은 turnsSoFar에서 두 번 트리거되지 않도록 lastCheckpointTurn과 같으면 무조건 false(중복 방지) —
 * worker 루프가 assistant 메시지마다 호출해도 한 턴에 한 번만 찍힌다.
 */
export function shouldCheckpoint(opts: CheckpointOpts): boolean {
  const everyTurns = opts.everyTurns ?? CHECKPOINT_EVERY_TURNS
  const everyMs = opts.everyMs ?? CHECKPOINT_EVERY_MS
  // 같은 턴 중복 방지 — 이미 이 턴에서 남겼으면(또는 아직 한 턴도 안 지났으면) 스킵.
  if (opts.turnsSoFar <= opts.lastCheckpointTurn) return false
  const turnsSince = opts.turnsSoFar - opts.lastCheckpointTurn
  const turnTrigger = everyTurns > 0 && turnsSince >= everyTurns
  const timeTrigger = everyMs > 0 && opts.elapsedMs >= everyMs
  return turnTrigger || timeTrigger
}

/**
 * 체크포인트 한 줄 콘텐츠(순수). 다이제스트·드로어에 동일 포맷으로 노출된다.
 * 예: "진행중: 12턴 · 커밋 3 · +240/-31". diffStat이 비면 "diff 없음"으로 명시(턴만 늘고 변경 0 = 이상징후 신호).
 */
export function formatCheckpoint(turns: number, commits: number, diffStat: string): string {
  return `진행중: ${turns}턴 · 커밋 ${commits} · ${summarizeDiffStat(diffStat)}`
}

/**
 * `git diff --stat`의 말미 요약(" N files changed, X insertions(+), Y deletions(-)")에서 +X/-Y만 뽑는다.
 * 요약을 못 찾으면(빈 diff 등) "diff 없음". 렌더에 여러 줄 stat 전체를 싣지 않으려는 압축(한 줄 유지).
 */
export function summarizeDiffStat(diffStat: string): string {
  if (!diffStat || !diffStat.trim()) return 'diff 없음'
  const ins = /(\d+) insertion/.exec(diffStat)
  const del = /(\d+) deletion/.exec(diffStat)
  const added = ins ? Number(ins[1]) : 0
  const removed = del ? Number(del[1]) : 0
  if (!ins && !del) {
    // --stat 요약 줄이 없다 — 파일 목록만 있거나 log --oneline 폴백. 변경 유무만이라도 알린다.
    return 'diff 없음'
  }
  return `+${added}/-${removed}`
}
