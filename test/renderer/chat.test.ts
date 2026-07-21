import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isImageMime,
  filterSlash,
  isEventForOpenConv,
  searchHitIds,
  searchHitIdsFromHistory,
  preserveHitIndex,
  nextBeforeId,
  mergePagedMessages,
  stripAttachSuffix,
  computeTargetKey,
  sessionStartStamp,
  fmtCost,
  usageLabel,
  contextPercent,
  isInteractiveElement,
  shouldRefocusInboxRow,
  fmtElapsed,
  elapsedMinutes,
  longestWait,
  fmtRelTime,
  parseStampMs,
  enqueueNaviMsg,
  dequeueNaviMsg,
  cancelQueuedNaviMsg,
  clearNaviQueue,
  naviQueueLength,
  parseAtToken,
  insertAtPath,
  fuzzyScore,
  fuzzyFilterFiles,
  taskActivityLine,
  updateActivityMap,
  isTaskActive,
  tileMeta,
  type NaviQueueItem,
} from '../../src/renderer/lib/chat'
import { SLASH_COMMANDS } from '../../src/renderer/components/SlashMenu'
import { encodeEditDiffLine } from '../../src/shared/editdiff'
import { encodeToolLine } from '../../src/shared/toolline'
import { encodeTodoLine } from '../../src/shared/todoline'
import type { ChatHistoryHit, ChatMessage, Task, TaskEvent } from '../../src/shared/types'

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
  it("'/' → 전체 10개", () => {
    expect(filterSlash('/', SLASH_COMMANDS)).toHaveLength(10)
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
  it('정확히 10개', () => {
    expect(SLASH_COMMANDS).toHaveLength(10)
  })
  it('cmd 유니크', () => {
    expect(new Set(SLASH_COMMANDS.map((c) => c.cmd)).size).toBe(10)
  })
  it('모든 cmd는 / 로 시작', () => {
    expect(SLASH_COMMANDS.every((c) => c.cmd.startsWith('/'))).toBe(true)
  })
  it('arg 있는 명령은 /go /verify /cancel /learn', () => {
    expect(SLASH_COMMANDS.filter((c) => c.arg).map((c) => c.cmd).sort()).toEqual(
      ['/cancel', '/go', '/verify', '/learn'].sort(),
    )
  })
  it('/compact는 즉시 실행형(arg 없음) — A5', () => {
    const compact = SLASH_COMMANDS.find((c) => c.cmd === '/compact')
    expect(compact).toBeDefined()
    expect(compact?.arg).toBeUndefined()
  })
})

// A5 — 비용 누적 표시. 구독 사용자는 costUsd가 0/undefined/null이라 '$' 부분을 숨긴다(설정 표시=실제 일치).
describe('fmtCost — 비용 포맷($X.XX, 0/미정 숨김)', () => {
  it('0·음수·NaN은 빈 문자열(구독 사용자 — $ 숨김)', () => {
    expect(fmtCost(0)).toBe('')
    expect(fmtCost(-1)).toBe('')
    expect(fmtCost(NaN)).toBe('')
  })
  it('양수는 소수 둘째 자리로 반올림', () => {
    expect(fmtCost(0.1234)).toBe('$0.12')
    expect(fmtCost(1)).toBe('$1.00')
    expect(fmtCost(12.345)).toBe('$12.35')
  })
})

describe('usageLabel — 토큰·비용 결합 라벨', () => {
  it('비용 0(구독)이면 tok만', () => {
    expect(usageLabel('1.2k', 0)).toBe('1.2k tok')
  })
  it('비용 있으면 tok · $X.XX', () => {
    expect(usageLabel('1.2k', 3.5)).toBe('1.2k tok · $3.50')
  })
})

// A5 — 컨텍스트 게이지(렌더러 계산본). main/compactgate.ts와 동일 로직(경계: 렌더러는 main 모듈 미import).
describe('contextPercent(renderer) — 컨텍스트 게이지 %', () => {
  it('threshold<=0이면 null(게이지 숨김)', () => {
    expect(contextPercent(100_000, 0)).toBeNull()
    expect(contextPercent(0, -5)).toBeNull()
  })
  it('정상 비율', () => {
    expect(contextPercent(120_000, 400_000)).toBe(30)
    expect(contextPercent(400_000, 400_000)).toBe(100)
  })
  it('임계 초과 시 100 넘게 반환(클램프는 표시 쪽 책임)', () => {
    expect(contextPercent(500_000, 400_000)).toBe(125)
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

  // I4 — tool 라인 content는 encodeToolLine('display\x1Fraw') 형태. 숨겨진 raw까지 매치하면
  // 하이라이트 없는 유령 히트가 잡히므로, 화면에 보이는 display만 검색한다.
  describe('tool 라인 — display만 검색(숨은 raw 유령 히트 방지)', () => {
    const SEP = String.fromCharCode(31) // encodeToolLine의 U+001F 구분자
    const toolMsgs: ChatMessage[] = [
      // display='Bash: 테스트 실행', raw엔 'secret-token' 같은 긴 원문이 잘려 숨어 있음
      { id: 10, scope: 'manager', role: 'tool', content: `Bash: 테스트 실행${SEP}npm test -- --token=secret-token`, createdAt: '' },
    ]
    it('display에 있는 말은 매치된다', () => {
      expect(searchHitIds(toolMsgs, '테스트 실행')).toEqual([10])
      expect(searchHitIds(toolMsgs, 'bash')).toEqual([10]) // 대소문자 무시
    })
    it('숨은 raw에만 있는 말은 매치되지 않는다(유령 히트 제거)', () => {
      expect(searchHitIds(toolMsgs, 'secret-token')).toEqual([])
      expect(searchHitIds(toolMsgs, '--token')).toEqual([])
    })
  })

  // A4 — TodoWrite 라인(encodeTodoLine, §todo§ 접두사)은 화면에 위젯(체크리스트 칩)으로만 보이므로
  // raw JSON 안의 문자열(항목 content 등)이 검색에 유령 히트로 잡히면 안 된다.
  describe('todo 라인 — 검색 대상에서 제외(위젯 전용 표시)', () => {
    const todoMsgs: ChatMessage[] = [
      {
        id: 20,
        scope: 'manager',
        role: 'tool',
        content: `§todo§${JSON.stringify([{ content: '시크릿 항목 완료', status: 'completed', activeForm: '완료 중' }])}`,
        createdAt: '',
      },
    ]
    it('todo 항목 안의 텍스트는 매치되지 않는다', () => {
      expect(searchHitIds(todoMsgs, '시크릿 항목')).toEqual([])
      expect(searchHitIds(todoMsgs, 'completed')).toEqual([])
    })
  })

  // P2-T3 — editdiff 라인(encodeEditDiffLine, §diff§ 접두사)은 EditDiffChip 위젯으로만 렌더되고
  // diff JSON(파일경로·코드)은 하이라이트 없이 검색에 유령 히트로 잡히면 안 된다(todo와 동일 원칙).
  describe('editdiff 라인 — 검색 대상에서 제외(위젯 전용 표시, 하이라이트 없음)', () => {
    const diffMsgs: ChatMessage[] = [
      {
        id: 30,
        scope: 'manager',
        role: 'tool',
        content: encodeEditDiffLine({
          tool: 'Edit',
          filePath: 'src/secret/config.ts',
          lines: [
            { kind: 'del', text: 'const apiKey = "old-secret"' },
            { kind: 'add', text: 'const apiKey = "new-secret"' },
          ],
          truncated: false,
        }),
        createdAt: '',
      },
    ]
    it('diff 안의 파일경로는 매치되지 않는다', () => {
      expect(searchHitIds(diffMsgs, 'config.ts')).toEqual([])
      expect(searchHitIds(diffMsgs, 'src/secret')).toEqual([])
    })
    it('diff 안의 코드 텍스트는 매치되지 않는다', () => {
      expect(searchHitIds(diffMsgs, 'apiKey')).toEqual([])
      expect(searchHitIds(diffMsgs, 'new-secret')).toEqual([])
    })
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

describe('sessionStartStamp — 이번 실행 경계 스탬프(DB 포맷 정합)', () => {
  // DB(store.nowStamp)는 'YYYY-MM-DD HH:MM:SS'(공백 구분, UTC) 포맷으로 저장한다.
  it('sessionStartStamp은 DB와 동일한 공백 구분 포맷을 만든다(T/Z 없음)', () => {
    expect(sessionStartStamp(new Date('2026-06-26T10:30:00.123Z'))).toBe('2026-06-26 10:30:00')
  })
})

// B3 — 인박스 포커스 강탈 방지(§ux1 T6). 답변 입력 중 새 항목 도착 시 포커스를 뺏지 않는다.
// FocusableLike는 tagName/isContentEditable만 있으면 되므로 plain object로 테스트(jsdom 불필요).
describe('isInteractiveElement — 사용자 상호작용 중 요소 판정', () => {
  it('null이면 false', () => {
    expect(isInteractiveElement(null)).toBe(false)
  })
  it('INPUT/TEXTAREA는 true', () => {
    expect(isInteractiveElement({ tagName: 'INPUT' })).toBe(true)
    expect(isInteractiveElement({ tagName: 'TEXTAREA' })).toBe(true)
  })
  it('일반 DIV는 false', () => {
    expect(isInteractiveElement({ tagName: 'DIV' })).toBe(false)
  })
  it('contentEditable=true인 요소는 true', () => {
    expect(isInteractiveElement({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })
})

describe('shouldRefocusInboxRow — total 변화·입력중 가드 조합', () => {
  const input = { tagName: 'INPUT' }
  const div = { tagName: 'DIV' }

  it('개수 감소(행 처리 완료)면 입력 중이어도 다음 행 포커스', () => {
    expect(shouldRefocusInboxRow(3, 2, input)).toBe(true)
  })
  it('개수 증가(신규 도착)인데 입력 중이면 스킵', () => {
    expect(shouldRefocusInboxRow(2, 3, input)).toBe(false)
  })
  it('개수 증가인데 상호작용 중이 아니면 포커스', () => {
    expect(shouldRefocusInboxRow(2, 3, div)).toBe(true)
    expect(shouldRefocusInboxRow(2, 3, null)).toBe(true)
  })
  it('개수 불변(초기 마운트 등)이고 입력 중 아니면 포커스', () => {
    expect(shouldRefocusInboxRow(0, 0, null)).toBe(true)
  })
  it('개수 불변인데 입력 중이면 스킵', () => {
    expect(shouldRefocusInboxRow(3, 3, input)).toBe(false)
  })
})

describe('fmtElapsed / elapsedMinutes / longestWait — 경과시간 포맷(C5 대기 배지)', () => {
  const NOW = new Date('2026-07-07T12:00:00Z')
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('1분 미만은 방금', () => {
    expect(fmtElapsed(new Date(NOW.getTime() - 30_000).toISOString())).toBe('방금')
  })
  it('분 단위(1분~59분)는 N분째', () => {
    expect(fmtElapsed(new Date(NOW.getTime() - 12 * 60_000).toISOString())).toBe('12분째')
  })
  it('시간 단위(1시간~23시간)는 N시간째', () => {
    expect(fmtElapsed(new Date(NOW.getTime() - 3 * 3600_000).toISOString())).toBe('3시간째')
  })
  it('24시간 이상은 N일째', () => {
    expect(fmtElapsed(new Date(NOW.getTime() - 50 * 3600_000).toISOString())).toBe('2일째')
  })
  it('파싱 불가 문자열은 빈 문자열', () => {
    expect(fmtElapsed('not-a-date')).toBe('')
  })

  it('elapsedMinutes — 분 단위 숫자를 반환', () => {
    expect(elapsedMinutes(new Date(NOW.getTime() - 12 * 60_000).toISOString())).toBe(12)
    expect(elapsedMinutes(new Date(NOW.getTime() - 30_000).toISOString())).toBe(0)
  })
  it('elapsedMinutes — 파싱 불가면 -1', () => {
    expect(elapsedMinutes('garbage')).toBe(-1)
  })

  it('longestWait — 가장 오래된 타임스탬프 기준으로 fmtElapsed', () => {
    const t = [
      new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      new Date(NOW.getTime() - 40 * 60_000).toISOString(), // 가장 오래됨
      new Date(NOW.getTime() - 1 * 60_000).toISOString(),
    ]
    expect(longestWait(t)).toBe('40분째')
  })
  it('longestWait — 빈 배열이면 null', () => {
    expect(longestWait([])).toBeNull()
  })

  it('fmtRelTime — N일 전 상대시간(C2 마지막 커밋)', () => {
    expect(fmtRelTime(new Date(NOW.getTime() - 30_000).toISOString())).toBe('방금')
    expect(fmtRelTime(new Date(NOW.getTime() - 12 * 60_000).toISOString())).toBe('12분 전')
    expect(fmtRelTime(new Date(NOW.getTime() - 3 * 3600_000).toISOString())).toBe('3시간 전')
    expect(fmtRelTime(new Date(NOW.getTime() - 3 * 24 * 3600_000).toISOString())).toBe('3일 전')
    expect(fmtRelTime('garbage')).toBe('')
  })

  // I1(P3-3 리뷰): DB datetime('now')는 UTC 'YYYY-MM-DD HH:MM:SS'(공백·Z 없음). raw Date.parse는 이를
  // 로컬로 오독해 TZ 오프셋(KST 9h)만큼 어긋났다 → parseStampMs가 공백형에 Z를 붙여 UTC로 해석해야 정확.
  // NOW=UTC 정오라 UTC 구성요소로 문자열을 직접 만들면 실행 머신 TZ와 무관하게 검증된다(구버그면 실패).
  it('fmtElapsed — DB UTC 공백표기(Z 없음)를 UTC로 해석(로컬 오독 금지·TZ 불변)', () => {
    expect(fmtElapsed('2026-07-07 11:48:00')).toBe('12분째') // NOW-12분
    expect(fmtElapsed('2026-07-07 09:00:00')).toBe('3시간째') // NOW-3시간
    expect(fmtElapsed('2026-07-07 11:59:30')).toBe('방금') // NOW-30초
  })
  it('fmtRelTime — DB UTC 공백표기를 UTC로 해석', () => {
    expect(fmtRelTime('2026-07-07 11:48:00')).toBe('12분 전')
  })
  it('elapsedMinutes — DB UTC 공백표기를 UTC로 해석', () => {
    expect(elapsedMinutes('2026-07-07 11:48:00')).toBe(12)
  })
  it('parseStampMs — 공백형엔 Z 부착(UTC), T+오프셋(git %cI)은 보존, 빈/불가는 NaN', () => {
    // 공백형 UTC → Z 부착 후 UTC 해석
    expect(parseStampMs('2026-07-07 11:48:00')).toBe(Date.parse('2026-07-07T11:48:00Z'))
    // git %cI(오프셋 포함 ISO)는 그대로 — 오프셋 존중(로컬 오독 아님)
    expect(parseStampMs('2026-07-07T12:00:00+09:00')).toBe(Date.parse('2026-07-07T12:00:00+09:00'))
    // 이미 Z 있는 ISO는 그대로
    expect(parseStampMs('2026-07-07T12:00:00Z')).toBe(Date.parse('2026-07-07T12:00:00Z'))
    expect(Number.isNaN(parseStampMs(''))).toBe(true)
    expect(Number.isNaN(parseStampMs('garbage'))).toBe(true)
  })
})

// A10 — Navi 직통 채팅 큐(naviId별 맵). 레인 msgQueue(단일 배열)를 일반화한 순수 함수들.
describe('Navi 메시지 큐 — naviId별 맵 적재/드레인/취소', () => {
  const item = (localId: number, text = 'hi'): NaviQueueItem => ({ text, attachments: [], localId })

  it('enqueueNaviMsg — 없던 naviId면 새로 생성, 있으면 뒤에 추가', () => {
    let q = new Map<string, NaviQueueItem[]>()
    q = enqueueNaviMsg(q, 'proj-a', item(1))
    expect(q.get('proj-a')).toEqual([item(1)])
    q = enqueueNaviMsg(q, 'proj-a', item(2))
    expect(q.get('proj-a')).toEqual([item(1), item(2)])
    // 다른 naviId는 독립 — 서로 섞이지 않는다.
    q = enqueueNaviMsg(q, 'proj-b', item(3))
    expect(q.get('proj-b')).toEqual([item(3)])
    expect(q.get('proj-a')).toEqual([item(1), item(2)])
  })

  it('enqueueNaviMsg — 원본 맵을 변경하지 않는다(불변)', () => {
    const q0 = new Map<string, NaviQueueItem[]>()
    const q1 = enqueueNaviMsg(q0, 'proj-a', item(1))
    expect(q0.size).toBe(0)
    expect(q1.size).toBe(1)
  })

  it('dequeueNaviMsg — FIFO로 첫 항목을 꺼내고, 소진되면 키를 제거(누수 방지)', () => {
    let q = new Map<string, NaviQueueItem[]>([['proj-a', [item(1), item(2)]]])
    const r1 = dequeueNaviMsg(q, 'proj-a')
    expect(r1.item).toEqual(item(1))
    expect(r1.queues.get('proj-a')).toEqual([item(2)])
    q = r1.queues
    const r2 = dequeueNaviMsg(q, 'proj-a')
    expect(r2.item).toEqual(item(2))
    expect(r2.queues.has('proj-a')).toBe(false) // 큐 소진 → 키 자체 제거
  })

  it('dequeueNaviMsg — 큐가 없거나 빈 naviId는 item=null, 맵 그대로', () => {
    const q = new Map<string, NaviQueueItem[]>()
    const r = dequeueNaviMsg(q, 'proj-x')
    expect(r.item).toBeNull()
    expect(r.queues).toBe(q) // 변경 없음(참조 동일)
  })

  it('cancelQueuedNaviMsg — localId로 특정 항목만 제거, 나머지는 순서 유지', () => {
    const q = new Map<string, NaviQueueItem[]>([['proj-a', [item(1), item(2), item(3)]]])
    const next = cancelQueuedNaviMsg(q, 'proj-a', 2)
    expect(next.get('proj-a')).toEqual([item(1), item(3)])
  })

  it('cancelQueuedNaviMsg — 마지막 항목 취소 시 키 제거', () => {
    const q = new Map<string, NaviQueueItem[]>([['proj-a', [item(1)]]])
    const next = cancelQueuedNaviMsg(q, 'proj-a', 1)
    expect(next.has('proj-a')).toBe(false)
  })

  it('cancelQueuedNaviMsg — 다른 naviId 큐는 건드리지 않는다', () => {
    const q = new Map<string, NaviQueueItem[]>([
      ['proj-a', [item(1)]],
      ['proj-b', [item(2)]],
    ])
    const next = cancelQueuedNaviMsg(q, 'proj-a', 1)
    expect(next.has('proj-a')).toBe(false)
    expect(next.get('proj-b')).toEqual([item(2)])
  })

  it('clearNaviQueue — 정지·전환 시 해당 naviId 큐 전체 비우고 제거된 id 목록 반환', () => {
    const q = new Map<string, NaviQueueItem[]>([
      ['proj-a', [item(1), item(2)]],
      ['proj-b', [item(3)]],
    ])
    const { removedIds, queues } = clearNaviQueue(q, 'proj-a')
    expect(removedIds).toEqual([1, 2])
    expect(queues.has('proj-a')).toBe(false)
    expect(queues.get('proj-b')).toEqual([item(3)]) // 다른 naviId는 무영향
  })

  it('clearNaviQueue — 큐가 없으면 removedIds=[]', () => {
    const q = new Map<string, NaviQueueItem[]>()
    const { removedIds, queues } = clearNaviQueue(q, 'proj-x')
    expect(removedIds).toEqual([])
    expect(queues).toBe(q)
  })

  it('naviQueueLength — 큐 길이(없으면 0)', () => {
    const q = new Map<string, NaviQueueItem[]>([['proj-a', [item(1), item(2)]]])
    expect(naviQueueLength(q, 'proj-a')).toBe(2)
    expect(naviQueueLength(q, 'proj-x')).toBe(0)
  })
})

// A12 — @파일 자동완성. parseAtToken은 커서 위치 기준 '@단어' 추출, insertAtPath는 치환.
describe('parseAtToken — 커서 기준 @단어 추출', () => {
  it("'@' 직후 caret — 빈 query 토큰", () => {
    expect(parseAtToken('hello @', 7)).toEqual({ start: 6, end: 7, query: '' })
  })
  it('@ 뒤 타이핑 중인 파일명', () => {
    expect(parseAtToken('참고: @App.tsx', 13)).toEqual({ start: 4, end: 13, query: 'App.tsx' })
  })
  it('caret이 @토큰 중간이면 end는 공백까지 확장', () => {
    // '@App.tsx' 중 caret이 '@Ap|p.tsx' 위치(4글자 뒤)
    const input = '@App.tsx'
    expect(parseAtToken(input, 3)).toEqual({ start: 0, end: 8, query: 'App.tsx' })
  })
  it('@ 없으면 null', () => {
    expect(parseAtToken('hello world', 11)).toBeNull()
  })
  it('@ 뒤에 이미 공백이 있으면(토큰 종료) null', () => {
    expect(parseAtToken('@foo bar', 8)).toBeNull()
  })
  it("단어 중간 '@'(이메일 등)는 트리거 안 됨 — 앞이 공백/개행/문자열 시작이어야", () => {
    expect(parseAtToken('user@example', 12)).toBeNull()
  })
  it('문자열 맨 앞 @는 트리거', () => {
    expect(parseAtToken('@foo', 4)).toEqual({ start: 0, end: 4, query: 'foo' })
  })
  it('개행 뒤 @도 트리거', () => {
    expect(parseAtToken('line1\n@foo', 10)).toEqual({ start: 6, end: 10, query: 'foo' })
  })
  it('여러 @ 중 caret에 가장 가까운 것만', () => {
    expect(parseAtToken('@a.ts and @b.ts', 15)).toEqual({ start: 10, end: 15, query: 'b.ts' })
  })
})

describe('insertAtPath — @토큰 자리 치환', () => {
  it('토큰을 상대경로+공백으로 치환하고 caret은 삽입 뒤로', () => {
    const token = { start: 4, end: 13, query: 'App.tsx' }
    const result = insertAtPath('참고: @App.tsx', token, 'src/renderer/App.tsx')
    expect(result.text).toBe('참고: @src/renderer/App.tsx ')
    expect(result.caret).toBe(result.text.length)
  })
  it('토큰 뒤 텍스트는 보존(치환은 토큰 구간만)', () => {
    const token = { start: 0, end: 4, query: 'foo' }
    const result = insertAtPath('@foo 그리고', token, 'bar.ts')
    expect(result.text).toBe('@bar.ts  그리고')
  })
})

describe('fuzzyScore — 부분열 매칭 점수', () => {
  it('빈 query는 0(전부 매치, 동점)', () => {
    expect(fuzzyScore('App.tsx', '')).toBe(0)
  })
  it('순서대로 나오면 매치(연속 아니어도)', () => {
    expect(fuzzyScore('App.tsx', 'ats')).not.toBeNull()
  })
  it('순서가 어긋나면 매치 실패(null)', () => {
    expect(fuzzyScore('App.tsx', 'tsa')).toBeNull()
  })
  it('없는 문자면 null', () => {
    expect(fuzzyScore('App.tsx', 'zzz')).toBeNull()
  })
  it('대소문자 무시', () => {
    expect(fuzzyScore('App.tsx', 'APP')).not.toBeNull()
  })
  it('연속 매치가 더 좋은(작은) 점수', () => {
    const tight = fuzzyScore('app.tsx', 'app')! // 앞에서 바로 연속
    const loose = fuzzyScore('a999pp888', 'app')! // 갭이 큼
    expect(tight).toBeLessThan(loose)
  })
})

describe('fuzzyFilterFiles — 파일 목록 fuzzy 필터+정렬+상한', () => {
  const files = ['src/renderer/App.tsx', 'src/main/App.ts', 'README.md', 'src/renderer/lib/chat.ts']
  it('매치되는 것만, 점수순 정렬', () => {
    const result = fuzzyFilterFiles(files, 'app')
    expect(result).toContain('src/renderer/App.tsx')
    expect(result).toContain('src/main/App.ts')
    expect(result).not.toContain('README.md')
  })
  it('빈 query는 전체(상한 내)', () => {
    expect(fuzzyFilterFiles(files, '', 2)).toHaveLength(2)
  })
  it('limit 상한 적용', () => {
    expect(fuzzyFilterFiles(files, 'a', 1)).toHaveLength(1)
  })
  it('매치 없으면 빈 배열', () => {
    expect(fuzzyFilterFiles(files, 'zzzzz')).toEqual([])
  })
})

describe('nextBeforeId — 페이징 커서(가장 오래된 로드분의 id)', () => {
  it('오래된 순으로 첫 양수 id를 커서로', () => {
    const msgs: ChatMessage[] = [
      { id: 5, scope: 'manager', role: 'user', content: 'a', createdAt: '' },
      { id: 6, scope: 'manager', role: 'assistant', content: 'b', createdAt: '' },
    ]
    expect(nextBeforeId(msgs)).toBe(5)
  })
  it('빈 배열 → undefined(더 불러올 기준 없음)', () => {
    expect(nextBeforeId([])).toBeUndefined()
  })
  it('맨 앞이 음수 id(낙관적 로컬 메시지)면 건너뛰고 첫 양수 id 사용', () => {
    const msgs: ChatMessage[] = [
      { id: -1, scope: 'manager', role: 'user', content: '전송중', createdAt: '' },
      { id: 7, scope: 'manager', role: 'assistant', content: 'b', createdAt: '' },
    ]
    expect(nextBeforeId(msgs)).toBe(7)
  })
  it('전부 음수 id면 undefined', () => {
    const msgs: ChatMessage[] = [{ id: -2, scope: 'manager', role: 'user', content: 'x', createdAt: '' }]
    expect(nextBeforeId(msgs)).toBeUndefined()
  })
})

describe('mergePagedMessages — 이전 페이지 prepend + 중복제거', () => {
  const current: ChatMessage[] = [
    { id: 10, scope: 'manager', role: 'user', content: 'c10', createdAt: '' },
    { id: 11, scope: 'manager', role: 'assistant', content: 'c11', createdAt: '' },
  ]
  it('older를 앞에 붙인다(순서 유지)', () => {
    const older: ChatMessage[] = [
      { id: 8, scope: 'manager', role: 'user', content: 'o8', createdAt: '' },
      { id: 9, scope: 'manager', role: 'assistant', content: 'o9', createdAt: '' },
    ]
    expect(mergePagedMessages(older, current).map((m) => m.id)).toEqual([8, 9, 10, 11])
  })
  it('older가 비어 있으면 current 그대로(참조 동일)', () => {
    expect(mergePagedMessages([], current)).toBe(current)
  })
  it('id 중복은 older 쪽을 버린다(current=최신 진실)', () => {
    const older: ChatMessage[] = [
      { id: 9, scope: 'manager', role: 'user', content: 'o9', createdAt: '' },
      { id: 10, scope: 'manager', role: 'user', content: 'stale-dup', createdAt: '' }, // current에도 10 있음
    ]
    const merged = mergePagedMessages(older, current)
    expect(merged.map((m) => m.id)).toEqual([9, 10, 11])
    expect(merged.find((m) => m.id === 10)?.content).toBe('c10') // current 쪽이 살아남음
  })
})

describe('searchHitIdsFromHistory — DB 전체기간 검색 히트 → 화면 하이라이트 id 순서', () => {
  it('최신순(DESC)으로 온 히트를 오래된→최신으로 뒤집는다', () => {
    const hits: ChatHistoryHit[] = [
      { id: 30, conversationId: 'c1', role: 'user', when: '', snippet: 's30' },
      { id: 20, conversationId: 'c1', role: 'assistant', when: '', snippet: 's20' },
      { id: 10, conversationId: 'c1', role: 'user', when: '', snippet: 's10' },
    ]
    expect(searchHitIdsFromHistory(hits)).toEqual([10, 20, 30])
  })
  it('빈 배열 → 빈 배열', () => {
    expect(searchHitIdsFromHistory([])).toEqual([])
  })
})

// PI3 — 페이징(prepend)으로 히트 배열이 앞에서 늘어날 때 활성 히트를 id로 재추적해 인덱스 보존.
describe('preserveHitIndex — 히트 배열 변동 시 활성 히트 인덱스 보존(스크롤 튐 방지)', () => {
  it('앞에 히트가 prepend되면 인덱스가 밀려도 같은 히트를 가리킨다', () => {
    // 이전: [30, 40], 활성 idx=0(→히트 30). 위로 페이징으로 [10, 20]이 앞에 붙어 [10,20,30,40].
    expect(preserveHitIndex([30, 40], 0, [10, 20, 30, 40])).toBe(2)
  })
  it('활성이 아닌 다른 히트도 새 위치로 정확히 옮겨진다', () => {
    // 이전 활성 idx=1(→히트 40). 새 배열에서 40은 인덱스 3.
    expect(preserveHitIndex([30, 40], 1, [10, 20, 30, 40])).toBe(3)
  })
  it('이전 활성 히트가 새 배열에서 사라졌으면 0', () => {
    expect(preserveHitIndex([30, 40], 0, [10, 20])).toBe(0)
  })
  it('이전 히트 배열이 비어 있으면 0', () => {
    expect(preserveHitIndex([], 0, [10, 20])).toBe(0)
  })
  it('idx가 이전 배열 범위를 넘어도 클램프 후 보존', () => {
    // idx=5는 [30,40] 범위 밖 → 마지막(40) 기준. 새 배열에서 40은 인덱스 1.
    expect(preserveHitIndex([30, 40], 5, [30, 40, 50])).toBe(1)
  })
})

// C1 — 내비 타일 라이브 활동 파생·타일 meta 선택.
const ev = (kind: TaskEvent['kind'], text: string, taskId = 't1'): TaskEvent =>
  ({ taskId, kind, text }) as TaskEvent

describe('taskActivityLine — TaskEvent → 타일 라이브 한 줄(decode·필터)', () => {
  it('tool 라인은 encodeToolLine의 display만 뽑는다(raw U+001F 미노출)', () => {
    const enc = encodeToolLine('Edit routes.py', 'C:/proj/src/routes.py 전체 원문...')
    const line = taskActivityLine(ev('tool', enc))
    expect(line).toBe('Edit routes.py')
    expect(line).not.toContain(String.fromCharCode(31)) // U+001F 노출 금지
    expect(line).not.toContain('routes.py 전체')
  })
  it('구분자 없는 평문 tool 라인은 그대로', () => {
    expect(taskActivityLine(ev('tool', 'Read config.ts'))).toBe('Read config.ts')
  })
  it('status 이벤트는 그대로 흘린다', () => {
    expect(taskActivityLine(ev('status', '검증 중'))).toBe('검증 중')
  })
  it('승인 대기 status(approval:*)는 타일에 안 흘림(null)', () => {
    expect(taskActivityLine(ev('status', 'approval:42'))).toBeNull()
  })
  it('todo 이벤트는 타일 라인에서 제외(raw JSON 노출 금지, 진행률로 별도 표시)', () => {
    const enc = encodeTodoLine([{ content: '작업', status: 'in_progress', activeForm: '작업 중' }])
    expect(taskActivityLine(ev('todo', enc))).toBeNull()
  })
  it('exit 이벤트(done/blocked/error)는 타일에 안 흘림(종료 사유·상태전환 직전 깜빡임 방지)', () => {
    expect(taskActivityLine(ev('exit', 'done'))).toBeNull()
    expect(taskActivityLine(ev('exit', 'blocked: 승인 대기'))).toBeNull()
    expect(taskActivityLine(ev('exit', 'error: 타임아웃'))).toBeNull()
  })
  it('공백뿐인 text는 null', () => {
    expect(taskActivityLine(ev('tool', '   '))).toBeNull()
  })
  it('subagent·text·error도 display로 흘린다', () => {
    expect(taskActivityLine(ev('subagent', '⑂ 진행'))).toBe('⑂ 진행')
    expect(taskActivityLine(ev('text', '요약 중'))).toBe('요약 중')
    expect(taskActivityLine(ev('error', '실패'))).toBe('실패')
  })
})

describe('updateActivityMap — taskId당 1개, 같은 값이면 참조 동일(setState 스킵)', () => {
  it('새 taskId면 추가한 새 맵', () => {
    const m0 = new Map<string, string>()
    const m1 = updateActivityMap(m0, 't1', 'Edit a.ts')
    expect(m1).not.toBe(m0)
    expect(m1.get('t1')).toBe('Edit a.ts')
  })
  it('같은 taskId 갱신 시 이전 값을 대체(누적 아님, 1개만)', () => {
    let m = updateActivityMap(new Map(), 't1', 'Read a.ts')
    m = updateActivityMap(m, 't1', 'Edit b.ts')
    expect(m.get('t1')).toBe('Edit b.ts')
    expect(m.size).toBe(1)
  })
  it('같은 값이면 같은 맵 참조 반환(리렌더 스킵)', () => {
    const m1 = updateActivityMap(new Map(), 't1', 'Read a.ts')
    const m2 = updateActivityMap(m1, 't1', 'Read a.ts')
    expect(m2).toBe(m1)
  })
  it('line=null이면 갱신 없이 기존 맵 반환', () => {
    const m1 = updateActivityMap(new Map(), 't1', 'Read a.ts')
    expect(updateActivityMap(m1, 't1', null)).toBe(m1)
  })
  it('여러 taskId를 독립적으로 유지', () => {
    let m = updateActivityMap(new Map(), 't1', 'a')
    m = updateActivityMap(m, 't2', 'b')
    expect(m.get('t1')).toBe('a')
    expect(m.get('t2')).toBe('b')
    expect(m.size).toBe(2)
  })
})

const mkTask = (over: Partial<Task>): Task =>
  ({
    id: 't1',
    projectId: 'p1',
    title: 'routes.py 리팩터',
    state: 'working',
    turns: 0,
    tokens: 0,
    createdAt: new Date().toISOString(),
    ...over,
  }) as Task

describe('isTaskActive — 진행 중(working·clarifying)만 활성', () => {
  it('null → false', () => expect(isTaskActive(null)).toBe(false))
  it.each(['working', 'clarifying'] as const)('%s → true', (state) => {
    expect(isTaskActive(mkTask({ state }))).toBe(true)
  })
  it.each(['blocked', 'review', 'error', 'ready', 'done', 'cancelled'] as const)('%s → false', (state) => {
    expect(isTaskActive(mkTask({ state }))).toBe(false)
  })
})

describe('tileMeta — 진행 중이면 title+경과/턴/토큰, 아니면 정적 meta 유지', () => {
  it('활성 task 없음 → active:false(정적 meta 유지)', () => {
    expect(tileMeta(null).active).toBe(false)
    expect(tileMeta(mkTask({ state: 'review' })).active).toBe(false)
  })
  it('활성 task → title + stats(경과·턴·토큰)', () => {
    // createdAt을 2분 전으로 → fmtElapsed '2분째'
    const created = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const tm = tileMeta(mkTask({ createdAt: created, turns: 12, tokens: 4200 }))
    expect(tm.active).toBe(true)
    expect(tm.title).toBe('routes.py 리팩터')
    expect(tm.stats).toBe('2분째 · 12턴 · 4.2k tok')
  })
  it('turns·tokens 0이면 생략(신호 대 소음)', () => {
    const created = new Date(Date.now() - 30 * 1000).toISOString() // 30초 전 → '방금'
    const tm = tileMeta(mkTask({ createdAt: created, turns: 0, tokens: 0 }))
    expect(tm.stats).toBe('방금')
  })
  it('토큰 1000 미만은 그대로, 이상은 k 축약', () => {
    const created = new Date(Date.now() - 30 * 1000).toISOString()
    expect(tileMeta(mkTask({ createdAt: created, tokens: 900 })).stats).toContain('900 tok')
    expect(tileMeta(mkTask({ createdAt: created, tokens: 15000 })).stats).toContain('15k tok')
  })
})
