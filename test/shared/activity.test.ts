// humanizeActivity — 도구 활동 한 줄 → 사람말 (UI③). 두 입력 형식(manager display / worker 로그)과
// '모르는 줄은 원문 유지'(발화 오변환 방지) 원칙을 회귀 가드로 박제.
import { describe, it, expect } from 'vitest'
import { humanizeActivity } from '../../src/shared/activity'

describe('humanizeActivity — manager(formatToolUse display) 형식', () => {
  it('Read <경로> → 파일 읽는 중 — 파일명만', () => {
    expect(humanizeActivity('Read C:\\lain\\src\\main\\store.ts')).toBe('파일 읽는 중 — store.ts')
  })
  it('Edit <경로> → 파일 고치는 중', () => {
    expect(humanizeActivity('Edit C:/lain/src/renderer/App.tsx')).toBe('파일 고치는 중 — App.tsx')
  })
  it('$ 명령 → 명령 실행 중 — 머리 40자', () => {
    expect(humanizeActivity('$ git status')).toBe('명령 실행 중 — git status')
    const long = '$ ' + 'x'.repeat(100)
    expect(humanizeActivity(long)).toBe(`명령 실행 중 — ${'x'.repeat(40)}…`)
  })
  it('Grep/Glob → 패턴 숨기고 찾는 중', () => {
    expect(humanizeActivity('Grep liveTool|formatToolUse')).toBe('파일·코드 찾는 중')
    expect(humanizeActivity('Glob **/*.ts')).toBe('파일·코드 찾는 중')
  })
  it('TodoWrite 진행률 병기', () => {
    expect(humanizeActivity('TodoWrite 3/5')).toBe('체크리스트 갱신 중 (3/5)')
    expect(humanizeActivity('TodoWrite')).toBe('체크리스트 갱신 중')
  })
  it('맨 도구명(WebSearch 등)', () => {
    expect(humanizeActivity('WebSearch')).toBe('웹 찾아보는 중')
    expect(humanizeActivity('Task')).toBe('보조 에이전트 돌리는 중')
  })
  it('레인 mcp 도구 — 아는 건 매핑, 모르는 건 도구 사용 중', () => {
    expect(humanizeActivity('mcp__lain__start_task')).toBe('작업 맡기는 중')
    expect(humanizeActivity('mcp__lain__unknown_tool_xyz')).toBe('도구 사용 중')
  })
})

describe('humanizeActivity — worker(canUseTool 로그) 형식', () => {
  it('Read: {json 조각} → 파일명 추출(이스케이프 역슬래시 처리)', () => {
    expect(humanizeActivity('Read: {"file_path":"C:\\\\lain\\\\src\\\\main\\\\worker.ts"}')).toBe(
      '파일 읽는 중 — worker.ts',
    )
  })
  it('120자 절단으로 닫는 따옴표가 없어도 파일명 추출', () => {
    expect(humanizeActivity('Read: {"file_path":"C:\\\\lain\\\\src\\\\shared\\\\activity')).toBe(
      '파일 읽는 중 — activity',
    )
  })
  it('Bash: 설명문 → 명령 실행 중 — 설명', () => {
    expect(humanizeActivity('Bash: Run typecheck')).toBe('명령 실행 중 — Run typecheck')
  })
  it('mcp__lain__ask_manager → 레인에게 질문 중', () => {
    expect(humanizeActivity('mcp__lain__ask_manager: {"question":"어느 쪽?"}')).toBe('레인에게 질문 중')
  })
})

describe('humanizeActivity — 모르는 줄은 원문 유지(오변환 방지)', () => {
  it('내비 발화(영어 문장)는 그대로', () => {
    const speech = 'Fixed the flaky test and reran the suite.'
    expect(humanizeActivity(speech)).toBe(speech)
  })
  it('한국어 status 라인은 그대로', () => {
    expect(humanizeActivity('세션 종료: success (12턴)')).toBe('세션 종료: success (12턴)')
    expect(humanizeActivity('🧠 컨텍스트 압축 중…')).toBe('🧠 컨텍스트 압축 중…')
  })
  it('빈 문자열은 빈 문자열', () => {
    expect(humanizeActivity('')).toBe('')
  })
})
