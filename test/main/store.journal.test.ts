import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 고정(격리).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-journal-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import {
  initStore,
  closeStore,
  addMessage,
  addNaviMessage,
  listConversationMessages,
  deleteConversation,
  ensureActiveConversation,
  setConversationSdkSession,
  conversationSdkSession,
  reconcileFromJournal,
  setSetting,
  getSetting,
  setConversationWorldState,
  getConversationWorldState,
  listConversationDialogue,
} from '../../src/main/store'
import { compactJournal, readJournalEntries, type JournalConv, type JournalMsg } from '../../src/main/journal'

// DB(메인+WAL+SHM)를 통째로 날린다 — 손상 복구가 WAL을 폐기하거나 파일이 유실되는 최악의 상황을 모사.
// 저널(history.ndjson)은 별도 파일이라 살아남아야 하고, 재오픈 시 reconcile이 이를 DB로 복원해야 한다.
function nukeDb(): void {
  closeStore()
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(path.join(DATA_DIR, 'lain.sqlite' + ext), { force: true })
    } catch {
      /* 무시 */
    }
  }
}

beforeEach(() => {
  // 이전 테스트가 연 핸들을 먼저 닫는다 — 안 닫으면 Windows에서 파일 잠금이 남아 nukeDb의 삭제가
  // 간헐 실패하고 데이터가 살아남아 위양성이 된다(closeStore는 미오픈/이중호출에도 안전).
  closeStore()
  initStore()
})

afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* 무시 */
  }
})

describe('저널=진실원천 — DB 유실에도 대화 기록이 살아남는다', () => {
  it('addMessage는 저널에도 기록되고, DB가 통째로 날아가도 재오픈 reconcile로 복원된다', () => {
    const cid = ensureActiveConversation('manager')
    addMessage('manager', 'user', '오늘 친 대화', cid)
    addMessage('manager', 'assistant', '레인의 응답', cid)

    nukeDb()
    initStore() // recover/reindex 후 reconcileFromJournal이 저널에서 복원해야 한다

    const after = listConversationMessages(cid)
    expect(after.some((m) => m.content === '오늘 친 대화')).toBe(true)
    expect(after.some((m) => m.content === '레인의 응답')).toBe(true)
  })

  it('addWorkerMessage(워커 채팅)도 저널로 복원된다', () => {
    const cid = ensureActiveConversation('proj-x')
    addNaviMessage('proj-x', 'user', '워커야 빌드해줘', cid)

    nukeDb()
    initStore()

    expect(listConversationMessages(cid).some((m) => m.content === '워커야 빌드해줘')).toBe(true)
  })

  it('sdk_session_id(resume 연속성)도 저널로 복원된다 — 컨텍스트가 초기화돼도 세션이 이어진다', () => {
    const cid = ensureActiveConversation('manager')
    setConversationSdkSession(cid, 'sess-xyz')

    nukeDb()
    initStore()

    expect(conversationSdkSession(cid)).toBe('sess-xyz')
  })

  it('world_state(무한세션 월드모델)도 저널로 복원된다 — 압축 누적 맥락이 DB 유실에도 살아남는다', () => {
    const cid = ensureActiveConversation('manager')
    setConversationWorldState(cid, '## 방침\n- 한국어\n## 진행 스레드\n- webapp 백엔드 슬림화')

    nukeDb()
    initStore()

    expect(getConversationWorldState(cid)).toContain('webapp 백엔드 슬림화')
  })

  it('listConversationDialogue는 도구 로그를 빼고 user/assistant 원문만 반환(압축 입력 잠식 방지)', () => {
    const cid = ensureActiveConversation('manager')
    addMessage('manager', 'user', '질문', cid)
    addMessage('manager', 'tool', '도구로그1', cid)
    addMessage('manager', 'tool', '도구로그2', cid)
    addMessage('manager', 'assistant', '답변', cid)

    const dia = listConversationDialogue(cid)
    expect(dia.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true) // tool 절대 미포함
    expect(dia.some((m) => m.content === '질문')).toBe(true)
    expect(dia.some((m) => m.content === '답변')).toBe(true)
    expect(dia.some((m) => m.content === '도구로그1')).toBe(false)
    expect(dia.some((m) => m.content === '도구로그2')).toBe(false)
  })

  it('reconcile은 멱등 — 두 번 돌려도 메시지가 중복되지 않는다', () => {
    const cid = ensureActiveConversation('manager')
    addMessage('manager', 'user', '딱 한 번', cid)

    nukeDb()
    initStore() // 1차 복원
    reconcileFromJournal() // 2차 — 중복 삽입 금지

    const hits = listConversationMessages(cid).filter((m) => m.content === '딱 한 번')
    expect(hits).toHaveLength(1)
  })

  it('설정(텔레그램 토큰·채팅ID 등)도 저널로 복원된다 — settings 유실에도 봇 설정이 살아남는다', () => {
    setSetting('telegram_bot_token', 'SECRET-46chars-xxxxxxxxxxxxxxxxxxxxxxxxx')
    setSetting('telegram_chat_id', '8700990285')
    setSetting('telegram_enabled', '1')
    nukeDb()
    initStore()
    expect(getSetting('telegram_bot_token')).toBe('SECRET-46chars-xxxxxxxxxxxxxxxxxxxxxxxxx')
    expect(getSetting('telegram_chat_id')).toBe('8700990285')
    expect(getSetting('telegram_enabled')).toBe('1')
  })

  it('telegram_offset는 고빈도라 저널 제외 — DB 유실 시 복원되지 않는다', () => {
    setSetting('telegram_offset', '999999')
    nukeDb()
    initStore()
    expect(getSetting('telegram_offset')).toBeNull()
  })

  it('reconcile은 저널 최신값을 적용한다 — 최근 변경(저널에도 반영됨)은 그대로 유지된다', () => {
    setSetting('manager_model', 'opus')
    nukeDb()
    initStore() // 저널에서 'opus' 복원
    setSetting('manager_model', 'sonnet') // 이후 변경 — DB·저널 모두 최신값 sonnet
    reconcileFromJournal() // 저널 최신값도 sonnet → 'opus'로 되돌리지 않는다
    expect(getSetting('manager_model')).toBe('sonnet')
  })

  it('reconcile은 stale한 DB 설정을 저널 최신값으로 되살린다 — WAL 폐기로 옛 체크포인트로 회귀한 경우(설정 리셋의 정체)', () => {
    // DB·저널에 옛 값(sonnet) — 마지막 체크포인트 상태
    setSetting('manager_model', 'sonnet')
    // 새 값(opus)으로 바꿨지만 그 DB 변경이 WAL에만 있다가 강제종료+WAL폐기로 사라졌다고 가정.
    // 저널엔 fsync로 opus가 남으므로, 저널에 직접 append해 'DB=sonnet인데 저널 최신=opus' 상황을 만든다.
    fs.appendFileSync(
      path.join(DATA_DIR, 'history.ndjson'),
      JSON.stringify({ t: 'set', key: 'manager_model', value: 'opus' }) + '\n',
    )
    // 부팅 reconcile — 키가 DB에 이미 있어도(sonnet) 저널 최신값(opus)으로 복원해야 한다.
    // (missing-only였을 땐 키가 존재해 스킵 → sonnet으로 고착 = 설정이 옛값으로 '리셋'되던 버그)
    reconcileFromJournal()
    expect(getSetting('manager_model')).toBe('opus')
  })

  it('deleteConversation은 톰스톤으로 영속 — DB가 통째로 날아가도 재부팅 reconcile이 되살리지 않는다', () => {
    const del = ensureActiveConversation('proj-del')
    addNaviMessage('proj-del', 'user', '지워질 메시지', del)
    const keep = ensureActiveConversation('proj-keep')
    addNaviMessage('proj-keep', 'user', '남아야 할 메시지', keep)

    deleteConversation(del)
    expect(listConversationMessages(del).some((m) => m.content === '지워질 메시지')).toBe(false)

    nukeDb()
    initStore() // 저널엔 지워진 대화의 conv/msg 엔트리 + del 톰스톤이 함께 있다

    expect(listConversationMessages(del).some((m) => m.content === '지워질 메시지')).toBe(false) // 안 되살아남
    expect(listConversationMessages(keep).some((m) => m.content === '남아야 할 메시지')).toBe(true) // 대조군 보존
  })

  it('reconcile은 톰스톤된 대화를 DB에 행이 남아 있어도 제거한다 (enforce, 멱등)', () => {
    const cid = ensureActiveConversation('proj-enforce')
    addNaviMessage('proj-enforce', 'user', '강제 삭제 대상', cid)
    // del 톰스톤만 저널에 직접 append — DB엔 행이 그대로 남은 상황(WAL에만 있던 DB 삭제가 유실된 경우) 모사
    fs.appendFileSync(
      path.join(DATA_DIR, 'history.ndjson'),
      JSON.stringify({ t: 'del', target: 'conv', id: cid }) + '\n',
    )
    reconcileFromJournal()
    expect(listConversationMessages(cid)).toHaveLength(0)
    reconcileFromJournal() // 멱등 — 두 번 돌려도 안전
    expect(listConversationMessages(cid)).toHaveLength(0)
  })

  it('기존(저널 이전) 메시지도 1회 백필로 저널에 올라가 DB 유실에서 복원된다', () => {
    const cid = ensureActiveConversation('manager')
    addMessage('manager', 'user', '백필 대상', cid)
    // 저널 도입 이전 상태를 모사: 저널 파일 삭제 + 백필 플래그 해제 → 재오픈 시 backfill이 DB→저널로 1회 올림
    fs.rmSync(path.join(DATA_DIR, 'history.ndjson'), { force: true })
    setSetting('journal_backfilled', '0')
    closeStore()
    initStore()
    // 백필된 저널만 있는 상태에서 DB가 통째로 날아가도 복원돼야 한다
    nukeDb()
    initStore()
    expect(listConversationMessages(cid).some((m) => m.content === '백필 대상')).toBe(true)
  })

  it('compactJournal은 삭제대화·톰스톤·설정중복·msg중복을 제거하고 live conv를 원순서로 보존한다 (F1)', () => {
    const jp = path.join(DATA_DIR, 'history.ndjson')
    const msg = (uid: string, cid: string) => ({
      t: 'msg', uid, scope: 'manager', projectId: null, role: 'user',
      content: uid, conversationId: cid, attachments: null, origin: null, createdAt: 't',
    })
    const conv = (id: string, worldState: string | null) => ({
      t: 'conv', id, target: 'manager', title: '', sdkSessionId: null, worldState, createdAt: 't0',
    })
    const raw = [
      conv('A', null), msg('m1', 'A'), conv('A', 'w1'), msg('m2', 'A'), conv('A', null), // live A: conv 3 + msg 2
      { t: 'set', key: 'jk', value: '1' }, { t: 'set', key: 'jk', value: '2' }, // set 최신=2
      conv('B', null), msg('m3', 'B'), msg('m3', 'B'), // B + 중복 msg
      { t: 'del', target: 'conv', id: 'B' }, // B 삭제 톰스톤
    ].map((e) => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(jp, raw)

    const stat = compactJournal({ minLines: 1 })
    expect(stat).toEqual({ before: 11, after: 6 })

    const kept = readJournalEntries()
    expect(kept.filter((e) => e.t === 'conv' && (e as JournalConv).id === 'B')).toHaveLength(0) // 삭제대화 제거
    expect(kept.filter((e) => e.t === 'del')).toHaveLength(0) // 톰스톤 제거
    expect(kept.filter((e) => e.t === 'msg' && (e as JournalMsg).uid === 'm3')).toHaveLength(0) // 삭제대화 msg 제거
    expect(kept.filter((e) => e.t === 'set')).toEqual([{ t: 'set', key: 'jk', value: '2' }]) // 설정 최신만
    expect(kept.filter((e) => e.t === 'conv' && (e as JournalConv).id === 'A')).toHaveLength(3) // live conv 전부
    expect(kept.filter((e) => e.t === 'msg').map((e) => (e as JournalMsg).uid)).toEqual(['m1', 'm2']) // 원순서·중복없음

    // reconcile 동등성 — 압축본을 fresh DB로 복원해도 무손실: A.worldState=w1(COALESCE), m1·m2 존재, B 없음, 설정 최신
    nukeDb()
    initStore()
    expect(getConversationWorldState('A')).toBe('w1')
    const am = listConversationMessages('A').map((m) => m.content)
    expect(am).toContain('m1')
    expect(am).toContain('m2')
    expect(listConversationMessages('B').map((m) => m.content)).not.toContain('m3')
    expect(getSetting('jk')).toBe('2')

    fs.rmSync(jp, { force: true }) // 다음 테스트 오염 방지
  })
})
