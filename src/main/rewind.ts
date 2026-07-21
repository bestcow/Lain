// D15 되감기 — 레인 '직접 편집'(additionalDirectories로 실레포 수정)의 턴 단위 체크포인트·복원.
// Navi 작업은 worktree 격리+폐기로 이미 안전하다 — 이건 격리 없는 레인 편집 전용 안전장치.
// 전부 결정론(L0): canUseTool의 Edit/Write allow 직전에 원본을 스냅샷(파일) + 메타(DB)로 남기고,
// 사용자가 편집 diff 카드에서 '이 턴 편집 되돌리기'를 누르면 파일별 최초(pre-turn) 스냅샷으로 복원한다.
// 복원 직전 상태도 새 그룹(r<ts>)으로 체크포인트를 떠 '되돌리기의 되돌리기'가 가능하다.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import { blocksSecretFile } from './safety'
import { appendCapped } from './logfile'
import {
  insertEditCheckpoint,
  editCheckpointsForTurn,
  listEditCheckpointTurns,
  deleteEditCheckpointTurn,
  type EditCheckpointRow,
} from './store'

const CHECKPOINT_DIR = path.join(DATA_DIR, 'checkpoints')
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 // 이보다 큰 파일은 스냅샷 생략(카드에 체크포인트 없음이 아니라 그냥 미보호 — 플레이버 아닌 안전장치지만 DB/디스크 비대화 방지 우선)
const RETAIN_DAYS = 14
const RETAIN_TOTAL_BYTES = 200 * 1024 * 1024

let seq = 0 // 백업 파일명 충돌 방지용 프로세스 내 시퀀스(같은 ms에 연속 편집 대비)

// 체크포인트 생성이 실패한 턴(디스크·권한 등). 실패는 편집을 막지 않으므로 그대로 삼키되, 되돌리기
// 시점에 '보존 기간 만료' 추정으로 오도하지 않도록 흔적만 남긴다. 프로세스 내 한정(재시작하면 사라짐 —
// 그 뒤엔 원래의 만료 추정 문구가 맞다). 상한을 둬 무한 성장하지 않게 한다.
const failedTurns = new Set<string>()
const MAX_FAILED_TURNS = 200
let lastFailLogAt = 0
const FAIL_LOG_COOLDOWN_MS = 60_000 // 디스크 풀 등으로 매 편집이 실패해도 로그가 폭주하지 않게

function markCheckpointFailure(turnId: string, toolName: string, e: unknown): void {
  if (failedTurns.size >= MAX_FAILED_TURNS) {
    const oldest = failedTurns.values().next().value // 삽입 순 — 가장 오래된 것부터 버린다
    if (oldest !== undefined) failedTurns.delete(oldest)
  }
  failedTurns.add(turnId)
  const now = Date.now()
  if (now - lastFailLogAt < FAIL_LOG_COOLDOWN_MS) return
  lastFailLogAt = now
  // 파일 경로는 남기지 않는다(§9-6) — 도구명과 에러 메시지만.
  rlog(`checkpoint 실패: ${toolName} ${(e as Error)?.message ?? e}`)
}

function rlog(m: string): void {
  appendCapped(path.join(DATA_DIR, 'recovery.log'), `${new Date().toISOString()} rewind ${m}\n`)
}

function turnDir(turnId: string): string {
  return path.join(CHECKPOINT_DIR, turnId.replace(/[^\w-]/g, '_'))
}

/** 편집 실행 '전' 원본 스냅샷 — canUseTool의 allow 경로에서 호출(best-effort, 실패해도 편집은 진행).
 *  시크릿 파일은 canUseTool이 이미 deny하지만 이중 방어로 여기서도 거른다(§9-6 — 스냅샷 자체가 유출면). */
export function checkpointEdit(
  turnId: string,
  conversationId: string,
  toolName: string,
  input: unknown,
): void {
  try {
    if (toolName !== 'Edit' && toolName !== 'Write') return
    if (blocksSecretFile(toolName, input)) return
    const filePath = String((input as { file_path?: unknown })?.file_path ?? '')
    if (!filePath || !path.isAbsolute(filePath)) return
    let backupPath: string | null = null
    if (fs.existsSync(filePath)) {
      const st = fs.statSync(filePath)
      if (!st.isFile() || st.size > MAX_BACKUP_BYTES) return // 비파일·대용량 — 미보호로 생략
      const dir = turnDir(turnId)
      fs.mkdirSync(dir, { recursive: true })
      backupPath = path.join(dir, `${String(++seq).padStart(4, '0')}.bak`)
      fs.copyFileSync(filePath, backupPath)
    }
    insertEditCheckpoint({ turnId, conversationId, filePath, backupPath, tool: toolName })
  } catch (e) {
    /* 체크포인트 실패가 편집을 막지 않는다 — 흐름은 그대로, 실패 흔적만 남긴다 */
    markCheckpointFailure(turnId, toolName, e)
  }
}

/** 복원 확인창용 요약 — 파일별 최초 체크포인트 기준(existed=false면 복원 시 파일 삭제됨). */
export function turnEditSummary(turnId: string): { filePath: string; existed: boolean }[] {
  const first = firstPerFile(editCheckpointsForTurn(turnId))
  return [...first.values()].map((r) => ({ filePath: r.filePath, existed: r.backupPath != null }))
}

function firstPerFile(rows: EditCheckpointRow[]): Map<string, EditCheckpointRow> {
  const first = new Map<string, EditCheckpointRow>()
  for (const r of rows) if (!first.has(r.filePath)) first.set(r.filePath, r)
  return first
}

/** 턴의 편집을 전부 편집 전 상태로 복원. 복원 직전 상태를 새 그룹(r<ts>)으로 먼저 체크포인트 —
 *  반환된 revertTurnId로 다시 revertTurn하면 '되돌리기 취소'가 된다.
 *  재리뷰 #4 — files(대상 파일 목록)·conversationId를 함께 반환: ipc가 revertTurnId를 실은 카드를
 *  채팅에 남겨 un-revert 진입점을 노출한다(반환만 하고 버리면 약속된 '복원의 복원'이 UI에 없다). */
export function revertTurn(turnId: string): {
  ok: boolean
  restored: number
  revertTurnId?: string
  files: string[]
  conversationId: string
  error?: string
} {
  const rows = editCheckpointsForTurn(turnId)
  if (rows.length === 0)
    return {
      ok: false,
      restored: 0,
      files: [],
      conversationId: '',
      // 이 프로세스에서 체크포인트 생성이 실패한 턴이면 '만료' 추정 대신 실제 원인을 말한다.
      error: failedTurns.has(turnId)
        ? '이 턴은 체크포인트 생성이 실패해 복원할 백업이 없다(디스크 여유·권한 확인)'
        : '이 턴의 체크포인트가 없다(보존 기간 만료·정리됐을 수 있음)',
    }
  // 일부만 실패한 턴은 남은 행만 복원되고 나머지는 조용히 누락된다 — 최소한 진단에는 남긴다.
  if (failedTurns.has(turnId)) rlog('revertTurn: 체크포인트 일부 실패한 턴 — 누락 파일 있을 수 있음')
  const first = firstPerFile(rows)
  const conversationId = rows[0].conversationId
  const files = [...first.keys()]
  // 복원 직전 상태 스냅샷(un-revert). 시퀀스가 겹치지 않게 별도 turnId.
  const revertTurnId = `r${Date.now()}`
  for (const fp of files) checkpointEdit(revertTurnId, conversationId, 'Write', { file_path: fp })
  let restored = 0
  const errors: string[] = []
  for (const [fp, r] of first) {
    try {
      if (r.backupPath) {
        if (!fs.existsSync(r.backupPath)) {
          errors.push(`${fp}: 백업 스냅샷 유실`)
          continue
        }
        fs.mkdirSync(path.dirname(fp), { recursive: true })
        fs.copyFileSync(r.backupPath, fp)
      } else {
        // 편집 전엔 없던 파일(Write 신규 생성) — 복원 = 삭제
        fs.rmSync(fp, { force: true })
      }
      restored++
    } catch (e) {
      errors.push(`${fp}: ${(e as Error).message}`)
    }
  }
  if (errors.length)
    return { ok: restored > 0, restored, revertTurnId, files, conversationId, error: errors.join(' · ') }
  return { ok: true, restored, revertTurnId, files, conversationId }
}

function dirBytes(dir: string): number {
  let total = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isFile()) total += fs.statSync(p).size
    }
  } catch {
    /* 없거나 못 읽음 = 0 */
  }
  return total
}

/** 보존 정리(부팅 시) — 14일 경과 또는 누적 200MB 초과분을 오래된 턴부터 삭제. DB에 없는 고아
 *  디렉터리도 제거. now 주입은 테스트용(기본 현재). 결정론·best-effort. */
export function cleanupCheckpoints(now = Date.now()): void {
  try {
    const turns = listEditCheckpointTurns() // 최신순
    const keep = new Set<string>()
    let cum = 0
    for (const t of turns) {
      const dir = turnDir(t.turnId)
      // created_at은 store nowStamp와 동일한 UTC 'YYYY-MM-DD HH:MM:SS'
      const ageMs = now - Date.parse(t.lastAt.replace(' ', 'T') + 'Z')
      cum += dirBytes(dir)
      if (ageMs > RETAIN_DAYS * 86_400_000 || cum > RETAIN_TOTAL_BYTES) {
        deleteEditCheckpointTurn(t.turnId)
        fs.rmSync(dir, { recursive: true, force: true })
      } else {
        keep.add(path.basename(dir))
      }
    }
    // 고아 디렉터리(DB 행 없음 — 크래시 잔재) 정리
    if (fs.existsSync(CHECKPOINT_DIR)) {
      for (const e of fs.readdirSync(CHECKPOINT_DIR, { withFileTypes: true })) {
        if (e.isDirectory() && !keep.has(e.name))
          fs.rmSync(path.join(CHECKPOINT_DIR, e.name), { recursive: true, force: true })
      }
    }
  } catch {
    /* 정리 실패는 무해 — 다음 부팅에 재시도 */
  }
}
