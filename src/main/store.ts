// 상태 저장소 (PLAN.md §6) — SQLite, Main 프로세스 단독 접근
// better-sqlite3 대신 node:sqlite 사용: Electron 42(Node 24) 내장이라 네이티브 리빌드 불필요
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { DATA_DIR } from './paths'
import { appendCapped } from './logfile'
import {
  journalMessage,
  journalConversation,
  journalSetting,
  journalDelete,
  readJournalEntries,
  type JournalMsg,
  type JournalConv,
  type JournalSetting,
  type JournalDelete,
} from './journal'
import type {
  Approval,
  ChatMessage,
  Conversation,
  ConversationPreview,
  FileAttachment,
  LainSettings,
  ModelTier,
  Project,
  ProjectStatus,
  ProjectView,
  BenchTaskResult,
  Lesson,
  Routine,
  McpServer,
  McpServerInput,
  Task,
  TaskEvent,
  TaskState,
  NaviMode,
  TaskPermissionMode,
  ThinkingLevel,
} from '../shared/types'
// 출력측 비밀 redaction + 교훈 인젝션 스캔 — 구현은 safety 소유자, store는 chokepoint에서 import-only.
import { redactSecrets, scanLessonInjection } from './safety'
// curatedPlugins 기본값(CC-FEATURES P1) — skills는 store를 import하지 않아 단방향(순환 없음).
import { CURATED_PLUGIN_NAMES } from './skills'

let db: DatabaseSync

export function initStore(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  // 손상 복구는 rw 오픈 *전에* — read-only 프로브로 손상 감지 후 손상 WAL을 폐기한다(메인 DB로 복원).
  // ⚠️ rw 연결을 close하면 SQLite가 손상 WAL을 메인에 체크포인트해 메인까지 오염시키므로 절대 금지.
  // read-only 연결은 메인에 못 쓰므로 close해도 체크포인트가 없다 → 안전하게 손상 감지 가능.
  recoverCorruptWalBeforeOpen()
  db = new DatabaseSync(path.join(DATA_DIR, 'lain.sqlite'))
  db.exec('PRAGMA journal_mode = WAL;')
  repairIndexesIfCorrupt() // WAL 폐기 후에도 남는 메인 인덱스 손상(autoindex 엔트리 불일치 등)을 REINDEX로 치유
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      path       TEXT NOT NULL,
      name       TEXT NOT NULL,
      stack      TEXT,
      verify_cmd TEXT,
      is_git     INTEGER NOT NULL DEFAULT 0,
      enabled    INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS project_status (
      project_id       TEXT PRIMARY KEY REFERENCES projects(id),
      git_branch       TEXT,
      ahead            INTEGER NOT NULL DEFAULT 0,
      behind           INTEGER NOT NULL DEFAULT 0,
      dirty_files      INTEGER NOT NULL DEFAULT 0,
      last_commit      TEXT,
      last_commit_at   TEXT,
      test_state       TEXT NOT NULL DEFAULT 'unknown',
      test_output_tail TEXT,
      todo_count       INTEGER NOT NULL DEFAULT 0,
      summary          TEXT,
      updated_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scope      TEXT NOT NULL,
      project_id TEXT,
      task_id    TEXT,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id             TEXT PRIMARY KEY,
      target         TEXT NOT NULL,           -- 'manager' | projectId
      sdk_session_id TEXT,                     -- SDK가 부여한 세션 id (첫 응답 후 저장, resume용)
      title          TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id),
      title             TEXT NOT NULL,
      state             TEXT NOT NULL,
      content           TEXT NOT NULL,
      questions         TEXT NOT NULL DEFAULT '[]',
      branch            TEXT,
      worktree_path     TEXT,
      worker_session_id TEXT,
      summary           TEXT,
      diff_stat         TEXT,
      verify_result     TEXT,
      cost_usd          REAL NOT NULL DEFAULT 0,
      turns             INTEGER NOT NULL DEFAULT 0,
      error             TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      state      TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cc_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      session_id TEXT,
      event      TEXT NOT NULL,            -- 클로드코드 훅 이벤트(SessionStart | SessionEnd)
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      task_id     TEXT NOT NULL,
      scope       TEXT NOT NULL DEFAULT 'project',
      trigger     TEXT NOT NULL DEFAULT '',
      lesson      TEXT NOT NULL,
      reuse_count INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS bench_runs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            TEXT NOT NULL,
      bench_task        TEXT NOT NULL,
      condition         TEXT NOT NULL,
      success           INTEGER NOT NULL DEFAULT 0,
      verify_first_pass INTEGER NOT NULL DEFAULT 0,
      turns             INTEGER NOT NULL DEFAULT 0,
      cost_usd          REAL NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS routines (
      id           TEXT PRIMARY KEY,
      project_id   TEXT,                                  -- nullable. 특정 프로젝트 스코프(NULL=전역/Lain 차원 루틴)
      title        TEXT NOT NULL,
      prompt       TEXT NOT NULL,                         -- Lain에게 보낼 지시 본문
      cron         TEXT NOT NULL,                         -- 결정론 스케줄 표현(computeNextRun 4종)
      enabled      INTEGER NOT NULL DEFAULT 1,
      next_run_at  TEXT,                                  -- ISO. NULL이면 미스케줄(생성 직후 computeNextRun으로 채움)
      last_run_at  TEXT,                                  -- 마지막 실행 ISO, nullable
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,                          -- mcpServers 레코드 키 + 도구 접두사. 'lain' 예약
      transport   TEXT NOT NULL,                          -- 'stdio' | 'sse' | 'http'
      command     TEXT,                                   -- stdio
      args        TEXT NOT NULL DEFAULT '[]',             -- JSON 배열
      env         TEXT NOT NULL DEFAULT '{}',             -- JSON 객체 (시크릿 §9-6 — 로그/다이제스트 금지)
      url         TEXT,                                   -- sse/http
      headers     TEXT NOT NULL DEFAULT '{}',             -- JSON 객체 (시크릿 §9-6)
      targets     TEXT NOT NULL DEFAULT 'manager,navi',   -- CSV 레벨 할당(cascade)
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  // 마이그레이션: 기존 DB에 컬럼 추가 (없으면)
  try {
    db.exec('ALTER TABLE project_status ADD COLUMN has_task_md INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec('ALTER TABLE approvals ADD COLUMN answer TEXT')
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'interactive'")
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'acceptEdits'")
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'default'")
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN disallowed_tools TEXT NOT NULL DEFAULT '[]'")
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec('ALTER TABLE tasks ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec('ALTER TABLE bench_runs ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* 이미 있음 */
  }
  // §24 Phase1 — 교훈 수명주기 + telemetry + 출처. curator(Phase3)·provenance 게이트의 공통 토대.
  for (const col of [
    "ALTER TABLE lessons ADD COLUMN status TEXT NOT NULL DEFAULT 'active'", // active|stale|archived
    'ALTER TABLE lessons ADD COLUMN last_used_at TEXT', // 마지막 주입 시각(recency 신호, nullable)
    'ALTER TABLE lessons ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0', // 불가침(수명주기 전이·폐기 제외)
    "ALTER TABLE lessons ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'", // agent|user (provenance 게이트)
    // §자기개선 — consolidation 계보 추적: 흡수된 교훈이 가리키는 umbrella id(revert 역참조 키, nullable).
    'ALTER TABLE lessons ADD COLUMN absorbed_into INTEGER',
    // 한 consolidate 호출에 archived+umbrella를 묶는 batch id(crypto.randomUUID()). NULL=curation 산물 아님.
    'ALTER TABLE lessons ADD COLUMN consolidation_batch TEXT',
    // Navi 스폰 시 실제 프롬프트에 주입된 횟수. reuse_count(=선택 bump)와 의미 분리 — inject_count는 실주입 신호.
    'ALTER TABLE lessons ADD COLUMN inject_count INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      db.exec(col)
    } catch {
      /* 이미 있음 */
    }
  }
  try {
    db.exec('ALTER TABLE messages ADD COLUMN conversation_id TEXT')
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec('ALTER TABLE messages ADD COLUMN chapter TEXT') // 우클릭 '챕터로 고정' 제목
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT') // user 첨부(JSON) 인라인 로그
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec('ALTER TABLE messages ADD COLUMN origin TEXT') // 폰發 출처('telegram'); null/'pc'는 PC 발신
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec('ALTER TABLE messages ADD COLUMN uid TEXT') // 저널 재조정용 안정 식별자(legacy 행은 null)
  } catch {
    /* 이미 있음 */
  }
  try {
    // uid 유니크 인덱스(부분) — reconcile 멱등 보장(중복 삽입 차단). legacy null uid는 인덱스에서 제외.
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_uid ON messages(uid) WHERE uid IS NOT NULL')
  } catch {
    /* 무시 */
  }
  try {
    // 작업 드로어 대화 트랜스크립트 — 이벤트 화자 귀속('worker'|'lain'|'user'). legacy 행은 null(시스템 로그로 표시).
    db.exec('ALTER TABLE task_events ADD COLUMN speaker TEXT')
  } catch {
    /* 이미 있음 */
  }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN last_mobile_at TEXT') // 마지막 텔레그램 메시지 시각(📱 표시용, Lain 기여)
  } catch {
    /* 이미 있음 */
  }
  try {
    // 대화 제목 자동요약 1회 가드 — 1이면 이미 요약됨(또는 수동 rename) → 자동요약 스킵
    db.exec('ALTER TABLE conversations ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* 이미 있음 */
  }
  try {
    // 무한세션 — 마지막 result의 컨텍스트 점유 토큰(임계 도달 시 압축 트리거). 기존 행은 0.
    db.exec('ALTER TABLE conversations ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* 이미 있음 */
  }
  try {
    // 무한세션 — 압축된 구조화 월드모델(4필드 md). 세션 리셋 후 재주입해 맥락 유지.
    db.exec('ALTER TABLE conversations ADD COLUMN world_state TEXT')
  } catch {
    /* 이미 있음 */
  }
  try {
    // Navi 유한세션 핸드오프 — Navi가 직접 쓴 핸드오프 md(세션 교체 후 새 세션에 재주입). Lain의 world_state(무한세션)와 별개.
    db.exec('ALTER TABLE conversations ADD COLUMN handoff_md TEXT')
  } catch {
    /* 이미 있음 */
  }
  try {
    // 단일 세션 Lain — 화면에 보일 최소 메시지 id(워터마크). 압축 시 전진해 최근 N개만 표시(DB·저널은 보존, 비파괴).
    db.exec('ALTER TABLE conversations ADD COLUMN visible_from_id INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* 이미 있음 */
  }
  try {
    // Navi 유한세션 핸드오프(A 자율작업) — 작업당 컨텍스트 점유. resume 경계에서 임계 도달 시 교체 트리거.
    db.exec('ALTER TABLE tasks ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* 이미 있음 */
  }
  try {
    // Navi 유한세션 핸드오프(A 자율작업) — Navi가 직접 쓴 작업 핸드오프 md(세션 교체 후 재주입).
    db.exec('ALTER TABLE tasks ADD COLUMN handoff_md TEXT')
  } catch {
    /* 이미 있음 */
  }
  try {
    // Lain 스킬 할당 — 이 작업 Navi에 노출할 스킬(JSON 배열 문자열 or NULL=기본 전체).
    db.exec('ALTER TABLE tasks ADD COLUMN skills TEXT')
  } catch {
    /* 이미 존재 */
  }
  try {
    // B17 이미지 입력 — 작업 입력 이미지(FileAttachment[] JSON, image만). NULL=없음.
    db.exec('ALTER TABLE tasks ADD COLUMN images TEXT')
  } catch {
    /* 이미 존재 */
  }
  try {
    // B4 fast-mode — Opus 빠른 출력 모드(작업별 boolean, 0/1). 기본 0=off.
    db.exec('ALTER TABLE tasks ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* 이미 존재 */
  }
  try {
    // 내비 '제거'는 하드 삭제가 아니라 보드에서 숨김(데이터 보존) — id가 폴더 경로 결정론이라
    // 같은 폴더를 다시 추가하면 대화·교훈·작업·현황이 그대로 복원된다. 스캔이 되살리지 않게 플래그로 둔다.
    db.exec('ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* 이미 있음 */
  }
  // 다중 세션 마이그레이션(1회) — 기존 대화(레거시 1세션)를 conversations 행으로 옮기고 메시지를 백필한다.
  // try/catch: DB가 비정상이어도 부팅(projects/tasks 로드)을 절대 깨지 않는다.
  try {
   if (getSetting('conv_migrated') !== '1') {
    const mkConv = (target: string, sdkSession: string | null): string => {
      const id = crypto.randomUUID()
      db.prepare(
        "INSERT INTO conversations (id, target, sdk_session_id, title) VALUES (?, ?, ?, '기존 대화')",
      ).run(id, target, sdkSession)
      return id
    }
    const hasMgr = db.prepare("SELECT 1 FROM messages WHERE scope = 'manager' LIMIT 1").get()
    const mgrSess = getSetting('manager_session_id')
    if (hasMgr || mgrSess) {
      const cid = mkConv('manager', mgrSess || null)
      db.prepare(
        "UPDATE messages SET conversation_id = ? WHERE scope = 'manager' AND conversation_id IS NULL",
      ).run(cid)
      setSetting('active_conv:manager', cid)
    }
    const pids = new Set<string>()
    for (const r of db
      .prepare("SELECT DISTINCT project_id FROM messages WHERE scope = 'worker' AND project_id IS NOT NULL")
      .all() as any[])
      pids.add(r.project_id)
    for (const r of db.prepare("SELECT key FROM settings WHERE key LIKE 'worker_chat_session:%'").all() as any[]) {
      const pid = String(r.key).slice('worker_chat_session:'.length)
      if (pid) pids.add(pid)
    }
    for (const pid of pids) {
      const sess = getSetting(`worker_chat_session:${pid}`)
      const cid = mkConv(pid, sess || null)
      db.prepare(
        "UPDATE messages SET conversation_id = ? WHERE scope = 'worker' AND project_id = ? AND conversation_id IS NULL",
      ).run(cid, pid)
      setSetting(`active_conv:${pid}`, cid)
    }
    setSetting('conv_migrated', '1')
   }
  } catch (e) {
    try {
      fs.appendFileSync(
        path.join(DATA_DIR, 'recovery.log'),
        `${new Date().toISOString()} conv migration skipped: ${e}\n`,
      )
    } catch {
      /* 로그 실패는 무시 */
    }
  }
  // 워크스페이스 폴더명 변경(C:\dev → C:\workspace, 2026-06 사용자 폴더 rename) 1회 반영 —
  // 기존 프로젝트의 절대 path prefix만 교체한다(id는 루트 상대경로라 불변). prefix 6자만 갈아끼워
  // 경로 중간에 'C:\dev'가 또 있어도 안전(REPLACE 아님). 가드로 1회만.
  try {
    if (getSetting('root_dev2workspace') !== '1') {
      const r = db
        .prepare("UPDATE projects SET path = ? || substr(path, ?) WHERE substr(path, 1, 6) = ?")
        .run('C:\\workspace', 7, 'C:\\dev')
      setSetting('root_dev2workspace', '1')
      if (Number(r.changes) > 0) logRecovery(`프로젝트 경로 마이그레이션: C:\\dev → C:\\workspace (${r.changes}개)`)
    }
  } catch (e) {
    logRecovery(`경로 마이그레이션 실패: ${e}`)
  }
  // 저널 도입 이전 기존 기록을 1회 저널로 백필 → 이후 저널(진실원천)에서 DB 유실분을 복원. 부팅 절대 안 깨지게 가드.
  try {
    backfillJournalOnce()
    reconcileFromJournal()
  } catch (e) {
    logRecovery(`저널 복원 호출 실패: ${e}`)
  }
}

// quick_check/integrity_check 결과(행) 또는 throw로부터 DB 손상 여부를 판정한다(순수 — 단위테스트 용이).
// 정상은 단일 행 'ok'. 인덱스 엔트리 수 불일치·페이지 손상 등은 'ok' 아닌 행으로, malformed 류는 throw로
// 드러난다. (과거 프로브는 `SELECT COUNT(*) FROM messages`만 봐서 messages 외 페이지·인덱스 손상을 놓쳤다.)
export function isCorruptResult(rows: unknown[] | null, err?: unknown): boolean {
  if (err !== undefined && err !== null)
    return /malformed|corrupt|not a database|disk image/i.test(String(err))
  if (!rows || rows.length === 0) return false
  if (rows.length === 1) {
    const r = rows[0] as Record<string, unknown>
    const v = r.quick_check ?? r.integrity_check
    return String(v).toLowerCase() !== 'ok'
  }
  return true // 'ok' 단일 행이 아니라 여러 문제 행 → 손상
}

// quick_check 결과/throw를 사람이 읽을 진단 문자열로 만든다(반복 손상 추적용 — 매번 같은 인덱스/페이지인지).
// 순수 — 단위테스트 용이. quick_check는 인덱스/페이지 식별자만 반환하므로 사용자 데이터·비밀이 새지 않는다.
export function formatCorruptDetail(rows: unknown[] | null, err?: unknown): string {
  if (err) return `예외 ${String(err).slice(0, 180)}`
  if (!rows || rows.length === 0) return '결과 없음'
  return rows
    .map((r) => {
      const o = r as Record<string, unknown>
      return String(o.quick_check ?? o.integrity_check ?? JSON.stringify(o))
    })
    .join(' | ')
    .slice(0, 300)
}

// REINDEX 후 '메인 영속화' 게이트 — **명시적 'ok'만** 통과시킨다(화이트리스트). 순수 — 단위테스트 용이.
// isCorruptResult는 '모름=정상'(빈 결과·비손상 예외 BUSY/locked/interrupted/OOM에 false)이라 영속화 게이트로
// 쓰면 미검증 상태를 메인에 굳혀버릴 수 있다(적대 리뷰 지적). 영속화 판정엔 반드시 이 화이트리스트를 쓴다.
export function isQuickCheckOk(rows: unknown[] | null, err?: unknown): boolean {
  if (err || !rows || rows.length !== 1) return false
  const r = rows[0] as Record<string, unknown>
  return String(r.quick_check ?? r.integrity_check).toLowerCase() === 'ok'
}

// quick_check 결과에서 NOT NULL 데이터 위반("NULL value in <table>.<column>")만 (table, column)으로 추출한다.
// 순수 — 단위테스트 용이. 이 위반은 인덱스가 아니라 행 데이터 문제라 REINDEX로 못 고친다(과거 손상으로
// projects.hidden이 NULL이 된 행이 매 부팅 REINDEX→여전히 손상→미영속 루프를 무한 반복시킨 원인).
export function parseNullViolations(
  rows: unknown[] | null,
  err?: unknown,
): Array<{ table: string; column: string }> {
  if (err !== undefined && err !== null) return [] // throw류(malformed 등)는 데이터 위반 아님
  if (!rows || rows.length === 0) return []
  const out: Array<{ table: string; column: string }> = []
  for (const r of rows) {
    const o = r as Record<string, unknown>
    const msg = String(o.quick_check ?? o.integrity_check ?? '')
    // SQLite 메시지 형식: "NULL value in <table>.<column>"
    const m = /^NULL value in ([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(msg.trim())
    if (m) out.push({ table: m[1], column: m[2] })
  }
  return out
}

// NOT NULL 위반 행을 **선언된 default**로 메워 무결성을 치유한다 — 무손실(스키마가 의도한 값으로 복원).
// default가 없는 NOT NULL 컬럼은 임의 데이터를 만들지 않으려 건드리지 않는다(그 경우 루프 대신 다음 부팅 재시도).
// db 핸들을 인자로 받아 테스트 가능. dflt_value는 자기 스키마(sqlite_master)에서 온 신뢰된 SQL 리터럴이다.
export function repairNullViolations(
  database: DatabaseSync,
  violations: Array<{ table: string; column: string }>,
): number {
  let healed = 0
  const seen = new Set<string>()
  for (const { table, column } of violations) {
    const key = `${table}.${column}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const cols = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string
        dflt_value: unknown
      }>
      const col = cols.find((c) => c.name === column)
      if (!col || col.dflt_value === null || col.dflt_value === undefined) continue // default 없음 → 미치유
      const r = database
        .prepare(`UPDATE "${table}" SET "${column}" = ${String(col.dflt_value)} WHERE "${column}" IS NULL`)
        .run()
      healed += Number(r.changes)
    } catch {
      /* 한 컬럼 실패가 다른 컬럼 치유를 막지 않게 무시 */
    }
  }
  return healed
}

// rw 오픈 후 메인 DB 구조를 점검 — 인덱스 손상(autoindex 엔트리 수 불일치 등)이면 REINDEX로 무손실 복구한다.
// 인덱스는 테이블 행에서 재생성 가능하므로 데이터 손실이 없다. WAL 폐기 후에도 메인에 남는 잠복 인덱스 손상을
// 치유한다(과거 'settings' PK autoindex 손상이 getSetting/setSetting에서 간헐적 malformed를 유발했다).
function repairIndexesIfCorrupt(): void {
  // ⚠️ 이 함수는 initStore에서 CREATE TABLE *전에* 호출된다(raw 오픈 직후 손상 점검). 그래서 fresh DB엔
  // settings 테이블이 아직 없다 — 재발 카운터(db_corrupt_streak) 접근은 best-effort로 감싸, 테이블 부재가
  // 부팅을 깨지 않게 한다(fresh DB엔 추적할 손상 이력도 없으므로 no-op이 맞다).
  const safeSetSetting = (k: string, v: string): void => {
    try {
      setSetting(k, v)
    } catch {
      /* settings 테이블 미생성 등 — 무시 */
    }
  }
  const safeGetSetting = (k: string): string | null => {
    try {
      return getSetting(k)
    } catch {
      return null
    }
  }
  let rows: unknown[] | null = null
  let err: unknown
  try {
    rows = db.prepare('PRAGMA quick_check').all()
  } catch (e) {
    err = e
  }
  if (!isCorruptResult(rows, err)) {
    safeSetSetting('db_corrupt_streak', '0') // 처음부터 ok → 재발 카운터 리셋
    return
  }
  // 진단 — quick_check가 본 손상을 남긴다(부팅마다 REINDEX가 반복될 때 동일 원인인지 추적). 비밀 없음.
  logRecovery(`quick_check 실패: ${formatCorruptDetail(rows, err)}`)
  try {
    db.exec('REINDEX')
  } catch (e) {
    logRecovery(`REINDEX 실패: ${e}`)
    // REINDEX 자체가 실패하는(심한 손상) 부팅도 '자동치유 실패'다 — 미영속 경로(아래 line 624~)와 동일하게
    // 재발 카운터에 합류시킨다. 안 그러면 매 부팅 REINDEX-throw가 반복돼도 streak이 영영 3에 못 닿아
    // pending_notify가 안 서고 사용자가 통지를 못 받는 사각지대가 생긴다. best-effort(테이블 부재 등 무해).
    const prev = Number(safeGetSetting('db_corrupt_streak') ?? '0') || 0
    safeSetSetting('db_corrupt_streak', String(prev + 1))
    if (prev + 1 >= 3)
      safeSetSetting(
        'db_corrupt_pending_notify',
        `DB 자동치유 ${prev + 1}회 연속 실패(REINDEX 실패) — ${formatCorruptDetail(rows, err)}`,
      )
    return
  }
  // REINDEX 결과(재생성 인덱스)는 WAL에 쓰인다 → 즉시 메인 DB에 영속화하지 않으면, 다음 강제종료(force-kill)
  // + 손상 WAL 폐기에 복구가 소실돼 매 부팅 REINDEX가 반복된다(관측된 루프의 재발 경로). 단 **REINDEX 후
  // quick_check가 다시 'ok'일 때만** 체크포인트한다 — 인덱스로 못 고치는 손상(페이지 등)을 메인에 굳혀버려
  // corrupt WAL을 메인에 합쳐 오염시킨 과거 사고([[lain-sqlite-wal-corruption-recovery]])를 재현하지 않도록.
  let after: unknown[] | null = null
  let afterErr: unknown
  try {
    after = db.prepare('PRAGMA quick_check').all()
  } catch (e) {
    afterErr = e
  }
  // REINDEX로 안 풀리는 NOT NULL 데이터 위반("NULL value in T.C")은 행 데이터를 선언 default로 복원해 치유한다.
  // 이게 없으면 quick_check가 영영 ok가 안 돼 매 부팅 REINDEX→미영속이 무한 반복됐다(관측된 루프의 실제 원인).
  if (!isQuickCheckOk(after, afterErr)) {
    const violations = parseNullViolations(after, afterErr)
    if (violations.length) {
      const healed = repairNullViolations(db, violations)
      if (healed > 0) {
        logRecovery(
          `NOT NULL 위반 치유: ${violations.map((v) => `${v.table}.${v.column}`).join(', ')} (${healed}행) → default 복원`,
        )
        try {
          after = db.prepare('PRAGMA quick_check').all()
          afterErr = undefined
        } catch (e) {
          after = null
          afterErr = e
        }
      }
    }
  }
  // best-effort 물리 재구축 — REINDEX·NOT NULL 치유로도 ok가 안 됐고, quick_check가 보고한 NOT NULL
  // 위반 컬럼들의 실제 NULL 행이 0인 '팬텀'(데이터는 멀쩡한데 quick_check만 위반을 보고)이면 VACUUM으로
  // 페이지를 물리 재구축해 본다. 전체 try/catch — VACUUM 실패·BUSY는 무해(미영속 경로로 떨어질 뿐).
  if (!isQuickCheckOk(after, afterErr)) {
    const phantomViolations = parseNullViolations(after, afterErr)
    const allPhantom =
      phantomViolations.length > 0 &&
      phantomViolations.every(({ table, column }) => {
        try {
          const r = db
            .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" IS NULL`)
            .get() as { n: number }
          return Number(r.n) === 0
        } catch {
          return false // COUNT 실패면 팬텀으로 단정하지 않는다(보수적)
        }
      })
    if (allPhantom) {
      try {
        db.exec('VACUUM')
        after = db.prepare('PRAGMA quick_check').all()
        afterErr = undefined
        if (isQuickCheckOk(after, afterErr))
          logRecovery(
            `팬텀 NOT NULL 위반(${phantomViolations.map((v) => `${v.table}.${v.column}`).join(', ')}) — VACUUM 물리 재구축으로 quick_check ok 수렴`,
          )
      } catch (e) {
        logRecovery(`VACUUM 물리 재구축 실패(미영속·다음 부팅 재시도): ${String(e).slice(0, 160)}`)
      }
    }
  }
  // 화이트리스트 — REINDEX(+NOT NULL 치유·VACUUM) 후 **명시적 'ok'를 확인했을 때만** 영속화. 빈 결과·비손상
  // 예외(BUSY 등)나 인덱스/데이터로 못 고친 잔존 손상(페이지 등)이면 메인에 굳히지 않고 다음 부팅 재시도.
  if (!isQuickCheckOk(after, afterErr)) {
    // 재발 카운터 — 같은 손상이 매 부팅 반복되면(자동치유 실패) 사용자에게 알린다. 3회 이상이면 지연 통지 플래그.
    const prev = Number(safeGetSetting('db_corrupt_streak') ?? '0') || 0
    safeSetSetting('db_corrupt_streak', String(prev + 1))
    if (prev + 1 >= 3)
      safeSetSetting(
        'db_corrupt_pending_notify',
        `DB 자동치유 ${prev + 1}회 연속 실패 — ${formatCorruptDetail(after, afterErr)}`,
      )
    logRecovery(
      `REINDEX 후 quick_check ok 미확인 — 미영속(다음 부팅 재시도): ${afterErr ? String(afterErr).slice(0, 160) : formatCorruptDetail(after)}`,
    )
    return
  }
  // 명시적 ok → 메인 영속화. wal_checkpoint(TRUNCATE)는 BUSY(리더 경합)면 throw 않고 busy=1 결과행만 주므로
  // 결과를 읽어 실제 영속 여부를 판정한다 — 안 합쳐졌는데 '루프 차단' 성공 로그를 남기지 않게(적대 리뷰 지적).
  safeSetSetting('db_corrupt_streak', '0') // 치유로 ok 수렴 → 재발 카운터 리셋
  try {
    const cp = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all() as Array<{ busy?: number }>
    if (cp[0]?.busy) {
      logRecovery('REINDEX 후 체크포인트 미완료(busy — WAL에 인덱스 잔존, 다음 부팅 재시도)')
    } else {
      logRecovery('quick_check 실패 → REINDEX로 인덱스 복구 (체크포인트로 메인 영속화 — 루프 차단)')
    }
  } catch (e) {
    logRecovery(`REINDEX 후 체크포인트 실패(다음 부팅 재시도): ${e}`)
  }
}

function logRecovery(m: string): void {
  appendCapped(path.join(DATA_DIR, 'recovery.log'), `${new Date().toISOString()} ${m}\n`)
}

// 저널 도입 이전부터 DB에 있던 기존 대화·메시지를 1회 저널에 백필한다 — 지금 있는 기록도 진실원천에
// 올려 이후 DB 유실에 대비. uid 없는(legacy) 행엔 uid를 부여한다. journal_backfilled 설정으로 1회만 실행.
function backfillJournalOnce(): void {
  // 1) 메시지·대화 백필 (journal_backfilled 가드)
  if (getSetting('journal_backfilled') !== '1') {
    try {
      const convs = db
        .prepare('SELECT id, target, title, sdk_session_id, created_at FROM conversations')
        .all() as any[]
      for (const c of convs)
        journalConversation({
          id: c.id,
          target: c.target,
          title: c.title ?? '',
          sdkSessionId: c.sdk_session_id ?? null,
          createdAt: c.created_at,
        })
      const rows = db
        .prepare(
          'SELECT id, uid, scope, project_id, role, content, conversation_id, attachments, origin, created_at FROM messages ORDER BY id ASC',
        )
        .all() as any[]
      const setUid = db.prepare('UPDATE messages SET uid = ? WHERE id = ? AND uid IS NULL')
      for (const r of rows) {
        const uid = r.uid ?? crypto.randomUUID()
        if (!r.uid) setUid.run(uid, r.id)
        journalMessage({
          uid,
          scope: r.scope,
          projectId: r.project_id ?? null,
          role: r.role,
          content: r.content,
          conversationId: r.conversation_id ?? null,
          attachments: r.attachments ?? null,
          origin: r.origin ?? null,
          createdAt: r.created_at,
        })
      }
      setSetting('journal_backfilled', '1')
      if (rows.length || convs.length)
        logRecovery(`저널 백필 1회: 메시지 ${rows.length}건·대화 ${convs.length}건`)
    } catch (e) {
      logRecovery(`저널 백필 실패: ${e}`)
    }
  }
  // 2) 설정 백필 (별도 가드) — 메시지 백필이 이미 끝난 DB에서도 1회 실행돼, 현재 config(텔레그램 토큰·
  //    채팅ID·모델 등)를 저널에 올린다. WAL 폐기·손상으로 settings가 날아가도 reconcile이 되살리게.
  if (getSetting('journal_settings_backfilled') !== '1') {
    try {
      let setN = 0
      for (const r of db.prepare('SELECT key, value FROM settings').all() as any[]) {
        if (!JOURNAL_SKIP_SETTINGS.has(r.key)) {
          journalSetting(r.key, String(r.value))
          setN++
        }
      }
      setSetting('journal_settings_backfilled', '1')
      if (setN) logRecovery(`저널 설정 백필 1회: ${setN}건`)
    } catch (e) {
      logRecovery(`저널 설정 백필 실패: ${e}`)
    }
  }
}

// 저널(진실원천)에서 DB에 빠진 기록을 복원한다 — WAL 폐기·DB 유실로 사라진 대화·메시지를 되살린다.
// 멱등: 메시지는 uid 유니크 인덱스로 중복 차단(INSERT OR IGNORE), 대화는 ON CONFLICT로 최신 상태 반영.
// initStore 끝(스키마·uid 컬럼·인덱스 준비 후)에서 호출된다. 단위테스트로도 직접 호출 가능.
export function reconcileFromJournal(): { messages: number; conversations: number; settings: number } {
  const entries = readJournalEntries()
  if (entries.length === 0) return { messages: 0, conversations: 0, settings: 0 }
  // 삭제 톰스톤(t:'del') 선스캔 — 삭제된 대화는 복원 대상에서 제외하고, 이미 DB에 남은 행도 아래에서 제거한다.
  const deleted = new Set<string>()
  for (const e of entries)
    if (e.t === 'del' && (e as JournalDelete).target === 'conv') deleted.add((e as JournalDelete).id)
  const convStmt = db.prepare(
    `INSERT INTO conversations (id, target, title, sdk_session_id, world_state, handoff_md, created_at)
       VALUES (@id, @target, @title, @sdkSessionId, @worldState, @handoffMd, @createdAt)
     ON CONFLICT(id) DO UPDATE SET
       sdk_session_id = COALESCE(excluded.sdk_session_id, conversations.sdk_session_id),
       world_state = COALESCE(excluded.world_state, conversations.world_state),
       handoff_md = COALESCE(excluded.handoff_md, conversations.handoff_md),
       title = CASE WHEN conversations.title IS NULL OR conversations.title = ''
                    THEN excluded.title ELSE conversations.title END`,
  )
  const msgStmt = db.prepare(
    `INSERT OR IGNORE INTO messages
       (uid, scope, project_id, role, content, conversation_id, attachments, origin, created_at)
       VALUES (@uid, @scope, @projectId, @role, @content, @conversationId, @attachments, @origin, @createdAt)`,
  )
  let messages = 0
  let conversations = 0
  let settings = 0
  // 'set' 엔트리는 키별 최신값을 모은다(저널=진실원천) — 아래에서 DB가 stale하면 이 값으로 복원한다.
  const setLatest = new Map<string, string>()
  db.exec('BEGIN')
  try {
    for (const e of entries) {
      if (e.t === 'conv') {
        const c = e as JournalConv
        if (deleted.has(c.id)) continue // 삭제된 대화는 복원하지 않는다
        convStmt.run({
          id: c.id,
          target: c.target,
          title: c.title ?? '',
          sdkSessionId: c.sdkSessionId ?? null,
          worldState: c.worldState ?? null,
          handoffMd: c.handoffMd ?? null,
          createdAt: c.createdAt,
        })
        conversations++
      } else if (e.t === 'set') {
        const s = e as JournalSetting
        setLatest.set(s.key, s.value)
      } else if (e.t === 'msg') {
        const m = e as JournalMsg
        if (m.conversationId && deleted.has(m.conversationId)) continue // 삭제된 대화의 메시지는 복원 안 함
        const r = msgStmt.run({
          uid: m.uid,
          scope: m.scope,
          projectId: m.projectId ?? null,
          role: m.role,
          content: m.content,
          conversationId: m.conversationId ?? null,
          attachments: m.attachments ?? null,
          origin: m.origin ?? null,
          createdAt: m.createdAt,
        })
        if (Number(r.changes) > 0) messages++ // 실제 삽입된 것만(이미 있으면 IGNORE → changes 0)
      }
      // 't' === 'del'은 위 선스캔에서 처리 — replay 루프에선 무시한다.
    }
    // 톰스톤 enforce — 저널 복원으로 안 들어왔어도, DB에 이미 남아 있던 삭제 대상 행을 제거한다(멱등).
    if (deleted.size > 0) {
      const delMsg = db.prepare('DELETE FROM messages WHERE conversation_id = ?')
      const delConv = db.prepare('DELETE FROM conversations WHERE id = ?')
      for (const id of deleted) {
        delMsg.run(id)
        delConv.run(id)
      }
    }
    // 설정 복원 — 저널(진실원천)의 키별 최신값을 DB에 반영한다(값이 다를 때만 upsert).
    // missing-only였을 땐, WAL 폐기로 settings가 옛 체크포인트 값으로 회귀해도 키가 이미 존재해
    // 저널 최신값으로 못 고쳤다(설정·토큰이 옛값으로 '리셋'되던 정체). setSetting은 매번 fsync 저널하므로
    // 저널 최신값이 진실 — 정상 동작 땐 DB==저널이라 no-op, 강제종료+WAL 폐기 후엔 stale을 되살린다.
    const curSetting = db.prepare('SELECT value FROM settings WHERE key = ?')
    const upSetting = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    for (const [k, v] of setLatest) {
      const cur = curSetting.get(k) as { value: string } | undefined
      if (!cur || cur.value !== v) {
        upSetting.run(k, v)
        settings++
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 무시 */
    }
    logRecovery(`저널 reconcile 실패: ${e}`)
    return { messages: 0, conversations: 0, settings: 0 }
  }
  if (messages > 0 || settings > 0)
    logRecovery(`저널 reconcile: 메시지 ${messages}건·설정 ${settings}건 복원(대화 ${conversations}건 반영)`)
  return { messages, conversations, settings }
}

// 정상 종료(트레이 종료·before-quit) 시 WAL을 메인에 합치고 닫는다 — WAL이 비대한 채 방치되다 강제종료에
// 손상되는 경로를 줄인다. 강제종료(Stop-Process -Force)엔 호출되지 않지만, 정상 종료에선 WAL이 작게 유지돼
// 다음 부팅의 손상 위험·복구 손실이 준다.
export function closeStore(): void {
  if (!db) return // initStore가 DB 생성 전 throw한 경우 — before-quit에서 호출돼도 안전
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* 무시 */
  }
  try {
    db.close()
  } catch {
    /* 무시 */
  }
}

// 손상 복구 — DB 손상은 흔히 WAL에만 있다(강제종료 등). rw 오픈 *전에* read-only 프로브로 감지하고
// 손상 WAL/SHM을 백업·폐기해 메인 DB(마지막 체크포인트)로 복원한다(거의 무손실).
// read-only 연결은 메인에 못 쓰므로 close해도 체크포인트가 없다 — rw로 열고 close하면 손상 WAL이
// 메인에 합쳐져 메인까지 오염되므로(검증됨) 반드시 read-only 프로브 + 오픈 전 폐기로 처리한다.
function recoverCorruptWalBeforeOpen(): void {
  const dbPath = path.join(DATA_DIR, 'lain.sqlite')
  if (!fs.existsSync(dbPath) || !fs.existsSync(dbPath + '-wal')) return // 새 설치·WAL 없음 → 할 일 없음
  const log = logRecovery
  let corrupt = false
  let probe: DatabaseSync | null = null
  try {
    probe = new DatabaseSync(dbPath, { readOnly: true })
    // PRAGMA quick_check — 전 구조(전 테이블·인덱스 페이지) 스캔. COUNT(messages)만 보던 과거 프로브는
    // messages가 멀쩡하면 통과해 settings 인덱스 손상·WAL 손상을 놓쳤다(→ rw 오픈 후 도처에서 malformed).
    const rows = probe.prepare('PRAGMA quick_check').all()
    corrupt = isCorruptResult(rows)
  } catch (e) {
    corrupt = isCorruptResult(null, e)
  } finally {
    try {
      probe?.close() // read-only close → 체크포인트 없음(메인 안전)
    } catch {
      /* 무시 */
    }
  }
  if (!corrupt) return
  try {
    const bdir = path.join(DATA_DIR, 'db-corrupt')
    fs.mkdirSync(bdir, { recursive: true })
    const stamp = Date.now()
    for (const ext of ['-wal', '-shm']) {
      const f = dbPath + ext
      if (!fs.existsSync(f)) continue
      try {
        fs.copyFileSync(f, path.join(bdir, `lain.sqlite${ext}-${stamp}`))
      } catch {
        /* 백업 실패 무시 */
      }
      fs.rmSync(f, { force: true })
    }
    log('손상 WAL 폐기(rw 오픈 전·read-only 프로브) → 메인 DB로 복원')
  } catch (e) {
    log(`WAL 폐기 실패: ${e}`)
  }
}

function rowToProject(r: any): Project {
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    stack: r.stack,
    verifyCmd: r.verify_cmd,
    isGit: !!r.is_git,
    enabled: !!r.enabled,
  }
}

function rowToStatus(r: any): ProjectStatus | null {
  if (!r || !r.project_id) return null
  return {
    projectId: r.project_id,
    gitBranch: r.git_branch,
    ahead: r.ahead,
    behind: r.behind,
    dirtyFiles: r.dirty_files,
    lastCommit: r.last_commit,
    lastCommitAt: r.last_commit_at,
    testState: r.test_state,
    testOutputTail: r.test_output_tail,
    todoCount: r.todo_count,
    hasTaskMd: !!r.has_task_md,
    summary: r.summary,
    updatedAt: r.updated_at,
  }
}

export function upsertProject(p: Project): void {
  db.prepare(`
    INSERT INTO projects (id, path, name, stack, verify_cmd, is_git, enabled)
    VALUES (@id, @path, @name, @stack, @verifyCmd, @isGit, @enabled)
    ON CONFLICT(id) DO UPDATE SET
      path = @path, name = @name, stack = @stack,
      verify_cmd = @verifyCmd, is_git = @isGit
  `).run({ ...p, isGit: p.isGit ? 1 : 0, enabled: p.enabled ? 1 : 0 })
}

export function setProjectEnabled(id: string, enabled: boolean): void {
  db.prepare('UPDATE projects SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

// 내비 '제거' = 보드에서 숨김(데이터 보존). 작업·대화·교훈·현황은 남는다(하드 삭제는 deleteProject).
export function hideProject(id: string): void {
  db.prepare('UPDATE projects SET hidden = 1 WHERE id = ?').run(id)
}
// 명시적 재추가(폴더 피커)는 숨김 해제 — 보존된 데이터와 함께 보드로 복귀. (스캔은 hidden을 보존해 안 되살림)
export function unhideProject(id: string): void {
  db.prepare('UPDATE projects SET hidden = 0 WHERE id = ?').run(id)
}

export function getProject(id: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
  return r ? rowToProject(r) : null
}

export function listProjects(): ProjectView[] {
  const rows = db.prepare(`
    SELECT p.*, s.project_id, s.git_branch, s.ahead, s.behind, s.dirty_files,
           s.last_commit, s.last_commit_at, s.test_state, s.test_output_tail,
           s.todo_count, s.summary, s.updated_at
    FROM projects p LEFT JOIN project_status s ON s.project_id = p.id
    WHERE p.hidden = 0
    ORDER BY p.id
  `).all()
  return rows.map((r: any) => ({ ...rowToProject(r), status: rowToStatus(r) }))
}

export function saveStatus(s: Partial<ProjectStatus> & { projectId: string }): void {
  const prev = db.prepare('SELECT * FROM project_status WHERE project_id = ?').get(s.projectId) as any
  const merged = { ...(rowToStatus(prev) ?? {
    projectId: s.projectId, gitBranch: null, ahead: 0, behind: 0, dirtyFiles: 0,
    lastCommit: null, lastCommitAt: null, testState: 'unknown' as const,
    testOutputTail: null, todoCount: 0, hasTaskMd: false, summary: null, updatedAt: '',
  }), ...s, updatedAt: new Date().toISOString() }
  db.prepare(`
    INSERT INTO project_status (project_id, git_branch, ahead, behind, dirty_files,
      last_commit, last_commit_at, test_state, test_output_tail, todo_count, has_task_md, summary, updated_at)
    VALUES (@projectId, @gitBranch, @ahead, @behind, @dirtyFiles,
      @lastCommit, @lastCommitAt, @testState, @testOutputTail, @todoCount, @hasTaskMd, @summary, @updatedAt)
    ON CONFLICT(project_id) DO UPDATE SET
      git_branch = @gitBranch, ahead = @ahead, behind = @behind, dirty_files = @dirtyFiles,
      last_commit = @lastCommit, last_commit_at = @lastCommitAt, test_state = @testState,
      test_output_tail = @testOutputTail, todo_count = @todoCount, has_task_md = @hasTaskMd,
      summary = @summary, updated_at = @updatedAt
  `).run({ ...merged, hasTaskMd: merged.hasTaskMd ? 1 : 0 })
}

// 첨부를 DB에 직렬화하기 전 비대화 방지: 이미지 base64가 상한을 넘으면 data를 비우고
// 메타(name/mimeType/isImage)만 남겨 파일 칩으로 표시한다(원본은 LLM 입력용으로 이미 전달됨).
const ATTACH_DATA_CAP = 256 * 1024 // 256KB
export function serializeAttachments(attachments?: FileAttachment[]): string | null {
  if (!attachments || !attachments.length) return null
  // 인라인 로그용 저장: 이미지는 썸네일 표시에 data 필요(상한 초과 시 칩 폴백), 텍스트 첨부는
  // 칩(이름)만 보여주므로 data를 저장하지 않는다 — 큰 텍스트 첨부로 messages 행이 비대해지는 것 방지.
  const capped = attachments.map((a) =>
    !a.isImage || a.data.length > ATTACH_DATA_CAP ? { ...a, data: '' } : a,
  )
  return JSON.stringify(capped)
}

export function parseAttachments(raw: unknown): FileAttachment[] | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) && v.length ? (v as FileAttachment[]) : undefined
  } catch {
    return undefined
  }
}

function rowToChatMessage(r: any): ChatMessage {
  return {
    id: r.id,
    scope: r.scope,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    chapter: r.chapter ?? null,
    attachments: parseAttachments(r.attachments),
    // telegram(📱)·lain(관리자→Navi)만 실어 보내고 null/'pc'는 undefined로 둔다(PC發엔 마커 안 뜨게·페이로드 군더더기 방지).
    origin: r.origin === 'telegram' ? 'telegram' : r.origin === 'lain' ? 'lain' : r.origin === 'discord' ? 'discord' : undefined,
  }
}

// datetime('now')와 동일 포맷·UTC 'YYYY-MM-DD HH:MM:SS' — 저널과 DB created_at을 정확히 일치시킨다.
function nowStamp(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

export function addMessage(
  scope: ChatMessage['scope'],
  role: ChatMessage['role'],
  content: string,
  conversationId?: string,
  attachments?: FileAttachment[],
  origin?: 'pc' | 'telegram' | 'discord', // 폰發/디스코드發 출처 표식. 미지정/'pc'는 null로 저장.
): void {
  // 다중 세션: conversationId 미지정이면 manager 활성 대화로 자동 태깅(스케줄러·curator 등 산발 호출 호환).
  const conv = conversationId ?? (scope === 'manager' ? ensureActiveConversation('manager') : null)
  const uid = crypto.randomUUID()
  // 출력측 비밀 redaction(PLAN §9-6) — 저널·DB INSERT 전 단일 chokepoint. 고신뢰 credential 형상만 마스킹.
  content = redactSecrets(content)
  const attach = serializeAttachments(attachments)
  const org = origin === 'telegram' ? 'telegram' : origin === 'discord' ? 'discord' : null
  const createdAt = nowStamp()
  // 저널 먼저(진실원천) — DB 기록이 WAL 폐기·손상으로 날아가도 부팅 reconcile이 복원한다.
  journalMessage({ uid, scope, projectId: null, role, content, conversationId: conv, attachments: attach, origin: org, createdAt })
  db.prepare(
    'INSERT INTO messages (uid, scope, role, content, conversation_id, attachments, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(uid, scope, role, content, conv, attach, org, createdAt)
  // 텔레그램 메시지면 해당 대화의 last_mobile_at 갱신 → SessionList 📱 아이콘 판단용 (Lain 기여)
  if (org === 'telegram' && conv) {
    db.prepare("UPDATE conversations SET last_mobile_at = datetime('now') WHERE id = ?").run(conv)
  }
}

// §5.6 Navi 직접 채팅 — 프로젝트별 대화 (scope='worker' + project_id), 다중 세션은 conversation_id로 분리
export function addNaviMessage(
  projectId: string,
  role: ChatMessage['role'],
  content: string,
  conversationId?: string,
  attachments?: FileAttachment[],
  origin?: 'lain', // 'lain'이면 관리자가 Navi에게 보낸 메시지 — Navi 대화창에서 'lain>'으로 귀속 표시
): void {
  const conv = conversationId ?? ensureActiveConversation(projectId)
  const uid = crypto.randomUUID()
  // 출력측 비밀 redaction(PLAN §9-6) — 저널·DB INSERT 전 단일 chokepoint(Navi 채팅도 동일 게이트).
  content = redactSecrets(content)
  const attach = serializeAttachments(attachments)
  const org = origin === 'lain' ? 'lain' : null
  const createdAt = nowStamp()
  // 저널 먼저(진실원천) — Navi 채팅도 DB 유실 시 부팅 reconcile로 복원된다.
  journalMessage({ uid, scope: 'worker', projectId, role, content, conversationId: conv, attachments: attach, origin: org, createdAt })
  db.prepare(
    "INSERT INTO messages (uid, scope, project_id, role, content, conversation_id, attachments, origin, created_at) VALUES (?, 'worker', ?, ?, ?, ?, ?, ?, ?)",
  ).run(uid, projectId, role, content, conv, attach, org, createdAt)
}

// ── 다중 세션 (Conversation) ──
function rowToConversation(r: any): Conversation {
  return {
    id: r.id,
    target: r.target,
    title: r.title || '',
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    lastContent: r.last_content
      ? String(r.last_content).split('\n')[0].slice(0, 160)
      : null,
    lastAt: r.last_at ?? null,
    lastMobileAt: r.last_mobile_at ?? null,
  }
}

// 대화의 현재 상태(target·title·sdk_session_id)를 저널에 남긴다 — 생성·세션갱신·제목변경 후 호출.
// 부팅 reconcile이 메시지 그룹핑·resume 세션을 복원하려면 대화 행도 저널에 있어야 한다(최신 상태가 이김).
function journalConvState(id: string): void {
  const r = db
    .prepare(
      'SELECT id, target, title, sdk_session_id, world_state, handoff_md, created_at FROM conversations WHERE id = ?',
    )
    .get(id) as any
  if (!r) return
  journalConversation({
    id: r.id,
    target: r.target,
    title: r.title ?? '',
    sdkSessionId: r.sdk_session_id ?? null,
    worldState: r.world_state ?? null,
    handoffMd: r.handoff_md ?? null,
    createdAt: r.created_at,
  })
}

export function createConversation(target: string, title = ''): string {
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO conversations (id, target, title) VALUES (?, ?, ?)').run(id, target, title)
  journalConvState(id)
  return id
}

export function listConversations(target: string): Conversation[] {
  return db
    .prepare(
      `SELECT c.*,
        (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_content,
        (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_at
       FROM conversations c WHERE c.target = ?
       ORDER BY c.last_used_at DESC, c.id DESC`,
    )
    .all(target)
    .map(rowToConversation)
}

export function getConversation(id: string): Conversation | null {
  const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any
  return r ? rowToConversation(r) : null
}

/** SDK 세션 id 조회(resume용) — main 전용. */
export function conversationSdkSession(id: string): string | null {
  const r = db.prepare('SELECT sdk_session_id FROM conversations WHERE id = ?').get(id) as any
  return r && r.sdk_session_id ? r.sdk_session_id : null
}

export function setConversationSdkSession(id: string, sdkSessionId: string): void {
  db.prepare("UPDATE conversations SET sdk_session_id = ?, last_used_at = datetime('now') WHERE id = ?").run(
    sdkSessionId,
    id,
  )
  journalConvState(id) // resume 세션을 저널에 — 컨텍스트 초기화·DB 유실에도 세션이 이어지게
}

export function touchConversation(id: string): void {
  db.prepare("UPDATE conversations SET last_used_at = datetime('now') WHERE id = ?").run(id)
}

// ── 무한세션(컨텍스트 자동 압축) — 점유 토큰·월드모델 접근자 ──
// 점유는 '최신 점유로 덮어씀'(누적합 아님 — input+cache는 매 요청 직전까지의 전체 컨텍스트라 마지막 값이 곧 현재).
// context_tokens는 비저널(단순 카운터 — 부팅 0이어도 다음 result에서 재충전, 자가치유).
// world_state는 setConversationWorldState가 journalConvState로 저널 → DB 유실/WAL 폐기에도 누적 맥락 보존(resume과 동급).
export function getConversationContextTokens(id: string): number {
  const r = db.prepare('SELECT context_tokens FROM conversations WHERE id = ?').get(id) as any
  return r ? Number(r.context_tokens ?? 0) : 0
}
export function setConversationContextTokens(id: string, tokens: number): void {
  db.prepare('UPDATE conversations SET context_tokens = ? WHERE id = ?').run(
    Math.max(0, Math.floor(tokens) || 0),
    id,
  )
}
export function resetConversationContextTokens(id: string): void {
  db.prepare('UPDATE conversations SET context_tokens = 0 WHERE id = ?').run(id)
}
export function getConversationWorldState(id: string): string | null {
  const r = db.prepare('SELECT world_state FROM conversations WHERE id = ?').get(id) as any
  return r && r.world_state ? String(r.world_state) : null
}
export function setConversationWorldState(id: string, md: string): void {
  db.prepare('UPDATE conversations SET world_state = ? WHERE id = ?').run(md, id)
  journalConvState(id) // 월드모델도 저널 — 압축 후 누적 맥락의 유일 캐리어이므로 DB 유실에도 보존
}
// Navi 유한세션 핸드오프 — Navi가 직접 쓴 핸드오프 md. world_state(Lain 전용)와 같은 저널 보존 패턴(교체 후 누적 맥락의 유일 캐리어).
export function getConversationHandoff(id: string): string | null {
  const r = db.prepare('SELECT handoff_md FROM conversations WHERE id = ?').get(id) as any
  return r && r.handoff_md ? String(r.handoff_md) : null
}
export function setConversationHandoff(id: string, md: string): void {
  db.prepare('UPDATE conversations SET handoff_md = ? WHERE id = ?').run(md, id)
  journalConvState(id) // 핸드오프도 저널 — DB 유실/WAL 폐기에도 보존
}

/** 제목이 비어 있으면 첫 메시지로 자동 설정(40자 절단). */
export function setConversationTitleIfEmpty(id: string, title: string): void {
  db.prepare(
    "UPDATE conversations SET title = ? WHERE id = ? AND (title IS NULL OR title = '')",
  ).run(title.split('\n')[0].slice(0, 40), id)
  journalConvState(id)
}

/** 대화 이름변경 — 빈문자열 조건 없이 무조건 덮어쓰기(40자 절단). 수동 제목은 자동요약이 덮지 않게 title_auto=1로 고정. */
export function renameConversation(id: string, title: string): void {
  db.prepare('UPDATE conversations SET title = ?, title_auto = 1 WHERE id = ?').run(
    title.split('\n')[0].slice(0, 40),
    id,
  )
  journalConvState(id)
}

/** 자동요약 필요 여부 — title_auto가 0/NULL이면 true(아직 1회 자동요약·수동 rename 전). */
export function needsAutoTitle(id: string): boolean {
  const r = db.prepare('SELECT title_auto FROM conversations WHERE id = ?').get(id) as any
  return !!r && !r.title_auto
}

/** 자동요약 제목 적용(1회) — 원자적 가드(title_auto=0인 행만). 빈 결과면 갱신 스킵. 반환: 실제 갱신됐는지. */
export function setAutoTitle(id: string, title: string): boolean {
  const t = title.split('\n')[0].trim().slice(0, 30)
  if (!t) return false
  const r = db
    .prepare('UPDATE conversations SET title = ?, title_auto = 1 WHERE id = ? AND title_auto = 0')
    .run(t, id)
  if (Number(r.changes) > 0) journalConvState(id)
  return Number(r.changes) > 0
}

/** 대화 삭제 — 그 대화의 메시지와 대화 행을 함께 제거. active_conv는 ensureActiveConversation이 자가복구.
 *  톰스톤을 DB 삭제보다 먼저 fsync한다 — DB 삭제가 WAL 폐기로 유실돼도 reconcile이 영속 삭제를 적용해
 *  되살아남을 막는다(저널이 진실원천이므로 톰스톤 없이는 부팅 reconcile이 통째로 복원했다). */
export function deleteConversation(id: string): void {
  journalDelete(id)
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

export function listConversationMessages(conversationId: string, limit = 200): ChatMessage[] {
  // 단일 세션 화면 정리 — visible_from_id 워터마크 이전 메시지는 숨긴다(DB엔 보존). 기본 0이라 무영향(Navi 포함).
  const rows = db
    .prepare(
      'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND id >= COALESCE((SELECT visible_from_id FROM conversations WHERE id = ?), 0) ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
    )
    .all(conversationId, conversationId, limit)
  return rows.map(rowToChatMessage)
}

// 단일 세션 화면 정리 — 그 대화의 최근 keepRecent개만 화면에 남기고 워터마크를 전진(비파괴, 압축 시 호출).
// (keepRecent)번째 최근 메시지 id를 floor로 둔다. 메시지가 keepRecent 이하면 no-op(전부 유지).
export function setManagerViewWindow(convId: string, keepRecent: number): void {
  if (keepRecent <= 0) {
    // 0개 유지 — 최신 메시지보다 위로 워터마크를 올려 전부 숨긴다(계약 정합성, 방어적).
    const maxRow = db
      .prepare('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?')
      .get(convId) as any
    if (maxRow?.m != null)
      db.prepare('UPDATE conversations SET visible_from_id = ? WHERE id = ?').run(maxRow.m + 1, convId)
    return
  }
  const row = db
    .prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?')
    .get(convId, keepRecent - 1) as any
  if (row) db.prepare('UPDATE conversations SET visible_from_id = ? WHERE id = ?').run(row.id, convId)
}

// 무한세션 압축 입력용 — user/assistant 원문만(도구 로그 제외). tool 로그가 최근 윈도를 잠식해
// 요약 입력이 빈약해지는 것을 막는다(role 사전 필터 후 최근 limit건, 오래된→최신 순).
export function listConversationDialogue(conversationId: string, limit = 40): ChatMessage[] {
  const rows = db
    .prepare(
      "SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
    )
    .all(conversationId, limit)
  return rows.map(rowToChatMessage)
}

/** 메시지를 챕터로 고정(title)하거나 해제(null) — 우클릭 메뉴. */
export function setChapter(messageId: number, title: string | null): void {
  db.prepare('UPDATE messages SET chapter = ? WHERE id = ?').run(title, messageId)
}

export function getActiveConversation(target: string): string | null {
  return getSetting(`active_conv:${target}`)
}

export function setActiveConversation(target: string, conversationId: string): void {
  setSetting(`active_conv:${target}`, conversationId)
}

/** 활성 대화 보장 — 없으면 가장 최근 것, 그것도 없으면 새로 만든다. */
export function ensureActiveConversation(target: string): string {
  const cur = getSetting(`active_conv:${target}`)
  if (cur && db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(cur)) return cur
  const recent = db
    .prepare('SELECT id FROM conversations WHERE target = ? ORDER BY last_used_at DESC, id DESC LIMIT 1')
    .get(target) as any
  const id = recent ? recent.id : createConversation(target)
  setSetting(`active_conv:${target}`, id)
  return id
}

export function listNaviMessages(projectId: string, limit = 200): ChatMessage[] {
  const rows = db
    .prepare(
      "SELECT * FROM (SELECT * FROM messages WHERE scope = 'worker' AND project_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
    )
    .all(projectId, limit)
  return rows.map(rowToChatMessage)
}

export function listMessages(scope: string, limit = 200): ChatMessage[] {
  const rows = db.prepare(
    'SELECT * FROM (SELECT * FROM messages WHERE scope = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'
  ).all(scope, limit)
  return rows.map(rowToChatMessage)
}

// ── 클로드코드 연동(개선 #2 Phase 1) — 사용자가 레인 밖에서 직접 실행한 CC 세션 이벤트 로그 ──
export interface CcEvent {
  id: number
  projectId: string
  sessionId: string
  event: string // SessionStart | SessionEnd
  createdAt: string
}
export function addCcEvent(projectId: string, sessionId: string, event: string): void {
  db.prepare('INSERT INTO cc_events (project_id, session_id, event) VALUES (?, ?, ?)').run(
    projectId,
    sessionId,
    event,
  )
}
export function listRecentCcEvents(limit = 20): CcEvent[] {
  return (
    db
      .prepare('SELECT * FROM cc_events ORDER BY id DESC LIMIT ?')
      .all(limit) as any[]
  ).map((r) => ({
    id: r.id,
    projectId: r.project_id,
    sessionId: r.session_id ?? '',
    event: r.event,
    createdAt: r.created_at,
  }))
}

/** idle 판정 기준 — 마지막 채팅 활동 시각(ISO/datetime 문자열). 순수 SQL(messages 전체의 MAX(created_at)).
 *  메시지가 하나도 없으면 null. scheduler.isIdle이 now와 비교해 끼어듦 게이트로 쓴다. */
export function lastChatActivityAt(): string | null {
  const r = db.prepare('SELECT MAX(created_at) AS m FROM messages').get() as any
  return r && r.m ? String(r.m) : null
}

/** 대화 인박스 — Lain(manager) + Navi 대화가 있는 프로젝트들의 '마지막 메시지' 1건씩.
 *  Navi별은 MAX(id)로 마지막 행만 조인(id는 PK AUTOINCREMENT라 단조 증가). content는 첫 줄·200자 절단. */
export function listConversationPreviews(): ConversationPreview[] {
  const trunc = (s: unknown) => String(s ?? '').split('\n')[0].slice(0, 200)
  const out: ConversationPreview[] = []
  const mgr = db
    .prepare("SELECT role, content, created_at FROM messages WHERE scope = 'manager' ORDER BY id DESC LIMIT 1")
    .get() as any
  out.push({
    target: 'manager',
    role: mgr ? mgr.role : null,
    content: mgr ? trunc(mgr.content) : null,
    createdAt: mgr ? mgr.created_at : null,
  })
  const rows = db
    .prepare(
      `SELECT m.project_id, m.role, m.content, m.created_at
       FROM messages m
       JOIN (SELECT project_id, MAX(id) AS mx FROM messages
             WHERE scope = 'worker' AND project_id IS NOT NULL GROUP BY project_id) g
         ON m.id = g.mx`,
    )
    .all() as any[]
  for (const r of rows) {
    out.push({ target: r.project_id, role: r.role, content: trunc(r.content), createdAt: r.created_at })
  }
  return out
}

// ── Phase 1: tasks / approvals / task_events ──

function rowToTask(r: any): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    state: r.state,
    mode: r.mode === 'autonomous' ? 'autonomous' : 'interactive',
    permissionMode:
      r.permission_mode === 'default' ||
      r.permission_mode === 'plan' ||
      r.permission_mode === 'bypass'
        ? r.permission_mode
        : 'acceptEdits',
    thinkingLevel: (['off', 'auto', 'high'] as const).includes(r.thinking_level)
      ? r.thinking_level
      : 'default',
    disallowedTools: mcpJsonArray(r.disallowed_tools),
    content: r.content,
    questions: JSON.parse(r.questions ?? '[]'),
    branch: r.branch,
    worktreePath: r.worktree_path,
    naviSessionId: r.worker_session_id,
    contextTokens: r.context_tokens ?? 0,
    handoffMd: r.handoff_md ?? null,
    summary: r.summary,
    diffStat: r.diff_stat,
    verifyResult: r.verify_result,
    costUsd: r.cost_usd,
    tokens: r.tokens ?? 0,
    turns: r.turns,
    error: r.error,
    skills: r.skills ? JSON.parse(r.skills) : null,
    images: r.images ? JSON.parse(r.images) : [],
    fastMode: r.fast_mode === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function insertTask(t: {
  id: string
  projectId: string
  title: string
  state: TaskState
  content: string
  mode?: NaviMode
  permissionMode?: TaskPermissionMode
  thinkingLevel?: ThinkingLevel
  disallowedTools?: string[]
  skills?: string[]
  fastMode?: boolean
}): void {
  db.prepare(
    'INSERT INTO tasks (id, project_id, title, state, content, mode, permission_mode, thinking_level, disallowed_tools, skills, fast_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(t.id, t.projectId, t.title, t.state, t.content, t.mode ?? 'interactive',
        t.permissionMode ?? 'acceptEdits',
        t.thinkingLevel ?? 'default',
        JSON.stringify(t.disallowedTools ?? []),
        t.skills && t.skills.length ? JSON.stringify(t.skills) : null,
        t.fastMode ? 1 : 0)
}

export function updateTask(id: string, patch: Partial<Task>): void {
  const colMap: Record<string, string> = {
    title: 'title',
    state: 'state',
    permissionMode: 'permission_mode',
    thinkingLevel: 'thinking_level',
    content: 'content',
    branch: 'branch',
    worktreePath: 'worktree_path',
    naviSessionId: 'worker_session_id',
    contextTokens: 'context_tokens',
    handoffMd: 'handoff_md',
    summary: 'summary',
    diffStat: 'diff_stat',
    verifyResult: 'verify_result',
    costUsd: 'cost_usd',
    tokens: 'tokens',
    turns: 'turns',
    error: 'error',
  }
  const sets: string[] = []
  const vals: (string | number | null)[] = []
  for (const [k, col] of Object.entries(colMap)) {
    if (k in patch) {
      sets.push(`${col} = ?`)
      vals.push((patch as any)[k])
    }
  }
  if ('questions' in patch) {
    sets.push('questions = ?')
    vals.push(JSON.stringify(patch.questions))
  }
  if ('skills' in patch) {
    sets.push('skills = ?')
    vals.push(patch.skills && patch.skills.length ? JSON.stringify(patch.skills) : null)
  }
  if ('disallowedTools' in patch) {
    sets.push('disallowed_tools = ?')
    vals.push(JSON.stringify(patch.disallowedTools ?? []))
  }
  if ('images' in patch) {
    sets.push('images = ?')
    vals.push(patch.images && patch.images.length ? JSON.stringify(patch.images) : null)
  }
  if ('fastMode' in patch) {
    sets.push('fast_mode = ?')
    vals.push(patch.fastMode ? 1 : 0)
  }
  if (sets.length === 0) return
  sets.push("updated_at = datetime('now')")
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

export function getTask(id: string): Task | null {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  return r ? rowToTask(r) : null
}

export function listTasks(limit = 100): Task[] {
  return db
    .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map(rowToTask)
}

export function activeTaskForProject(projectId: string): Task | null {
  const r = db
    .prepare(
      "SELECT * FROM tasks WHERE project_id = ? AND state NOT IN ('done','error','cancelled') ORDER BY created_at DESC LIMIT 1",
    )
    .get(projectId)
  return r ? rowToTask(r) : null
}

export function insertApproval(taskId: string, kind: string, payload: string): number {
  const res = db
    .prepare('INSERT INTO approvals (task_id, kind, payload) VALUES (?, ?, ?)')
    .run(taskId, kind, payload)
  return Number(res.lastInsertRowid)
}

export function resolveApprovalRow(
  id: number,
  state: 'approved' | 'rejected',
  answer?: string,
): void {
  db.prepare('UPDATE approvals SET state = ?, answer = ? WHERE id = ?').run(
    state,
    answer ?? null,
    id,
  )
}

export function listApprovals(): Approval[] {
  return db
    .prepare("SELECT * FROM approvals WHERE state = 'pending' ORDER BY id ASC")
    .all()
    .map((r: any) => ({
      id: r.id,
      taskId: r.task_id,
      kind: r.kind,
      payload: r.payload,
      state: r.state,
      createdAt: r.created_at,
    }))
}

export function addTaskEvent(
  taskId: string,
  kind: string,
  content: string,
  speaker?: TaskEvent['speaker'], // 'worker'|'lain'|'user' — 대화 트랜스크립트 화자 귀속(없으면 시스템 로그)
): void {
  db.prepare('INSERT INTO task_events (task_id, kind, content, speaker) VALUES (?, ?, ?, ?)').run(
    taskId,
    kind,
    content,
    speaker ?? null,
  )
}

export function listTaskEvents(taskId: string, limit = 500): TaskEvent[] {
  return db
    .prepare(
      'SELECT * FROM (SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
    )
    .all(taskId, limit)
    .map((r: any) => ({ taskId: r.task_id, kind: r.kind, text: r.content, speaker: r.speaker ?? undefined }))
}

/** 크래시 복원(§15b): 재시작 시점의 pending 승인은 대기자(promise)가 사라진 고아 — 일괄 거절 처리 */
export function clearOrphanApprovals(): number {
  const r = db.prepare("UPDATE approvals SET state = 'rejected' WHERE state = 'pending'").run()
  return Number(r.changes)
}

// ── 자기개선 교훈 (§22) ──
function rowToLesson(r: any): Lesson {
  return {
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    scope: r.scope === 'global' ? 'global' : 'project',
    trigger: r.trigger,
    lesson: r.lesson,
    reuseCount: r.reuse_count,
    createdAt: r.created_at,
    status: r.status === 'stale' ? 'stale' : r.status === 'archived' ? 'archived' : 'active',
    lastUsedAt: r.last_used_at ?? null,
    pinned: !!r.pinned,
    origin: r.origin === 'user' ? 'user' : 'agent',
    absorbedInto: r.absorbed_into ?? null,
    consolidationBatch: r.consolidation_batch ?? null,
    injectCount: r.inject_count ?? 0,
  }
}

export function insertLesson(l: {
  projectId: string
  taskId: string
  scope: 'project' | 'global'
  trigger: string
  lesson: string
  origin?: 'agent' | 'user' // 기본 agent(회고). user 교훈은 curator 폐기 대상에서 제외(§24 Phase3 토대)
  consolidationBatch?: string // curator umbrella 삽입 시 batch 태깅용(§자기개선 revert 토대)
}): number {
  const origin = l.origin ?? 'agent'
  // 교훈 주입 인젝션 방어 — origin='agent'(추출된 교훈)만 스캔. 단일 PC라 user 입력은 신뢰루트.
  // 매치 시 새 status 추가 없이 기존 'archived'로 즉시 격리(주입 경로에서 제외). 본문은 그대로 보존(추적용).
  const status = origin === 'agent' && scanLessonInjection(l.lesson).blocked ? 'archived' : 'active'
  const res = db
    .prepare(
      'INSERT INTO lessons (project_id, task_id, scope, trigger, lesson, origin, status, consolidation_batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(l.projectId, l.taskId, l.scope, l.trigger, l.lesson, origin, status, l.consolidationBatch ?? null)
  return Number(res.lastInsertRowid)
}

/** Navi 스폰 시 주입할 교훈 — 해당 프로젝트 교훈 + 모든 global 교훈, archived 제외.
 *  queryText(작업 내용)를 주면 §24 콘텐츠-인지 랭킹: 작업과 키워드가 겹치는 교훈을 우선(pin > 관련도 > 재사용).
 *  없으면 기존대로 pin·재사용·최신순. lessons는 소형이라 전건 fetch 후 JS 스코어링(임베딩은 후속). */
export function lessonsForProject(projectId: string, limit = 8, queryText?: string): Lesson[] {
  const rows = db
    .prepare(
      `SELECT * FROM lessons WHERE (project_id = ? OR scope = 'global') AND status != 'archived'`,
    )
    .all(projectId)
    .map(rowToLesson)
  const terms = (queryText ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
  const score = (l: Lesson): number => {
    if (terms.length === 0) return 0
    const hay = `${l.lesson} ${l.trigger}`.toLowerCase()
    return terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0)
  }
  // 적합도(fitness) — reuse_count/max(inject_count,1): 여러 번 주입됐는데 한 번도 실제 적용(reuse) 안 된
  // 교훈은 1 미만으로 떨어져 강등된다. inject_count=0(아직 한 번도 안 박힌 새 교훈)은 1.0(중립)로 둬
  // 신규 교훈이 부당하게 강등되지 않게 한다. pin·관련도·reuse 다음의 동률 분리 신호로 작용.
  const fitness = (l: Lesson): number =>
    l.injectCount > 0 ? l.reuseCount / l.injectCount : 1
  return rows
    .map((l) => ({ l, s: score(l), f: fitness(l) }))
    .sort(
      (a, b) =>
        Number(b.l.pinned) - Number(a.l.pinned) ||
        b.s - a.s ||
        b.l.reuseCount - a.l.reuseCount ||
        b.f - a.f ||
        b.l.id - a.l.id,
    )
    .slice(0, limit)
    .map((x) => x.l)
}

// 시간 기반 자동 만료(stale/archive)는 폐지했다 — 계속 배운 교훈이 쌓여야 개인화의 의미가 있고,
// 주입은 어차피 관련도순 top-K만 뽑으므로 누적은 안전하다. 정리는 시간이 아니라 명시적 신호로만 한다:
// 사용자 flag(flagLesson→archived) · 중복 병합(curator: applyConsolidation→soft-archive). (이전: applyLessonLifecycle)

/** 교훈 목록 — 인자 없으면 status 무관 최신 200건(기존 동작). opts.status가 active|stale|archived면 해당만,
 *  'all'/미지정이면 전체. opts.limit 기본 200. */
export function listLessons(opts?: { status?: Lesson['status'] | 'all'; limit?: number }): Lesson[] {
  const limit = opts?.limit ?? 200
  const status = opts?.status
  if (status && status !== 'all') {
    return db
      .prepare('SELECT * FROM lessons WHERE status = ? ORDER BY id DESC LIMIT ?')
      .all(status, limit)
      .map(rowToLesson)
  }
  return db.prepare('SELECT * FROM lessons ORDER BY id DESC LIMIT ?').all(limit).map(rowToLesson)
}

/** 주입된 교훈의 재사용 카운트 증가 + last_used_at 갱신(recency telemetry) + stale→active 되살림(§24). */
export function bumpLessonReuse(ids: number[]): void {
  if (ids.length === 0) return
  const stmt = db.prepare(
    `UPDATE lessons
     SET reuse_count = reuse_count + 1,
         last_used_at = datetime('now'),
         status = CASE WHEN status = 'archived' THEN status ELSE 'active' END
     WHERE id = ?`,
  )
  for (const id of ids) stmt.run(id)
}

/** lessonsBlock이 프롬프트에 실제 주입한 교훈의 inject_count += 1(실주입 신호). reuse_count(=선택 bump)와
 *  별개 — last_used_at·status 되살림은 건드리지 않음(그건 bumpLessonReuse 책임). 빈 배열이면 no-op. */
export function bumpLessonInject(ids: number[]): void {
  if (ids.length === 0) return
  // 주입 = '사용'으로 친다 — last_used_at 갱신. 자동 만료는 폐지했으므로(계속 배운 게 쌓여야 개인화),
  // 적용 중인 교훈은 항상 살아있다. 정리는 시간 만료가 아니라 명시적 flag·중복 병합(curator)만.
  const stmt = db.prepare(
    "UPDATE lessons SET inject_count = inject_count + 1, last_used_at = datetime('now') WHERE id = ?",
  )
  for (const id of ids) stmt.run(id)
}

export function countLessons(): number {
  return Number((db.prepare('SELECT COUNT(*) c FROM lessons').get() as any).c)
}

/** §24 Phase3 curator — consolidate 후보: agent 출처·비핀·비archived 교훈. 프롬프트 한도용 cap.
 *  pinned·origin='user'는 절대 후보 아님(불가침). */
export function lessonsForCuration(limit = 40): Lesson[] {
  return db
    .prepare(
      `SELECT * FROM lessons
       WHERE origin = 'agent' AND pinned = 0 AND status != 'archived'
       ORDER BY project_id, id`,
    )
    .all()
    .map(rowToLesson)
    .slice(0, limit)
}

/** §24 Phase3 curator — consolidate 적용: archiveIds를 자격 재검증 후 soft-archive하고 umbrella 1건 삽입.
 *  트랜잭션. pinned·origin='user'·이미 archived는 보호. 2건 미만이면 무효(병합 의미 없음). 반환: archived 수. */
export function applyConsolidation(
  archiveIds: number[],
  umbrella: { projectId: string; scope: 'project' | 'global'; trigger: string; lesson: string },
): number {
  const eligible = archiveIds.filter(
    (id) =>
      !!db
        .prepare(
          `SELECT 1 FROM lessons WHERE id = ? AND origin = 'agent' AND pinned = 0 AND status != 'archived'`,
        )
        .get(id),
  )
  if (eligible.length < 2) return 0
  // batch id로 umbrella와 흡수된 교훈들을 묶는다 — revertConsolidationBatch의 데이터 토대(§자기개선).
  const batch = crypto.randomUUID()
  db.exec('BEGIN')
  try {
    // umbrella 먼저 삽입하고 rowid 확보 → 흡수 교훈의 absorbed_into 백필에 쓴다.
    const umbrellaId = insertLesson({
      projectId: umbrella.projectId,
      taskId: 'curator',
      scope: umbrella.scope,
      trigger: umbrella.trigger,
      lesson: umbrella.lesson,
      origin: 'agent',
      consolidationBatch: batch,
    })
    const stmt = db.prepare(
      `UPDATE lessons SET status = 'archived', absorbed_into = ?, consolidation_batch = ? WHERE id = ?`,
    )
    for (const id of eligible) stmt.run(umbrellaId, batch, id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return eligible.length
}

/** §자기개선 curation revert — 한 batch의 umbrella를 archive하고 흡수된 교훈(absorbed_into=umbrellaId)을
 *  active 복구한다. 트랜잭션. 반환: 복구된 교훈 수. applyConsolidation의 역연산. */
export function revertConsolidationBatch(batch: string): number {
  const umbrellaIds = db
    .prepare(`SELECT id FROM lessons WHERE consolidation_batch = ? AND task_id = 'curator'`)
    .all(batch)
    .map((r: any) => Number(r.id))
  if (umbrellaIds.length === 0) return 0
  db.exec('BEGIN')
  let restored = 0
  try {
    const archiveUmbrella = db.prepare(`UPDATE lessons SET status = 'archived' WHERE id = ?`)
    for (const id of umbrellaIds) archiveUmbrella.run(id)
    const restore = db.prepare(
      `UPDATE lessons SET status = 'active', absorbed_into = NULL WHERE absorbed_into = ?`,
    )
    for (const id of umbrellaIds) restored += Number(restore.run(id).changes)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return restored
}

/** §24 Phase3 patch-on-use — Navi가 '주입된 교훈이 틀렸다'고 신고하면 즉시 soft-archive(복구 가능).
 *  pinned·origin='user'는 보호. 신고 자체가 신호라 judge LLM 불필요(틀린 교훈 누적 §22.2 정면 차단).
 *  반환: 실제로 보관됐는지. */
export function flagLesson(id: number): boolean {
  const r = db
    .prepare(
      `UPDATE lessons SET status = 'archived'
       WHERE id = ? AND pinned = 0 AND origin != 'user' AND status != 'archived'`,
    )
    .run(id)
  return Number(r.changes) > 0
}

/** 핀 토글 — pinned 명시. unflag와 달리 status는 건드리지 않는다(불가침 표시만). 반환: 변경됨 여부. */
export function pinLesson(id: number, pinned: boolean): boolean {
  const r = db.prepare('UPDATE lessons SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  return Number(r.changes) > 0
}

/** flagLesson 역연산 — archived 교훈을 active로 복구. pinned/origin 무관(복구는 항상 허용). 반환: 변경됨 여부. */
export function unflagLesson(id: number): boolean {
  const r = db
    .prepare(`UPDATE lessons SET status = 'active' WHERE id = ? AND status = 'archived'`)
    .run(id)
  return Number(r.changes) > 0
}

export interface HistoryHit {
  kind: 'task' | 'message'
  taskId: string | null
  when: string
  snippet: string
}

/** §24 Phase2 — 교차세션 회수. 이 프로젝트의 과거 작업(tasks)·Navi 대화(messages)를 키워드로 검색.
 *  단일 PC 규모라 LIKE 기반(한국어 2글자도 매칭). trigram FTS5는 가용 실측됨 — 데이터가 커지면 도입.
 *  project_id 스코프 강제(Navi/Lain이 다른 프로젝트 기록을 못 봄). read-only. */
export function searchHistory(projectId: string, queryText: string, limit = 8): HistoryHit[] {
  const terms = queryText
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 5)
  if (terms.length === 0) return []
  const taskWhere = terms.map(() => '(title LIKE ? OR summary LIKE ? OR content LIKE ?)').join(' OR ')
  const taskArgs: string[] = []
  for (const t of terms) {
    const w = `%${t}%`
    taskArgs.push(w, w, w)
  }
  const tasks = db
    .prepare(
      `SELECT id, title, summary, content, created_at FROM tasks
       WHERE project_id = ? AND (${taskWhere})
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(projectId, ...taskArgs, limit) as any[]
  const msgWhere = terms.map(() => 'content LIKE ?').join(' OR ')
  const msgArgs = terms.map((t) => `%${t}%`)
  const msgs = db
    .prepare(
      `SELECT task_id, content, created_at FROM messages
       WHERE project_id = ? AND scope = 'worker' AND (${msgWhere})
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(projectId, ...msgArgs, limit) as any[]
  const hits: HistoryHit[] = []
  for (const t of tasks)
    hits.push({
      kind: 'task',
      taskId: t.id,
      when: t.created_at,
      snippet: `[${t.title}] ${String(t.summary || t.content || '')
        .replace(/\s+/g, ' ')
        .slice(0, 200)}`,
    })
  for (const m of msgs)
    hits.push({
      kind: 'message',
      taskId: m.task_id ?? null,
      when: m.created_at,
      snippet: String(m.content || '')
        .replace(/\s+/g, ' ')
        .slice(0, 200),
    })
  hits.sort((a, b) => (a.when < b.when ? 1 : -1))
  return hits.slice(0, limit)
}

export function deleteAllLessons(): void {
  db.prepare('DELETE FROM lessons').run()
}

// ── 선언적 routines (§루프) — 단일 인터벌 → 다중 스케줄. additive: 기본 routine 없음·기존 스캔 불변 ──
function rowToRoutine(r: any): Routine {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    title: r.title,
    prompt: r.prompt,
    cron: r.cron,
    enabled: !!r.enabled,
    nextRunAt: r.next_run_at ?? null,
    lastRunAt: r.last_run_at ?? null,
    createdAt: r.created_at,
  }
}

/** 결정론 — cron 표현(4종)과 기준 시각으로 다음 실행 ISO를 계산. 순수 함수(LLM 없음·테스트 용이).
 *  지원: daily:HH:MM | hourly:MM | weekly:<0-6>:HH:MM | interval:<분>. 파싱 불가/미지원이면 null
 *  (=비스케줄, 안전 — throw 금지로 스케줄러를 안 깬다). 모든 계산은 UTC 기준(ISO 입출력). */
export function computeNextRun(cron: string, fromIso: string): string | null {
  const from = new Date(fromIso)
  if (isNaN(from.getTime())) return null
  const m = /^([a-z]+):(.+)$/.exec(cron.trim())
  if (!m) return null
  const kind = m[1]
  const spec = m[2]
  if (kind === 'interval') {
    const min = Number(spec)
    if (!Number.isFinite(min) || min <= 0) return null
    return new Date(from.getTime() + min * 60_000).toISOString()
  }
  if (kind === 'hourly') {
    const mm = Number(spec)
    if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null
    const next = new Date(from)
    next.setUTCSeconds(0, 0)
    next.setUTCMinutes(mm)
    if (next.getTime() <= from.getTime()) next.setUTCHours(next.getUTCHours() + 1)
    return next.toISOString()
  }
  if (kind === 'daily') {
    const t = parseHHMM(spec)
    if (!t) return null
    const next = new Date(from)
    next.setUTCSeconds(0, 0)
    next.setUTCHours(t.h, t.min)
    if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1)
    return next.toISOString()
  }
  if (kind === 'weekly') {
    const parts = spec.split(':')
    if (parts.length !== 3) return null
    const dow = Number(parts[0])
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null
    const t = parseHHMM(`${parts[1]}:${parts[2]}`)
    if (!t) return null
    const next = new Date(from)
    next.setUTCSeconds(0, 0)
    next.setUTCHours(t.h, t.min)
    let delta = (dow - next.getUTCDay() + 7) % 7
    if (delta === 0 && next.getTime() <= from.getTime()) delta = 7
    next.setUTCDate(next.getUTCDate() + delta)
    return next.toISOString()
  }
  return null
}

function parseHHMM(s: string): { h: number; min: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return { h, min }
}

export function insertRoutine(r: {
  projectId?: string | null
  title: string
  prompt: string
  cron: string
}): string {
  const id = crypto.randomUUID()
  const nextRun = computeNextRun(r.cron, new Date().toISOString())
  db.prepare(
    'INSERT INTO routines (id, project_id, title, prompt, cron, next_run_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, r.projectId ?? null, r.title, r.prompt, r.cron, nextRun)
  return id
}

export function listRoutines(): Routine[] {
  return db.prepare('SELECT * FROM routines ORDER BY created_at DESC').all().map(rowToRoutine)
}

/** enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= now(또는 인자) 인 루틴. 디스패치 대상. */
export function listDueRoutines(nowIso?: string): Routine[] {
  const now = nowIso ?? new Date().toISOString()
  return db
    .prepare(
      'SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC',
    )
    .all(now)
    .map(rowToRoutine)
}

/** enabled 토글. 켤 때 next_run_at이 과거/NULL이면 computeNextRun으로 재계산(즉시 폭주 방지·재스케줄). */
export function setRoutineEnabled(id: string, enabled: boolean): void {
  if (enabled) {
    const r = db.prepare('SELECT cron, next_run_at FROM routines WHERE id = ?').get(id) as any
    if (r) {
      const now = new Date().toISOString()
      const stale = !r.next_run_at || String(r.next_run_at) <= now
      const next = stale ? computeNextRun(r.cron, now) : r.next_run_at
      db.prepare('UPDATE routines SET enabled = 1, next_run_at = ? WHERE id = ?').run(next, id)
      return
    }
  }
  db.prepare('UPDATE routines SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function deleteRoutine(id: string): void {
  db.prepare('DELETE FROM routines WHERE id = ?').run(id)
}

/** 디스패치 직후 호출 — last_run_at=now, next_run_at=computeNextRun(cron, now). 중복 실행 차단. */
export function markRoutineRan(id: string, nowIso?: string): void {
  const now = nowIso ?? new Date().toISOString()
  const r = db.prepare('SELECT cron FROM routines WHERE id = ?').get(id) as any
  if (!r) return
  const next = computeNextRun(r.cron, now)
  db.prepare('UPDATE routines SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(now, next, id)
}

// ── 외부 MCP 서버 (CC-FEATURES P1) — Routine과 동형 CRUD. 시크릿(env/headers)은 로그 금지(§9-6) ──
const MCP_RESERVED = new Set(['lain'])

function mcpJsonArray(s: unknown): string[] {
  try {
    const v = JSON.parse(String(s))
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
function mcpJsonObject(s: unknown): Record<string, string> {
  try {
    const v = JSON.parse(String(s))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function rowToMcpServer(r: any): McpServer {
  return {
    id: r.id,
    name: r.name,
    transport: r.transport,
    command: r.command ?? null,
    args: mcpJsonArray(r.args),
    env: mcpJsonObject(r.env),
    url: r.url ?? null,
    headers: mcpJsonObject(r.headers),
    targets: String(r.targets ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as McpServer['targets'],
    enabled: !!r.enabled,
    createdAt: r.created_at,
  }
}

/** 이름 검증 — 도구 접두사로 쓰여 안전 문자만. 'lain'(내부 서버) 예약·중복 차단. 에러 문자열 또는 null. */
export function validateMcpName(name: string, exceptId?: string): string | null {
  const n = (name ?? '').trim()
  if (!n) return '이름이 필요하다'
  if (!/^[A-Za-z0-9_-]+$/.test(n)) return '이름은 영문·숫자·_·- 만 가능'
  if (MCP_RESERVED.has(n.toLowerCase())) return "'lain'은 예약된 이름이다"
  const dup = db.prepare('SELECT id FROM mcp_servers WHERE lower(name) = lower(?)').get(n) as any
  if (dup && dup.id !== exceptId) return '같은 이름의 서버가 이미 있다'
  return null
}

export function insertMcpServer(s: McpServerInput): { id?: string; error?: string } {
  const err = validateMcpName(s.name)
  if (err) return { error: err }
  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, command, args, env, url, headers, targets, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    id,
    s.name.trim(),
    s.transport,
    s.command ?? null,
    JSON.stringify(s.args ?? []),
    JSON.stringify(s.env ?? {}),
    s.url ?? null,
    JSON.stringify(s.headers ?? {}),
    (s.targets ?? ['manager', 'navi']).join(','),
  )
  return { id }
}

export function listMcpServers(): McpServer[] {
  return db.prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all().map(rowToMcpServer)
}

export function updateMcpServer(
  id: string,
  patch: Partial<McpServerInput>,
): { ok: boolean; error?: string } {
  if (patch.name !== undefined) {
    const err = validateMcpName(patch.name, id)
    if (err) return { ok: false, error: err }
  }
  const cur = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as any
  if (!cur) return { ok: false, error: '없는 서버' }
  const next = {
    name: patch.name !== undefined ? patch.name.trim() : cur.name,
    transport: patch.transport ?? cur.transport,
    command: patch.command !== undefined ? patch.command : cur.command,
    args: patch.args !== undefined ? JSON.stringify(patch.args) : cur.args,
    env: patch.env !== undefined ? JSON.stringify(patch.env) : cur.env,
    url: patch.url !== undefined ? patch.url : cur.url,
    headers: patch.headers !== undefined ? JSON.stringify(patch.headers) : cur.headers,
    targets: patch.targets !== undefined ? patch.targets.join(',') : cur.targets,
  }
  db.prepare(
    `UPDATE mcp_servers SET name=?, transport=?, command=?, args=?, env=?, url=?, headers=?, targets=? WHERE id=?`,
  ).run(
    next.name,
    next.transport,
    next.command ?? null,
    next.args,
    next.env,
    next.url ?? null,
    next.headers,
    next.targets,
    id,
  )
  return { ok: true }
}

export function setMcpServerEnabled(id: string, enabled: boolean): void {
  db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function deleteMcpServer(id: string): void {
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
}

/** 벤치 정리용 — 임시 프로젝트와 모든 부속을 제거(FK 순서 준수) */
export function deleteProject(projectId: string): void {
  const taskIds = db
    .prepare('SELECT id FROM tasks WHERE project_id = ?')
    .all(projectId)
    .map((r: any) => r.id)
  for (const tid of taskIds) {
    db.prepare('DELETE FROM approvals WHERE task_id = ?').run(tid)
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(tid)
  }
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(projectId)
  db.prepare('DELETE FROM project_status WHERE project_id = ?').run(projectId)
  db.prepare('DELETE FROM lessons WHERE project_id = ?').run(projectId)
  db.prepare('DELETE FROM messages WHERE project_id = ?').run(projectId)
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
}

// ── 평가 하네스 (§23) ──
export function insertBenchResult(runId: string, r: BenchTaskResult): void {
  db.prepare(
    `INSERT INTO bench_runs (run_id, bench_task, condition, success, verify_first_pass, turns, cost_usd, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    r.benchTask,
    r.condition,
    r.success ? 1 : 0,
    r.verifyFirstPass ? 1 : 0,
    r.turns,
    r.costUsd,
    r.tokens,
  )
}

export function getSetting(key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
  return r ? r.value : null
}

/** §9 signal review wake-gate 스냅샷 — 직전 리뷰가 본 다이제스트 해시. 같은 상태 반복 리뷰 차단
 *  (autoPriority 해시가드와 동형). settings 위 래퍼. */
export function getWakeGateSnapshot(): string | null {
  return getSetting('wake_gate_snapshot')
}
export function setWakeGateSnapshot(hash: string): void {
  setSetting('wake_gate_snapshot', hash)
}

// 저널에 남기지 않을 고빈도/일회성 키 — 폴·스캔마다 갱신돼 append-only 저널을 단조 비대화시킨다.
// 모두 부팅 시 재생성되거나 변화감지용이라 복구 가치가 없다(저널은 telegram 토큰·world_state 등 '진짜 잃으면 안 되는 것'만).
const JOURNAL_SKIP_SETTINGS = new Set([
  'telegram_offset', // 폴마다
  'dock_briefing', // 브리핑 전문, ~5분마다 / 부팅 시 briefNow로 재생성
  'auto_priority_wake_snapshot', // 스캔마다 프로젝트 스냅샷 JSON
  'auto_priority_last_digest', // 변화감지 해시
  'lesson_curator_last_hash', // 변화감지 해시
  'wake_gate_snapshot', // 변화감지 해시
  'db_corrupt_streak', // 손상 카운터(이걸 저널링하면 손상 복구를 방해)
  'db_corrupt_pending_notify', // 일회성 통지 플래그
])

export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
  // 설정도 저널(진실원천)에 — WAL 폐기·손상 복구로 settings가 유실돼 텔레그램 봇이 멈춘 사례 방지.
  if (!JOURNAL_SKIP_SETTINGS.has(key)) journalSetting(key, value)
}

// ── 타입드 설정 뷰 (§9b 티어링 매핑 + cap) — settings 테이블 위 헬퍼 ──

const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const

function asTier(v: string | null, fallback: ModelTier): ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(v ?? '') ? (v as ModelTier) : fallback
}

// 어깨너머 — 기본 민감앱 블랙리스트(앱명/창 제목 소문자 부분일치). 사용자가 설정에서 덮어씀.
const DEFAULT_SENSITIVE_APPS = [
  '1password',
  'bitwarden',
  'keepass',
  'lastpass',
  'dashlane',
  '은행',
  '뱅킹',
]

export function getSettings(): LainSettings {
  return {
    concurrencyCap: Math.max(1, Number(getSetting('concurrency_cap') ?? '2') || 2),
    naviModel: asTier(getSetting('worker_model'), 'sonnet'),
    managerModel: asTier(getSetting('manager_model'), 'sonnet'),
    judgeModel: asTier(getSetting('judge_model'), 'sonnet'),
    managerPermissionMode: (['default', 'acceptEdits', 'plan', 'bypass'] as readonly string[]).includes(
      getSetting('manager_permission_mode') ?? '',
    )
      ? (getSetting('manager_permission_mode') as TaskPermissionMode)
      : 'acceptEdits',
    managerEffort: (['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as readonly string[]).includes(
      getSetting('manager_effort') ?? '',
    )
      ? (getSetting('manager_effort') as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode')
      : 'high',
    managerEffortAuto: (getSetting('manager_effort_auto') ?? '1') === '1',
    managerFastMode: (getSetting('manager_fast_mode') ?? '0') === '1',
    defaultTaskMode: (['auto', 'autonomous', 'interactive'] as readonly string[]).includes(
      getSetting('default_task_mode') ?? '',
    )
      ? (getSetting('default_task_mode') as 'auto' | 'autonomous' | 'interactive')
      : 'auto',
    overlayMonitoringEnabled: (getSetting('overlay_monitoring_enabled') ?? '0') === '1',
    monitorSensitiveApps: (() => {
      const raw = getSetting('monitor_sensitive_apps')
      if (raw == null) return [...DEFAULT_SENSITIVE_APPS]
      try {
        const v = JSON.parse(raw)
        return Array.isArray(v) ? v.map(String) : [...DEFAULT_SENSITIVE_APPS]
      } catch {
        return [...DEFAULT_SENSITIVE_APPS]
      }
    })(),
    monitorCooldownSec: Math.max(5, Number(getSetting('monitor_cooldown_sec') ?? '30') || 30),
    monitorPollMs: Math.max(500, Number(getSetting('monitor_poll_ms') ?? '1500') || 1500),
    scanIntervalMin: Math.max(0, Number(getSetting('scan_interval_min') ?? '10') || 0),
    closeToTray: (getSetting('close_to_tray') ?? '1') === '1',
    autoStart: (getSetting('auto_start') ?? '0') === '1',
    autoPriority: (getSetting('auto_priority') ?? '0') === '1',
    lessonCurator: (getSetting('lesson_curator') ?? '0') === '1',
    signalReview: (getSetting('signal_review') ?? '0') === '1',
    idleMin: Math.max(1, Number(getSetting('idle_min') ?? '3') || 3),
    routinesEnabled: (getSetting('routines_enabled') ?? '0') === '1',
    ccHooksEnabled: (getSetting('cc_hooks_enabled') ?? '0') === '1',
    telegramEnabled: (getSetting('telegram_enabled') ?? '0') === '1',
    telegramBotToken: getSetting('telegram_bot_token') ?? '',
    telegramChatId: getSetting('telegram_chat_id') ?? '',
    groqApiKey: getSetting('groq_api_key') ?? '',
    contextCompactThreshold: Math.max(0, Number(getSetting('context_compact_threshold') ?? '400000') || 0),
    naviHandoffThreshold: Math.max(0, Number(getSetting('navi_handoff_threshold') ?? '150000') || 0),
    turnWatchdogMin: Math.max(0, Number(getSetting('turn_watchdog_min') ?? '10') || 0),
    skillsEnabled: (getSetting('skills_enabled') ?? '0') === '1',
    curatedPlugins: (() => {
      const raw = getSetting('curated_plugins')
      if (raw == null) return [...CURATED_PLUGIN_NAMES]
      try {
        const v = JSON.parse(raw)
        return Array.isArray(v) ? v.map(String) : [...CURATED_PLUGIN_NAMES]
      } catch {
        return [...CURATED_PLUGIN_NAMES]
      }
    })(),
    discordEnabled: (getSetting('discord_enabled') ?? '0') === '1',
    discordBotToken: getSetting('discord_bot_token') ?? '',
    discordGuildId: getSetting('discord_guild_id') ?? '',
    discordVoiceChannelId: getSetting('discord_voice_channel_id') ?? '',
    discordUserId: getSetting('discord_user_id') ?? '',
    discordTtsVoice: getSetting('discord_tts_voice') ?? '',
    discordVoiceMode: getSetting('discord_voice_mode') === 'wake' ? 'wake' : 'always',
    ttsBackend:
      getSetting('tts_backend') === 'gpt-sovits'
        ? 'gpt-sovits'
        : getSetting('tts_backend') === 'supertonic'
          ? 'supertonic'
          : 'edge',
    gptSovitsUrl: getSetting('gpt_sovits_url') ?? 'http://127.0.0.1:9880',
    gptSovitsRefAudio: getSetting('gpt_sovits_ref_audio') ?? '',
    gptSovitsRefText: getSetting('gpt_sovits_ref_text') ?? '',
    gptSovitsRefLang: getSetting('gpt_sovits_ref_lang') ?? 'ko',
    supertonicVoice: (() => {
      const v = getSetting('supertonic_voice')
      return v && /^[FM][1-9]$/.test(v) ? v : 'F5'
    })(),
    supertonicSpeed: Math.max(0.5, Math.min(2.0, Number(getSetting('supertonic_speed') ?? '1.05') || 1.05)),
    supertonicStep: Math.max(2, Math.min(16, Number(getSetting('supertonic_step') ?? '8') || 8)),
    updateNotify: (getSetting('update_notify') ?? '1') === '1',
    updateAutoDownload: (getSetting('update_auto_download') ?? '0') === '1',
  }
}

export function saveSettings(patch: Partial<LainSettings>): LainSettings {
  if (patch.concurrencyCap !== undefined)
    setSetting('concurrency_cap', String(Math.max(1, Math.floor(patch.concurrencyCap) || 1)))
  if (patch.naviModel !== undefined) setSetting('worker_model', asTier(patch.naviModel, 'sonnet'))
  if (patch.managerModel !== undefined)
    setSetting('manager_model', asTier(patch.managerModel, 'sonnet'))
  if (patch.judgeModel !== undefined) setSetting('judge_model', asTier(patch.judgeModel, 'sonnet'))
  if (patch.managerPermissionMode !== undefined)
    setSetting('manager_permission_mode', patch.managerPermissionMode)
  if (patch.managerEffort !== undefined) setSetting('manager_effort', patch.managerEffort)
  if (patch.managerEffortAuto !== undefined)
    setSetting('manager_effort_auto', patch.managerEffortAuto ? '1' : '0')
  if (patch.managerFastMode !== undefined)
    setSetting('manager_fast_mode', patch.managerFastMode ? '1' : '0')
  if (patch.defaultTaskMode !== undefined) setSetting('default_task_mode', patch.defaultTaskMode)
  if (patch.updateNotify !== undefined) setSetting('update_notify', patch.updateNotify ? '1' : '0')
  if (patch.updateAutoDownload !== undefined)
    setSetting('update_auto_download', patch.updateAutoDownload ? '1' : '0')
  if (patch.overlayMonitoringEnabled !== undefined)
    setSetting('overlay_monitoring_enabled', patch.overlayMonitoringEnabled ? '1' : '0')
  if (patch.monitorSensitiveApps !== undefined)
    setSetting('monitor_sensitive_apps', JSON.stringify(patch.monitorSensitiveApps.map(String)))
  if (patch.monitorCooldownSec !== undefined)
    setSetting('monitor_cooldown_sec', String(Math.max(5, Math.floor(patch.monitorCooldownSec) || 30)))
  if (patch.monitorPollMs !== undefined)
    setSetting('monitor_poll_ms', String(Math.max(500, Math.floor(patch.monitorPollMs) || 1500)))
  if (patch.scanIntervalMin !== undefined)
    setSetting('scan_interval_min', String(Math.max(0, Math.floor(patch.scanIntervalMin) || 0)))
  if (patch.closeToTray !== undefined) setSetting('close_to_tray', patch.closeToTray ? '1' : '0')
  if (patch.autoStart !== undefined) setSetting('auto_start', patch.autoStart ? '1' : '0')
  if (patch.autoPriority !== undefined)
    setSetting('auto_priority', patch.autoPriority ? '1' : '0')
  if (patch.lessonCurator !== undefined)
    setSetting('lesson_curator', patch.lessonCurator ? '1' : '0')
  if (patch.signalReview !== undefined)
    setSetting('signal_review', patch.signalReview ? '1' : '0')
  if (patch.idleMin !== undefined)
    setSetting('idle_min', String(Math.max(1, Math.floor(patch.idleMin) || 3)))
  if (patch.routinesEnabled !== undefined)
    setSetting('routines_enabled', patch.routinesEnabled ? '1' : '0')
  if (patch.ccHooksEnabled !== undefined)
    setSetting('cc_hooks_enabled', patch.ccHooksEnabled ? '1' : '0')
  if (patch.curatedPlugins !== undefined)
    setSetting('curated_plugins', JSON.stringify(patch.curatedPlugins))
  if (patch.telegramEnabled !== undefined)
    setSetting('telegram_enabled', patch.telegramEnabled ? '1' : '0')
  if (patch.telegramBotToken !== undefined)
    setSetting('telegram_bot_token', patch.telegramBotToken.trim())
  if (patch.telegramChatId !== undefined)
    setSetting('telegram_chat_id', patch.telegramChatId.trim())
  if (patch.groqApiKey !== undefined)
    setSetting('groq_api_key', patch.groqApiKey.trim())
  if (patch.contextCompactThreshold !== undefined)
    setSetting(
      'context_compact_threshold',
      String(Math.max(0, Math.floor(patch.contextCompactThreshold) || 0)),
    )
  if (patch.naviHandoffThreshold !== undefined)
    setSetting(
      'navi_handoff_threshold',
      String(Math.max(0, Math.floor(patch.naviHandoffThreshold) || 0)),
    )
  if (patch.turnWatchdogMin !== undefined)
    setSetting('turn_watchdog_min', String(Math.max(0, Math.floor(patch.turnWatchdogMin) || 0)))
  if (patch.skillsEnabled !== undefined)
    setSetting('skills_enabled', patch.skillsEnabled ? '1' : '0')
  if (patch.discordEnabled !== undefined)
    setSetting('discord_enabled', patch.discordEnabled ? '1' : '0')
  if (patch.discordBotToken !== undefined)
    setSetting('discord_bot_token', patch.discordBotToken.trim())
  if (patch.discordGuildId !== undefined)
    setSetting('discord_guild_id', patch.discordGuildId.trim())
  if (patch.discordVoiceChannelId !== undefined)
    setSetting('discord_voice_channel_id', patch.discordVoiceChannelId.trim())
  if (patch.discordUserId !== undefined)
    setSetting('discord_user_id', patch.discordUserId.trim())
  if (patch.discordTtsVoice !== undefined)
    setSetting('discord_tts_voice', patch.discordTtsVoice.trim())
  if (patch.discordVoiceMode !== undefined)
    setSetting('discord_voice_mode', patch.discordVoiceMode === 'wake' ? 'wake' : 'always')
  if (patch.ttsBackend !== undefined)
    setSetting(
      'tts_backend',
      patch.ttsBackend === 'gpt-sovits' || patch.ttsBackend === 'supertonic' ? patch.ttsBackend : 'edge',
    )
  if (patch.gptSovitsUrl !== undefined) setSetting('gpt_sovits_url', patch.gptSovitsUrl.trim())
  if (patch.gptSovitsRefAudio !== undefined)
    setSetting('gpt_sovits_ref_audio', patch.gptSovitsRefAudio.trim())
  if (patch.gptSovitsRefText !== undefined)
    setSetting('gpt_sovits_ref_text', patch.gptSovitsRefText.trim())
  if (patch.gptSovitsRefLang !== undefined)
    setSetting('gpt_sovits_ref_lang', patch.gptSovitsRefLang.trim() || 'ko')
  if (patch.supertonicVoice !== undefined)
    setSetting('supertonic_voice', /^[FM][1-9]$/.test(patch.supertonicVoice) ? patch.supertonicVoice : 'F5')
  if (patch.supertonicSpeed !== undefined)
    setSetting('supertonic_speed', String(Math.max(0.5, Math.min(2.0, patch.supertonicSpeed || 1.05))))
  if (patch.supertonicStep !== undefined)
    setSetting('supertonic_step', String(Math.max(2, Math.min(16, Math.floor(patch.supertonicStep) || 8))))
  // 설정 영속성 보장 — WAL을 메인 DB에 즉시 병합한다.
  // deploy 시 Stop-Process -Force(강제종료) 후 recoverCorruptWal이 WAL을 폐기할 수 있어
  // 체크포인트 안 된 설정이 사라지는 문제를 차단한다. saveSettings는 호출 빈도가 낮아 FULL 모드 OK.
  try { db.exec('PRAGMA wal_checkpoint(FULL)') } catch { /* 무시 */ }
  return getSettings()
}
