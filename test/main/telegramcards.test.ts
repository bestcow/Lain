// P1 텔레그램 라이브 카드 순수 헬퍼 — 카드 본문·활동 라인·edit 스로틀·diff 전달 방식 판정을 박제.
import { describe, it, expect } from 'vitest'
import {
  buildLiveCard,
  liveActivityLine,
  shouldEditLiveCard,
  finalCardLabel,
  diffDelivery,
  LIVE_EDIT_MIN_MS,
} from '../../src/main/telegramcards'

const NOW = new Date('2026-07-14T12:00:00Z').getTime()
const baseTask = {
  projectId: 'blog',
  title: '다크모드 구현',
  createdAt: new Date(NOW - 12 * 60_000).toISOString(),
  todos: null,
  turns: 0,
}

describe('liveActivityLine', () => {
  it('tool 이벤트는 사람말로', () => {
    expect(liveActivityLine({ kind: 'tool', text: 'Read: {"file_path":"C:\\\\x\\\\App.tsx"}' })).toBe(
      '파일 읽는 중 — App.tsx',
    )
  })
  it('text/checkpoint/status는 머리만, approval: 신호·todo·exit는 제외', () => {
    expect(liveActivityLine({ kind: 'text', text: '테스트를 먼저 고치겠습니다.\n그리고…' })).toBe(
      '테스트를 먼저 고치겠습니다. 그리고…',
    )
    expect(liveActivityLine({ kind: 'checkpoint', text: '진행중: 8턴 · 커밋 2 · +120/-30' })).toBe(
      '진행중: 8턴 · 커밋 2 · +120/-30',
    )
    expect(liveActivityLine({ kind: 'status', text: 'approval:12' })).toBeNull()
    expect(liveActivityLine({ kind: 'todo', text: '[]' })).toBeNull()
    expect(liveActivityLine({ kind: 'exit', text: 'done' })).toBeNull()
  })
})

describe('buildLiveCard', () => {
  it('제목·경과·턴·할일·지금 줄을 담는다', () => {
    const card = buildLiveCard(
      { ...baseTask, turns: 5, todos: [
        { content: 'a', status: 'completed', activeForm: '' },
        { content: 'b', status: 'pending', activeForm: '' },
      ] as never },
      '파일 고치는 중 — store.ts',
      NOW,
    )
    expect(card).toContain('⚙ blog — 다크모드 구현')
    expect(card).toContain('12분 경과')
    expect(card).toContain('5턴')
    expect(card).toContain('할일 1/2')
    expect(card).toContain('지금: 파일 고치는 중 — store.ts')
  })
  it('활동 없으면 지금 줄 생략, 1시간 넘으면 시간 표기', () => {
    const card = buildLiveCard(
      { ...baseTask, createdAt: new Date(NOW - 95 * 60_000).toISOString() },
      null,
      NOW,
    )
    expect(card).not.toContain('지금:')
    expect(card).toContain('1시간 35분 경과')
  })
})

describe('shouldEditLiveCard', () => {
  it('내용이 같으면 edit 안 함, 최소 간격 전에도 안 함', () => {
    expect(shouldEditLiveCard('a', 'a', 0, NOW)).toBe(false)
    expect(shouldEditLiveCard('a', 'b', NOW - LIVE_EDIT_MIN_MS + 1000, NOW)).toBe(false)
    expect(shouldEditLiveCard('a', 'b', NOW - LIVE_EDIT_MIN_MS, NOW)).toBe(true)
  })
})

describe('finalCardLabel', () => {
  it('상태별 확정 라벨', () => {
    expect(finalCardLabel('done')).toContain('완료')
    expect(finalCardLabel('review')).toContain('결재')
    expect(finalCardLabel('cancelled')).toContain('취소')
  })
})

describe('diffDelivery', () => {
  it('빈 diff → empty, 짧으면 text, 길면 file', () => {
    expect(diffDelivery('  \n')).toEqual({ mode: 'empty' })
    expect(diffDelivery('+a\n-b')).toEqual({ mode: 'text', text: '+a\n-b' })
    expect(diffDelivery('x'.repeat(4000))).toEqual({ mode: 'file' })
  })
})
