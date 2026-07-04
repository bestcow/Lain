// 검증 증거 넛지 (학습루프 T7, hermes verification-on-stop 대응 — 메커니즘만 lain 고유 재구현).
// 레인이 직접 코드 파일을 Edit/Write한 턴이 검증 실행(Bash/PowerShell의 test·typecheck·build류) 없이
// 끝나면, 다음 턴 프롬프트에 1회 넛지를 주입한다. 전부 결정론(L0) — 도구 사용 스트림에서 감지만 하고
// 판단·주입 소비는 manager.ts가 한다. 문서류(.md 등)만 고친 턴은 억제(hermes 오탐 수정 반영).

// 코드 확장자 화이트리스트 — 문서/데이터 파일(.md/.txt/.json/.yml…)은 넛지 대상 아님.
const CODE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte|sql|sh|bash|ps1|psm1|css|scss|less)$/i

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// 검증 명령 형상 — 셸 명령 문자열에서 test/typecheck/lint/build류를 감지(보수적: 흔한 러너·스크립트만).
const VERIFY_CMD_RE =
  /\b(vitest|jest|pytest|playwright|tsc\b|typecheck|eslint|ruff|clippy|golangci)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|typecheck|lint|check)\b|\bcargo\s+(test|check|build)\b|\bgo\s+(test|vet|build)\b|\bmake\s+(test|check)\b|\bdotnet\s+(test|build)\b|\bmvn\s+(test|verify)\b|\bgradle\w*\s+(test|check)\b/i

/** 이 tool_use가 코드 파일 수정인가 — Edit/Write류 + 코드 확장자. */
export function isCodeEdit(toolName: string, input: unknown): boolean {
  if (!EDIT_TOOLS.has(toolName)) return false
  const i = input as Record<string, unknown> | null
  const p = String(i?.file_path ?? i?.notebook_path ?? '')
  return CODE_EXT_RE.test(p)
}

/** 이 tool_use가 검증 실행인가 — 셸의 검증 명령 또는 lain 자체 검증/배포 도구. */
export function isVerifyRun(toolName: string, input: unknown): boolean {
  if (toolName === 'mcp__lain__run_verify' || toolName === 'mcp__lain__deploy_lain') return true
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return false
  const i = input as Record<string, unknown> | null
  return VERIFY_CMD_RE.test(String(i?.command ?? ''))
}

/** 순수 — 턴 종료 시 넛지를 세울지. 코드 수정 있었고 검증 실행이 없었을 때만. */
export function shouldNudge(codeEdited: boolean, verifyRan: boolean): boolean {
  return codeEdited && !verifyRan
}

// 다음 턴 프롬프트에 붙는 1회 넛지 — 루프 방지는 소비처(manager)가 플래그를 즉시 내려서 보장.
export const VERIFY_NUDGE_NOTE =
  '\n\n(검증 넛지: 직전 턴에 코드 파일을 수정했지만 검증 실행이 확인되지 않았다. 아직이라면 해당 프로젝트의 테스트/타입체크를 돌려 결과까지 확인하고 보고해라. 이미 검증했거나 검증이 무의미한 변경이면 무시해도 된다.)'
