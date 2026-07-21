// src/main/audit.ts — 독립 완료 심사관 (L1, lain 루프 P6). Navi 자기 보고를 신뢰하지 않고
// 실제 git diff·완료 조건과 대조해 done 전에 완료 여부를 판정한다. 순수부(프롬프트/파싱/기준추출)는
// 단위테스트 대상, LLM·git 호출부(모듈 내부 auditTask)는 진입점 runAudit을 거쳐 orchestrator의
// finishWork가 verify 통과 후에만 호출한다.
//
// ⚠ auditTask는 명시 승인된 judge 지점(L1) — L0 결정론 코어가 아니라 판정 단계라 SDK query()를 쓴다
// (reflect/reflectFailure와 동형). L0 배관에 LLM을 넣지 않는다는 컨벤션의 명시적 예외.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { AGENT_CWD, CLAUDE_BIN } from './paths'
import { judgeQueryOptions } from './agentopts'
import type { Task, ReviewDepth } from '../shared/types'

const execP = promisify(exec)

export interface AuditVerdict {
  pass: boolean
  issues: string[]
}

// 완료 기준 섹션 헤딩(§21.3 elicitation 산출 '## 합격 기준' / DoD '## 완료 조건').
const CRITERIA_HEADS = [/^##\s*합격 기준/, /^##\s*완료 조건/]

/** TASK.md 본문에서 '## 합격 기준' / '## 완료 조건' 섹션의 불릿을 기준 목록으로 뽑는다.
 *  다음 ## 헤딩을 만나면 섹션 종료. 기준 섹션이 없으면 빈 배열(심사는 diff·산문으로만). */
export function extractCriteria(content: string): string[] {
  const lines = (content || '').split('\n')
  const out: string[] = []
  let inSec = false
  for (const ln of lines) {
    if (/^##\s/.test(ln)) inSec = CRITERIA_HEADS.some((re) => re.test(ln.trim()))
    else if (inSec) {
      const m = ln.match(/^\s*[-*]\s+(.+)/)
      if (m) out.push(m[1].trim())
    }
  }
  return out
}

/** 심사 프롬프트 — 자기 보고 불신을 명시하고 요구사항·완료조건·실제 diff·자기보고를 대조하게 한다.
 *  lens(L4/P6) — adversarial 3렌즈 중 하나로 심사관 시야를 좁힐 때만 서두에 한 줄 주입(생략=단일 렌즈 표준 심사). */
export function buildAuditPrompt(
  spec: string,
  criteria: string[],
  diffStat: string,
  summary: string,
  lens?: string,
): string {
  return [
    '너는 독립 심사관이다. 작업자의 자기 보고를 신뢰하지 말고, 요구사항과 실제 변경을 대조해 완료 여부를 판정하라.',
    lens ? `심사 렌즈: ${lens}` : '',
    '',
    '--- 작업 지시(요구사항) ---',
    spec.slice(0, 3000),
    criteria.length ? ['', '--- 완료 조건 ---', ...criteria.map((c) => `- ${c}`)].join('\n') : '',
    '',
    '--- 실제 변경 (git diff --stat) ---',
    diffStat.slice(0, 2000),
    '',
    '--- 작업자 자기 보고 ---',
    summary.slice(0, 1500),
    '',
    '판정 기준: 요구와 다른 구현·누락된 완료 조건·변경 없는 완료 주장. diff stat만으로 판단 불가한 항목은 의심 사유가 없으면 통과로 둔다.',
    '출력(이것만): ```json\n{"pass": true|false, "issues": ["미충족·불일치 사유 …"]}\n```',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 심사 응답에서 판정 JSON 한 블록을 파싱. pass가 boolean이 아니거나 블록이 없으면 null(심사 불능). */
export function parseAuditVerdict(text: string): AuditVerdict | null {
  const m = (text || '').match(/```json\s*([\s\S]*?)```/)
  if (!m) return null
  try {
    const j = JSON.parse(m[1])
    if (typeof j.pass !== 'boolean') return null
    return { pass: j.pass, issues: Array.isArray(j.issues) ? j.issues.map(String).slice(0, 10) : [] }
  } catch {
    return null
  }
}

// judge 1콜 — reflect/reflectFailure와 동일 골격(짧은 판정, 도구 없음, 60초 abort, 로컬 라우팅).
// 무응답/타임아웃/throw면 null → 호출부에서 심사 불능=통과 취급.
async function runAuditJudge(prompt: string): Promise<string | null> {
  const abort = new AbortController()
  const kill = setTimeout(() => abort.abort(), 60_000)
  let last = ''
  try {
    const stream = query({
      prompt,
      options: {
        cwd: AGENT_CWD,
        allowedTools: [],
        maxTurns: 2,
        ...judgeQueryOptions(), // §9b 판정류(local 라우팅 + D7 사용량 가드 강등)
        abortController: abort,
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리 경로 명시
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) last = t
      }
    }
  } catch {
    return null
  } finally {
    clearTimeout(kill)
  }
  return last
}

/** 독립 완료 심사 — worktree의 실제 diff와 완료 조건·자기보고를 judge로 대조한다.
 *  반환: 판정(AuditVerdict) 또는 null(심사 불능 — git diff 실패 등 → 호출부는 통과 취급, 흐름 막지 않기).
 *  git diff base: 병합 시점에만 채워지는 mergeBaseSha는 심사 시점(병합 전)엔 보통 null → 'main' 기준.
 *  git 호출 실패 시 finishWork가 이미 산출한 task.diffStat(merge-base 기준)로 폴백, 그마저 없으면 심사 불능. */
async function auditTask(task: Task, worktreePath: string, lens?: string): Promise<AuditVerdict | null> {
  const base = task.mergeBaseSha || 'main'
  let stat = ''
  let gitOk = false
  try {
    const { stdout } = await execP(`git diff ${base}...HEAD --stat`, {
      cwd: worktreePath,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    stat = stdout.trim()
    gitOk = true
  } catch {
    // 기본 브랜치명이 main이 아닌 repo 등 — finishWork가 merge-base 헬퍼로 이미 채운 diffStat로 폴백.
    stat = (task.diffStat || '').trim()
  }
  if (!gitOk && !stat) return null // git 실패 + 폴백도 없음 = 심사 불능
  // gitOk이면 stat가 빈 문자열이어도 판정에 넘긴다 — '변경 없는 완료 주장'을 심사관이 잡게.
  // L3(P6) — 구조화 criteria(elicit 영속분)가 있으면 그걸 우선 쓴다. content 파싱(extractCriteria)은
  // 구버전 작업(criteria 컬럼 없음)·content만 남은 경우의 하위호환 폴백.
  const criteria = task.criteria?.length ? task.criteria : extractCriteria(task.content)
  const prompt = buildAuditPrompt(task.content, criteria, stat, task.summary ?? '', lens)
  const text = await runAuditJudge(prompt)
  if (text === null) return null
  return parseAuditVerdict(text)
}

// L4(P6) — 리뷰 강도 다이얼: adversarial의 3렌즈(요구사항/완료조건/회귀)는 각기 좁은 시야로 한 번씩만 본다
// (한 콜에 다 물으면 서로 물타기해 놓치는 걸 막는다). 순서는 무관 — combineVerdicts가 과반으로 합의한다.
export const AUDIT_LENSES = [
  '요구사항 대비: 지시와 다른 구현·빠진 요구가 없는지만 본다.',
  '완료 조건 대비: 완료 조건 각 항목이 실제로 충족됐는지만 본다.',
  '회귀·부작용: 변경이 기존 동작을 깨뜨릴 위험만 본다.',
]

/** 여러 렌즈의 판정을 하나로 합친다(순수) — 과반 fail이면 fail, issues는 실패 렌즈들의 합집합(최대 10개, 중복 제거).
 *  과반 pass면 pass(그때 issues는 무의미하므로 비운다 — auditTask의 '통과 시 issues 없음' 관례와 통일). */
export function combineVerdicts(vs: AuditVerdict[]): AuditVerdict {
  const fails = vs.filter((v) => !v.pass)
  const pass = fails.length <= vs.length / 2
  const issues = [...new Set(fails.flatMap((v) => v.issues))].slice(0, 10)
  return { pass, issues: pass ? [] : issues }
}

/** 리뷰 강도 다이얼(L4/P6) 진입점 — finishWork가 이걸로만 심사를 돌린다.
 *  light=심사 생략(null → 호출부의 '심사 불능=통과' 경로와 자연 합류) · standard=기존 1콜 심사 ·
 *  adversarial=AUDIT_LENSES 3렌즈를 병렬(Promise.all)로 각각 auditTask에 태워 합의(비용 3배, opt-in).
 *  렌즈 중 일부가 심사 불능(null)이면 제외하고 나머지로 합의, 전부 불능이면 null(호출부 통과 취급 동일). */
export async function runAudit(
  task: Task,
  worktreePath: string,
  depth: ReviewDepth,
): Promise<AuditVerdict | null> {
  if (depth === 'light') return null
  if (depth === 'standard') return auditTask(task, worktreePath)
  const vs = (
    await Promise.all(AUDIT_LENSES.map((lens) => auditTask(task, worktreePath, lens)))
  ).filter((v): v is AuditVerdict => !!v)
  return vs.length ? combineVerdicts(vs) : null
}
