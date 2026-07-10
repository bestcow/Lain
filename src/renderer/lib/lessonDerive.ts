// C7 — 교훈 계보/실주입 파생 로직(순수, vitest 검증). LessonDetail이 '주입 N회 / 인용 N회'와 정리 후보,
// 흡수된 원본 목록을 표시하는 데 쓴다. injectCount(실주입)·reuseCount(인용)·absorbedInto(병합 계보)는
// 이미 Lesson 타입/스토어에 수집돼 있으나 패널에 안 보였다 — 여기서 표시용 파생만 뽑는다(상태·IPC 없음).
import type { Lesson } from '../../shared/types'

/** 정리 후보 — 실제로 프롬프트에 주입은 됐는데(injectCount>0) 한 번도 인용(reuseCount)되지 않은 '죽은 교훈'.
 *  pinned(불가침)·archived(이미 정리됨)는 후보에서 제외. '주입만 되고 안 쓰이는' 낭비를 식별하는 신호. */
export function isCleanupCandidate(l: Lesson): boolean {
  if (l.pinned) return false
  if (l.status === 'archived') return false
  return l.injectCount > 0 && l.reuseCount === 0
}

/** 이 umbrella(병합 통합본) 교훈에 흡수된 원본 교훈들 — absorbedInto === umbrellaId 역참조.
 *  createdAt 오름차순(오래된 원본 먼저)으로 정렬해 계보를 시간순으로 나열한다. */
export function absorbedOriginals(all: Lesson[], umbrellaId: number): Lesson[] {
  return all
    .filter((l) => l.absorbedInto === umbrellaId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id))
}
