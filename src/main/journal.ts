// 영속 저널(진실의 출처, PLAN §6 보강) — 매 대화 턴을 append-only NDJSON에 즉시 fsync로 기록한다.
// 동기: SQLite WAL은 강제종료·손상 복구로 통째로 폐기될 수 있어(오늘 기록 유실의 정체였다), 기록의 진실원천을
// SQLite와 분리한다. 부팅 시 store.reconcileFromJournal이 이 저널에서 DB에 빠진 기록을 복원한다.
// 클로드 코드가 매 턴을 JSONL 세션 파일에 박는 것과 같은 발상 — DB는 질의용 인덱스, 저널이 원천.
// 이 모듈은 paths(DATA_DIR)만 의존한다 — store를 import하지 않아 순환참조가 없다.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'

export type JournalMsg = {
  t: 'msg'
  uid: string
  scope: string
  projectId: string | null
  role: string
  content: string
  conversationId: string | null
  attachments: string | null // 직렬화된 첨부(메타만; 큰 blob은 store.serializeAttachments가 이미 제거)
  origin: string | null // 'telegram' | null
  createdAt: string
}
export type JournalConv = {
  t: 'conv'
  id: string
  target: string
  title: string
  sdkSessionId: string | null // resume 연속성 — 컨텍스트 초기화에도 세션이 이어지게
  worldState?: string | null // 무한세션 — 압축된 월드모델(DB 유실/WAL 폐기에도 누적 맥락 보존). 옛 엔트리엔 없음(옵셔널)
  handoffMd?: string | null // Navi 유한세션 핸드오프 md(DB 유실/WAL 폐기에도 보존). 옛 엔트리엔 없음(옵셔널)
  createdAt: string
}
// 설정(config) — 텔레그램 토큰·채팅ID·모델 등. WAL 폐기·손상 복구로 settings가 유실돼 봇이 멈춘 사례(2026-06-19)
// 방지용. history.ndjson은 lain.sqlite와 같은 로컬 데이터 저장소(외부 전송 안 함)라 토큰 포함이 노출면을 키우지 않는다.
export type JournalSetting = {
  t: 'set'
  key: string
  value: string
}
// 삭제 톰스톤 — 세션(대화) 삭제를 영속화한다. append-only 저널이라 기록을 지울 수 없어, 삭제를 별도 마커로 남긴다.
// reconcile이 이 마커를 보고 해당 대화·메시지를 복원 대상에서 제외(+ 이미 DB에 남은 행도 제거)한다.
// → 세션 삭제가 DB 유실/WAL 폐기/재부팅에도 유지된다(이전엔 reconcile이 저널에서 통째로 되살려 삭제가 무효였다).
export type JournalDelete = {
  t: 'del'
  target: 'conv'
  id: string
}
export type JournalEntry = JournalMsg | JournalConv | JournalSetting | JournalDelete

function journalPath(): string {
  return path.join(DATA_DIR, 'history.ndjson')
}

// append + fsync — 앱 강제종료는 OS 버퍼가 지켜주지만, OS 크래시·전원유실까지 견디게 fsync한다.
// 사람 대화 빈도라 per-write fsync 비용은 무시 가능. 저널 기록 실패는 삼킨다(DB 기록은 별개로 진행).
function appendLine(obj: JournalEntry): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const fd = fs.openSync(journalPath(), 'a')
    try {
      fs.writeSync(fd, JSON.stringify(obj) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* 저널 기록 실패는 치명적이지 않게 삼킨다 — 단 그만큼 내구성은 약해진다 */
  }
}

export function journalMessage(rec: Omit<JournalMsg, 't'>): void {
  appendLine({ t: 'msg', ...rec })
}

export function journalConversation(rec: Omit<JournalConv, 't'>): void {
  appendLine({ t: 'conv', ...rec })
}

export function journalSetting(key: string, value: string): void {
  appendLine({ t: 'set', key, value })
}

// 대화 삭제 톰스톤 — fsync로 즉시 영속화한다(store.deleteConversation이 DB 행 삭제 전에 호출).
export function journalDelete(id: string): void {
  appendLine({ t: 'del', target: 'conv', id })
}

// 저널 전체를 읽어 엔트리 배열로 — 깨진(torn) 마지막 줄·잘못된 줄은 건너뛴다(append 중 강제종료 내성).
export function readJournalEntries(): JournalEntry[] {
  let raw: string
  try {
    raw = fs.readFileSync(journalPath(), 'utf8')
  } catch {
    return [] // 파일 없음 — 빈 저널
  }
  const out: JournalEntry[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const e = JSON.parse(s)
      if (e && (e.t === 'msg' || e.t === 'conv' || e.t === 'set' || e.t === 'del'))
        out.push(e as JournalEntry)
    } catch {
      /* 깨진 줄(보통 마지막) — 건너뛴다 */
    }
  }
  return out
}
