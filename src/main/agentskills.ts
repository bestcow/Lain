// 레인 스킬 자가 생성 (학습루프 T1, hermes skill_manage 대응 — 메커니즘만 lain 고유 재구현).
// 교훈(한두 문장)이 못 담는 여러 단계 절차를 md로 저장한다. 본문은 %APPDATA%\lain\skills\<name>\SKILL.md,
// 메타·사용 추적은 SQLite agent_skills(store.ts). 주입은 점진 공개 — 다이제스트 seam에 name+설명 인덱스만,
// 본문은 mcp__lain__skill_view로. CC Skill 도구(settingSources) 안 씀 — 정체성 오염 회피(§18).
// L0: 파일 IO·인덱스 조립·관련도 스코어링(결정론). "무엇을 저장할까"는 L1(레인/judge)이 결정.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import { listAgentSkills, type AgentSkillMeta } from './store'

// name = 폴더명 겸 도구 인자 — ascii kebab 강제(한글·경로문자 차단). 표시용 제목은 md 본문 안에.
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name)
}

export function skillsDir(): string {
  return path.join(DATA_DIR, 'skills')
}

function skillFile(name: string): string {
  return path.join(skillsDir(), name, 'SKILL.md')
}

/** 스킬 본문 읽기 — 없으면 null. name은 호출부에서 검증 후 전달(이중 방어로 여기서도 거른다). */
export function readSkillBody(name: string): string | null {
  if (!isValidSkillName(name)) return null
  try {
    return fs.readFileSync(skillFile(name), 'utf8')
  } catch {
    return null
  }
}

/** 스킬 본문 쓰기(create/replace 공용) — 디렉터리 보장 후 통째 기록. */
export function writeSkillBody(name: string, content: string): void {
  if (!isValidSkillName(name)) throw new Error(`잘못된 스킬 이름: ${name}`)
  fs.mkdirSync(path.dirname(skillFile(name)), { recursive: true })
  fs.writeFileSync(skillFile(name), content, 'utf8')
}

/** 부분 문자열 patch(hermes patch 대응 — 전체 재전송 없이 토큰 절약). 첫 매치만 교체.
 *  반환: ok | not-found(old_text 미매치) | no-skill(본문 없음). 순수 함수 아님(fs) — 로직은 applyPatch에. */
export function patchSkillBody(
  name: string,
  oldText: string,
  newText: string,
): 'ok' | 'not-found' | 'no-skill' {
  const body = readSkillBody(name)
  if (body == null) return 'no-skill'
  const patched = applyPatch(body, oldText, newText)
  if (patched == null) return 'not-found'
  writeSkillBody(name, patched)
  return 'ok'
}

/** 순수 — old의 첫 등장을 next로 교체. 미매치면 null. */
export function applyPatch(body: string, old: string, next: string): string | null {
  if (!old || !body.includes(old)) return null
  const at = body.indexOf(old)
  return body.slice(0, at) + next + body.slice(at + old.length)
}

// ── 인덱스 주입(점진 공개) — 매 메시지 다이제스트 seam에 name+설명만. 본문은 skill_view로. ──
const INDEX_CAP = 30 // 다이제스트 비대화 방지 — use_count·최신순 상위만(교훈 top-K와 합산 토큰 감시)

/** 순수 — 메타 목록을 인덱스 줄로 조립. 정렬은 store가 이미 use_count·최신순으로 준다. */
export function buildSkillsIndex(metas: AgentSkillMeta[], cap = INDEX_CAP): string {
  return metas
    .slice(0, cap)
    .map((m) => `- ${m.name} — ${m.description}${m.state === 'stale' ? ' (오래 미사용)' : ''}`)
    .join('\n')
}

/** 레인 fullText 주입 블록 — 스킬이 하나도 없으면 ''(주입 0, 기존 동작 불변). */
export function skillsIndexBlock(): string {
  let metas: AgentSkillMeta[]
  try {
    metas = listAgentSkills()
  } catch {
    return ''
  }
  if (metas.length === 0) return ''
  return `\n\n<skills-index>\n저장된 절차 스킬 목록(이름 — 설명). 관련 작업이면 mcp__lain__skill_view로 본문을 먼저 확인:\n${buildSkillsIndex(metas)}\n</skills-index>`
}

// ── Navi 전달 — 작업 내용 키워드 매칭으로 관련 스킬만 인덱스 주입(lessonsForProject 동형).
// Navi(worker)는 mcp__lain__skill_view 도구를 받으므로 본문은 스스로 연다(점진 공개 동일).
/** 순수 — 질의 텀과 name+description 겹침 스코어. */
export function scoreSkillRelevance(meta: AgentSkillMeta, queryText: string): number {
  const terms = (queryText ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
  if (terms.length === 0) return 0
  const hay = `${meta.name} ${meta.description}`.toLowerCase()
  return terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0)
}

/** Navi 시작 프롬프트용 관련 스킬 인덱스 — 매칭 0이면 ''(무관 스킬로 프롬프트를 불리지 않는다). */
export function naviSkillsBlock(taskContent: string, limit = 5): string {
  let metas: AgentSkillMeta[]
  try {
    metas = listAgentSkills()
  } catch {
    return ''
  }
  const relevant = metas
    .map((m) => ({ m, s: scoreSkillRelevance(m, taskContent) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.m.useCount - a.m.useCount)
    .slice(0, limit)
    .map((x) => x.m)
  if (relevant.length === 0) return ''
  return `

## 레인 스킬 (누적 절차 노하우 — 관련해 보이면 mcp__lain__skill_view 로 본문을 먼저 확인)
${buildSkillsIndex(relevant, limit)}`
}
