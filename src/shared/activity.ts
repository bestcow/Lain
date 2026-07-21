// 도구 활동 한 줄 → 사람말 상태 라벨 (main/renderer 공용).
// 레인 일러스트 옆 '지금 뭐 하는 중' 라인·프로젝트 카드·작업 드로어가 공유하는 단일 출처.
//
// 입력은 두 형식이 온다:
//  - 레인(manager) liveTool: formatToolUse display — "Read <경로>" / "$ <명령>" / "Grep <패턴>" / 맨 도구명
//  - Navi(worker) tool 로그: "<도구명>: <설명|명령|입력JSON 조각>" (worker.ts canUseTool의 log 형식)
//
// 원칙: **아는 도구만** 사람말로 바꾸고, 모르는 줄(내비 발화·한국어 status·이모지 라인)은 원문 그대로
// 돌려준다 — 첫 단어가 우연히 대문자라고 발화를 "도구 사용 중"으로 뭉개는 오변환을 막는다.
// 경로는 파일명만·명령은 머리 40자만 노출(시크릿·잡음 방지, formatToolUse와 동일 정책).

/** 레인 전용(mcp__lain__*) 도구 → 사람말. 목록에 없으면 '도구 사용 중'. */
const LAIN_TOOL_LABELS: Record<string, string> = {
  // Navi(worker) 쪽
  ask_manager: '레인에게 질문 중',
  // 레인(manager) 쪽
  ask_user: '질문 준비 중',
  list_projects: '현황 확인 중',
  list_tasks: '현황 확인 중',
  list_approvals: '현황 확인 중',
  list_cc_activity: '현황 확인 중',
  refresh_status: '현황 확인 중',
  start_task: '작업 맡기는 중',
  start_task_group: '작업 맡기는 중',
  rerun_task: '작업 맡기는 중',
  reorder_queue: '작업 순서 조정 중',
  set_task_deps: '작업 순서 조정 중',
  answer_clarify: 'Navi 질문에 답하는 중',
  cancel_task: '작업 취소 중',
  resolve_review: '작업 결재 중',
  resolve_group: '작업 결재 중',
  revert_merge: '병합 되돌리는 중',
  message_navi: 'Navi에게 말 거는 중',
  broadcast_navis: 'Navi에게 말 거는 중',
  search_history: '기록 뒤지는 중',
  retract_lessons: '기억 정리 중',
  scan_projects: '프로젝트 훑는 중',
  run_verify: '검증 돌리는 중',
  set_user_title: '설정 반영 중',
  set_discord_config: '설정 반영 중',
}

/** 세부 정보 없이 '도구 사용 중'으로만 표시하는 표준 도구(세부가 사용자에게 무의미). */
const OPAQUE_TOOLS = new Set([
  'KillShell',
  'BashOutput',
  'TaskOutput',
  'ExitPlanMode',
  'EnterPlanMode',
  'SlashCommand',
  'Skill',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
])

function head(s: string, n: number): string {
  const t = s.trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function basename(p: string): string {
  return (
    p
      .replace(/["']/g, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? ''
  )
}

/** detail에서 파일명을 뽑는다 — JSON 조각({"file_path":"…"})이든 맨 경로든. 없으면 ''. */
function fileFromDetail(detail: string): string {
  const m = detail.match(/"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)+)"/)
  if (m) return basename(m[1].replace(/\\\\/g, '\\'))
  const t = detail.trim()
  // worker 로그는 JSON이 120자에서 잘려 닫는 따옴표가 없을 수 있다 — 위 매칭 실패 시 잘린 경로도 시도.
  const cut = detail.match(/"(?:file_path|notebook_path|path)"\s*:\s*"([^"]+)/)
  if (cut) return basename(cut[1].replace(/\\\\/g, '\\'))
  if (t && !t.startsWith('{') && /[\\/]/.test(t)) return basename(t)
  return ''
}

/** detail에서 명령/설명 머리를 뽑는다 — JSON이면 command 값, 아니면 원문 머리. */
function cmdFromDetail(detail: string): string {
  const m = detail.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"?/)
  const c = m ? m[1].replace(/\\"/g, '"') : detail.startsWith('{') ? '' : detail
  return head(c, 40)
}

/**
 * 도구 활동 한 줄을 사람말로. 아는 형식이 아니면 원문 그대로 반환한다.
 * 빈 문자열은 빈 문자열 그대로(호출부가 표시 여부를 판단).
 */
export function humanizeActivity(line: string): string {
  const t = (line ?? '').trim()
  if (!t) return t
  // formatToolUse의 셸 표기: "$ <명령>"
  if (t.startsWith('$ ')) return `명령 실행 중 — ${head(t.slice(2), 40)}`
  const m = t.match(/^(mcp__[\w-]+__[\w-]+|[A-Za-z][\w]*)\s*:?\s+(.*)$/s) ?? t.match(/^(mcp__[\w-]+__[\w-]+|[A-Za-z][\w]*)$/)
  if (!m) return t
  const name = m[1]
  const detail = (m[2] ?? '').trim()
  if (name.startsWith('mcp__')) {
    const short = name.split('__').pop() ?? name
    return LAIN_TOOL_LABELS[short] ?? '도구 사용 중'
  }
  switch (name) {
    case 'Read': {
      const f = fileFromDetail(detail)
      return f ? `파일 읽는 중 — ${f}` : '파일 읽는 중'
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const f = fileFromDetail(detail)
      return f ? `파일 고치는 중 — ${f}` : '파일 고치는 중'
    }
    case 'Bash':
    case 'PowerShell': {
      const c = cmdFromDetail(detail)
      return c ? `명령 실행 중 — ${c}` : '명령 실행 중'
    }
    case 'Grep':
    case 'Glob':
      return '파일·코드 찾는 중'
    case 'WebFetch':
    case 'WebSearch':
      return '웹 찾아보는 중'
    case 'Task':
    case 'Agent':
      return '보조 에이전트 돌리는 중'
    case 'TodoWrite':
      return detail ? `체크리스트 갱신 중 (${head(detail, 20)})` : '체크리스트 갱신 중'
    default:
      if (OPAQUE_TOOLS.has(name)) return '도구 사용 중'
      // 모르는 첫 단어 = 도구가 아니라 발화/상태문일 가능성 — 원문 유지(오변환 방지).
      return t
  }
}
