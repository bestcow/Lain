// 클로드코드 연동(#2 Phase 1) — settings.json 훅 병합/제거 순수 로직. 사용자의 글로벌 ~/.claude
// 설정을 건드리므로, 기존 훅 보존·멱등·정확한 제거를 단위로 못박는다(fs·homedir 없이 순수 함수만).
import { describe, it, expect } from 'vitest'
import { mergeOurHooks, stripOurHooks } from '../../src/main/cchooks'

const CMD = 'node "C:/x/cc-link/lain-cc-hook.cjs"'
const cmdsOf = (groups: any[]): string[] =>
  (groups ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command))

describe('cchooks — settings.json 훅 병합', () => {
  it('빈 설정에 SessionStart/SessionEnd 우리 훅 추가', () => {
    const out = mergeOurHooks({}, CMD)
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe(CMD)
    expect(out.hooks.SessionEnd[0].hooks[0].command).toBe(CMD)
  })

  it('멱등 — 두 번 병합해도 우리 훅은 이벤트당 1개', () => {
    const twice = mergeOurHooks(mergeOurHooks({}, CMD), CMD)
    expect(cmdsOf(twice.hooks.SessionStart).filter((c) => c === CMD)).toHaveLength(1)
    expect(cmdsOf(twice.hooks.SessionEnd).filter((c) => c === CMD)).toHaveLength(1)
  })

  it('사용자의 기존 훅·키 보존(같은 이벤트의 남의 훅 + 무관 이벤트 + 무관 키)', () => {
    const user = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }],
      },
      permissions: { allow: ['Bash'] },
    }
    const out = mergeOurHooks(user, CMD)
    expect(cmdsOf(out.hooks.SessionStart)).toContain('echo hi') // 남의 것 유지
    expect(cmdsOf(out.hooks.SessionStart)).toContain(CMD) // 우리 것 추가
    expect(out.hooks.PostToolUse).toEqual(user.hooks.PostToolUse) // 무관 이벤트 그대로
    expect(out.permissions).toEqual({ allow: ['Bash'] }) // 무관 키 그대로
  })

  it('stripOurHooks — 우리 훅만 제거하고 남의 것·키 보존', () => {
    const merged = mergeOurHooks(
      { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, keep: 1 },
      CMD,
    )
    const out = stripOurHooks(merged)
    expect(cmdsOf(out.hooks.SessionStart)).toEqual(['echo hi']) // 남의 것만 남음
    expect(out.hooks.SessionEnd).toBeUndefined() // 우리만 있던 이벤트는 키째 제거
    expect(out.keep).toBe(1)
  })

  it('stripOurHooks — 우리 훅만 있던 설정은 hooks 키까지 제거', () => {
    expect(stripOurHooks(mergeOurHooks({}, CMD)).hooks).toBeUndefined()
  })

  it('순수 — 원본 입력을 변형하지 않음', () => {
    const input = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }
    const snap = JSON.stringify(input)
    mergeOurHooks(input, CMD)
    stripOurHooks(input)
    expect(JSON.stringify(input)).toBe(snap)
  })
})
