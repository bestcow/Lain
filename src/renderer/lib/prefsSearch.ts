// B11 — 환경설정 검색의 순수 매칭 로직. PrefsModal의 각 설정 행에 붙인 검색 항목(라벨+힌트 키워드+
// 소속 카테고리)을 대상으로 부분일치한다. 검색 필드가 매치될 때 어느 카테고리로 전환할지, 어떤 항목을
// 하이라이트할지를 여기서 결정론적으로 계산한다(상태 없는 순수 함수 — vitest 검증). '필터 표시'가 아닌
// '카테고리 자동 전환 + 하이라이트' 방식(구현 단순).

export interface PrefsSearchItem {
  /** 설정 행 식별자(하이라이트 대상 지정용). PrefsModal의 data-skey와 일치. */
  key: string
  /** 사람이 보는 설정명(라벨). */
  label: string
  /** 힌트/설명 등 부가 검색어(공백 결합). */
  hint?: string
  /** 소속 카테고리 id(CATS.id). */
  cat: string
}

/** 쿼리 정규화 — 트림·소문자. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase()
}

/**
 * 한 항목이 쿼리에 매치되는지 — 공백 분리 다중 토큰 AND, label+hint 소문자 부분일치.
 * 빈 쿼리는 매치 없음(false)으로 취급한다(하이라이트/전환을 트리거하지 않음).
 */
export function matchesItem(item: PrefsSearchItem, q: string): boolean {
  const nq = normalizeQuery(q)
  if (!nq) return false
  const hay = `${item.label} ${item.hint ?? ''}`.toLowerCase()
  return nq.split(/\s+/).filter(Boolean).every((t) => hay.includes(t))
}

/** 쿼리에 매치되는 항목 전부(표시 순서 유지). */
export function matchingItems(items: PrefsSearchItem[], q: string): PrefsSearchItem[] {
  if (!normalizeQuery(q)) return []
  return items.filter((it) => matchesItem(it, q))
}

/** 매치되는 항목 key 집합(하이라이트 판정용). */
export function matchingKeys(items: PrefsSearchItem[], q: string): Set<string> {
  return new Set(matchingItems(items, q).map((it) => it.key))
}

/**
 * 검색 결과로 전환할 카테고리 — 첫 매치 항목의 카테고리. 매치 없으면 null(전환 안 함).
 * 현재 보고 있는 카테고리에 이미 매치가 있으면 전환하지 않는다(사용자 위치 존중 — 타 카테고리로 튀지 않게).
 */
export function targetCategory(
  items: PrefsSearchItem[],
  q: string,
  currentCat?: string,
): string | null {
  const hits = matchingItems(items, q)
  if (hits.length === 0) return null
  if (currentCat && hits.some((h) => h.cat === currentCat)) return currentCat
  return hits[0].cat
}
