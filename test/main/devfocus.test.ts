import { describe, it, expect } from 'vitest'
import { isDevForeground, DEFAULT_DEV_APPS } from '../../src/main/devfocus'

describe('isDevForeground', () => {
  it('터미널·에디터는 통과', () => {
    expect(isDevForeground('WindowsTerminal', '~ PowerShell')).toBe(true)
    expect(isDevForeground('Code', 'main.ts — lain')).toBe(true)
    expect(isDevForeground('pwsh', '')).toBe(true)
  })
  it('브라우저는 개발성 제목일 때만 통과', () => {
    expect(isDevForeground('chrome', 'localhost:5173 - app')).toBe(true)
    expect(isDevForeground('msedge', 'bestcow/Lain: GitHub')).toBe(true)
    expect(isDevForeground('msedge', 'lain/pulls - GitHub')).toBe(true)
    expect(isDevForeground('chrome', 'YouTube')).toBe(false)
    expect(isDevForeground('chrome', 'GitHub outage explained - YouTube')).toBe(false)
  })
  it('비개발 앱은 차단', () => {
    expect(isDevForeground('MusicApp64', 'MusicApp')).toBe(false)
    expect(isDevForeground('ChatApp', '')).toBe(false)
    expect(isDevForeground('WordProc', '문서.docx')).toBe(false)
  })
  it('사용자 확장 목록이 더해진다', () => {
    expect(isDevForeground('MusicApp64', 'MusicApp', ['musicapp64'])).toBe(true)
  })
  it('기본 목록에 핵심 개발 앱 포함', () => {
    for (const k of ['windowsterminal', 'code', 'powershell']) expect(DEFAULT_DEV_APPS).toContain(k)
  })
})
