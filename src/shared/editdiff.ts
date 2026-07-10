// A6 — 레인 직접 Edit/Write 편집의 diff 미리보기. Navi 작업은 worktree 격리 + git diff(worktree.ts
// diffBody)가 있지만, 레인 직접 편집은 격리도 diff도 없어 'Edit <경로>' 한 줄만 남고 뭐가 바뀌었는지
// 볼 수단이 없었다(감사 A6). Edit tool_use의 input(old_string/new_string)·Write의 input(content)에서
// 표시용 라인 diff를 만드는 순수 함수 — git 없이 문자열만으로 계산(레인 편집은 워크트리가 아니라
// 등록된 실제 레포를 직접 건드리므로 git diff 커맨드에 기대지 않는다).
//
// 인코딩은 todoline.ts(A4)와 동일한 "접두사 + JSON" 패턴 — main이 tool 라인 content 하나에 실어
// addMessage로 영속하고, renderer(markdown.tsx)가 같은 모듈로 디코딩해 접이식 diff 카드로 렌더한다.

export type DiffLineKind = 'ctx' | 'add' | 'del'
export type DiffLine = { kind: DiffLineKind; text: string }

export type EditDiffPayload = {
  tool: 'Edit' | 'Write'
  filePath: string
  lines: DiffLine[]
  truncated: boolean // 원본 줄 수가 표시 상한을 넘어 잘렸는지(펼쳐도 전체가 아님을 표시)
  turnId?: string // D15 되감기 — 이 편집이 속한 턴 체크포인트 그룹. 있으면 카드에 '되돌리기' 노출(구 카드는 없음)
  label?: string // 재리뷰 #4 — 있으면 카드 헤더를 'tool filePath' 대신 이 라벨로 표시(un-revert 카드 '↩ 복원 직전 상태' 등)
}

// 라인 하나가 표시상 지나치게 길면(한 줄짜리 minified 코드 등) 잘라 카드 폭을 지킨다.
const LINE_MAX = 300
function clip(line: string): string {
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line
}

/** old_string/new_string 각각을 줄 단위로 쪼개, 앞뒤 공통 줄은 문맥(ctx)으로 남기고
 * 가운데 달라지는 구간만 del(old)/add(new)로 표시한다. 진짜 LCS 정렬은 아니고(YAGNI — 파일 전체가
 * 아니라 Edit 인자 자체가 이미 국소 변경분), 공통 prefix/suffix 제거만으로 대부분의 실사용 편집을
 * 충분히 읽기 좋게 축약한다. 문맥은 앞뒤 최대 2줄만 남겨 카드가 old/new 전문으로 부풀지 않게 한다. */
export function buildEditDiffLines(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  let start = 0
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++
  }
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--
    newEnd--
  }
  const CTX = 2
  const lines: DiffLine[] = []
  const ctxStart = Math.max(0, start - CTX)
  for (let i = ctxStart; i < start; i++) lines.push({ kind: 'ctx', text: clip(oldLines[i]) })
  for (let i = start; i < oldEnd; i++) lines.push({ kind: 'del', text: clip(oldLines[i]) })
  for (let i = start; i < newEnd; i++) lines.push({ kind: 'add', text: clip(newLines[i]) })
  const ctxEndOld = Math.min(oldLines.length, oldEnd + CTX)
  for (let i = oldEnd; i < ctxEndOld; i++) lines.push({ kind: 'ctx', text: clip(oldLines[i]) })
  return lines
}

/** Write는 파일을 통째로 새 내용으로 덮어쓴다 — 이전 내용을 canUseTool 시점에 알 수 없으므로
 * (읽지 않고 덮어쓰기도 허용되는 도구) 새 content 전체를 add로 보여준다. */
export function buildWriteDiffLines(content: string): DiffLine[] {
  return content.split('\n').map((text) => ({ kind: 'add', text: clip(text) }))
}

// 카드가 지나치게 길어지는 것(수백 줄 diff)을 막는 표시 상한 — TaskDrawer diff 뷰와 별개로 채팅
// 카드는 훨씬 좁으므로 코드블록 접힘 기준(CODE_FOLD_LINES=25, markdown.tsx)보다 낮게 잡는다.
export const DIFF_FOLD_LINES = 40

/** 표시용 diff 라인이 상한을 넘으면 앞부분만 남기고 잘라 truncated=true로 표시한다(순수 함수 — 테스트 대상). */
export function foldDiffLines(lines: DiffLine[], max = DIFF_FOLD_LINES): { lines: DiffLine[]; truncated: boolean } {
  if (lines.length <= max) return { lines, truncated: false }
  return { lines: lines.slice(0, max), truncated: true }
}

/** diff 라인을 +/-/(문맥은 공백) 접두사가 붙은 plain 텍스트로 조립 — question 카드(QuestionCard)처럼
 * 서식 없는 텍스트만 표시하는 승인 카드에 파일경로 + diff를 한 문자열로 실을 때 쓴다. */
export function renderEditDiffText(payload: EditDiffPayload): string {
  const prefix: Record<DiffLineKind, string> = { ctx: '  ', del: '- ', add: '+ ' }
  const body = payload.lines.map((l) => `${prefix[l.kind]}${l.text}`).join('\n')
  const verb = payload.tool === 'Write' ? '새로 씀' : '수정'
  const trunc = payload.truncated ? '\n… (이하 생략 — 접이식 diff 카드에서 전체 확인)' : ''
  return `${payload.tool} ${verb}: ${payload.filePath}\n\n${body}${trunc}`
}

const DIFF_PREFIX = '§diff§'

/** EditDiffPayload를 한 줄 문자열로 인코딩(todoline.ts와 동일 "접두사 + JSON" 패턴). */
export function encodeEditDiffLine(payload: EditDiffPayload): string {
  return `${DIFF_PREFIX}${JSON.stringify(payload)}`
}

function isDiffLineKind(v: unknown): v is DiffLineKind {
  return v === 'ctx' || v === 'add' || v === 'del'
}

/** encodeEditDiffLine 결과를 payload로 복원. 접두사 없거나 JSON/형태가 깨졌으면 null(호출부가
 * 평범한 라인으로 폴백 — todoline.ts decodeTodoLine과 동형). */
export function decodeEditDiffLine(content: string): EditDiffPayload | null {
  if (!content.startsWith(DIFF_PREFIX)) return null
  try {
    const parsed = JSON.parse(content.slice(DIFF_PREFIX.length)) as Partial<EditDiffPayload>
    if (parsed.tool !== 'Edit' && parsed.tool !== 'Write') return null
    if (typeof parsed.filePath !== 'string') return null
    if (!Array.isArray(parsed.lines)) return null
    const lines: DiffLine[] = []
    for (const l of parsed.lines) {
      const o = l as { kind?: unknown; text?: unknown }
      if (!isDiffLineKind(o?.kind) || typeof o?.text !== 'string') continue
      lines.push({ kind: o.kind, text: o.text })
    }
    return {
      tool: parsed.tool,
      filePath: parsed.filePath,
      lines,
      truncated: !!parsed.truncated,
      turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
      label: typeof parsed.label === 'string' ? parsed.label : undefined,
    }
  } catch {
    return null
  }
}
