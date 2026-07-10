// Codex 엔진 어댑터 — OpenAI Codex CLI(codex exec)를 작업 Navi의 대체 엔진으로.
// 매니저(Lain)·judge는 Claude 고정, worker(작업 실행)만 task.engine으로 선택한다.
// runNavi(worker.ts)와 같은 NaviReport 계약을 지켜 orchestrator의 clarify→verify→review→merge
// 흐름을 그대로 재사용한다(worktree 격리·diff·머지 승인 모두 동일).
//
// 실측 codex-cli 0.142.5 (2026-07-05, PLAN §18 방식):
//  - `codex exec --json` → JSONL 이벤트: thread.started(thread_id) · turn.started ·
//    item.started/completed(item.type: agent_message | command_execution{command,exit_code} |
//    file_change{changes[]}) · turn.completed(usage{input_tokens,cached_input_tokens,output_tokens})
//  - 재개: `codex exec resume <thread_id> --json -` (‑C/-s 플래그는 없음 → cwd/샌드박스는 -c 오버라이드)
//  - 프롬프트는 stdin('-')으로 — 인자 이스케이프·주입 문제 원천 차단
//  - npm 전역 셔틀은 .cmd/.ps1이라 직접 spawn 불가(Node CVE-2024-27980) → node + codex.js 경로로 실행
//
// ⚠ 승인 큐 미적용: codex exec는 비대화형이라 사람에게 못 묻는다. 방어선은 codex 자체
// 샌드박스(workspace-write: worktree 밖 쓰기 차단)다. lain의 RISKY/시스템 게이트·ask_manager·
// 교훈/스킬 주입은 claude 엔진 전용 — 이 차이는 start_task 도구 설명에 명시한다.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { addTaskEvent, updateTask, getProject } from './store'
import { conventionsBlock } from './conventions'
import type { ExitReason, Task, TaskEvent } from '../shared/types'
import { parseReport, type NaviReport, type RunNaviOpts } from './worker'

/** codex.js(npm 전역 설치본) 경로 탐지 — env 오버라이드 → APPDATA npm → where.exe 순. */
function codexJs(): string | null {
  const envp = process.env.LAIN_CODEX_JS
  if (envp && fs.existsSync(envp)) return envp
  const cands: string[] = []
  if (process.env.APPDATA)
    cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
  try {
    const w = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8', timeout: 5000 })
    for (const line of String(w.stdout ?? '').split(/\r?\n/)) {
      const dir = path.dirname(line.trim())
      if (dir && dir !== '.')
        cands.push(path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
    }
  } catch {
    /* where 실패 — 후보만으로 진행 */
  }
  for (const c of cands) if (fs.existsSync(c)) return c
  return null
}

/** 사용 가능 여부 — start_task가 시작 전에 검사해 명확한 에러를 돌려주게. */
export function codexStatus(): { ok: boolean; reason?: string } {
  if (!codexJs())
    return { ok: false, reason: 'Codex CLI 미설치 — `npm install -g @openai/codex` 후 다시 시도' }
  if (!fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json')))
    return { ok: false, reason: 'Codex 미로그인 — 터미널에서 `codex login` 후 다시 시도' }
  return { ok: true }
}

// ── JSONL 이벤트 → lain task_events 매핑 (순수함수 — 단위테스트 대상) ──
export type CodexMapped =
  | { kind: 'thread'; threadId: string }
  | { kind: 'text'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'exec'; text: string } // D12 — 명령 실행 감사(승인 큐 없는 codex의 유일한 관측창)
  | { kind: 'usage'; tokens: number }
  | null

export function mapCodexLine(line: string): CodexMapped {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return null // JSONL 외 출력(경고 등)은 무시
  }
  switch (ev?.type) {
    case 'thread.started':
      return ev.thread_id ? { kind: 'thread', threadId: String(ev.thread_id) } : null
    case 'item.completed': {
      const it = ev.item ?? {}
      if (it.type === 'agent_message' && it.text) return { kind: 'text', text: String(it.text) }
      if (it.type === 'command_execution') {
        // D12 — 승인 큐 없는 codex의 명령 실행은 감사 가시 이벤트(kind:'exec')로. exit!=0는 렌더러가 경고색.
        const status = it.exit_code === 0 ? 'OK' : `exit ${it.exit_code}`
        return { kind: 'exec', text: `$ ${String(it.command ?? '').slice(0, 160)} → ${status}` }
      }
      if (it.type === 'file_change') {
        const files = (Array.isArray(it.changes) ? it.changes : [])
          .map((c: any) => `${c.kind}: ${path.basename(String(c.path ?? ''))}`)
          .join(', ')
        return { kind: 'status', text: `파일 변경 — ${files}`.slice(0, 200) }
      }
      return null
    }
    case 'turn.completed': {
      const u = ev.usage ?? {}
      return { kind: 'usage', tokens: Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0) }
    }
    case 'turn.failed':
    case 'error':
      return { kind: 'status', text: `codex 오류: ${String(ev.error?.message ?? ev.message ?? '').slice(0, 200)}` }
    default:
      return null
  }
}

// naviPrompt(worker)와 같은 보고 JSON 계약 — 단 lain MCP 도구(ask_manager 등)는 없으니 언급 금지.
export function codexPrompt(task: Task): string {
  const conventions = conventionsBlock(getProject(task.projectId)?.path ?? '')
  const p = getProject(task.projectId)
  const verify = p?.verifyCmd
    ? `\n- 검증(판사) 명령: \`${p.verifyCmd}\` — 끝내기 전 반드시 실행해 통과시켜라.`
    : ''
  return `${conventions}너는 lain의 Navi(Codex 엔진)다. 이 디렉터리는 전용 git worktree이고 현재 브랜치(${task.branch})가 네 작업 브랜치다.

## 작업 지시 (TASK.md)
${task.content}

## 규칙
- 이 worktree 안에서만 작업한다. 절대 다른 경로를 수정하지 않는다.
- 브랜치 변경 금지, push 금지. 의미 있는 단위로 커밋해라(커밋은 자유).${verify}
- 이 세션은 비대화형이다 — 사람에게 질문할 수 없다. 사소한 모호함은 보수적 기본값으로 진행하고, 해소 불가능하게 막히면 blocked로 보고해라.
- 작업을 끝내면(또는 막히면) 마지막 메시지를 반드시 아래 JSON 한 블록으로 끝내라:

\`\`\`json
{"status": "done" | "blocked", "summary": "<무엇을 했고 결과가 어떤지 3-5문장>", "questions": ["<막혔을 때만, 사람에게 물을 질문>"]}
\`\`\``
}

/** Windows 프로세스 트리 종료 — codex.js가 네이티브 codex.exe를 자식으로 두므로 /T 필수. */
function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 5000 })
  } catch {
    /* 이미 죽었으면 무시 */
  }
}

/** Codex 엔진 Navi 실행 — runNavi와 동일한 NaviReport 계약. worker.runNavi가 위임 호출한다. */
export async function runCodexNavi(
  task: Task,
  emit: (ev: TaskEvent) => void,
  opts: RunNaviOpts,
  signal: AbortSignal,
): Promise<NaviReport> {
  const log = (kind: TaskEvent['kind'], text: string, speaker?: TaskEvent['speaker']) => {
    addTaskEvent(task.id, kind, text, speaker)
    emit({ taskId: task.id, kind, text, speaker } as TaskEvent)
  }
  const logExit = (reason: ExitReason, detail?: string) => {
    const text = detail ? `${reason}: ${detail}` : reason
    addTaskEvent(task.id, 'exit', text)
    emit({ taskId: task.id, kind: 'exit', text, exitReason: reason } as unknown as TaskEvent)
  }

  const st = codexStatus()
  if (!st.ok) {
    log('status', `codex 사용 불가: ${st.reason}`)
    logExit('blocked', st.reason)
    return {
      status: 'blocked',
      summary: `Codex 엔진 사용 불가 — ${st.reason}`,
      questions: ['claude 엔진으로 다시 시작할까?'],
    }
  }

  const js = codexJs()!
  const resume = Boolean(opts.resumePrompt && task.naviSessionId)
  // -C/-s는 exec 전용 플래그라 resume엔 없음 → 공통으로 cwd는 spawn cwd, 샌드박스는 -c 오버라이드.
  const cfg = ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true']
  const args = resume
    ? ['exec', 'resume', task.naviSessionId!, ...cfg, '--json', '--skip-git-repo-check', '-']
    : ['exec', ...cfg, '--json', '--skip-git-repo-check', '-']
  const promptText = resume ? opts.resumePrompt! : codexPrompt(task)

  log('status', `codex exec ${resume ? `resume(${task.naviSessionId!.slice(0, 8)}…)` : '새 세션'} — 샌드박스 workspace-write`)

  let lastText = ''
  let tokens = task.tokens ?? 0
  let turns = task.turns ?? 0
  const child = spawn('node', [js, ...args], {
    cwd: task.worktreePath!,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const onAbort = (): void => killTree(child.pid)
  signal.addEventListener('abort', onAbort, { once: true })

  let stderrTail = ''
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000)
  })
  child.stdin.write(promptText)
  child.stdin.end()

  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const m = mapCodexLine(line)
    if (!m) return
    if (m.kind === 'thread') updateTask(task.id, { naviSessionId: m.threadId })
    else if (m.kind === 'text') {
      lastText = m.text
      log('text', m.text, 'worker')
    } else if (m.kind === 'status') log('status', m.text, 'worker')
    // D12 — 명령 실행 감사는 시스템 로그 줄(speaker 없음)로 적재해 TaskDrawer가 전용 아이콘(⌘)으로 구분 렌더.
    else if (m.kind === 'exec') log('exec', m.text)
    else if (m.kind === 'usage') {
      tokens += m.tokens
      turns += 1
      updateTask(task.id, { tokens, turns })
    }
  })

  const exitCode: number | null = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(-1))
  })
  signal.removeEventListener('abort', onAbort)

  if (signal.aborted) {
    logExit('aborted')
    log('status', '세션 중단됨(abort)')
    return { status: 'done', summary: lastText.slice(0, 1500) || '(중단됨)', questions: [] }
  }
  if (exitCode !== 0 && !lastText) {
    const detail = stderrTail.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 200)
    logExit('error', detail || `codex 종료 코드 ${exitCode}`)
    throw new Error(`codex exec 실패(코드 ${exitCode}): ${detail}`)
  }

  log('status', `세션 종료 (누적 ${tokens.toLocaleString()} tok)`)
  const report = parseReport(lastText)
  logExit(report?.status === 'blocked' ? 'blocked' : 'done')
  if (report) return report
  return {
    status: 'done',
    summary: lastText.slice(0, 1500) || '(Navi가 보고 없이 종료됨)',
    questions: [],
  }
}
