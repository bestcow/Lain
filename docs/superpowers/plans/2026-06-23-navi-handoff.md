# Navi 유한세션 핸드오프 + Lain A/B 위임 판단 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 일하는 Navi(navichat 직접 대화 세션)의 컨텍스트가 차면 Navi가 직접 핸드오프 md를 써서 새 세션으로 갈아끼우고, Lain에게는 작업을 A(격리 자율작업)/B(직접 대화) 중 고르는 판단 기준을 준다.

**Architecture:** Lain 무한세션(침묵 월드모델 압축, `compact.ts`)은 **그대로 두고**, Navi용 명시적 핸드오프를 새 모듈 `handoff.ts`로 분리한다. 감지 게이트(`compactgate.ts`의 `shouldCompact`/`contextOccupancyTokens`)와 대화별 `context_tokens` 컬럼은 재사용. 핸드오프 md는 `conversations.handoff_md`(저널 보존)+파일 미러로 저장하고, 세션 교체 후 `<handoff>` 블록으로 새 세션에 재주입한다. A/B 판단은 `manager.ts` SYSTEM_PROMPT 한 줄(신규 배관 0).

**Tech Stack:** Electron Main(TS), `node:sqlite`, `@anthropic-ai/claude-agent-sdk` `query()`, vitest, React(PrefsModal).

## Global Constraints

- **무한세션(침묵 압축)=Lain 전용. 본 작업은 Navi를 무한세션으로 만들지 않는다.** 코드 주석/문서에서 둘을 혼동하지 않는다(핸드오프=명시적 md, 압축≠핸드오프).
- 1차 슬라이스는 **navichat(B)만**. worker(A) 핸드오프는 후속(이 플랜 범위 밖).
- L0 배관(store/journal/navichat 배선)에 판단 LLM 호출 금지 — LLM 호출은 `handoff.ts`만(판단=LLM 컨벤션). `handoff.ts`는 manager/worker가 아닌 navichat이 호출하지만 query()를 격리 보유.
- SDK 옵션은 **검증된 패턴만**: `handoff.ts`의 query()는 `compact.ts`(`cwd`/`allowedTools:[]`/`maxTurns:1`/`executable:'node'`/`pathToClaudeCodeExecutable:CLAUDE_BIN`)를 그대로 미러(추측 금지 — 패키징본에서는 언팩된 네이티브 바이너리 경로를 명시해야 한다).
- 새 IPC 채널 추가 없음(설정은 기존 settings 채널 재사용). `LainSettings` 변경은 `shared/types.ts` 한 곳.
- 킬스위치: `naviHandoffThreshold=0`이면 감지·주입 모두 off(오늘과 100% 동일 동작).
- 검증 후 **반드시 `npm run deploy`로 설치본 동기화**(build만으론 미반영). 워크트리엔 node_modules 없음 — typecheck/test/deploy는 메인 체크아웃에서(병합 후) 또는 워크트리 `npm ci` 후.

---

### Task 1: store — `handoff_md` 컬럼 + 저널 보존 + 접근자

**Files:**
- Modify: `src/main/journal.ts` (JournalConv 타입, ~22-30)
- Modify: `src/main/store.ts` (마이그레이션 ~266 / journalConvState 804-818 / reconcileFromJournal 459-490 / 접근자 ~888)
- Test: `test/main/store.handoff.test.ts` (신규)

**Interfaces:**
- Produces: `getConversationHandoff(id: string): string | null`, `setConversationHandoff(id: string, md: string): void`(저널 보존). `JournalConv.handoffMd?: string | null`.

- [ ] **Step 1: 실패 테스트 작성**

Create `test/main/store.handoff.test.ts` (setup은 `store.title.test.ts` 미러):

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { DATA_DIR } = vi.hoisted(() => {
  const os = require('node:os')
  const fsh = require('node:fs')
  const ph = require('node:path')
  return { DATA_DIR: fsh.mkdtempSync(ph.join(os.tmpdir(), 'lain-handoff-')) }
})
vi.mock('../../src/main/paths', () => ({
  DATA_DIR,
  PROJECT_ROOT: process.cwd(),
  AGENT_CWD: process.cwd(),
  BENCH_DIR: path.join(process.cwd(), 'bench'),
  CLAUDE_BIN: 'claude',
}))

import {
  initStore,
  createConversation,
  getConversationHandoff,
  setConversationHandoff,
} from '../../src/main/store'

beforeAll(() => initStore())
afterAll(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* DB 파일 잠금 — 무시 */
  }
})

describe('Navi 유한세션 핸드오프 저장', () => {
  it('새 대화는 핸드오프 없음(null)', () => {
    const id = createConversation('proj-a')
    expect(getConversationHandoff(id)).toBeNull()
  })
  it('set 후 get으로 그대로 반환', () => {
    const id = createConversation('proj-a')
    setConversationHandoff(id, '## 지금 하던 일\n슬림화')
    expect(getConversationHandoff(id)).toBe('## 지금 하던 일\n슬림화')
  })
  it('덮어쓰면 최신값', () => {
    const id = createConversation('proj-a')
    setConversationHandoff(id, 'v1')
    setConversationHandoff(id, 'v2')
    expect(getConversationHandoff(id)).toBe('v2')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/store.handoff.test.ts`
Expected: FAIL — `getConversationHandoff`/`setConversationHandoff` is not a function (export 없음).

- [ ] **Step 3: journal.ts — JournalConv에 handoffMd 추가**

`src/main/journal.ts` 22-30, `worldState?` 줄 **뒤에** 한 줄 추가:

```ts
  worldState?: string | null // 무한세션 — 압축된 월드모델(DB 유실/WAL 폐기에도 누적 맥락 보존). 옛 엔트리엔 없음(옵셔널)
  handoffMd?: string | null // Navi 유한세션 핸드오프 md(DB 유실/WAL 폐기에도 보존). 옛 엔트리엔 없음(옵셔널)
  createdAt: string
```

- [ ] **Step 4: store.ts — 마이그레이션 컬럼 추가**

`src/main/store.ts`, world_state 마이그레이션 블록(261-266) **바로 뒤에** 추가:

```ts
  try {
    // Navi 유한세션 핸드오프 — Navi가 직접 쓴 핸드오프 md(세션 교체 후 새 세션에 재주입). Lain의 world_state(무한세션)와 별개.
    db.exec('ALTER TABLE conversations ADD COLUMN handoff_md TEXT')
  } catch {
    /* 이미 있음 */
  }
```

- [ ] **Step 5: store.ts — journalConvState가 handoff_md도 저널**

`src/main/store.ts` 804-818 `journalConvState`를 교체:

```ts
function journalConvState(id: string): void {
  const r = db
    .prepare(
      'SELECT id, target, title, sdk_session_id, world_state, handoff_md, created_at FROM conversations WHERE id = ?',
    )
    .get(id) as any
  if (!r) return
  journalConversation({
    id: r.id,
    target: r.target,
    title: r.title ?? '',
    sdkSessionId: r.sdk_session_id ?? null,
    worldState: r.world_state ?? null,
    handoffMd: r.handoff_md ?? null,
    createdAt: r.created_at,
  })
}
```

- [ ] **Step 6: store.ts — reconcileFromJournal upsert에 handoff_md 반영**

`src/main/store.ts` 459-467 `convStmt`를 교체:

```ts
  const convStmt = db.prepare(
    `INSERT INTO conversations (id, target, title, sdk_session_id, world_state, handoff_md, created_at)
       VALUES (@id, @target, @title, @sdkSessionId, @worldState, @handoffMd, @createdAt)
     ON CONFLICT(id) DO UPDATE SET
       sdk_session_id = COALESCE(excluded.sdk_session_id, conversations.sdk_session_id),
       world_state = COALESCE(excluded.world_state, conversations.world_state),
       handoff_md = COALESCE(excluded.handoff_md, conversations.handoff_md),
       title = CASE WHEN conversations.title IS NULL OR conversations.title = ''
                    THEN excluded.title ELSE conversations.title END`,
  )
```

그리고 483-490 `convStmt.run({...})`에 `handoffMd` 추가:

```ts
        convStmt.run({
          id: c.id,
          target: c.target,
          title: c.title ?? '',
          sdkSessionId: c.sdkSessionId ?? null,
          worldState: c.worldState ?? null,
          handoffMd: c.handoffMd ?? null,
          createdAt: c.createdAt,
        })
```

- [ ] **Step 7: store.ts — 접근자 추가**

`src/main/store.ts`, `setConversationWorldState`(885-888) **바로 뒤에** 추가:

```ts
// Navi 유한세션 핸드오프 — Navi가 직접 쓴 핸드오프 md. world_state(Lain 전용)와 같은 저널 보존 패턴(교체 후 누적 맥락의 유일 캐리어).
export function getConversationHandoff(id: string): string | null {
  const r = db.prepare('SELECT handoff_md FROM conversations WHERE id = ?').get(id) as any
  return r && r.handoff_md ? String(r.handoff_md) : null
}
export function setConversationHandoff(id: string, md: string): void {
  db.prepare('UPDATE conversations SET handoff_md = ? WHERE id = ?').run(md, id)
  journalConvState(id) // 핸드오프도 저널 — DB 유실/WAL 폐기에도 보존
}
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `npx vitest run test/main/store.handoff.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add src/main/journal.ts src/main/store.ts test/main/store.handoff.test.ts
git commit -m "feat(store): conversations.handoff_md 컬럼·저널 보존·접근자 (Navi 유한세션 핸드오프)"
```

---

### Task 2: store/types — `naviHandoffThreshold` 설정

**Files:**
- Modify: `src/shared/types.ts` (LainSettings, ~189)
- Modify: `src/main/store.ts` (getSettings 1715 뒤 / saveSettings 1753-1757 뒤)
- Test: `test/main/store.handoff.test.ts` (Task 1 파일에 describe 추가)

**Interfaces:**
- Produces: `LainSettings.naviHandoffThreshold: number`(기본 150000, 0=끔). 설정 키 `navi_handoff_threshold`.

- [ ] **Step 1: 실패 테스트 추가**

`test/main/store.handoff.test.ts` 상단 import에 `getSettings, saveSettings` 추가하고, describe 블록 추가:

```ts
import {
  initStore,
  createConversation,
  getConversationHandoff,
  setConversationHandoff,
  getSettings,
  saveSettings,
} from '../../src/main/store'
```

```ts
describe('naviHandoffThreshold 설정', () => {
  it('기본값 150000', () => {
    expect(getSettings().naviHandoffThreshold).toBe(150000)
  })
  it('저장 라운드트립(음수·소수는 보정)', () => {
    saveSettings({ naviHandoffThreshold: 80000 })
    expect(getSettings().naviHandoffThreshold).toBe(80000)
    saveSettings({ naviHandoffThreshold: 0 })
    expect(getSettings().naviHandoffThreshold).toBe(0)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/store.handoff.test.ts`
Expected: FAIL — `naviHandoffThreshold` 프로퍼티 없음(타입/런타임).

- [ ] **Step 3: types.ts — LainSettings 필드 추가**

`src/shared/types.ts` 189 `contextCompactThreshold` 줄 **뒤에** 추가:

```ts
  contextCompactThreshold: number // 무한세션 — 관리자 대화 컨텍스트 점유가 이 토큰 넘으면 월드모델 압축 후 새 세션. 0 = 끔
  naviHandoffThreshold: number // Navi 유한세션 핸드오프 — Navi 대화 점유가 이 토큰 넘으면 핸드오프 md 기록 후 새 세션(≠무한세션). 0 = 끔
```

- [ ] **Step 4: store.ts — getSettings/saveSettings**

`getSettings()` 1715 `contextCompactThreshold:` 줄 **뒤에** 추가:

```ts
    contextCompactThreshold: Math.max(0, Number(getSetting('context_compact_threshold') ?? '150000') || 0),
    naviHandoffThreshold: Math.max(0, Number(getSetting('navi_handoff_threshold') ?? '150000') || 0),
```

`saveSettings()` 1753-1757 `contextCompactThreshold` 블록 **뒤에** 추가:

```ts
  if (patch.naviHandoffThreshold !== undefined)
    setSetting(
      'navi_handoff_threshold',
      String(Math.max(0, Math.floor(patch.naviHandoffThreshold) || 0)),
    )
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run test/main/store.handoff.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/store.ts test/main/store.handoff.test.ts
git commit -m "feat(settings): naviHandoffThreshold(기본 150K·0=끔)"
```

---

### Task 3: `handoff.ts` — Navi 자기 핸드오프 작성 + 순수 헬퍼

**Files:**
- Create: `src/main/handoff.ts`
- Test: `test/main/handoff.test.ts` (신규)

**Interfaces:**
- Consumes: `getSettings().naviModel`(store), `CLAUDE_BIN`(paths), `ChatMessage`(types).
- Produces:
  - `serializeNaviDialogue(msgs: ChatMessage[]): string` (순수)
  - `handoffBlock(md: string | null | undefined): string` (순수 — md 없으면 `''`)
  - `summarizeNaviHandoff(projectPath: string, recentMsgs: ChatMessage[], prevHandoff: string | null, mirrorFile: string): Promise<string | null>`

- [ ] **Step 1: 순수 헬퍼 실패 테스트 작성**

Create `test/main/handoff.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { serializeNaviDialogue, handoffBlock } from '../../src/main/handoff'
import type { ChatMessage } from '../../src/shared/types'

const m = (role: ChatMessage['role'], content: string): ChatMessage =>
  ({ id: 0, role, content, createdAt: '' }) as ChatMessage

describe('serializeNaviDialogue — user/assistant 원문만, 800자 상한', () => {
  it('tool 라인 제외, 라벨 부여', () => {
    const out = serializeNaviDialogue([
      m('user', '슬림화 해줘'),
      m('tool', '· Read a.ts'),
      m('assistant', '백엔드부터 봤다'),
    ])
    expect(out).toBe('[사용자/Lain] 슬림화 해줘\n[Navi] 백엔드부터 봤다')
  })
  it('800자 초과는 절단', () => {
    const out = serializeNaviDialogue([m('user', 'x'.repeat(1000))])
    expect(out).toBe('[사용자/Lain] ' + 'x'.repeat(800))
  })
  it('빈 입력은 빈 문자열', () => {
    expect(serializeNaviDialogue([])).toBe('')
  })
})

describe('handoffBlock — 새 세션 주입 블록', () => {
  it('md 없으면 빈 문자열(주입 안 함)', () => {
    expect(handoffBlock(null)).toBe('')
    expect(handoffBlock(undefined)).toBe('')
    expect(handoffBlock('   ')).toBe('')
  })
  it('md 있으면 <handoff> 래핑 + 트레일링 개행', () => {
    const out = handoffBlock('## 지금 하던 일\n슬림화')
    expect(out).toContain('<handoff>')
    expect(out).toContain('## 지금 하던 일\n슬림화')
    expect(out).toContain('</handoff>')
    expect(out.endsWith('\n\n')).toBe(true)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/main/handoff.test.ts`
Expected: FAIL — `src/main/handoff` 모듈 없음.

- [ ] **Step 3: handoff.ts 작성**

Create `src/main/handoff.ts`:

```ts
// Navi 유한세션 핸드오프 — '무한세션'(침묵 월드모델 압축, Lain 전용 compact.ts)이 아니다.
// 일하던 Navi 세션의 컨텍스트가 한계에 닿으면, Navi 자신이 곧 버릴 세션에서 핸드오프 md를 *직접* 쓰고,
// 새 세션이 그 md를 읽어 이어간다. 명시적 인수인계(요약 압축과 구분). 순수 헬퍼는 단위테스트한다.
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { CLAUDE_BIN } from './paths'
import { getSettings } from './store'
import type { ChatMessage } from '../shared/types'

const SECTIONS = `## 지금 하던 일\n## 진행 상황(완료·진행중)\n## 다음 단계\n## 핵심 맥락·결정·함정\n## 막힌 점`

const INSTRUCTION = `너는 이 프로젝트에서 작업하던 Navi다. 지금 세션의 컨텍스트가 한계에 가까워, 새 세션이 네 일을 이어받아야 한다.
다음 세션의 네가 *맥락 없이도* 곧장 이어서 작업하도록, 지금까지의 상태를 핸드오프 한 장(한국어 마크다운)으로 남겨라.
**아래 5개 섹션만** 쓰고 다른 서두·설명은 출력하지 마라. 이 프로젝트에 기록 컨벤션(CLAUDE.md 등)이 있으면 그 형식·용어에 맞춰 보강하라.

${SECTIONS}

규칙:
- 구체적으로: 파일 경로·함수명·명령·결정 이유·함정을 실명으로. "잘 진행 중" 같은 공허한 요약 금지.
- 끝난·무의미한 건 버리고, 다음 세션이 실제로 필요한 것만 남겨라.
- 해당 내용이 없는 섹션은 제목만 두고 비워라.`

/** user/assistant 원문만 직렬화(도구 라인 제외), 각 800자 상한. compact.ts serialize와 동형. */
export function serializeNaviDialogue(msgs: ChatMessage[]): string {
  return msgs
    .filter((mm) => mm.role === 'user' || mm.role === 'assistant')
    .map((mm) => `[${mm.role === 'user' ? '사용자/Lain' : 'Navi'}] ${mm.content.slice(0, 800)}`)
    .join('\n')
}

/** 새 세션 프롬프트에 끼울 핸드오프 블록. md 없으면 빈 문자열(주입 안 함). */
export function handoffBlock(md: string | null | undefined): string {
  const t = md?.trim()
  if (!t) return ''
  return `<handoff>\n이전 세션에서 넘어온 핸드오프 — 여기서 이어서 작업해라(맥락 복원):\n${t}\n</handoff>\n\n`
}

/** Navi가 직접 핸드오프 md 작성(naviModel·프로젝트 cwd). 실패·빈응답이면 null(호출부가 직전 핸드오프 유지). */
export async function summarizeNaviHandoff(
  projectPath: string,
  recentMsgs: ChatMessage[],
  prevHandoff: string | null,
  mirrorFile: string,
): Promise<string | null> {
  const convo = serializeNaviDialogue(recentMsgs)
  if (!convo.trim() && !prevHandoff) return null

  const prompt = `${INSTRUCTION}\n\n=== 직전 핸드오프(있으면 갱신) ===\n${
    prevHandoff?.trim() || '(없음)'
  }\n\n=== 최근 대화 ===\n${convo || '(없음)'}\n\n위 규칙대로 핸드오프(5섹션 md)만 출력:`

  try {
    let last = ''
    const stream = query({
      prompt,
      options: {
        cwd: projectPath,
        allowedTools: [],
        maxTurns: 1,
        model: getSettings().naviModel, // 당사자 Navi 티어로 작성(judge 아님)
        executable: 'node',
        pathToClaudeCodeExecutable: CLAUDE_BIN, // 패키징본: asar.unpacked 네이티브 바이너리
      },
    })
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const t = (msg.message?.content ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
        if (t) last += t
      }
    }
    const out = last.trim()
    if (!out) return null
    // 사람이 볼 미러 한 장 — best-effort. 실패해도 핸드오프 본류(DB)는 진행.
    try {
      fs.mkdirSync(path.dirname(mirrorFile), { recursive: true })
      fs.writeFileSync(mirrorFile, out, 'utf8')
    } catch {
      /* 미러 실패 무시 */
    }
    return out
  } catch {
    return null // 작성 실패 → 호출부가 직전 핸드오프 유지(맥락 손실 최소화)
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run test/main/handoff.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/handoff.ts test/main/handoff.test.ts
git commit -m "feat(handoff): Navi 자기 핸드오프 작성 + 순수 주입/직렬화 헬퍼"
```

---

### Task 4: navichat.ts — 감지·교체·주입·점유 기록 배선

**Files:**
- Modify: `src/main/navichat.ts` (import 블록 11-32 / sendToNavi 본문 150-194 / result 핸들러 270-281)

**Interfaces:**
- Consumes: Task 1·2·3의 store 접근자, 설정, `handoff.ts`, `compactgate.ts`.
- 단위테스트 어려움(query 포함) → 검증은 typecheck + Task 3 순수헬퍼 + Task 7 수동검증.

- [ ] **Step 1: import 보강**

`src/main/navichat.ts` `from './store'` import 목록(11-26)에 추가:

```ts
  getConversationContextTokens,
  getConversationHandoff,
  listConversationDialogue,
  resetConversationContextTokens,
  setConversationContextTokens,
  setConversationHandoff,
```

새 import 두 줄 추가(`from './safety'` 줄 근처, 32 부근):

```ts
import { shouldCompact, contextOccupancyTokens } from './compactgate'
import { summarizeNaviHandoff, handoffBlock } from './handoff'
```

(`path`·`DATA_DIR`·`getSettings`·`getProject`는 이미 import됨.)

- [ ] **Step 2: sendToNavi 본문 재배치(감지·교체·주입)**

`src/main/navichat.ts` 150-194 구간(`if (busyProjects.has...` 부터 `let assistantSeen = false` 직전까지)을 아래로 **교체**. 핵심: ①사용자 메시지 기록을 body 합성 앞으로 ②resume 계산 직후 핸드오프 감지·교체 ③body에 handoffBlock 주입.

```ts
  if (busyProjects.has(projectId)) return { error: '이 Navi가 이전 메시지를 처리 중이다.' }
  busyProjects.add(projectId)

  // 사용자/Lain 메시지 먼저 기록 — body 합성 전에(핸드오프 🔄 노트가 이 메시지 뒤에 오도록).
  const userContent = text + (attachments.length ? ` [+${attachments.length}개 첨부]` : '')
  addNaviMessage(projectId, 'user', userContent, conversationId, attachments, msgOrigin)
  setConversationTitleIfEmpty(conversationId, text)
  touchConversation(conversationId)

  // Navi 유한세션 핸드오프(≠ Lain 무한세션) — 점유가 임계 넘으면 현 세션에서 Navi가 핸드오프 md를 직접 쓰고
  // 세션을 교체한다. working/blocked/review는 위에서 이미 분기 → 여기 도달 = idle 신규/resume 진입.
  let resume = conversationSdkSession(conversationId) || undefined // ''(에러로 초기화됨)도 새 세션
  const handoffThreshold = getSettings().naviHandoffThreshold
  if (
    handoffThreshold > 0 &&
    resume &&
    shouldCompact(getConversationContextTokens(conversationId), handoffThreshold)
  ) {
    const prev = getConversationHandoff(conversationId)
    const recent = listConversationDialogue(conversationId, 40) // user/assistant 원문만
    const mirror = path.join(
      DATA_DIR,
      'handoffs',
      `${projectId.replaceAll('/', '_')}-${conversationId}.md`,
    )
    const md = await summarizeNaviHandoff(project.path, recent, prev, mirror)
    if (md) setConversationHandoff(conversationId, md) // 실패(null)면 직전 핸드오프 유지(덮어쓰지 않음)
    // 교체 가드 — 다음 세션에 줄 다리(새 md 또는 직전 핸드오프)가 있을 때만 끊는다(맥락 0 세션 방지).
    if (md || prev) {
      setConversationSdkSession(conversationId, '')
      resetConversationContextTokens(conversationId)
      resume = undefined
      const note = '🔄 세션 교체 — 핸드오프 md로 맥락 이어감'
      addNaviMessage(projectId, 'tool', note, conversationId)
      emit({ projectId, kind: 'tool', text: note })
    }
  }
  // 새 세션(resume 없음)이면 핸드오프 1회 주입(킬스위치: threshold 0이면 무주입). resume 있으면 세션에 이미 있음.
  const handoffInject =
    handoffThreshold > 0 && !resume ? handoffBlock(getConversationHandoff(conversationId)) : ''

  // 텍스트 첨부 코드블록 + 핸드오프 주입 = 본문(매니저처럼 텍스트는 프롬프트, 이미지는 SDK 블록).
  const textAttachments = attachments.filter((a) => !a.isImage)
  const textSuffix = textAttachments.length
    ? '\n\n' +
      textAttachments.map((a) => `[첨부: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\``).join('\n\n')
    : ''
  const body = `${handoffInject}${text}${textSuffix}`
  const imageAttachments = attachments.filter((a) => a.isImage)
  type ImgMedia = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  type ImageBlock = {
    type: 'image'
    source: { type: 'base64'; media_type: ImgMedia; data: string }
  }
  type TextBlock = { type: 'text'; text: string }
  const promptContent: (TextBlock | ImageBlock)[] = [{ type: 'text', text: body }]
  for (const img of imageAttachments) {
    promptContent.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType as ImgMedia, data: img.data },
    })
  }
  const promptParam =
    imageAttachments.length > 0
      ? (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: promptContent },
            parent_tool_use_id: null,
          }
        })()
      : body
```

⚠️ 이 교체로 **기존 라인 184-188의 사용자 메시지 기록과 190의 `const resume = ...`는 제거**된다(위 블록이 흡수). `let resume`이 됐으므로 query options의 `resume`는 그대로 사용.

- [ ] **Step 3: result 핸들러 — 점유 토큰 기록**

`src/main/navichat.ts` result 분기(270-281), `setConversationSdkSession(conversationId, msg.session_id)` **다음 줄**에 추가:

```ts
      } else if (msg.type === 'result') {
        resultSeen = true
        if ('session_id' in msg && msg.session_id)
          setConversationSdkSession(conversationId, msg.session_id)
        setConversationContextTokens(conversationId, contextOccupancyTokens(msg)) // 다음 턴 핸드오프 감지용
        emit({
```

- [ ] **Step 4: 타입체크**

Run: `npm run typecheck` (메인 체크아웃에서, 또는 워크트리 `npm ci` 후)
Expected: 0 errors. (`resume` 재사용·import·`project.path` 스코프 확인.)

- [ ] **Step 5: 전체 테스트(회귀 없음)**

Run: `npm test`
Expected: 전부 PASS(기존 + Task1~3 신규). navichat 회귀 없음.

- [ ] **Step 6: Commit**

```bash
git add src/main/navichat.ts
git commit -m "feat(navichat): Navi 유한세션 핸드오프 감지·교체·주입·점유 기록 배선"
```

---

### Task 5: PrefsModal — `naviHandoffThreshold` 입력 UI

**Files:**
- Modify: `src/renderer/components/PrefsModal.tsx` (~246, 무한세션 입력 뒤)

- [ ] **Step 1: 입력 행 추가**

`src/renderer/components/PrefsModal.tsx`, `contextCompactThreshold` `<label>`(234-246) **닫는 `</label>` 뒤**, 텔레그램 섹션 주석(248) **앞에** 추가:

```tsx
              <label className="settings-row">
                <span className="settings-key">Navi 핸드오프(토큰)</span>
                <input
                  type="number"
                  min={0}
                  step={10000}
                  value={settings.naviHandoffThreshold}
                  onChange={(e) => patch({ naviHandoffThreshold: Number(e.target.value) || 0 })}
                />
                <span className="dim settings-hint">
                  Navi 대화가 이 토큰 넘으면 핸드오프 md 기록 후 새 세션(유한세션 교체) — 0이면 끔
                </span>
              </label>
```

- [ ] **Step 2: 타입체크**

Run: `npm run typecheck`
Expected: 0 errors (`settings.naviHandoffThreshold`가 LainSettings에 있음 — Task 2).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/PrefsModal.tsx
git commit -m "feat(prefs): naviHandoffThreshold 입력 UI"
```

---

### Task 6: manager SYSTEM_PROMPT — A/B 위임 판단 지침

**Files:**
- Modify: `src/main/manager.ts` (SYSTEM_PROMPT, 71 뒤)

- [ ] **Step 1: 판단 지침 한 줄 추가**

`src/main/manager.ts` SYSTEM_PROMPT 71(`- 작업 시작(start_task)은 ...`) **뒤에** 추가:

```
- 위임 판단(A/B): 일을 맡길 때 — **격리해서 검토받고 끝낼 일이면 start_task(A)**(명확한 산출물·worktree 격리·검토(병합/폐기) 필요·테스트로 검증 가능·위험/대규모·병렬), **같이 만지며 이어갈 일이면 message_navi(B)**(탐색·디버깅·반복 질의·누적 맥락 의존·턴마다 방향 조정·사소한 즉시 수정). 헷갈리면: 끝나고 'diff를 리뷰'할 일=A, '대화하며 좁혀갈' 일=B. Navi 대화 세션은 컨텍스트가 차면 자동으로 핸드오프 md를 남기고 새 세션으로 갈아끼워지니(유한세션 교체), 길게 이어가도 된다.
```

- [ ] **Step 2: 타입체크(문자열만 변경 — 회귀 없음 확인)**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/manager.ts
git commit -m "feat(manager): A/B 위임 판단 지침(start_task vs message_navi) + 핸드오프 안내"
```

---

### Task 7: 검증 + 배포

**Files:** 없음(빌드·배포)

- [ ] **Step 1: 타입체크**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: 전체 테스트**

Run: `npm test`
Expected: 전부 PASS(기존 585+ 와 신규 store.handoff 5 + handoff 5). 실패 0.

- [ ] **Step 3: 워크트리 → main 병합(배포 전 필수)**

⚠️ 배포 가드가 비자손/구버전 소스를 거부하므로 워크트리 작업을 main에 먼저 병합한다. **파괴적이지 않으나 main을 건드리므로 사용자 확인 후** 진행:

```bash
git -C <메인 체크아웃> fetch <worktree-branch> 또는 동등 병합
# (실행자: 현재 브랜치 claude/vigilant-knuth-a12287 → main 병합)
```

- [ ] **Step 4: 배포**

Run: `npm run deploy` (메인 체크아웃에서)
Expected: 빌드 → 패키징 → 실행 중 lain 종료 → 설치본(`%LOCALAPPDATA%\Programs\lain`) 동기화 → 재시작. 데이터(`%APPDATA%\lain`)는 보존.

- [ ] **Step 5: 수동 검증(런타임)**

PrefsModal에서 `naviHandoffThreshold`를 낮게(예: 2000) 설정 → 한 프로젝트 Navi 직접 채팅을 몇 턴 주고받아 점유 누적 → 다음 턴 진입 시 `🔄 세션 교체` 라인 표시 확인 → `%APPDATA%\lain\handoffs\<proj>-<conv>.md` 생성 확인 → 이어진 응답이 핸드오프 맥락을 반영하는지 확인. 끝나면 임계 원복(0 또는 150000).

---

## Self-Review

**1. Spec coverage** — spec §2 결정표 대조:
- #1 용어분리 → Task1·3 주석, Task6 안내 ✓ · #2 md작성자=Navi → Task3 `summarizeNaviHandoff`(naviModel) ✓ · #3 자동+알림 → Task4 자동 배선, Lain 호출 없음 ✓ · #4 감지지표 → Task4 `contextOccupancyTokens` 재사용 ✓ · #5 임계값 → Task2 ✓ · #6 게이트 → Task4 `shouldCompact` 재사용 ✓ · #7 시점 → Task4 idle 진입에서만 ✓ · #8 저장 → Task1 컬럼+저널, Task3 미러 ✓ · #9 repo 비오염 → 미러는 DATA_DIR ✓ · #10 컨벤션 → Task3 INSTRUCTION ✓ · #11 Lain 직접지시 → 프롬프트 제어(Task6 안내) ✓ · #12 교체 → Task4 ✓ · #13 재주입 → Task4 handoffInject ✓ · #14 가시화 → Task4 🔄 라인 ✓ · #15 A/B → Task6 ✓. 교체 가드(맥락0 방지) → Task4 ✓.
**2. Placeholder scan** — 모든 step에 실제 코드/명령. TBD 없음.
**3. Type consistency** — `getConversationHandoff`/`setConversationHandoff`/`handoffBlock`/`serializeNaviDialogue`/`summarizeNaviHandoff`/`naviHandoffThreshold` 이름이 Task 전반 일치. `summarizeNaviHandoff(projectPath, recentMsgs, prevHandoff, mirrorFile)` 시그니처 Task3 정의 = Task4 호출 일치 ✓.
