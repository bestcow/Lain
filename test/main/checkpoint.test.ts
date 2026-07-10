import { describe, it, expect } from 'vitest'
import {
  shouldCheckpoint,
  formatCheckpoint,
  summarizeDiffStat,
  CHECKPOINT_EVERY_TURNS,
  CHECKPOINT_EVERY_MS,
} from '../../src/main/checkpoint'

describe('shouldCheckpoint — N턴 경계', () => {
  it('마지막 체크포인트 이후 N턴 미만이면 false', () => {
    expect(
      shouldCheckpoint({ turnsSoFar: 5, lastCheckpointTurn: 0, elapsedMs: 0 }),
    ).toBe(false)
    expect(
      shouldCheckpoint({ turnsSoFar: 9, lastCheckpointTurn: 0, elapsedMs: 0 }),
    ).toBe(false)
  })
  it('정확히 N턴 경계면 true', () => {
    expect(
      shouldCheckpoint({ turnsSoFar: CHECKPOINT_EVERY_TURNS, lastCheckpointTurn: 0, elapsedMs: 0 }),
    ).toBe(true)
  })
  it('N턴 초과도 true', () => {
    expect(
      shouldCheckpoint({ turnsSoFar: 12, lastCheckpointTurn: 0, elapsedMs: 0 }),
    ).toBe(true)
  })
  it('직전 체크포인트 기준으로 N턴 재계산(누적 아님)', () => {
    // 10턴에 한 번 찍었으면 다음은 11..19까진 false, 20에서 true.
    expect(shouldCheckpoint({ turnsSoFar: 15, lastCheckpointTurn: 10, elapsedMs: 0 })).toBe(false)
    expect(shouldCheckpoint({ turnsSoFar: 20, lastCheckpointTurn: 10, elapsedMs: 0 })).toBe(true)
  })
})

describe('shouldCheckpoint — M분 경계', () => {
  it('M분 미만이면(턴도 미달) false', () => {
    expect(
      shouldCheckpoint({ turnsSoFar: 1, lastCheckpointTurn: 0, elapsedMs: CHECKPOINT_EVERY_MS - 1 }),
    ).toBe(false)
  })
  it('턴이 미달이어도 M분 경과면 true', () => {
    expect(
      shouldCheckpoint({ turnsSoFar: 2, lastCheckpointTurn: 0, elapsedMs: CHECKPOINT_EVERY_MS }),
    ).toBe(true)
    expect(
      shouldCheckpoint({ turnsSoFar: 3, lastCheckpointTurn: 0, elapsedMs: CHECKPOINT_EVERY_MS + 5000 }),
    ).toBe(true)
  })
})

describe('shouldCheckpoint — 같은 턴 중복 방지', () => {
  it('turnsSoFar가 lastCheckpointTurn 이하면 시간이 지나도 false(한 턴에 한 번만)', () => {
    expect(
      shouldCheckpoint({ turnsSoFar: 10, lastCheckpointTurn: 10, elapsedMs: CHECKPOINT_EVERY_MS * 2 }),
    ).toBe(false)
    expect(
      shouldCheckpoint({ turnsSoFar: 8, lastCheckpointTurn: 10, elapsedMs: CHECKPOINT_EVERY_MS * 2 }),
    ).toBe(false)
  })
})

describe('shouldCheckpoint — 커스텀 임계', () => {
  it('everyTurns/everyMs 주입이 기본 상수를 덮는다', () => {
    expect(
      shouldCheckpoint({ turnsSoFar: 3, lastCheckpointTurn: 0, elapsedMs: 0, everyTurns: 3, everyMs: 999999 }),
    ).toBe(true)
    expect(
      shouldCheckpoint({ turnsSoFar: 2, lastCheckpointTurn: 0, elapsedMs: 0, everyTurns: 3, everyMs: 999999 }),
    ).toBe(false)
  })
  it('everyTurns=0이면 턴 트리거 비활성(시간만)', () => {
    expect(
      shouldCheckpoint({ turnsSoFar: 100, lastCheckpointTurn: 0, elapsedMs: 0, everyTurns: 0, everyMs: 1000 }),
    ).toBe(false)
    expect(
      shouldCheckpoint({ turnsSoFar: 100, lastCheckpointTurn: 0, elapsedMs: 2000, everyTurns: 0, everyMs: 1000 }),
    ).toBe(true)
  })
})

describe('formatCheckpoint — 콘텐츠 포맷', () => {
  it('턴·커밋·diffStat 요약을 한 줄로', () => {
    const stat = ' src/a.ts | 10 ++++\n 2 files changed, 240 insertions(+), 31 deletions(-)'
    expect(formatCheckpoint(12, 3, stat)).toBe('진행중: 12턴 · 커밋 3 · +240/-31')
  })
  it('빈 diffStat은 "diff 없음"', () => {
    expect(formatCheckpoint(4, 0, '')).toBe('진행중: 4턴 · 커밋 0 · diff 없음')
  })
})

describe('summarizeDiffStat — +X/-Y 추출', () => {
  it('insertion만 있으면 -0', () => {
    expect(summarizeDiffStat(' 1 file changed, 5 insertions(+)')).toBe('+5/-0')
  })
  it('deletion만 있으면 +0', () => {
    expect(summarizeDiffStat(' 1 file changed, 7 deletions(-)')).toBe('+0/-7')
  })
  it('요약 줄이 없으면(파일목록·log 폴백) diff 없음', () => {
    expect(summarizeDiffStat('abc123 커밋 메시지')).toBe('diff 없음')
    expect(summarizeDiffStat('   ')).toBe('diff 없음')
  })
})
