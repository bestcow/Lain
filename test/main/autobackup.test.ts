// E8 확장 — 자동 백업 순수 함수 테스트. 파일시스템 접근(runAutoBackupIfDue)은 얇은 껍데기라 여기선
// 판정(isBackupDue)·네이밍(backupFileName)·보존 정리 대상 계산(pruneTargets)만 검증한다.
import { describe, it, expect } from 'vitest'
import {
  localDateKey,
  isBackupDue,
  backupFileName,
  pruneTargets,
} from '../../src/main/autobackup'

describe('localDateKey / isBackupDue — 하루 1회 판정(로컬 날짜)', () => {
  it('localDateKey는 월·일을 0패딩한 YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(localDateKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('기록 없음(null) → due', () => {
    expect(isBackupDue(null, new Date(2026, 6, 16))).toBe(true)
  })

  it('오늘 이미 백업함(같은 날짜) → due 아님', () => {
    expect(isBackupDue('2026-07-16', new Date(2026, 6, 16))).toBe(false)
  })

  it('날짜가 바뀌면 due — 며칠 꺼져 있었어도(밀린 백업) 첫 판정에서 돈다', () => {
    expect(isBackupDue('2026-07-14', new Date(2026, 6, 16))).toBe(true)
  })
})

describe('backupFileName — 수동 내보내기와 동일 네이밍', () => {
  it('lain-backup-YYYYMMDDHHMMSS.sqlite 포맷(UTC)', () => {
    expect(backupFileName(new Date('2026-07-16T01:02:03Z'))).toBe(
      'lain-backup-20260716010203.sqlite',
    )
  })

  it('생성한 이름은 pruneTargets의 정리 대상 패턴에 걸린다(자기 정리 가능)', () => {
    const name = backupFileName(new Date())
    expect(pruneTargets([name], 0)).toEqual([]) // keep 클램프=1 → 1개는 보존
    expect(pruneTargets([name, 'lain-backup-19990101000000.sqlite'], 1)).toEqual([
      'lain-backup-19990101000000.sqlite',
    ])
  })
})

describe('pruneTargets — 보존 개수 초과분(오래된 것부터) 삭제 대상 계산', () => {
  const f = (stamp: string) => `lain-backup-${stamp}.sqlite`

  it('보존 개수 이하면 삭제 대상 없음', () => {
    expect(pruneTargets([f('20260714120000'), f('20260715120000')], 7)).toEqual([])
  })

  it('초과분을 오래된 것부터 돌려준다(정렬 안 된 입력도 처리)', () => {
    const files = [f('20260716120000'), f('20260713120000'), f('20260715120000'), f('20260714120000')]
    expect(pruneTargets(files, 2)).toEqual([f('20260713120000'), f('20260714120000')])
  })

  it('백업 네이밍이 아닌 파일은 건드리지 않는다(사용자가 둔 파일 보호)', () => {
    const files = ['lain.sqlite', 'notes.txt', 'lain-backup-abc.sqlite', f('20260714120000'), f('20260715120000')]
    expect(pruneTargets(files, 1)).toEqual([f('20260714120000')])
  })

  it('keep<1·NaN은 1로 클램프 — 전량 삭제 불가(항상 최소 1개 보존)', () => {
    const files = [f('20260714120000'), f('20260715120000')]
    expect(pruneTargets(files, 0)).toEqual([f('20260714120000')])
    expect(pruneTargets(files, -3)).toEqual([f('20260714120000')])
    expect(pruneTargets(files, NaN)).toEqual([f('20260714120000')])
  })

  it('빈 목록 → 빈 결과', () => {
    expect(pruneTargets([], 7)).toEqual([])
  })
})
