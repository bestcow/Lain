import { describe, it, expect } from 'vitest'
import { classifySystemDestructive } from '../../src/main/sysrisk'

// 핵심 의도(HANDOFF 2026-07-04): PC 자체를 망가뜨리는 명령만 좁게 잡는다.
// 오탐 금지가 제1 원칙 — 일상 운영(deploy·node_modules 삭제·lain 재시작)이 걸리면 매우 성가심.
describe('classifySystemDestructive — 시스템 파괴만 잡는다 (미탐 방지)', () => {
  it('전원/세션 종료', () => {
    expect(classifySystemDestructive('shutdown /s /t 0')).toBe('power')
    expect(classifySystemDestructive('shutdown -h now')).toBe('power')
    expect(classifySystemDestructive('Stop-Computer -Force')).toBe('power')
    expect(classifySystemDestructive('Restart-Computer')).toBe('power')
    expect(classifySystemDestructive('logoff')).toBe('power')
  })

  it('디스크/파일시스템 파괴', () => {
    expect(classifySystemDestructive('format d: /q')).toBe('disk')
    expect(classifySystemDestructive('diskpart /s wipe.txt')).toBe('disk')
    expect(classifySystemDestructive('mkfs.ext4 /dev/sda1')).toBe('disk')
    expect(classifySystemDestructive('bcdedit /deletevalue')).toBe('disk')
    expect(classifySystemDestructive('vssadmin delete shadows /all')).toBe('disk')
    expect(classifySystemDestructive('Format-Volume -DriveLetter D')).toBe('disk')
  })

  it('레지스트리 삭제', () => {
    expect(classifySystemDestructive('reg delete HKLM\\SOFTWARE\\X /f')).toBe('registry')
    expect(classifySystemDestructive('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v foo')).toBe('registry')
    expect(classifySystemDestructive('Remove-Item -Recurse HKLM:\\SOFTWARE\\Foo')).toBe('registry')
    expect(classifySystemDestructive('Remove-ItemProperty -Path HKCU:\\X -Name y')).toBe('registry')
  })

  it('루트/시스템/홈 통째 삭제', () => {
    expect(classifySystemDestructive('rm -rf /')).toBe('root_delete')
    expect(classifySystemDestructive('rm -rf /*')).toBe('root_delete')
    expect(classifySystemDestructive('rm -rf ~')).toBe('root_delete')
    expect(classifySystemDestructive('rm -rf $HOME')).toBe('root_delete')
    expect(classifySystemDestructive('rm -rf /c')).toBe('root_delete')
    expect(classifySystemDestructive('Remove-Item -Recurse -Force C:\\')).toBe('root_delete')
    expect(classifySystemDestructive('Remove-Item -Recurse -Force C:\\Windows')).toBe('root_delete')
    expect(classifySystemDestructive('Remove-Item -Recurse -Force C:\\Users\\someone')).toBe('root_delete')
    expect(classifySystemDestructive('del /s /q C:\\Windows')).toBe('root_delete')
    expect(classifySystemDestructive('rd /s /q C:\\')).toBe('root_delete')
    expect(classifySystemDestructive('rm -rf "%USERPROFILE%"')).toBe('root_delete')
    expect(classifySystemDestructive('Remove-Item -Recurse $env:SystemRoot')).toBe('root_delete')
    // 체이닝 뒤에 숨긴 경우
    expect(classifySystemDestructive('echo hi && rm -rf /')).toBe('root_delete')
  })

  it('중요 프로세스 강제 종료', () => {
    expect(classifySystemDestructive('taskkill /f /im winlogon.exe')).toBe('critical_process')
    expect(classifySystemDestructive('taskkill /f /im explorer.exe')).toBe('critical_process')
    expect(classifySystemDestructive('Stop-Process -Name lsass -Force')).toBe('critical_process')
  })
})

describe('classifySystemDestructive — 일상 운영은 통과 (오탐 방지)', () => {
  it('개발 일상 명령', () => {
    expect(classifySystemDestructive('npm run deploy')).toBeNull()
    expect(classifySystemDestructive('npm test -- --forceExit')).toBeNull()
    expect(classifySystemDestructive('rm -rf node_modules')).toBeNull()
    expect(classifySystemDestructive('rm -rf dist out')).toBeNull()
    expect(classifySystemDestructive('Remove-Item -Recurse -Force .\\dist')).toBeNull()
    expect(classifySystemDestructive('Remove-Item -Recurse -Force C:\\workspace\\tools\\x\\node_modules')).toBeNull()
    expect(classifySystemDestructive('rm -rf C:\\Users\\someone\\proj\\node_modules')).toBeNull()
    expect(classifySystemDestructive('del /q C:\\temp\\a.txt')).toBeNull() // /q 스위치가 git-bash 루트로 오탐되면 안 됨
    expect(classifySystemDestructive('git reset --hard HEAD~1')).toBeNull() // RISKY(destructive) 몫 — system 아님
    expect(classifySystemDestructive('git push -f origin main')).toBeNull()
  })

  it('lain 자체 재시작/배포·앱 프로세스 종료는 통과', () => {
    expect(classifySystemDestructive('taskkill /f /im lain.exe')).toBeNull()
    expect(classifySystemDestructive('Stop-Process -Name lain -Force')).toBeNull()
    expect(classifySystemDestructive('taskkill /f /im node.exe')).toBeNull()
  })

  it('레지스트리 읽기/추가는 통과 (삭제만 게이트)', () => {
    expect(classifySystemDestructive('reg query HKLM\\SOFTWARE\\X')).toBeNull()
    expect(classifySystemDestructive('reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v lain /d x')).toBeNull()
    expect(classifySystemDestructive('Get-ItemProperty HKCU:\\Software\\X')).toBeNull()
  })

  it('산문/파일명 속 단어는 통과', () => {
    expect(classifySystemDestructive('git commit -m "fix shutdown handler"')).toBeNull()
    expect(classifySystemDestructive('cat docs/format-guide.md')).toBeNull()
    expect(classifySystemDestructive('node scripts/build-format.js')).toBeNull()
  })

  it('빈 문자열/무관 명령', () => {
    expect(classifySystemDestructive('')).toBeNull()
    expect(classifySystemDestructive('ls -la')).toBeNull()
  })
})
