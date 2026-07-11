// B10 — 키보드 단축키의 단일 출처. 실제 App.tsx·AttentionInbox·CommandPalette에 구현된 단축키만
// 정확히 나열한다(없는 단축키 날조 금지 — 테스트로 코드-라벨 일치를 고정). '?' 도움말 오버레이와
// CommandPalette 뱃지가 이 목록을 함께 렌더하므로, 새 단축키를 붙일 땐 여기 한 곳만 고치면 된다.

export interface Shortcut {
  /** 사람이 읽을 키 표기(예: 'Ctrl+K', '↑ / ↓', 'Esc'). 도움말·뱃지에 그대로 표시. */
  keys: string
  /** 무엇을 하는지 한 줄 설명. */
  desc: string
  /** 어디서 유효한지(그룹 헤더). */
  group: string
  /** CommandPalette 항목과 연결할 때 쓰는 액션 id(있는 항목만 뱃지 부착). */
  paletteId?: string
}

// 그룹 순서 = 도움말 오버레이 표시 순서.
export const SHORTCUTS: Shortcut[] = [
  // 전역
  { keys: 'Ctrl+K', desc: '명령 팔레트 열기 (Ctrl+P도 동일)', group: '전역' },
  { keys: '?', desc: '이 단축키 도움말 열기', group: '전역', paletteId: 'act:shortcuts' },
  { keys: 'Esc', desc: '열린 오버레이·검색·메뉴 닫기 (없으면 응답 중 정지)', group: '전역' },
  // 대화
  { keys: 'Ctrl+F', desc: '현재 대화 내 검색', group: '대화' },
  { keys: '↑ / ↓', desc: '입력창이 비었을 때 이전/다음 보낸 메시지 회상', group: '대화' },
  { keys: 'Enter', desc: '전송 (Shift+Enter는 줄바꿈)', group: '대화' },
  { keys: '/', desc: '입력창 맨 앞에서 슬래시 명령 팝업', group: '대화' },
  { keys: '@', desc: '파일 경로 자동완성 팝업', group: '대화' },
  // 인박스(대기 처리)
  { keys: 'y / Enter', desc: '승인 (선택된 승인 행)', group: '인박스' },
  { keys: 'n', desc: '거절 (선택된 승인 행)', group: '인박스' },
  { keys: 'm / Enter', desc: '병합 (선택된 결재 행)', group: '인박스' },
  { keys: 'b', desc: '브랜치 유지 (선택된 결재 행)', group: '인박스' },
]

/** 그룹 순서를 보존하며 { group, items } 목록으로 묶는다(첫 등장 순). 도움말 오버레이 렌더용. */
export function groupedShortcuts(list: Shortcut[] = SHORTCUTS): { group: string; items: Shortcut[] }[] {
  const out: { group: string; items: Shortcut[] }[] = []
  const byGroup = new Map<string, Shortcut[]>()
  for (const s of list) {
    let bucket = byGroup.get(s.group)
    if (!bucket) {
      bucket = []
      byGroup.set(s.group, bucket)
      out.push({ group: s.group, items: bucket })
    }
    bucket.push(s)
  }
  return out
}

/** paletteId → keys 표기 맵(팔레트 항목 뱃지 부착용). paletteId 없는 항목은 제외. */
export function paletteHotkeys(list: Shortcut[] = SHORTCUTS): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of list) if (s.paletteId) out[s.paletteId] = s.keys
  return out
}
