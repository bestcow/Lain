import { describe, it, expect } from 'vitest'
import {
  NAVI_CHAT_LESSON_LIMIT,
  naviChatLessonsBlock,
  shouldInjectNaviChatLessons,
} from '../../src/main/lessoninject'
import type { Lesson } from '../../src/shared/types'

// Navi 직접 채팅 학습 주입(§5.6) — 주입 여부(새 세션만)·블록 포맷(manager <lessons> 동형)·cap(6건) 고정.

function mkLesson(over: Partial<Lesson>): Lesson {
  return {
    id: 1,
    projectId: 'p',
    taskId: 't',
    scope: 'project',
    trigger: '',
    lesson: 'x',
    reuseCount: 0,
    createdAt: '2026-07-07T10:00:00',
    status: 'active',
    lastUsedAt: null,
    pinned: false,
    origin: 'agent',
    absorbedInto: null,
    consolidationBatch: null,
    injectCount: 0,
    ...over,
  }
}

describe('shouldInjectNaviChatLessons — 새 세션만 주입(결정론)', () => {
  it('resume 없음(새 세션) → 주입', () => {
    expect(shouldInjectNaviChatLessons(undefined)).toBe(true)
  })
  it("빈 문자열(에러로 초기화된 세션)도 새 세션 취급 → 주입", () => {
    expect(shouldInjectNaviChatLessons('')).toBe(true)
  })
  it('resume 살아있으면(세션 히스토리에 이미 있음) 재주입 안 함', () => {
    expect(shouldInjectNaviChatLessons('sess-abc')).toBe(false)
  })
})

describe('naviChatLessonsBlock — 포맷·cap', () => {
  it('학습 0건이면 빈 문자열(주입 0)', () => {
    expect(naviChatLessonsBlock([])).toBe('')
  })

  it('manager <lessons> 포맷과 동형 — trigger 있으면 "trigger → 본문" 불릿', () => {
    const block = naviChatLessonsBlock([
      mkLesson({ trigger: '배포', lesson: '배포는 deploy 스크립트로 끝낸다' }),
      mkLesson({ id: 2, lesson: '트리거 없는 학습' }),
    ])
    expect(block).toContain('<lessons>\n')
    expect(block).toContain('</lessons>')
    expect(block).toContain('- 배포 → 배포는 deploy 스크립트로 끝낸다')
    expect(block).toContain('- 트리거 없는 학습') // trigger 없으면 화살표 없이 본문만
    expect(block).not.toContain('-  →') // 빈 trigger가 화살표를 남기지 않는다
  })

  it('preamble 블록 규약 — trailing \\n\\n으로 끝나 뒤 블록과 이어붙는다', () => {
    expect(naviChatLessonsBlock([mkLesson({})]).endsWith('</lessons>\n\n')).toBe(true)
  })

  it(`개수 cap — ${NAVI_CHAT_LESSON_LIMIT}건 초과 입력은 앞 ${NAVI_CHAT_LESSON_LIMIT}건만(manager와 동일 기준)`, () => {
    const many = Array.from({ length: NAVI_CHAT_LESSON_LIMIT + 4 }, (_, i) =>
      mkLesson({ id: i + 1, lesson: `학습-${i + 1}` }),
    )
    const block = naviChatLessonsBlock(many)
    const bullets = block.split('\n').filter((ln) => ln.startsWith('- '))
    expect(bullets).toHaveLength(NAVI_CHAT_LESSON_LIMIT)
    expect(block).toContain(`학습-${NAVI_CHAT_LESSON_LIMIT}`)
    expect(block).not.toContain(`학습-${NAVI_CHAT_LESSON_LIMIT + 1}`) // 컷 경계
  })

  it('본문은 원문 그대로(글자수 절단 없음 — manager 기준 미러)', () => {
    const longText = '한'.repeat(400)
    expect(naviChatLessonsBlock([mkLesson({ lesson: longText })])).toContain(longText)
  })
})
