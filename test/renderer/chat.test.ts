import { describe, it, expect } from 'vitest'
import {
  isImageMime,
  filterSlash,
  isEventForOpenConv,
  searchHitIds,
  stripAttachSuffix,
  computeTargetKey,
  sessionStartStamp,
  filterThisSession,
} from '../../src/renderer/lib/chat'
import { SLASH_COMMANDS } from '../../src/renderer/components/SlashMenu'
import type { ChatMessage } from '../../src/shared/types'

describe('isImageMime — Anthropic 이미지 4종 화이트리스트', () => {
  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])('허용: %s', (m) => {
    expect(isImageMime(m)).toBe(true)
  })
  it.each(['image/bmp', 'image/svg+xml', 'image/tiff', 'image/heic', 'application/pdf', 'text/plain', ''])(
    '거부(API 400 방지): %s',
    (m) => {
      expect(isImageMime(m)).toBe(false)
    },
  )
})

describe('filterSlash — 첫 토큰 접두 매칭', () => {
  const cmds = (xs: { cmd: string }[]) => xs.map((c) => c.cmd)
  it("'/sc' → /scan", () => {
    expect(cmds(filterSlash('/sc', SLASH_COMMANDS))).toEqual(['/scan'])
  })
  it("'/' → 전체 9개", () => {
    expect(filterSlash('/', SLASH_COMMANDS)).toHaveLength(9)
  })
  it("'/zzz' → 없음", () => {
    expect(filterSlash('/zzz', SLASH_COMMANDS)).toEqual([])
  })
  it('인자 뒤 공백은 첫 토큰만 매칭', () => {
    expect(cmds(filterSlash('/go proj1', SLASH_COMMANDS))).toEqual(['/go'])
  })
  it('대소문자 무시', () => {
    expect(cmds(filterSlash('/SCAN', SLASH_COMMANDS))).toEqual(['/scan'])
  })
})

describe('SLASH_COMMANDS — 상수 무결성', () => {
  it('정확히 9개', () => {
    expect(SLASH_COMMANDS).toHaveLength(9)
  })
  it('cmd 유니크', () => {
    expect(new Set(SLASH_COMMANDS.map((c) => c.cmd)).size).toBe(9)
  })
  it('모든 cmd는 / 로 시작', () => {
    expect(SLASH_COMMANDS.every((c) => c.cmd.startsWith('/'))).toBe(true)
  })
  it('arg 있는 명령은 /go /verify /cancel /learn', () => {
    expect(SLASH_COMMANDS.filter((c) => c.arg).map((c) => c.cmd).sort()).toEqual(
      ['/cancel', '/go', '/verify', '/learn'].sort(),
    )
  })
})

describe('isEventForOpenConv — 열린 대화 분기', () => {
  it.each([
    [null, 'c1', true], // 연 대화 없음 → 표시
    ['c1', null, true], // 레거시(conversationId 없음) → 표시
    ['c1', undefined, true],
    ['c1', 'c1', true], // 일치
    ['c1', 'c2', false], // 불일치
  ])('open=%s ev=%s → %s', (open, ev, expected) => {
    expect(isEventForOpenConv(open as string | null, ev as string | null | undefined)).toBe(expected)
  })
})

describe('searchHitIds — 대화 내 검색', () => {
  const msgs: ChatMessage[] = [
    { id: 1, scope: 'manager', role: 'user', content: 'Hello World', createdAt: '' },
    { id: 2, scope: 'manager', role: 'assistant', content: 'goodbye', createdAt: '' },
    { id: 3, scope: 'manager', role: 'user', content: 'hello again', createdAt: '' },
  ]
  it('빈 쿼리 → []', () => {
    expect(searchHitIds(msgs, '')).toEqual([])
    expect(searchHitIds(msgs, '   ')).toEqual([])
  })
  it('대소문자 무시 부분 일치', () => {
    expect(searchHitIds(msgs, 'hello')).toEqual([1, 3])
  })
  it('매치 없음 → []', () => {
    expect(searchHitIds(msgs, 'zzz')).toEqual([])
  })
})

describe('stripAttachSuffix — 첨부 꼬리표 제거', () => {
  it('끝의 [+N개 첨부] 제거', () => {
    expect(stripAttachSuffix('hi [+2개 첨부]')).toBe('hi')
    expect(stripAttachSuffix('파일 보냄 [+10개 첨부]')).toBe('파일 보냄')
  })
  it('꼬리표 없으면 원문 유지', () => {
    expect(stripAttachSuffix('hi')).toBe('hi')
  })
  it('중간 삽입은 보존(앵커 $)', () => {
    expect(stripAttachSuffix('hi [+2개 첨부] tail')).toBe('hi [+2개 첨부] tail')
  })
})

describe('computeTargetKey — 초안 키', () => {
  it('manager는 conv별, conv 없으면 manager', () => {
    expect(computeTargetKey('manager', 'c1')).toBe('c1')
    expect(computeTargetKey('manager', null)).toBe('manager')
  })
  it('워커/@all은 대상명 그대로', () => {
    expect(computeTargetKey('apps/foo', 'c1')).toBe('apps/foo')
    expect(computeTargetKey('@all', null)).toBe('@all')
  })
})

describe('sessionStartStamp / filterThisSession — 이번 실행 메시지 필터(DB 포맷 정합)', () => {
  // DB(store.nowStamp)는 'YYYY-MM-DD HH:MM:SS'(공백 구분, UTC) 포맷으로 저장한다.
  const rows: ChatMessage[] = [
    { id: 1, scope: 'manager', role: 'user', content: '이전 실행', createdAt: '2026-06-26 10:00:00' },
    { id: 2, scope: 'manager', role: 'assistant', content: '이번 실행', createdAt: '2026-06-26 11:00:00' },
  ]

  it('sessionStartStamp은 DB와 동일한 공백 구분 포맷을 만든다(T/Z 없음)', () => {
    expect(sessionStartStamp(new Date('2026-06-26T10:30:00.123Z'))).toBe('2026-06-26 10:30:00')
  })

  it('세션 시작 이후 메시지만 남긴다 — 공백 포맷 문자열 비교가 정확', () => {
    const start = sessionStartStamp(new Date('2026-06-26T10:30:00Z'))
    expect(filterThisSession(rows, start).map((m) => m.id)).toEqual([2])
  })

  it('회귀: toISOString 포맷을 기준으로 쓰면 전부 누락된다(채팅창 리셋 버그)', () => {
    // ' '(0x20) < 'T'(0x54)이라 모든 DB 메시지가 toISOString 기준보다 작다고 판정 → 빈 배열.
    const buggyStart = new Date('2026-06-26T10:30:00Z').toISOString()
    expect(rows.every((m) => m.createdAt < buggyStart)).toBe(true)
    expect(filterThisSession(rows, buggyStart)).toEqual([])
  })
})

describe('이번 실행 경계 = main 기동 시각 — 렌더러 reload 후에도 세션 메시지 보존', () => {
  // 렌더러가 크래시하면 main이 자동 reload하는데(index.ts render-process-gone), 그때 경계를 '지금'으로
  // 재계산하면 이번 실행 메시지가 전부 < 경계로 필터돼 콜드스타트처럼 사라진다(화면이 빈 화면으로 리셋).
  // 그래서 경계는 reload 불변인 main(APP_STARTED_AT)에서 받아야 한다.
  const appStart = '2026-06-26 10:00:00' // main 기동 시각 — reload돼도 불변
  const sessionRows: ChatMessage[] = [
    { id: 9, scope: 'manager', role: 'assistant', content: '이번 실행 중 답', createdAt: '2026-06-26 10:05:00' },
  ]

  it('main 경계로 필터하면 reload 후에도 이번 실행 메시지가 남는다', () => {
    expect(filterThisSession(sessionRows, appStart).map((m) => m.id)).toEqual([9])
  })

  it('회귀: reload 시각으로 경계를 재계산하면 이번 실행 메시지가 사라진다', () => {
    // 메시지(10:05) 이후 시각에 reload → 그 시각을 경계로 쓰면 빈 배열(버그 재현).
    const reloadStart = sessionStartStamp(new Date('2026-06-26T10:10:00Z'))
    expect(filterThisSession(sessionRows, reloadStart)).toEqual([])
  })
})
