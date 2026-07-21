import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// store.ts는 './paths'의 DATA_DIR만 쓴다 — 테스트 고유 tmp 디렉터리로 격리(store.hide 패턴).
const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-retract-')) }
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
  insertLesson,
  applyConsolidation,
  retractLessons,
  lessonsForProject,
} from '../../src/main/store'

beforeAll(() => initStore())
afterAll(() => {
  try {
    closeStore()
  } catch {
    /* 잠금 무시 */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

// 2026-07-05 실제 사고 재현: 잘못된 학습이 큐레이터 병합(umbrella)으로 이미 흡수된 뒤엔,
// 원본만 보관해도 umbrella 안의 사본이 active로 남아 계속 주입됐다. retract는 우산까지 걷어야 한다.
describe('retractLessons — 사용자 정정發 철회는 병합 파생본까지 걷는다', () => {
  it('키워드 매칭 학습 + umbrella가 함께 보관되고 주입 목록에서 사라진다', () => {
    const a = insertLesson({
      projectId: '__lain__',
      taskId: 'turn-review',
      scope: 'global',
      trigger: '사용자를 호칭할 때',
      lesson: "사용자의 이름은 홍길동이다. 호칭 시 '홍길동'으로 부른다.",
      origin: 'agent',
    })
    const b = insertLesson({
      projectId: '__lain__',
      taskId: 'turn-review',
      scope: 'global',
      trigger: '호칭 관련',
      lesson: '홍길동이라는 이름을 기억하고 그렇게 지칭한다.',
      origin: 'agent',
    })
    // 큐레이터 병합 — 잘못된 사실이 umbrella로 흡수(원본 2건은 archived, 사본은 active)
    const archived = applyConsolidation([a, b], {
      projectId: '__lain__',
      scope: 'global',
      trigger: '사용자 호칭·지칭',
      lesson: "사용자의 이름은 홍길동이며 호칭·지칭 시 '홍길동'으로 부른다.",
    })
    expect(archived).toBe(2)
    // 병합 후에도 잘못된 내용이 주입 목록에 살아 있다(사고 상태)
    expect(lessonsForProject('__lain__', 10).some((l) => l.lesson.includes('홍길동'))).toBe(true)

    // 철회 — umbrella가 키워드로 직접 매칭돼 함께 보관된다
    const removed = retractLessons('홍길동')
    expect(removed.length).toBeGreaterThan(0)
    expect(lessonsForProject('__lain__', 10).some((l) => l.lesson.includes('홍길동'))).toBe(false)
  })

  it('무관한 학습은 건드리지 않는다', () => {
    insertLesson({
      projectId: '__lain__',
      taskId: 'turn-review',
      scope: 'global',
      trigger: '빌드',
      lesson: '빌드 후 반드시 deploy까지 실행한다.',
      origin: 'agent',
    })
    retractLessons('홍길동')
    expect(lessonsForProject('__lain__', 10).some((l) => l.lesson.includes('deploy까지'))).toBe(true)
  })

  it('pinned·user 학습도 명시 철회 대상(사용자 의사가 불가침 표시보다 우선)', () => {
    insertLesson({
      projectId: '__lain__',
      taskId: '',
      scope: 'global',
      trigger: '테스트규칙',
      lesson: '무지개색 버튼을 선호한다.',
      origin: 'user',
    })
    const removed = retractLessons('무지개색')
    expect(removed.length).toBe(1)
    expect(lessonsForProject('__lain__', 10).some((l) => l.lesson.includes('무지개색'))).toBe(false)
  })

  it('매칭 없으면 빈 배열·부수효과 없음', () => {
    expect(retractLessons('존재하지않는키워드')).toEqual([])
  })
})
