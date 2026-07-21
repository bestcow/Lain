# Lain 스킬 할당 + Navi 자율 사용 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lain이 `start_task`로 Navi에 스킬을 할당하고, Navi/Lain이 노출된 클로드 스킬을 Skill 도구로 자율 사용한다. 기본 풀 전체·킬스위치 OFF·`plugins` 깨끗 로딩.

**Architecture:** 신규 `src/main/skills.ts`가 큐레이션 코딩 플러그인을 `installed_plugins.json`에서 해석해 `plugins`+`skills` 부분옵션(`skillOptions`)으로 조립한다. manager·worker·navichat 세 `query()`가 이 한 함수를 스프레드한다. per-task 할당은 `tasks.skills` 컬럼 → `start_task` 도구 파라미터. `settingSources`는 안 써(`[]`) CLAUDE.md/슬래시 오염을 막는다.

**Tech Stack:** TypeScript, Electron Main, `@anthropic-ai/claude-agent-sdk` 0.3.173 (`node:sqlite` store), React 렌더러, vitest.

## Global Constraints

- **추측금지(CLAUDE.md)**: Agent SDK 옵션은 Task 1 스파이크로 실측 후 진행. 스파이크가 핵심 전제(plugins로 settingSources 없이 스킬 로드)를 반증하면 **멈추고 설계 재논의**.
- SDK 옵션 사실(0.3.173, 실측): `plugins?: SdkPluginConfig[]`(`{type:'local', path, skipMcpDiscovery?:boolean}`) · `skills?: string[] | 'all'`(노출 필터, 주면 Skill 도구 자동추가) · `settingSources?: SettingSource[]`(`'user'|'project'|'local'`, `[]`=격리). 둘 다 export됨.
- **컨텍스트 오염 금지**: `settingSources: []` 명시. 사용자 전역 `~/.claude/CLAUDE.md`·슬래시·서브에이전트가 Lain/Navi에 섞이면 안 됨.
- **킬스위치 `skillsEnabled` 기본 OFF**: off면 `skillOptions`가 `{}` 반환 → 기존 동작 100% 동일(회귀 0).
- **풀(설치 실측 확인)**: `['superpowers','feature-dev','commit-commands','skill-creator','code-review','code-simplifier']`. pdf/docx(anthropic-skills)는 설치 플러그인 아님 → 제외.
- 경로해석은 `~/.claude/plugins/installed_plugins.json`의 `installPath`(버전 디렉터리 `6.0.3`·`unknown` 제각각이라 글로빙 금지).
- L0 배관(store/ipc)엔 LLM 호출 금지. 새 IPC는 ipc.ts+preload+types.ts 3곳 동기화(이번엔 settings/tasks가 기존 채널로 흐르므로 **신규 IPC 채널 없음** — 필드만 추가).
- 마이그레이션은 `try{ db.exec('ALTER TABLE … ADD COLUMN …') }catch{}` 패턴.
- `src/**` 변경 후 **반드시 `npm run deploy`**(build만으론 설치본 미반영). 워크트리엔 node_modules 없음 → typecheck/test/deploy는 `C:\lain` 메인에서, 또는 워크트리 `npm ci` 후.

---

### Task 1: 스파이크 T0 — plugins→skills 로딩 실측 (게이트)

**목적:** 본 구현 전, `plugins`로 `settingSources` 없이 스킬이 로드되고 Skill 도구가 자동 추가되는지 실측. 반증되면 멈춤.

**Files:**
- Create(임시, 커밋 안 함): `C:\lain\scratch-skill-spike.mjs`

**Interfaces:**
- Produces: 실측 findings(아래 5문항) → `.superpowers/sdd/skill-spike-findings.md`에 기록.

- [ ] **Step 1: 스파이크 스크립트 작성** (`C:\lain\scratch-skill-spike.mjs`)

```js
// 실측: plugins로 settingSources 없이 스킬 로드 + Skill 도구 자동추가 확인. C:\lain에서 `node scratch-skill-spike.mjs`.
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/plugins/installed_plugins.json'), 'utf8'))
const sp = installed.plugins['superpowers@claude-plugins-official'][0].installPath
console.log('superpowers path:', sp, 'exists:', fs.existsSync(sp))

const stream = query({
  prompt: '사용 가능한 스킬 이름만 쉼표로 나열해라. 그 외 말 금지.',
  options: {
    settingSources: [],                                   // 오염 격리
    plugins: [{ type: 'local', path: sp, skipMcpDiscovery: true }],
    skills: 'all',
    maxTurns: 1,
    executable: 'node',
    // CLAUDE_BIN: dev는 보통 node_modules의 cli. 없으면 'claude' 시도.
    pathToClaudeCodeExecutable: path.join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js'),
  },
})
for await (const m of stream) {
  if (m.type === 'system') console.log('INIT system msg keys:', Object.keys(m), JSON.stringify(m).slice(0, 1200))
  if (m.type === 'assistant') console.log('ASSISTANT:', JSON.stringify(m.message?.content)?.slice(0, 800))
  if (m.type === 'result') console.log('RESULT:', m.subtype, 'tools?')
}
```

- [ ] **Step 2: 실행·관찰**

Run (in `C:\lain`): `node scratch-skill-spike.mjs`
관찰 5문항: ①init/system 메시지에 superpowers 스킬(brainstorming 등) 노출되나 ②`skills:'all'` 응답에 스킬명 나오나(Skill 도구 인지) ③에러 없이 settingSources:[] 동작하나 ④pathToClaudeCodeExecutable 경로 맞나(아니면 CLAUDE_BIN 실측) ⑤skipMcpDiscovery로 lain MCP 미연결(에러 없음). 실패 시 `settingSources:['project']` 등 변형 실측.

- [ ] **Step 3: findings 기록 + 임시파일 삭제**

`.superpowers/sdd/skill-spike-findings.md`에 5문항 결과·확정 plugin path 규칙·skills 이름 형식(`plugin:skill` 필요 여부) 기록. `scratch-skill-spike.mjs` 삭제. **전제 반증 시 여기서 멈추고 보고.**

- [ ] **Step 4: Commit (findings만)**

```bash
git add .superpowers/sdd/skill-spike-findings.md
git commit -m "spike(skills): plugins→skills 로딩 실측 findings"
```

---

### Task 2: `skills.ts` — 순수 조립 + 경로해석 모듈

**Files:**
- Create: `src/main/skills.ts`
- Test: `test/main/skills.test.ts`

**Interfaces:**
- Produces:
  - `CURATED_PLUGIN_NAMES: readonly string[]`
  - `parseInstalledPlugin(manifestJson: string, name: string, marketplace?: string): string | null` (순수)
  - `assembleSkillOptions(plugins: SdkPluginConfig[], assigned: string[] | null, enabled: boolean): SkillOptions` (순수)
  - `resolveInstalledPlugin(name: string): string | null` (fs)
  - `curatedPlugins(): SdkPluginConfig[]` (fs)
  - `skillOptions(assigned: string[] | null, enabled: boolean): SkillOptions` (fs)
  - `type SkillOptions = { plugins?: SdkPluginConfig[]; skills?: string[] | 'all'; settingSources?: SettingSource[] }`

- [ ] **Step 1: 실패 테스트 작성** (`test/main/skills.test.ts`)

```ts
// test/main/skills.test.ts
import { describe, it, expect } from 'vitest'
import { parseInstalledPlugin, assembleSkillOptions } from '../../src/main/skills'

const FIXTURE = JSON.stringify({
  version: 2,
  plugins: {
    'superpowers@claude-plugins-official': [{ installPath: 'C:/x/superpowers/6.0.3' }],
    'feature-dev@claude-plugins-official': [{ installPath: 'C:/x/feature-dev/unknown' }],
  },
})

describe('parseInstalledPlugin', () => {
  it('이름→installPath 해석', () => {
    expect(parseInstalledPlugin(FIXTURE, 'superpowers')).toBe('C:/x/superpowers/6.0.3')
  })
  it('미설치 플러그인은 null', () => {
    expect(parseInstalledPlugin(FIXTURE, 'code-review')).toBeNull()
  })
  it('깨진 JSON은 null', () => {
    expect(parseInstalledPlugin('{not json', 'superpowers')).toBeNull()
  })
})

describe('assembleSkillOptions', () => {
  const plugins = [{ type: 'local' as const, path: 'C:/x/superpowers/6.0.3', skipMcpDiscovery: true }]
  it('enabled=false면 빈 객체(회귀0)', () => {
    expect(assembleSkillOptions(plugins, null, false)).toEqual({})
  })
  it('enabled=true·미할당이면 all + settingSources:[]', () => {
    expect(assembleSkillOptions(plugins, null, true)).toEqual({
      plugins, settingSources: [], skills: 'all',
    })
  })
  it('빈 배열 할당도 all로 폴백', () => {
    expect(assembleSkillOptions(plugins, [], true).skills).toBe('all')
  })
  it('할당 배열이면 그 목록', () => {
    expect(assembleSkillOptions(plugins, ['systematic-debugging'], true).skills).toEqual(['systematic-debugging'])
  })
  it('플러그인 0개면 빈 객체(폴백)', () => {
    expect(assembleSkillOptions([], ['x'], true)).toEqual({})
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- skills`
Expected: FAIL ("Cannot find module '../../src/main/skills'").

- [ ] **Step 3: `src/main/skills.ts` 구현**

```ts
// Lain 스킬 할당 — 큐레이션 코딩 플러그인을 plugins로 깨끗 로딩(settingSources 회피·정체성 보존).
// 순수(parse/assemble) + 경로해석(fs). manager/worker/navichat 세 query()가 skillOptions로 동일 조립.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SdkPluginConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk'

// 설치 실측 확인된 코딩 플러그인만(앱 내장 anthropic-skills pdf/docx는 plugins로 못 줘 제외).
export const CURATED_PLUGIN_NAMES = [
  'superpowers', 'feature-dev', 'commit-commands', 'skill-creator', 'code-review', 'code-simplifier',
] as const

const MARKETPLACE = 'claude-plugins-official'

export type SkillOptions = {
  plugins?: SdkPluginConfig[]
  skills?: string[] | 'all'
  settingSources?: SettingSource[]
}

// 순수 — installed_plugins.json 문자열에서 플러그인 installPath 추출.
export function parseInstalledPlugin(
  manifestJson: string,
  name: string,
  marketplace = MARKETPLACE,
): string | null {
  try {
    const json = JSON.parse(manifestJson)
    const entry = json?.plugins?.[`${name}@${marketplace}`]
    const installPath = Array.isArray(entry) ? entry[0]?.installPath : undefined
    return typeof installPath === 'string' && installPath ? installPath : null
  } catch {
    return null
  }
}

// 순수 — plugins·할당·enabled로 query() 부분옵션 조립.
export function assembleSkillOptions(
  plugins: SdkPluginConfig[],
  assigned: string[] | null,
  enabled: boolean,
): SkillOptions {
  if (!enabled || plugins.length === 0) return {}
  return {
    plugins,
    settingSources: [],
    skills: assigned && assigned.length ? assigned : 'all',
  }
}

export function resolveInstalledPlugin(name: string): string | null {
  try {
    const manifest = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')
    const p = parseInstalledPlugin(fs.readFileSync(manifest, 'utf8'), name)
    return p && fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}

export function curatedPlugins(): SdkPluginConfig[] {
  const out: SdkPluginConfig[] = []
  for (const name of CURATED_PLUGIN_NAMES) {
    const p = resolveInstalledPlugin(name)
    if (p) out.push({ type: 'local', path: p, skipMcpDiscovery: true })
  }
  return out
}

export function skillOptions(assigned: string[] | null, enabled: boolean): SkillOptions {
  return assembleSkillOptions(curatedPlugins(), assigned, enabled)
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- skills`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/skills.ts test/main/skills.test.ts
git commit -m "feat(skills): 큐레이션 플러그인 skillOptions 조립·경로해석 모듈"
```

---

### Task 3: types + store — `tasks.skills` 컬럼 · `skillsEnabled` 설정

**Files:**
- Modify: `src/shared/types.ts` (Task 인터페이스, LainSettings 인터페이스)
- Modify: `src/main/store.ts` (마이그레이션 블록 ~L173-288, insertTask L1110-1121, updateTask colMap L1124-1140, rowToTask L1084-1108, getSettings L1756-1782, saveSettings L1784-1837)
- Test: `test/main/store.skills.test.ts`

**Interfaces:**
- Consumes: `skills.ts`(없음 — 독립).
- Produces: `Task.skills: string[] | null`, `LainSettings.skillsEnabled: boolean`. `insertTask`가 `skills?: string[]` 받음. `getTask().skills` 파싱.

- [ ] **Step 1: 실패 테스트** (`test/main/store.skills.test.ts`)

```ts
// test/main/store.skills.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os'); const fsh = require('node:fs'); const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-skills-store-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR, PROJECT_ROOT: process.cwd(), AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'), CLAUDE_BIN: 'claude',
}))

import { initStore, insertTask, getTask, getSettings, saveSettings, addProject } from '../../src/main/store'

beforeAll(() => { initStore(); addProject({ id: 'p1', name: 'p1', path: process.cwd(), isGit: true } as any) })
afterAll(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* 잠금 무시 */ } })

describe('tasks.skills 왕복', () => {
  it('할당 배열 저장·파싱', () => {
    insertTask({ id: 't1', projectId: 'p1', title: 't', state: 'clarifying', content: 'c', skills: ['systematic-debugging'] })
    expect(getTask('t1')!.skills).toEqual(['systematic-debugging'])
  })
  it('미할당이면 null', () => {
    insertTask({ id: 't2', projectId: 'p1', title: 't', state: 'clarifying', content: 'c' })
    expect(getTask('t2')!.skills).toBeNull()
  })
})

describe('skillsEnabled 설정', () => {
  it('기본 false', () => { expect(getSettings().skillsEnabled).toBe(false) })
  it('저장 후 true', () => { saveSettings({ skillsEnabled: true }); expect(getSettings().skillsEnabled).toBe(true) })
})
```

> ⚠️ `addProject` 시그니처는 store.ts 실제와 맞춰라(없으면 기존 store 테스트의 프로젝트 시드 방식 차용). FK(project_id REFERENCES projects) 때문에 프로젝트 선삽입 필요.

- [ ] **Step 2: 실패 확인**

Run: `npm test -- store.skills`
Expected: FAIL (skills/skillsEnabled undefined).

- [ ] **Step 3: types 추가** (`src/shared/types.ts`)

`Task` 인터페이스(L62-84)에 `error` 다음 줄에 추가:
```ts
  skills: string[] | null // Lain이 이 작업 Navi에 할당한 스킬(null=기본 풀 전체)
```
`LainSettings` 인터페이스(L172~)에 한 필드 추가(예: discordEnabled 인근):
```ts
  skillsEnabled: boolean // 클로드 스킬 노출 킬스위치(기본 OFF — plugins/skills 안 붙임)
```

- [ ] **Step 4: store 마이그레이션·접근자 구현** (`src/main/store.ts`)

마이그레이션 블록(다른 `ALTER TABLE tasks` 인근, L288 뒤)에:
```ts
  try {
    // Lain 스킬 할당 — 이 작업 Navi에 노출할 스킬(JSON 배열 문자열 or NULL=기본 전체).
    db.exec('ALTER TABLE tasks ADD COLUMN skills TEXT')
  } catch {
    /* 이미 존재 */
  }
```
`insertTask`(L1110-1121) 시그니처에 `skills?: string[]` 추가하고 INSERT 확장:
```ts
}: {
  id: string; projectId: string; title: string; state: TaskState; content: string
  mode?: NaviMode; skills?: string[]
}): void {
  db.prepare(
    'INSERT INTO tasks (id, project_id, title, state, content, mode, skills) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(t.id, t.projectId, t.title, t.state, t.content, t.mode ?? 'interactive',
        t.skills && t.skills.length ? JSON.stringify(t.skills) : null)
}
```
`rowToTask`(L1084-1108)에 매핑 추가(`error` 다음):
```ts
    skills: r.skills ? JSON.parse(r.skills) : null,
```
`updateTask` colMap(L1124-1140)에 추가(향후 편집용):
```ts
    skills: 'skills',
```
단 `skills`는 배열이라 colMap 일반경로(문자열/숫자/null)와 안 맞음 → `questions`처럼 별도 처리. colMap에 넣지 말고 questions 블록(L1149-1152) 다음에:
```ts
  if ('skills' in patch) {
    sets.push('skills = ?')
    vals.push(patch.skills && patch.skills.length ? JSON.stringify(patch.skills) : null)
  }
```
`getSettings`(L1757 return)에 추가:
```ts
    skillsEnabled: (getSetting('skills_enabled') ?? '0') === '1',
```
`saveSettings`(L1784~)에 추가(discord 블록 인근):
```ts
  if (patch.skillsEnabled !== undefined)
    setSetting('skills_enabled', patch.skillsEnabled ? '1' : '0')
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- store.skills`
Expected: PASS (4 tests). 그리고 `npm test -- store` 로 기존 store 테스트 회귀 없음 확인.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/store.ts test/main/store.skills.test.ts
git commit -m "feat(store): tasks.skills 컬럼·skillsEnabled 설정 + 왕복 테스트"
```

---

### Task 4: orchestrator + manager — `start_task` 스킬 파라미터

**Files:**
- Modify: `src/main/orchestrator.ts` (startTask L147-209)
- Modify: `src/main/manager.ts` (start_task 도구 L200-224, SYSTEM_PROMPT 인근 L72)
- Test: `test/main/orchestrator.test.ts` (기존 — 케이스 추가)

**Interfaces:**
- Consumes: store `insertTask({…, skills})`(Task 3).
- Produces: `startTask(projectId, { content?, mode?, skills?: string[] })` → `tasks.skills` 저장. `start_task` MCP 도구가 `skills?: string[]` 받음.

- [ ] **Step 1: 실패 테스트(orchestrator)** — startTask가 skills를 task에 저장하는지

기존 `test/main/orchestrator.test.ts`에 케이스 추가(파일 패턴 따름):
```ts
it('startTask가 skills를 task에 저장한다', async () => {
  // (기존 테스트의 프로젝트 시드·mock 사용)
  const r = await startTask('p1', { content: '디버그 작업', skills: ['systematic-debugging'] })
  expect(getTask(r.taskId!)!.skills).toEqual(['systematic-debugging'])
})
```
> 기존 orchestrator.test.ts의 셋업(프로젝트/launch mock)을 재사용. clarify 비동기 launch가 부담이면 `getTask` 즉시조회로 skills만 검증(launch 완료 불요).

- [ ] **Step 2: 실패 확인**

Run: `npm test -- orchestrator`
Expected: 새 케이스 FAIL (skills undefined).

- [ ] **Step 3: orchestrator.startTask 구현** (`src/main/orchestrator.ts`)

L149 opts 타입에 `skills?: string[]` 추가:
```ts
  opts: { skipClarify?: boolean; content?: string; mode?: NaviMode; skills?: string[] } = {},
```
L200 insertTask 호출에 skills 전달:
```ts
  insertTask({ id: taskId, projectId, title, state: 'clarifying', content, mode, skills: opts.skills })
```

- [ ] **Step 4: manager start_task 도구 + 프롬프트** (`src/main/manager.ts`)

도구 입력 스키마(L203-213)에 추가:
```ts
        skills: z
          .array(z.string())
          .optional()
          .describe('이 작업 Navi에 노출할 스킬 이름(생략=큐레이션 풀 전체). 예: ["systematic-debugging","test-driven-development"]'),
```
핸들러(L214-215)에서 전달:
```ts
      async ({ project_id, content, mode, skills }) => {
        const r = await startTask(project_id, { content, mode, skills })
```
SYSTEM_PROMPT의 start_task 안내(L72 "작업 시작(start_task)은…") 다음에 한 줄:
```
- start_task의 skills로 그 작업에 맞는 스킬만 좁혀줄 수 있다(생략=전체 자율). 풀: brainstorming·systematic-debugging·test-driven-development·writing-plans·feature-dev·commit·code-review 등. 구현만 빠르게 할 자율 작업엔 과한 프로세스 스킬(brainstorming 등)을 빼는 게 낫다.
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- orchestrator`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/orchestrator.ts src/main/manager.ts test/main/orchestrator.test.ts
git commit -m "feat(orchestrator,manager): start_task skills 파라미터 → tasks.skills"
```

---

### Task 5: query() 배선 — worker · navichat · manager

**Files:**
- Modify: `src/main/worker.ts` (query options ~L485-495)
- Modify: `src/main/navichat.ts` (query options ~L239-)
- Modify: `src/main/manager.ts` (query options L687-717)

**Interfaces:**
- Consumes: `skills.ts` `skillOptions`, store `getSettings`, `task.skills`.
- Produces: 세 query()가 enabled 시 plugins+skills 노출.

- [ ] **Step 1: worker.ts 배선**

상단 import에 추가: `import { skillOptions } from './skills'` (getSettings는 이미 import됨 — 확인).
query options(L490 `model:` 다음)에 스프레드 추가:
```ts
        model: opts.modelOverride ?? getSettings().naviModel,
        ...skillOptions(task.skills, getSettings().skillsEnabled),
```

- [ ] **Step 2: navichat.ts 배선**

상단 import: `skillOptions` 추가, `getSettings` import 없으면 추가(`import { getSettings } from './store'` 인근).
query options 객체(~L240-258) 안에 추가:
```ts
        ...skillOptions(null, getSettings().skillsEnabled),
```
> navichat은 작업 아닌 채팅 → 항상 `null`(=전체).

- [ ] **Step 3: manager.ts 배선**

상단 import에 `skillOptions` 추가. query options(L697 `model: getSettings().managerModel,` 다음)에:
```ts
        model: getSettings().managerModel,
        ...skillOptions(null, getSettings().skillsEnabled),
```

- [ ] **Step 4: 타입체크 (배선엔 단위테스트 대신 typecheck + Task 8 라이브)**

Run (in `C:\lain`): `npm run typecheck`
Expected: 0 errors. (`skillOptions` 부분옵션이 세 query() Options에 스프레드 호환되는지 확인 — 안 맞으면 SkillOptions 필드 타입 점검.)

- [ ] **Step 5: 회귀 — killswitch OFF 동작 동일**

Run: `npm test`
Expected: 전체 그린(기존 + Task2~4 신규). enabled 기본 false라 세 query() 동작 불변.

- [ ] **Step 6: Commit**

```bash
git add src/main/worker.ts src/main/navichat.ts src/main/manager.ts
git commit -m "feat(worker,navichat,manager): query()에 skillOptions 스프레드(킬스위치 OFF 기본)"
```

---

### Task 6: PrefsModal — `skillsEnabled` 킬스위치 토글

**Files:**
- Modify: `src/renderer/components/PrefsModal.tsx` (settings-row 블록 ~L188-216)

**Interfaces:**
- Consumes: `settings.skillsEnabled`, `patch({ skillsEnabled })`(기존 settings IPC 일반 경로 — 신규 채널 없음).
- Produces: UI 토글.

- [ ] **Step 1: 토글 추가** (`학습 정비` 블록 L199-209 패턴 미러, 그 다음에 삽입)

```tsx
              <label className="settings-row">
                <span className="settings-key">스킬 사용</span>
                <input
                  type="checkbox"
                  checked={settings.skillsEnabled}
                  onChange={(e) => patch({ skillsEnabled: e.target.checked })}
                />
                <span className="dim settings-hint">
                  Lain·Navi에 클로드 스킬 노출(brainstorming·디버깅·TDD 등). 작업별 할당은 Lain이 start_task로.
                </span>
              </label>
```

- [ ] **Step 2: 타입체크·렌더 확인**

Run (in `C:\lain`): `npm run typecheck`
Expected: 0 errors. (settings 객체에 skillsEnabled 존재 — Task 3 LainSettings.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/PrefsModal.tsx
git commit -m "feat(prefs): 스킬 사용 킬스위치 토글"
```

---

### Task 7: TaskDrawer — 부여된 스킬 읽기 표시

**Files:**
- Modify: `src/renderer/components/TaskDrawer.tsx` (drawer-head ~L120-127)

**Interfaces:**
- Consumes: `task.skills`(기존 tasks IPC로 자동 흐름 — Task 3에서 타입 추가).
- Produces: 드로어 헤드에 할당 스킬 칩.

- [ ] **Step 1: 표시 추가** (drawer-title L121-123 다음, dim 메타 앞)

```tsx
        {task.skills && task.skills.length > 0 && (
          <span className="task-skills" title="이 작업에 할당된 스킬">
            🧩 {task.skills.join(' · ')}
          </span>
        )}
```
> `task.skills`가 null이면 미표시(=기본 풀 전체, 굳이 안 알림). CSS 없으면 인라인/기존 dim 클래스 재사용 가능.

- [ ] **Step 2: 타입체크**

Run (in `C:\lain`): `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/TaskDrawer.tsx
git commit -m "feat(taskdrawer): 작업 할당 스킬 읽기 표시"
```

---

### Task 8: 라이브 E2E + deploy

**Files:** (없음 — 검증·배포)

- [ ] **Step 1: 전체 검증**

Run (in `C:\lain`): `npm run typecheck && npm test`
Expected: typecheck 0 · 전체 그린.

- [ ] **Step 2: deploy**

Run (in `C:\lain`, main 병합 후): `npm run deploy`
Expected: 빌드→패키징→설치본 동기화→재시작. (워크트리 작업이면 배포 가드가 비자손 소스를 거부하므로 **메인 체크아웃 main 병합 후** deploy.)

- [ ] **Step 3: 라이브 — 스킬 ON 거동 실측**

설치본 PrefsModal에서 **스킬 사용 ON**. 확인:
1. **Lain 채팅**: "사용 가능한 스킬 알려줘" → 큐레이션 스킬 나열되나(노출 확인).
2. **할당**: Lain에게 "webapp에 systematic-debugging만 줘서 디버그 작업 시작해" → TaskDrawer에 `🧩 systematic-debugging` 표시 + Navi가 그 스킬만 인지(미할당 스킬 미노출).
3. **§7 리스크 실측**: 자율(autonomous) Navi에 풀 전체(미할당) 줬을 때 brainstorming HARD-GATE로 구현을 멈추는지 관찰. 멈추면 → 후속으로 풀에서 프로세스-게이팅 스킬 분리(또는 자율 작업 기본을 capability 스킬로 제한).
4. **회귀**: 스킬 OFF로 되돌리면 기존과 동일.

- [ ] **Step 4: 결과 기록 + 킬스위치 기본 재검토**

라이브 findings를 HANDOFF.md에 기록. 거동 OK면 "기본 ON 전환" 후속 판단 메모. 문제 시 OFF 유지.

- [ ] **Step 5: Commit (HANDOFF/문서)**

```bash
git add HANDOFF.md
git commit -m "docs(handoff): 스킬 할당 구현·라이브 검증 기록"
```

---

## Self-Review (작성자 점검 결과)

- **Spec coverage**: §3 결정 1~9 → Task 매핑됨(로딩 T5, plugins T2, 풀 T2, 기본 T2/T4, surface T4, message_navi='all' T5, Lain자신 T5, 킬스위치 T3/T6, 안전 불변=설계상). §4 A~I → Task2(skills.ts)·Task3(store/types)·Task4(orchestrator/manager 도구·프롬프트)·Task5(query 배선)·Task6(Prefs)·Task7(Drawer). §8 테스트 → 각 Task 단위 + Task8 라이브. ✅
- **Placeholder scan**: 코드 스텝 전부 실제 코드. 단 Task3/4 테스트의 프로젝트 시드(`addProject` 시그니처)·orchestrator 기존 셋업은 실파일 확인 후 맞추라고 명시(실행자 주의). ⚠️ 허용된 "실파일 대조" 지시.
- **Type consistency**: `skillOptions`/`assembleSkillOptions`/`SkillOptions`/`curatedPlugins`/`CURATED_PLUGIN_NAMES`/`Task.skills`/`LainSettings.skillsEnabled`/`tasks.skills`(snake) 전 Task 일관. `parseInstalledPlugin` 순수·`resolveInstalledPlugin` fs 분리.
- **미결(설계 §6)**: 풀 정확 멤버는 Task1 스파이크 + Task8 §7 리스크로 확정. 킬스위치 기본 OFF는 Task8 후 재검토.
