import { describe, it, expect } from 'vitest'
import { mergeActivity } from '../../src/renderer/lib/activityFeed'
import type { ActivityRaw } from '../../src/shared/types'

describe('mergeActivity — task_events + cc_events 시간 역순 병합', () => {
  const raws: ActivityRaw[] = [
    { source: 'task', at: '2026-07-07 14:02:00', detail: 'status', text: '작업 생성[interactive]: 리팩터', taskId: 't1' },
    { source: 'cc', at: '2026-07-07 13:40:00', detail: 'SessionEnd', projectId: 'hermes' },
    { source: 'task', at: '2026-07-07 13:55:00', detail: 'error', text: 'verify 실패\n두번째줄', taskId: 't2' },
    { source: 'cc', at: '2026-07-07 12:00:00', detail: 'SessionStart', projectId: 'lain' },
  ]

  it('최신이 먼저(시간 역순)', () => {
    const items = mergeActivity(raws)
    expect(items.map((i) => i.at)).toEqual([
      '2026-07-07 14:02:00',
      '2026-07-07 13:55:00',
      '2026-07-07 13:40:00',
      '2026-07-07 12:00:00',
    ])
  })

  it('cc 이벤트 라벨: SessionStart/End 한국어화, projectId 운반', () => {
    const items = mergeActivity(raws)
    const end = items.find((i) => i.source === 'cc' && i.kind === 'SessionEnd')!
    expect(end.label).toBe('CC 세션 종료')
    expect(end.projectId).toBe('hermes')
    const start = items.find((i) => i.kind === 'SessionStart')!
    expect(start.label).toBe('CC 세션 시작')
  })

  it('task 이벤트 라벨: status는 본문 첫 줄, error는 접두 + 첫 줄만', () => {
    const items = mergeActivity(raws)
    const status = items.find((i) => i.taskId === 't1')!
    expect(status.label).toBe('작업 생성[interactive]: 리팩터')
    const err = items.find((i) => i.taskId === 't2')!
    expect(err.label).toBe('작업 에러 — verify 실패') // 두번째줄 제외
    expect(err.source).toBe('task')
  })

  it('limit로 상위 N만', () => {
    expect(mergeActivity(raws, 2)).toHaveLength(2)
    expect(mergeActivity(raws, 2)[0].at).toBe('2026-07-07 14:02:00')
  })

  it('limit<=0이면 전부 반환', () => {
    expect(mergeActivity(raws, 0)).toHaveLength(4)
  })

  it('빈 입력이면 빈 배열', () => {
    expect(mergeActivity([])).toEqual([])
  })

  it('원본 배열을 변형하지 않는다(정렬은 map 사본에)', () => {
    const before = raws.map((r) => r.at)
    mergeActivity(raws)
    expect(raws.map((r) => r.at)).toEqual(before)
  })
})
