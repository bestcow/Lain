// E8 확장 — 자동 백업 루틴. 하루 1회(로컬 날짜 기준) lain.sqlite를 DATA_DIR\backups\ 에 복사하고
// 보존 개수 초과분을 오래된 것부터 삭제한다. L0 결정론(§4) — LLM 없음. 마지막 백업 '날짜'를 settings에
// 기록해 비교하므로 앱이 24시간 켜져 있지 않아도 부팅·첫 틱에서 밀린 백업이 자동으로 돈다.
// 판정(due)·정리 대상 계산은 순수 함수 — vitest 대상(파일시스템 접근은 runAutoBackupIfDue에만).
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import { appendCapped } from './logfile'
import { backupDatabase, getSetting, getSettings, setSetting } from './store'
import { notifyUser } from './notify'

const LAST_DATE_KEY = 'auto_backup_last_date' // YYYY-MM-DD (로컬)
// 상태 세팅 — 백업이 조용히 실패하면 backup.log를 열어보지 않는 한 알 수 없었다. 성공/실패를 settings에
// 남겨 다른 표면(설정 화면·진단)이 읽을 수 있게 한다. 값은 JSON 1줄(경로·시크릿 없음 — 파일명·크기·사유만).
const LAST_OK_KEY = 'auto_backup_last_ok' // {"at":ISO,"bytes":n}
const LAST_ERROR_KEY = 'auto_backup_last_error' // {"at":ISO,"error":"...","streak":n}
const NOTIFY_STREAK = 3 // 연속 3회 실패 = 재시도로 안 풀리는 상태 → 사람이 봐야 한다(딱 1회만 통지)
// 수동 내보내기(data:backup)와 동일 네이밍 — lain-backup-YYYYMMDDHHMMSS.sqlite. 이 패턴만 정리 대상
// (backups 폴더에 사용자가 둔 다른 파일은 절대 건드리지 않는다).
const BACKUP_NAME_RE = /^lain-backup-\d{14}\.sqlite$/

/** 로컬 날짜 키(YYYY-MM-DD) — UTC가 아니라 사용자 로컬 자정 기준으로 '하루 1회'를 판정한다. */
export function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 오늘 백업이 이미 돌았는지 — 마지막 백업 날짜와 오늘(로컬)이 다르면 due. null(기록 없음)이면 항상 due. */
export function isBackupDue(lastDate: string | null, now: Date): boolean {
  return lastDate !== localDateKey(now)
}

/** 백업 파일명 — 수동 내보내기와 동일 포맷(UTC ISO → YYYYMMDDHHMMSS). 타임스탬프가 이름에 박혀 사전순=시간순. */
export function backupFileName(d: Date): string {
  return `lain-backup-${d.toISOString().slice(0, 19).replace(/[:T-]/g, '')}.sqlite`
}

/**
 * 보존 정리 — 파일명 목록에서 삭제 대상(오래된 것부터, keep 초과분)을 돌려주는 순수 함수.
 * 자동 백업 네이밍만 대상으로 정렬(사전순=시간순)해 최신 keep개를 남긴다. keep<1은 1로 클램프
 * (설정 오염으로도 전량 삭제는 불가 — 항상 최소 1개 보존).
 */
export function pruneTargets(files: string[], keep: number): string[] {
  const k = Math.max(1, Math.floor(keep) || 1)
  const backups = files.filter((f) => BACKUP_NAME_RE.test(f)).sort()
  return backups.slice(0, Math.max(0, backups.length - k))
}

/** 실패 기록 — 사유와 연속 실패 횟수를 settings에 남기고, 딱 NOTIFY_STREAK번째에만 1회 통지한다.
 *  (그 이하 실패는 다음 틱 재시도로 대개 복구되므로 상태 필드로만 남긴다 — 통지 소음 방지.) */
function recordFailure(reason: string): void {
  let streak = 0
  try {
    const prev = JSON.parse(getSetting(LAST_ERROR_KEY) ?? '{}')
    streak = Number(prev?.streak) || 0
  } catch {
    /* 값이 깨졌으면 0부터 — 상태 기록 실패가 백업 흐름을 깨지 않는다 */
  }
  streak += 1
  try {
    setSetting(
      LAST_ERROR_KEY,
      JSON.stringify({ at: new Date().toISOString(), error: reason, streak }),
    )
  } catch {
    /* 설정 기록 실패는 무시 — 로그는 이미 남았다 */
  }
  if (streak === NOTIFY_STREAK) {
    try {
      notifyUser('lain — 자동 백업 실패', `${NOTIFY_STREAK}회 연속 실패했다: ${reason}`)
    } catch {
      /* 통지 실패는 무시 — 상태는 이미 기록됐다 */
    }
  }
}

/** 성공 기록 — 마지막 성공 시각·바이트를 남기고 실패 연속 카운터를 리셋한다. */
function recordSuccess(bytes: number): void {
  try {
    setSetting(LAST_OK_KEY, JSON.stringify({ at: new Date().toISOString(), bytes }))
    if (getSetting(LAST_ERROR_KEY)) setSetting(LAST_ERROR_KEY, '')
  } catch {
    /* 설정 기록 실패는 무시 — 백업 자체는 이미 성공 */
  }
}

function log(m: string): void {
  // 시크릿 없음 — 파일명·크기·에러 메시지만 남긴다(§9-6). 회전 로그(appendCapped)로 무한 성장 차단.
  appendCapped(path.join(DATA_DIR, 'backup.log'), `${new Date().toISOString()} ${m}\n`)
}

/**
 * 부팅·주기 스캔 틱에서 호출 — 설정 off거나 오늘 이미 완료면 no-op. 성공 시에만 날짜를 기록해
 * 실패한 날은 다음 틱에 자동 재시도한다. 모든 실패는 로그만 남기고 호출자를 깨지 않는다.
 */
export function runAutoBackupIfDue(now = new Date()): void {
  try {
    const s = getSettings()
    if (!s.autoBackupEnabled) return
    if (!isBackupDue(getSetting(LAST_DATE_KEY), now)) return
    const dir = path.join(DATA_DIR, 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, backupFileName(now))
    const r = backupDatabase(dest)
    if (!r.ok) {
      log(`자동 백업 실패: ${r.error ?? '알 수 없음'} — 다음 틱에 재시도`)
      recordFailure(r.error ?? '알 수 없음')
      return
    }
    setSetting(LAST_DATE_KEY, localDateKey(now))
    recordSuccess(r.bytes ?? 0)
    log(
      `자동 백업 완료 — ${path.basename(dest)} (${Math.round((r.bytes ?? 0) / 1024)}KB)` +
        (r.busy ? ' · WAL 병합 미완(리더 경합) — 일부 최신 변경 누락 가능' : ''),
    )
    // 보존 개수 초과분 정리 — 오래된 것부터. 개별 삭제 실패는 무해(다음 백업 때 재시도).
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return // 방금 만든 폴더를 못 읽는 예외 상황 — 정리만 생략
    }
    for (const name of pruneTargets(names, s.autoBackupKeep)) {
      try {
        fs.unlinkSync(path.join(dir, name))
        log(`오래된 자동 백업 삭제 — ${name} (보존 ${s.autoBackupKeep}개)`)
      } catch (e) {
        log(`자동 백업 삭제 실패 — ${name}: ${(e as Error).message}`)
      }
    }
  } catch (e) {
    log(`자동 백업 오류: ${(e as Error).message}`)
    recordFailure((e as Error).message)
  }
}
