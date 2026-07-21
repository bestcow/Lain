# maestro — Claude Code 오케스트레이터 계획서

> 여러 프로젝트에 Claude Code를 한 명씩 붙여, 한 명의 **관리자 Claude**가 현황을 파악하고 작업을 지시·중계하는 프로그램.
> 너는 관리자 한 명과 채팅하고, 관리자가 프로젝트별 **Navi Claude**들과의 대화를 대신 굴린다.

- 상태: **Phase 0~3 + autonomous 첫 슬라이스(§21) 구현 완료** — 진행 상태·남은 것은 [HANDOFF.md](HANDOFF.md)
- 최종 수정: 2026-07-18 (개발자 오케스트레이터 전향 — §1 개정, §25 플래너 제거)
- 위치(배치): **`C:\lain` (확정)**
- 이름: **lain (확정)** — 문서 본문의 maestro 표기는 구명, 점진 교체.

---

## 1. 목적과 문제

> **한 줄 정의 (2026-07-18 전향)**: lain은 **여러 레포를 가진 개발자의 로컬 AI 오케스트레이터** — Claude Code 작업을 지휘·검증·병합하는 관제탑이다. 얼굴은 레인(페르소나 유지), 본질은 개발 도구다.

여러 프로젝트(blog, solid, security, main, webapp, cli-tool, game-client, docs-site …)를 동시에 개발 중이며, 각 현황 파악과 작업 분배가 1인의 인지 부하를 넘는다.

**해결:** 사람(부장) ↔ 관리자 Claude(팀장) ↔ Navi Claude들(팀원)의 보고 라인을 프로그램으로 만든다.

- 관리자는 모든 프로젝트의 **전체 코드를 머릿속에 담지 않는다.** 코드가 항상 최신으로 유지하는 **현황 요약**만 읽고 판단한다.
- Navi는 자기 프로젝트 하나의 `cwd`에 격리되어 실제 코드를 깊게 이해하고 작업한다.

---

## 2. 목표 / 비목표

### 목표 (이 프로그램이 하는 것)
1. 지정한 프로젝트 폴더들의 **현황을 수집·요약**한다 (git 상태, 빌드/테스트, TODO, 진행 중 작업).
2. 폴더에 둔 `TASK.md`를 읽어, 관리자가 **요구사항을 명확화**한 뒤 Navi에게 위임한다.
3. 너 ↔ 관리자 ↔ Navi의 **쌍방향 채팅**(보고받기 / 되묻기 / 지시)을 지원한다.
4. Navi 작업을 **안전하게 격리**(전용 브랜치)하고, push/머지는 **사람 승인** 후에만.
5. 모든 현황·대화·작업을 **하나의 데스크톱 앱**(Electron)에서 본다.

### 비목표 (이 프로그램이 하지 않는 것)
- 사람 승인 없는 자동 push/PR 머지/배포.
- 관리자가 모든 프로젝트 코드를 동시에 깊게 이해하는 것(불가능·고비용).
- 멀티 PC 동기화(집 PC 1대 전제 — §11).
- 클라우드 호스팅·브라우저 웹앱(로컬 데스크톱 앱 전제).
- **일반 비서·컴패니언 기능** (2026-07-18 확정): 캘린더·리마인드 등 일정관리, 범용 화면 감시, 음성 대화 입력, 캐릭터 중심 UI 확장은 만들지 않는다. 페르소나는 인터페이스이지 제품이 아니다. 신규 기능 제안은 "개발자 오케스트레이션에 기여하는가"를 게이트로 판정한다.

---

## 3. 용어

| 용어 | 뜻 |
|---|---|
| **관리자 (Manager)** | 너와 채팅하는 상위 Claude. 현황 요약을 읽고 우선순위·지시·중계를 담당. |
| **Navi** | 프로젝트 하나(`cwd`)에 묶인 Claude Code 세션. 실제 코드 작업. |
| **상태 저장소 (State Store)** | 코드(L0)가 유지하는 DB. 프로젝트 현황·세션 매핑·작업 상태·로그. |
| **TASK.md** | 프로젝트 폴더에 둔 작업 지시서 — 네가 적는 **입력 인터페이스**. L0가 읽어 Navi 스폰 프롬프트에 주입(Navi가 파일을 직접 읽지 않음). |
| **L0 / L1 / L2** | 결정론 코어 / 관리자 / Navi 계층. |

---

## 4. 아키텍처

전부 Claude에게 맡기지 않는다. **결정론적 배관(스폰·동시성·스케줄·상태·안전장치)은 코드**가, **판단(명확화·작업·완료판정·요약)은 Claude**가 한다.

```
┌──────────────────────────────────────────────────────────────┐
│  사용자 (Electron 데스크톱 창 = Renderer)                       │
│   └─ 채팅으로 관리자와 대화 / 현황판 / 승인 버튼                 │
└───────────────▲──────────────────────────────────────────────┘
                │  Electron IPC (양방향 + 스트리밍 이벤트)
┌───────────────┴──────────────────────────────────────────────┐
│  L0  결정론 코어  (Electron Main = Node/TS — Claude 안 씀)     │
│   · 프로젝트 레지스트리        · 프로세스 스폰 (Agent SDK)      │
│   · 동시성 제한 (cap=N)        · 상태 저장소 (SQLite)          │
│   · 사용량/타임아웃 가드       · 안전장치(canUseTool 승인 라우팅)│
│   · 스케줄러(Phase 3, 선택)    · 이벤트 버스 → UI(IPC)         │
└───────┬───────────────────────────────────────┬──────────────┘
        │ spawn/resume (cwd=maestro 자체 컨텍스트)│ spawn/resume (cwd=프로젝트)
        ▼                                         ▼
┌──────────────────────┐              ┌───────────────────────────┐
│ L1 관리자 Claude      │  지시/질문   │ L2 Navi Claude (프로젝트별) │
│  · 현황 요약 읽기      │ ───────────▶ │  · 프롬프트의 작업지시 수행 │
│  · 요구사항 명확화     │ ◀─────────── │  · 막히면 ask_manager 호출  │
│  · 우선순위·중계       │  보고/되질문 │  · 전용 브랜치+커밋          │
└──────────────────────┘              └───────────────────────────┘
        ▲                                         │
        │ 현황 요약(읽기 전용, 코드가 생성)        │ git/test 결과
        └────────────── [상태 저장소] ◀───────────┘
```

핵심: **관리자는 상태 저장소의 "요약"만** 읽는다(전체 코드 X). 그 요약을 항상 최신으로 만드는 건 L0다.

---

## 5. 통신 설계 (쌍방향의 핵심)

채팅이 세 단계 전부 성립한다: **너 ⇄ 관리자 ⇄ Navi.**

### 5.1 세션 모델
- Navi/관리자는 1회성 명령이 아니라 **세션을 가진 대화 상대**다.
- Agent SDK의 두 방식 사용:
  1. **턴 기반(resume):** 지시 → 응답(질문 포함) → `session_id`로 `resume`하며 답장 → 이어서 작업. (너와 나의 채팅과 동일 구조)
  2. **스트리밍 입력(live):** `query`의 `prompt`를 비동기 이터러블로 주어 세션을 열어둔 채 실시간 주고받기.

### 5.2 Navi → 관리자 역질문 (두 등급)
- **턴 끝 질문 (간단·확실):** Navi가 작업 턴을 끝내며 구조화 출력으로 보고.
  ```jsonc
  { "status": "blocked", "summary": "...", "questions": ["A안/B안 중?"], "diffSummary": "..." }
  ```
  관리자가 읽고 답을 `resume`으로 전달.
- **작업 중간 인터럽트 (고급):** Navi에게 **in-process MCP 툴** `ask_manager(question)`을 부여. Navi가 막히면 호출 → 제어가 L0를 거쳐 관리자로 → 답 → Navi가 그 자리에서 이어감. (`canUseTool` 콜백 + SDK in-process MCP 서버로 구현. 함수명은 §18에서 확정.)

### 5.3 사용자 ↔ 관리자
관리자는 채팅 프론트를 가진 Claude 루프다. 예:
- "지금 다들 어때?" → 상태 요약 읽고 보고
- "webapp Navi한테 왜 그 방식 골랐는지 물어봐" → 해당 Navi 세션 `resume`해 질문·답 중계
- "blog 작업 중단" → 해당 Navi에 중단 지시

### 5.4 한계 (정직)
- 세션 내 대화는 **턴 기반**. 토큰 단위 즉시 인터럽트는 제한적이지만, **안전 경계에서 중단→네 메시지 우선 처리는 지원**(§5.7).
- Navi마다 독립 세션 → 관리자는 여러 Navi와 동시에 각각 대화 가능하나, 컨텍스트·비용이 Navi 수만큼 증가.

### 5.5 능동·비동기 보고 (보고 타이밍이 제각각이어도)
프로젝트마다 구현·검증 타이밍이 다르다. 네가 묻기를 기다리지 않고, **새 보고 사항이 생기는 순간 관리자가 먼저 알린다.**
- **이벤트 버스(L0):** Navi가 `질문 생성 / 완료 / 결재 필요 / 에러`를 내면 즉시 이벤트 발생.
- **3중 알림:** ① 해당 Navi 도트 캐릭터 위 말풍선 ② 관리자 채팅에 한 줄 push ③ 창이 백그라운드면 OS 알림.
- **관리자의 판단:** 단순 진행은 조용히 두고, 너 결정이 필요한 것(질문·결재·실패)만 끌어올린다.
- **폭주 방지:** 짧은 시간 내 다발 이벤트는 **디바운스로 묶어** "3건 보고" 식으로 한 번에. 중요도 임계값·조용한 시간(방해금지)은 설정.
- 결과적으로 너는 "지금 어때?"라고 안 물어도, **반응이 필요할 때만** 호출된다.

### 5.6 메시지 대상 지정 (관리자 / 1명 / 다수 / 전체)
누구에게 말할지 고를 수 있다. 입력창의 **대상 칩**으로 전환.
- **관리자(기본):** 평소 대화·지휘. 관리자가 알아서 Navi에 중계.
- **Navi 1명 (직접):** 특정 Navi에게 바로 입력 → **그 프로젝트의 Claude Code에 직접 타이핑하는 것과 동일**(관리자 우회). 그 Navi 세션에 streaming-input/`resume`으로 전달, 응답은 해당 콘솔/채팅에 표시. Navi가 idle이면 그 프로젝트에 세션을 새로 띄운다(= 거기서 Claude Code를 새로 여는 것).
- **다수 선택:** Navi 여러 명 선택 후 같은 메시지를 각자에게 동시 전송(fan-out), 각 Navi가 독립 응답. 예: 선택한 3명에게 "지금 변경 커밋하지 말고 멈춰".
- **전체(broadcast):** 모든 활성 Navi에게. 예: "전부 현재 상태 1줄 보고" / "전부 중지".
- **비용·안전:** 다수/전체는 Navi 수만큼 사용량·동시성↑ → cap 적용. 파괴적 지시는 Navi별 승인(§9-4) 그대로 적용. 직접 메시지도 감사 로그(§9-10)에 기록되고, 관리자는 다이제스트로 동기 유지.

### 5.7 작업 중 끼어들기 (인터럽트)
작업 중(working)인 Navi나 관리자에게 말을 걸면:
1. **경고:** "지금 작업 중입니다 — 보내면 진행이 끊깁니다. 그래도 보낼까요?" (idle 대상은 경고 없이 바로 전송)
2. **확정 후 전송:** 현재 실행을 **안전 지점에서 중단**(진행 중 툴 호출은 마치고 멈춤 — 파일 반쯤 수정 방지)하고, 네 메시지를 **최우선**으로 처리. 즉 하던 일을 멈추고 네 말부터 확인한다.
3. **상태 보존:** worktree·브랜치·세션은 그대로 → 끼어든 처리 후 "이어서 계속"으로 원래 작업 재개 가능.
4. **다수/전체:** 바쁜 Navi 각각에 인터럽트 적용. 경고는 "N명 중 M명 작업 중"으로 한 번에.
- 구현: SDK 스트리밍 세션 interrupt + 메시지 주입(정확한 API는 §18). 토큰 단위 즉시 중단이 아니라 **다음 안전 경계에서 중단→재지정**.

---

## 6. 데이터 모델 (상태 저장소)

SQLite(`better-sqlite3`) 권장 — 단일 파일, 트랜잭션, Main 프로세스 단독 접근.
(JSON 파일도 가능하나 동시 쓰기·조회에 약함.)

```
projects
  id            TEXT PK         -- 폴더명 기준 안정 키
  path          TEXT            -- 절대경로
  name, stack, structure        -- README 표 + 자동 감지
  is_git        INTEGER         -- git repo 여부 (false면 격리/검증 방식 다름, §15b)
  verify_cmd    TEXT            -- 자동 감지(package.json scripts / pyproject) → 없으면 수동/NULL
  enabled       INTEGER         -- 편성 여부: true=무대에 캐릭터 표시·작업 대상 / false=제외(설정은 보존)

project_status                  -- 현황 요약 (코드가 갱신, 관리자가 읽음)
  project_id    FK
  git_branch, ahead, behind, dirty_files
  last_commit, last_commit_at
  test_state    TEXT            -- pass | fail | unknown | running
  test_output_tail TEXT
  todo_count
  summary       TEXT            -- Navi가 작업 끝에 쓴 판단 요약(§10.2)
  updated_at

tasks                           -- TASK.md 1건 = task 1건
  id            TEXT PK
  project_id    FK
  source_md_path, md_hash       -- 변경 감지
  title         TEXT            -- 현재 작업 한 줄 제목(Navi 카드에 표시)
  state         TEXT            -- 아래 상태 머신
  worker_session_id  TEXT       -- Navi resume 키
  cost_usd, turns, branch
  created_at, updated_at

messages                        -- 모든 대화(너↔관리자↔Navi) 통합 로그
  id, scope(user|manager|worker), project_id?, task_id?
  role(user|assistant|tool), content, created_at

approvals                       -- 사람 승인 대기 큐
  id, task_id
  kind          TEXT            -- push | merge | dep_change | file_delete | migration | network | risky_cmd
  payload, state(pending|approved|rejected)

audit                           -- Navi 행동 영구 기록 (사후 검토·신뢰)
  id, task_id, tool, args_summary, path, result, created_at
```

### 작업 상태 머신 (tasks.state)
```
 idle ─▶ clarifying ─▶ ready ─▶ working ─▶ review ─▶ done
            │                       │          │
            └─▶ blocked ◀───────────┘          └─▶ approval_pending ─▶ done
                  (질문 대기)                       (push/merge 승인 대기)
        any ─▶ error / cancelled
```

---

## 7. TASK.md 스펙 (네가 적는 작업 입력)

각 프로젝트 폴더 루트에 둔다. 너는 이것만 잘 적으면 된다.
**Navi가 직접 읽는 파일이 아니다** — L0가 내용을 읽어 Navi **스폰 프롬프트에 주입**한다(§8). 미추적 파일이라 Navi worktree에는 존재하지 않으므로, worktree로의 복사·동기화가 아예 필요 없다.

```markdown
# TASK
## 목표
무엇을 / 왜.

## 완료 조건 (DoD)
- 이게 되면 끝. 체크 가능한 항목으로.

## 제약
- 건드리지 말 것 / 따라야 할 컨벤션.

## 검증
- 실행해서 통과해야 할 명령 (예: `npm test`, `pytest`).

## 범위 / 우선순위
- 이번에 할 것 / 하지 말 것.
```

- 파일명 고정: `TASK.md` (충돌 피하려면 `.maestro/TASK.md`도 옵션).
- `md_hash`로 변경 감지 → 내용 바뀌면 새 작업으로 인식.
- 모호하면 관리자가 `clarifying` 단계에서 질문을 모아 한 번에 너에게.

### 7.1 수명주기 (완료 후 처리)
- 작업 완료(done) 시 `TASK.md`는 그대로 두지 않는다 → **maestro 데이터 폴더** `data/done/<project-id>/<task-id>.md`로 이동(아카이브) + 결과·diff·비용 메타 동봉. 재실행/혼선 방지, **프로젝트 repo를 오염시키지 않음**.
- 같은 프로젝트에 새 작업은 `TASK.md`를 다시 적으면 됨(이력은 maestro 쪽 `done/`에 누적).

### 7.2 작업의 출처 두 가지
1. **`TASK.md` 파일** (기본) — 위 스펙.
2. **채팅 즉석 지시** — "blog의 X 고쳐"처럼 관리자에게 말하면, 관리자가 내용을 정리해 task로 등록한 뒤 동일 흐름(프롬프트 주입)으로 진행. 파일 생성 불필요 — 두 출처가 한 경로로 수렴.

---

## 8. 실행 흐름 (시퀀스)

```
1. 너: UI에서 "작업할 폴더" 선택 → "착수" 지시
2. L0: 각 폴더의 TASK.md 로드, task 생성(state=clarifying)
3. 관리자: 작업 내용 검토(L0가 로드한 TASK.md)
     ├─ 명확 → state=ready
     └─ 모호 → 질문 취합 → UI로 너에게 (state=blocked)
                 너 답변 → 관리자 반영 → state=ready
4. L0: ready인 task를 동시성 cap 내에서 Navi 스폰 (state=working)
        - Navi cwd=프로젝트, 전용 브랜치 생성
        - 작업 지시(TASK.md 내용+명확화 결과)는 스폰 프롬프트에 주입
5. Navi: 작업 수행, 진행을 IPC로 UI에 스트리밍(도트 캐릭터 애니 + 콘솔)
        - 막히면 ask_manager → 관리자 응답 → 이어감
        - 이벤트 발생 시 능동 보고(§5.5): 캐릭터 말풍선 + 채팅 + OS 알림
6. Navi: 완료 → 구조화 보고(diff 요약, 검증 결과) → state=review
7. L0: verify_cmd 실행 → 결과 기록
8. 관리자: 결과 요약 → 너에게 보고
9. push/PR 필요 시 → approval_pending → 너 승인 → 실행 → done
```

---

## 9. 안전장치 (정석·문제 방지의 핵심)

1. **작업 격리 (git worktree):** Navi는 in-place가 아니라 task별 `git worktree`(예: `.maestro/wt/<task-id>`)에서 `maestro/<task-id>` 전용 브랜치로 작업. **네 라이브 작업트리·현재 브랜치와 절대 충돌하지 않음.** 시작 전 깨끗한 base(보통 main 최신)에서 분기. 완료/취소 시 worktree 제거(GC).
2. **범위 가둠 (confinement):** Navi 작업은 **`C:\dev` 범위로 한정**(시스템 전역 접근 차단). 그 안에서 자기 worktree가 기본 작업 영역. (관리자 도구 경계·정확한 범위 규칙은 구현 시 확정 — §17)
3. **push/머지 = 사람 승인:** 글로벌 규칙 준수. Navi는 커밋까지, push/PR은 `approvals` 큐를 통해 너만.
4. **권한 모델 = "전부 허용, 단 허락받음":** 도구를 사전 차단(denylist/allowlist)하지 않는다 — Navi는 필요한 모든 도구를 쓸 수 있다. **대신 파괴적·외부 행위는 실행 직전 사용자 허락**(approval)을 받는다.
   - **허락 필요(실행 전 승인 카드):** push/merge, 파일 삭제, 의존성 추가·삭제, 마이그레이션, 외부 네트워크 호출, `rm -rf`·force push·`reset --hard` 류, `C:\dev` 밖 접근 시도.
   - **허락 없이 진행:** worktree 내 일반 읽기·편집·테스트 등 비파괴 작업.
   - 구현: `canUseTool` 콜백이 "거부"가 아니라 **위험 행위를 승인 큐로 라우팅**(승인 시 진행, 거절 시 취소).
5. **인증 = Claude Max:** Navi·관리자 모두 **Claude Max 구독 로그인**으로 SDK 구동(API 키 별도 과금 아님). → 과금은 토큰 단가가 아니라 **Max 사용량 한도** 기준(§9b). (로그인 토큰 보관은 Electron `safeStorage`/OS 키체인.)
6. **시크릿 보호:** 프로젝트 `.env` 값은 다이제스트·로그·메시지에 절대 미포함(마스킹). (`.env` 자체는 Navi 실행을 위해 worktree에 제공 — §15b.)
7. **사용량·턴 상한:** task당 `maxTurns` + 전역 사용량 상한(§9b). 초과 시 일시정지 후 보고.
8. **타임아웃 & 취소:** Navi가 행에 걸리면 L0가 중단. 모든 Navi는 취소 가능(취소 시 worktree·브랜치 정리).
9. **읽기/쓰기 분리:** 현황 수집은 읽기 전용(git/test 셸 직접), 작업만 쓰기 경로.
10. **감사 로그(audit):** Navi의 모든 툴 호출(파일·Bash·diff)을 task별로 영구 기록 → 사후 검토·신뢰.
11. **드라이런:** 첫 도입 시 "제안만(diff 미적용)" 모드 제공.

---

## 9b. 모델 자동 티어링 (관리자가 난이도로 선택)

Claude Max 구독(§9-5)이라 토큰 단가가 아니라 **사용량 한도**가 제약이다. 모델을 난이도에 맞춰 **관리자가 알아서** 골라 한도를 아낀다.

- **기본 규칙(코드):** 잡담·짧은 요약·상태질문 → **Haiku/Fable**(가벼움). 보통 구현·수정 → **Sonnet**. 어려운 디버깅·설계·대규모 리팩터 → **Opus**(+ `maxTurns` 넉넉히).
- **관리자 재량:** `TASK.md`와 다이제스트를 보고 난이도를 판정해 Navi 스폰 시 모델 지정. 반복 실패 시 **자동 에스컬레이션**(Sonnet→Opus) 후 재시도.
- **관리자 자신:** 평소 가벼운 모델, 복잡한 판단 때만 Opus로 일시 승격.
- **너의 통제:** 설정에서 티어별 모델 매핑, "이 작업은 무조건 Opus" 핀 고정.
- **투명성:** 각 작업 카드에 사용 모델·턴 표시.
- **사용량 가드:** Max 한도에 근접하면 신규 스폰 억제 + 진행 작업 안전 정지 + 보고(레이트리밋/한도 초과 대비). 동시 세션 수도 cap으로 제한.
- 구현: SDK `query()`의 모델 옵션을 작업별로 전달(정확한 키명·Max 인증 연동은 §18에서 확정).

---

## 10. 현황 수집 + 관리자 다이제스트 (관리자의 눈)

관리자는 프로젝트 raw(README/코드)를 매번 읽지 않는다. **한 번 만들어 여러 번 싸게 읽는 다이제스트**를 본다. 다이제스트는 성격이 다른 두 부분으로 구성:

### 10.1 결정론적 현황 (LLM 토큰 0 — 코드가 즉석 생성)
git/test는 Claude 없이 셸로 뽑는다. 즉석 계산이 싸므로 진실 원본으로 저장하지 않고 캐시만 한다(stale 방지).
- `git status --porcelain`, `git rev-list --count`(ahead/behind), `git log -1`
- `verify_cmd` 실행 → pass/fail/output tail
- TODO/FIXME 카운트(grep)

### 10.2 판단 요약 (Navi가 작업 끝에 1회 작성)
"이 프로젝트 지금 상태 / 막힌 점 / 다음 할 일" — 이미 그 프로젝트 컨텍스트에 들어가 있는 Navi가 작업 종료 시 1회 기록. 관리자는 이 짧은 요약을 N번 싸게 읽는다.
- 저장: `project_status.summary` + 각 repo의 **`HANDOFF.md`**(네 기존 컨벤션 재사용).
- `HANDOFF.md`는 1석 3조: (a) 관리자 다이제스트 (b) 너 자신의 온보딩 노트 (c) Navi가 다음 세션에 직전 작업 이어받기.

### 10.3 왜 raw 직접 읽기보다 이득인가
- **반복 비용:** 관리자가 N개 프로젝트를 매 턴 raw로 읽으면 매번 수만 토큰. 다이제스트는 프로젝트당 수백 토큰. 읽는 횟수에 비례해 격차가 커진다.
- **비용 전가:** 비싼 raw 독해는 Navi가 1회만, 관리자는 싼 것만.
- **신선도:** README는 "무엇인지"를 적지 현재 live state(미커밋·깨진 테스트·진행 작업)는 안 적힘 — 다이제스트가 잡음.

### 10.4 갱신 시점
수동 새로고침 / Navi 작업 후(판단 요약) / 매 스캔(결정론 현황) / (Phase 3) 주기 스캔.

---

## 11. 단일 PC 전제 (동기화 불필요)

집 PC 1대에서만 쓴다. 멀티 PC 동기화·세션 PC 매핑·경로 매핑 로직은 전부 **제거**한다 — 단순함이 곧 안정성.
- Navi 세션 JSONL(`~/.claude/projects/...`)은 로컬에 그대로, 같은 머신에서 `resume`.
- 상태 저장소(SQLite)는 로컬 단일 파일. 충돌 고민 없음.
- maestro 자체도 repo 동기화 가정 없이 그냥 로컬 프로젝트로 둔다.
- `projects.path`는 절대경로 그대로 사용(PC별 경로 매핑 불필요).

---

## 12. UI 디자인 (Electron 데스크톱 앱)

### 12.1 컨셉 — "도트 캐릭터 작업실"
2000년경 상상하던 사이버공간 + 옛 CRT 픽셀 게임 감성. **검은 배경 + 인광(phosphor) 초록.** 화면 중앙이 **픽셀아트 작업실**이다: 가운데 **관리자 도트 캐릭터 1명**, 주위에 **Navi 도트 캐릭터들**(각 1명 = 프로젝트 1개). 너는 관리자 캐릭터와 대화하고, Navi들이 일하는 모습을 **눈으로 직접 본다.** 리스트가 아니라 작은 사무실/관제실을 내려다보는 느낌.

핵심은 **심플·직관**: 누가 일하는지, 누가 막혔는지, 누가 내 결재를 기다리는지를 *글을 읽지 않고 캐릭터만 봐도* 안다.

**디자인 3원칙:**
1. 캐릭터의 포즈·말풍선이 곧 상태 (텍스트 안 읽어도 됨).
2. 그린 단색 위주 + 상태만 형광색으로 구분 (정보=색, 장식≠색).
3. 효과(스캔라인·글로우)는 은은하게, 토글로 끌 수 있게(가독성 우선).

### 12.2 레이아웃 (관리자 바 + Navi 그리드)
위에 관리자 바(보고사항 한눈에), 아래 Navi 그리드(자동 배치). Navi 클릭 시 콘솔 드로어.
```
┌ MANAGER BAR ───────────────────────────────────────────────────────────┐
│ ☺관리자  최근▸ security 질문 보고          작업2·대기5·$0.42      ⚙ ⟳ │
│ 보고함 ▸ [⚠ security 질문][▮ main 결재][✗ solid 에러2]  ← 클릭=처리     │
├ WORKERS ────────────────────── (스크롤 없음·부족하면 창이 커짐) ───────┤
│ ┌blog────┐ ┌solid───┐ ┌webapp──┐ ┌security─┐ ┌main────┐ ┌cli-tool┐     │
│ │  ☻ ✓   │ │  ☻ ✗   │ │  ☺ ⌨   │ │  ☻ ?    │ │  ☻ ▮   │ │  ☻ z   │     │
│ │ blog   │ │ solid  │ │ webapp │ │security │ │ main   │ │cli-tool│     │
│ │변경없음 │ │테스트  │ │OAuth   │ │콜백 URL │ │push    │ │대기 중 │     │
│ │        │ │회귀수정 │ │리팩터링 │ │확인대기 │ │승인대기 │ │        │     │
│ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘     │
│ ┌api-svc─┐ ┌docs────┐ ... 더 많아지면 다음 줄로 자동 wrap → 창 높이↑   │
├ INPUT ──────────────────────────────────────────────────────────────────┤
│ user@maestro:~$ ▋                                          [▶착수][⏸]   │
└──────────────────────────────────────────────────────────────────────────┘
   Navi 카드 클릭 → 콘솔 드로어: ▸Read auth.py ▸Edit routes.py ▸pytest ✓
                                  diff +12-4 │ [push 승인][거절][직접대화]
```

### 12.3 주요 요소
- **관리자 바(상단, 가로 길게):** ① 관리자 도트 + 최근 한 줄 보고 ② **보고함** — 네 처리가 필요한 항목(질문·결재·에러)을 칩으로 한눈에, 클릭하면 해당 처리(답변/승인/diff)로 ③ 전체 카운트·누적 비용·설정. 새 보고는 능동 푸시(§5.5)로 여기에 즉시 뜸.
- **Navi 그리드(메인):** 프로젝트별 Navi 카드 = 도트 캐릭터(상태 포즈/색, §12.4) + 이름 + **현재 작업 한 줄 제목**(예: "OAuth 리팩터링"). 카드 클릭 → 콘솔 드로어.
- **현재 작업 제목:** Navi가 지금 무엇을 하는지 1줄로 표시(진행 중 task 제목 또는 실시간 활동 요약). 길면 말줄임. idle은 "대기 중".
- **입력(하단) + 대상 선택:** 프롬프트 한 줄 + 착수/전체중지. **대상 칩**으로 `[관리자]`(기본)·`[webapp]`(1명)·`[3명]`(다수)·`[전체]` 전환(§5.6). Navi 대상이면 그 Claude Code에 바로 입력하는 것과 동일.
- **작업 중 끼어들기 경고:** 대상이 작업 중이면 전송 시 경고 배너("진행이 끊깁니다 — 그래도 보내기?") → 확정하면 멈추고 네 말부터 처리(§5.7).
- **Navi 선택:** 카드 클릭=대상 지정+콘솔 열기, Ctrl/Shift+클릭=다수 선택, "전체" 토글. 선택 상태가 입력 대상 칩에 반영(선택된 카드는 강조 링).
- **Navi 콘솔 드로어(클릭 시):** 해당 Navi 세션 실시간 스트리밍(툴·파일·테스트), diff 요약, push 승인, "직접 말하기".

### 12.3b 창 크기·스크롤 정책 (내용이 창을 정한다)
- **스크롤 최소화:** Navi가 많아 공간이 부족하면 스크롤 대신 **창이 세로/가로로 자동 확장**해 전부 보이게 한다.
- **그 크기가 최소 창 크기:** 확장된 크기 = `minWidth`/`minHeight`로 고정 → 그 아래로 못 줄임. 결과적으로 스크롤이 사라진다.
- **모니터 한계까지:** 화면(작업 영역)을 넘어설 때만 비로소 스크롤 허용(최후 수단).
- **자동 배치:** Navi 카드는 `auto-fit` 그리드로 폭에 맞춰 줄 수가 정해지고, 줄이 늘면 높이가 따라 커짐.

### 12.4 상태 = 캐릭터 포즈 + 색 (사이버 팔레트)
상태를 글자 대신 **도트 캐릭터의 포즈/애니메이션**으로 먼저 읽히게 하고, 색은 보조. 색약 대비 글리프도 병기.
| 상태 | 캐릭터 포즈/애니메이션 | 색 | 글리프 |
|---|---|---|---|
| idle | 꾸벅꾸벅 졸기 | 흐린 초록 `#2e6b3e` | z |
| working | 키보드 타이핑(들썩임) | 형광 시안 `#00e5ff` | ⌨ |
| blocked(질문) | 머리 위 `?` 말풍선·손 듦 | 앰버 `#ffb000` | ?? |
| approval_pending | 서류 들고 내미는 포즈 | 마젠타 `#ff2bd6` | ▮ |
| done / pass | 따봉·점프 | 인광 그린 `#00ff66` | ✓ |
| error / fail | 머리 위 빨강 `!`·털썩 | 형광 레드 `#ff3b3b` | ✗ |

관리자 캐릭터는 가운데에서 살짝 크게, 보고가 생긴 Navi를 향해 고개/손짓으로 가리켜 시선을 유도한다.

### 12.5 인터랙션 원칙
- 실시간성: Navi 진행은 **Main→Renderer IPC 이벤트**로 푸시(폴링 X).
- 끼어들기: 작업 중에도 "중지/질문" 항상 가능.
- 안전: 모든 파괴적/외부 행위는 명시적 승인 카드. 기본은 거부 쪽.
- 접근성: 키보드 단축(전송, 다음 blocked로 점프, 승인).
- 반응형: 창 좁히면 Inspector를 드로어로.

### 12.5b 네이티브(OS) 통합 — 데스크톱 앱이라 가능
- **트레이 상주:** 창을 닫아도 트레이에 남아 Navi 동작 지속(선택). 트레이 아이콘에 작업중/blocked 수 뱃지.
- **OS 알림:** blocked 질문·승인 대기·작업 완료 시 네이티브 알림 → 클릭하면 해당 항목으로.
- **네이티브 메뉴/단축키:** 전역 메뉴(파일/작업/도움말), OS 단축키.
- **자동 시작(선택):** 로그인 시 트레이로 기동.
- **딥링크/파일 드롭:** 폴더를 창에 끌어다 놓으면 작업 대상 추가.

### 12.6 화면 목록 (구현 단위)
1. 작업실 무대 + 관리자 채팅 — 메인
2. Navi 콘솔 드로어(캐릭터 클릭 시)
3. 프로젝트 추가/설정 모달(경로, verify_cmd, enabled)
4. 작업 이력/로그 뷰(task별 타임라인·비용)
5. 승인 센터(대기 중 push/merge 모음)
6. 설정(동시성 cap, 사용량 상한, 모델 티어, 승인 규칙, 방해금지, 비주얼 효과 토글)

### 12.7 비주얼 아이덴티티 (사이버펑크 그린 CRT)
- **팔레트:** 배경 `#0a0e0a`(거의 검정), 본문 인광 그린 `#33ff66`, 흐린 그린 `#1f5c33`(보조/구분선), 액센트는 §12.4. 하이라이트 글로우는 `text-shadow`로 은은하게.
- **타이포:** 모노스페이스 — 본문 `IBM Plex Mono`/`Share Tech Mono`, 강조/타이틀 `VT323`(레트로). 자간 넓게, 대문자 라벨.
- **캐릭터(도트):** 16×16 또는 24×24 픽셀 스프라이트, 1~2프레임 애니(타이핑·졸기·따봉). 관리자는 색/실루엣 구분(예: 헤드셋·살짝 큼). Navi 발밑에 프로젝트명 라벨.
- **모티프:** 와이어프레임 박스(박스드로잉 `┌─┐│└┘`)로 패널 테두리, 라벨 `[ STAGE ]` `[ MANAGER ]` `[ WORKER ]`. 모서리 브래킷 `⌜ ⌟`.
- **효과(토글 가능):** 미세 스캔라인 오버레이, 약한 CRT 비네팅, 부팅 스플래시(타이핑되는 `maestro v0.1 // booting...`), 커서 블링크 `▋`. 과하지 않게 — 끄면 순수 그린 터미널.
- **채팅:** 입력은 프롬프트 `>` 스타일, 너=`user@maestro:~$`, 관리자=`manager>`, Navi 인용=`[webapp]>` 접두. Navi 활동 로그는 콘솔 스트림처럼 한 줄씩 흐름.
- **사운드(선택, 기본 OFF):** 키스트로크/완료 비프 등 레트로 효과음 토글.
- **접근성 보호:** 모든 효과는 설정에서 OFF 가능, 색 대비는 글리프로 이중화 → "멋"이 가독성을 못 깎게.
- **테마 토큰:** `shared/theme-tokens.css`를 베이스로 사이버 팔레트를 오버라이드(완전 별도 테마, 타 프로젝트는 영향 없음).

### 12.8 Navi 편성(로스터) 관리 — 동적 합류/제외
무대에 서는 Navi 캐릭터를 네가 직접 추가/제외한다(`projects.enabled`).
- **합류:** "폴더 추가"(버튼) 또는 **폴더를 창에 드래그&드롭** → 자동 감지(stack·verify_cmd·is_git) → 새 Navi 캐릭터가 무대에 등장(입장 애니).
- **제외(숨김):** Navi 캐릭터 우클릭 → "제외" → 무대에서 사라짐. **삭제가 아니라 비활성** — 설정·이력은 보존, 다시 "복귀"로 등장.
- **삭제:** 레지스트리에서 완전 제거는 별도 확인(파괴적 → 명시적 승인).
- **안전장치:** 작업 중(working)인 Navi를 제외하려 하면 "진행 중 작업 있음 — 중지 후 제외?" 확인. 즉시 숨기지 않음.
- 무대가 붐비면 그리드/페이지로 정렬, 제외된 Navi는 별도 "대기실" 목록에서 한눈에.

---

## 13. 기술 스택

| 영역 | 선택 | 이유 |
|---|---|---|
| 셸/패키징 | **Electron** | Main이 Node라 Agent SDK를 같은 프로세스에서 직접 구동. 트레이·알림·네이티브 메뉴 |
| 런타임 | **Node + TypeScript** (Electron Main = L0) | 네 주력, SDK 일급 지원 |
| 오케스트레이션 | **`@anthropic-ai/claude-agent-sdk`** | 다중 세션·resume·권한·cwd 제어 |
| 프론트(Renderer) | **React + Vite** | 가볍고 빠른 데스크톱 렌더러. (Next 불필요 — 서버 라우팅 안 씀) |
| 스타일 | Tailwind + 사이버 그린 테마(§12.7), `shared/theme-tokens.css` 오버라이드 | CRT 사이버펑크 룩 |
| 실시간 | **Electron IPC** (`ipcMain`/`ipcRenderer` + 이벤트 emit) | Main↔Renderer 스트리밍, HTTP 서버 불필요 |
| 상태 저장 | **SQLite (`node:sqlite` 내장)** | 단일 파일·트랜잭션. Electron 42(Node 24) 내장이라 네이티브 리빌드 불필요. (better-sqlite3는 Electron 42 V8과 소스 비호환 — 실측으로 교체) |
| 프로세스 | SDK `query()` 직접(우선), CLI `claude -p`는 폴백 | 제어/관측 용이 |
| 빌드/배포 | **electron-builder** (Windows NSIS/portable) | Windows 데스크톱 |
| 실행 모델 | **앱 실행 시 기동**(트레이 상주 옵션) | 단순·안전. 상시 백그라운드는 Phase 3 |

> Tauri 대안 검토: 번들이 가볍지만 백엔드가 Rust라 Node Agent SDK를 별도 사이드카 프로세스로 띄워야 함 → 복잡도 증가. SDK 구동 일관성 때문에 **Electron 채택.**

---

## 14. maestro 디렉터리 구조 (제안)

계층 기반(단일 도메인 소~중형 → 네 컨벤션).

```
lain/                      # C:\dev\lain (확정)
  PLAN.md                  ← 이 문서
  README.md  CLAUDE.md
  package.json
  electron-builder.yml     # 패키징 설정
  src/
    main/                  # L0 결정론 코어 (Electron Main = Node)
      index.ts             # 앱 진입(BrowserWindow·트레이·메뉴·알림)
      ipc.ts               # ipcMain 핸들러 + 이벤트 emit
      registry.ts          # 프로젝트 스캔/레지스트리
      store.ts             # SQLite 접근
      orchestrator.ts      # 스폰·동시성·상태머신
      manager.ts           # L1 관리자 세션 래퍼
      worker.ts            # L2 Navi 세션 래퍼
      collectors.ts        # git/test 현황 수집(읽기전용)
      safety.ts            # canUseTool 승인 라우팅·범위 가둠
    preload/
      index.ts             # contextBridge로 안전한 IPC API 노출
    renderer/              # 프론트 (React + Vite)
      main.tsx  App.tsx  components/  lib/
    shared/                # 타입(상태머신, 메시지/IPC 채널 스키마)
  data/
    maestro.sqlite         # 로컬(.gitignore)
    done/                  # 완료 TASK.md 아카이브(§7.1) — <project-id>/<task-id>.md
  .gitignore               # node_modules, dist, out, release, data/
```

> 보안: Renderer는 `nodeIntegration: false` + `contextIsolation: true`. preload의 `contextBridge`로 화이트리스트된 IPC만 노출(임의 Node 접근 차단).

---

## 15. 단계별 로드맵 (위험 낮은 순)

- **Phase 0 — 읽기 전용 현황 대시보드**
  - 레지스트리 + collectors + 상태 저장소 + 대시보드 사이드바.
  - 코드 수정 0. 관리자 채팅으로 "현황 요약" 보고. 즉시 가치·무위험. **여기서 시작.**
- **Phase 1 — 단일 프로젝트 작업 실행**
  - TASK.md 로드 → 관리자 명확화 → Navi 스폰(브랜치+커밋) → 보고. 승인 센터(드라이런 우선).
- **Phase 2 — 다중 병렬 + 쌍방향 심화**
  - 동시성 cap, blocked 큐, `ask_manager` 인터럽트, session resume, Inspector 스트리밍.
- **Phase 3 — 자동화(선택)**
  - 주기 스캔, 관리자 자동 우선순위, 트레이 상주 백그라운드 실행, 자동 시작, OS 알림 고도화.
  - **별도 트랙**: autonomous Navi 모드(glass-box) 착수 — §21.9. interactive(§15 Phase 1~2)와 코어 공유, 검증 가능 작업 전용.

각 Phase 끝에 빌드/타입체크/테스트로 검증(네 규칙).

---

## 15b. 운영·복원력 (Resilience & Ops)

리뷰에서 보강된 운영 측면.

### Navi 실행 환경
- **비추적 필수 파일(.env 등):** git worktree는 추적 파일만 체크아웃 → `.env`·로컬 config는 `.gitignore`라 안 들어온다. Navi가 테스트·실행하려면 **메인 체크아웃의 `.env` 등 비추적 필수 파일을 worktree로 복사/심링크**한다(사용자가 `.env` 제공). 단 그 값은 로그·다이제스트에 미노출(§9-6).
- **의존성:** worktree에서 검증하려면 deps 필요. 정책: Python은 venv 생성(가벼움), Node는 worktree마다 `npm install` 비용이 크므로 **메인 체크아웃의 `node_modules` 재사용(심링크/복사) 우선, 실패 시 설치**. (정확 방식은 §17 튜닝)
- **포트 충돌:** dev 서버 검증이 필요하면 동적 포트 할당 + 종료 보장. 가능하면 서버 띄우지 말고 테스트/타입체크로 검증.
- **자원:** 동시 빌드는 무겁다 → 동시성 cap을 CPU/RAM 기준으로(기본 2), 빌드 작업은 직렬화 옵션.

### 실패·재시도
- **검증 실패 루프:** verify 실패 → Navi에 결과 피드백 → 재시도 **최대 N회(기본 2)** → 그래도 실패면 `blocked`로 너에게 보고(무한 재시도 금지).
- **모델 에스컬레이션:** 반복 실패 시 상위 티어로 1회 승격 후 재시도(§9b).
- **API 장애:** 지수 백오프 재시도, 한도 초과 시 작업 일시정지·보고.
- **고아 정리(GC):** 중단·취소·크래시로 남은 worktree/브랜치를 시작 시 스캔해 정리.

### 크래시 복원
- 앱 재시작 시 상태 저장소에서 미완 task 복구. Navi 세션은 `session_id`로 `resume`(같은 PC). resume 불가하면 worktree 보존 후 재시작 옵션 제시.

### 관리자 컨텍스트 관리
- 프로젝트가 많고 대화가 길어지면 관리자 컨텍스트가 한계 → 오래된 대화는 요약 압축, 현황은 항상 최신 다이제스트로 재주입(원문 누적 X).
- 재시작 시 유지: 진행 중 task·승인 대기·최근 요약. 전체 대화 원문은 비유지(저장소엔 남김).

### 비표준 프로젝트
- **비-git**(일부 정적 HTML): worktree 불가 → 작업 전 폴더 스냅샷 백업 후 in-place, 또는 작업 제외.
- **Godot(game-client)**: `npm test` 없음 → verify_cmd를 Godot 헤드리스 또는 "검증 없음"으로. 스택별 검증 어댑터.

### 데이터 보존
- `messages`/`audit`/스트리밍 로그는 증가 → task별 보관 기간·용량 한도 후 아카이브/정리.

### maestro 자체 테스트
- SDK·git·셸을 목(mock)으로 둔 단위 테스트, 상태 머신 전이 테스트. Navi 없이 오케스트레이션 로직 검증.

---

## 16. 리스크 & 완화

| 리스크 | 완화 |
|---|---|
| Navi가 의도 밖 변경 | 브랜치 격리 + push 승인 + 드라이런 + 파괴행위 허락 게이트 |
| 비용 폭주 | task별 비용/턴 상한, 동시성 cap, 대시보드 누적 비용 |
| 관리자 컨텍스트 과부하 | 전체 코드 X, 다이제스트만. Navi가 깊이 담당 |
| 다이제스트 stale | 결정론 부분 매 스캔 갱신 + 판단 요약 작업 종료 시 갱신 |
| 행/무한루프 | 타임아웃·취소·maxTurns |
| SDK API 변동 | §18 체크리스트로 빌드 시 실측 후 확정 |
| 동시 git 작업 충돌 | 프로젝트당 Navi 1, worktree 격리, 직렬 git 작업 |
| 네 라이브 편집과 충돌 | worktree 분리(§9-1) — Navi는 별도 디렉터리/브랜치 |
| worktree 디스크 누적 | 완료·취소·시작 시 고아 GC(§15b) |
| 시크릿 유출 | Max 로그인 토큰 safeStorage 보관 + .env 값 다이제스트/로그 마스킹(§9-6) |

---

## 17. 미해결 / 추후 결정

- ~~배치 위치~~ → **확정: `C:\dev\lain`, 이름 lain.**
- **관리자 도구 경계 — 구현 시 확정.** 관리자(LLM)가 L0에 내리는 도구(`get_status`/`message_navi`/`create_task`/`request_approval` 등)와 정확한 범위 규칙은 빌드 때 정함.
- **merge-back 흐름 — 구현 시 확정.** 승인된 Navi 브랜치를 main에 합치는 방식(merge/rebase·충돌 처리·worktree 정리).
- **직접-대-Navi vs 관리자-대-Navi 직렬화** — 한 세션 동시 발화 방지(대화 소유권 규칙).
- **미커밋 작업 인계** — 네 작업 디렉터리의 미커밋 변경을 Navi에 넘길지(stash/포함 옵션). 기본은 커밋 시점 분기.
- **프로젝트 작업 중 새 TASK** — 큐 적재 vs 거절.
- **설정 저장소** — 동시성 cap·모델 티어·승인 규칙·방해금지 등 설정 보관 위치(테이블/파일).
- 관리자를 항상 켜둘지(세션 유지) vs 요청 시 생성. → Phase 1에서 결정.
- worktree의 `node_modules` 처리(재사용 심링크 vs 매번 설치) — 프로젝트별 빌드 특성 보고 튜닝.
- 검증 재시도 횟수·자원 기준 동시성 cap 기본값 실측 조정.
- PR 생성을 GitHub(`gh`)까지 자동화할지, 로컬 브랜치까지만 할지.

---

## 18. 부록 — SDK 옵션 확정 체크리스트 (빌드 시 실측)

아래는 설계 가정이며, 구현 직전 설치된 SDK 버전에서 **이름·동작을 실제로 확인**한 뒤 확정한다(추측 금지).

- [ ] 패키지: `@anthropic-ai/claude-agent-sdk` 진입점 `query({ prompt, options })`
- [ ] `options.cwd` 로 프로젝트별 작업 디렉터리 지정
- [ ] `options.resume` (session_id) / `continue` 로 세션 이어가기, `session_id` 취득 위치
- [ ] `options.allowedTools` / `disallowedTools` / `permissionMode` 값 집합
- [ ] `options.canUseTool` 콜백 시그니처(위험 행위 → 승인 큐 라우팅 구현, §9-4)
- [ ] in-process MCP 서버 정의 API(`ask_manager` 툴 구현)
- [ ] 스트리밍 입력(`prompt`로 AsyncIterable) 지원 여부
- [ ] `stream-json`/메시지 이벤트 형태(진행 스트리밍 → IPC 이벤트 매핑)
- [ ] `maxTurns`·사용량 가드 옵션 실제 키명(Max 한도 연동)
- [ ] 세션 저장 위치(`~/.claude/projects/...`)와 `CLAUDE_CONFIG_DIR` 동작
- [ ] 동시 다중 `query()` 안정성·동시성 한계
- [ ] 작업별 모델 지정 옵션 키명(티어링 §9b)
- [ ] cwd 밖 접근을 `canUseTool`/설정으로 가두는 방법(경로 confinement)
- [ ] **Claude Max 로그인으로 SDK 구동** + 동시 세션/사용량 한도 실측(API 키 아님), 로그인 토큰 `safeStorage` 보관
- [ ] `git worktree` 기반 격리 + node_modules 재사용 실측
- [ ] 스트리밍 세션 interrupt + 메시지 주입(작업 중 끼어들기 §5.7)

---

## 19. 구현 방법 (빌드 전략)

### 19.1 결론 — 전체를 ultracode 한 방으로 짜지 않는다
maestro는 ultracode/대규모 병렬 워크플로우가 **맞지 않는** 작업이다. 이유:
- **통합·상태 기반 코드:** IPC 계약·공유 타입·상태 머신·SDK 세션 관리가 서로 얽힘 → 병렬 에이전트가 인터페이스 어긋난 코드를 양산.
- **SDK API 미검증(§18):** 실측 전 추측 생성 = 추측의 대량 생산.
- **실행 루프 필요:** Electron 실행·SDK 인터럽트·git worktree는 돌려봐야 확정 → 사람 개입 반복이 본질.

→ **대화형 반복 빌드를 메인**으로, Phase 0→1→2→3 순서. ultracode는 아래 좁은 지점에만.

### 19.2 모델 분배 (티어링을 빌드에도)
- **Opus:** 오케스트레이터·SDK 통합(다중세션/resume/**interrupt**/canUseTool)·상태 머신·worktree 격리 — 어려운 핵심.
- **fable(빠름)/Sonnet:** 보일러플레이트·UI 마크업·타입 정의·반복 수정.

### 19.3 ultracode/워크플로우가 실제로 이득인 지점
1. **빌드 전 §18 SDK 표면 병렬 검증** (가장 위험한 불확실성 제거 — 권장 1순위).
2. **독립 보일러플레이트 대량 생성**(타입, React 컴포넌트 골격).
3. **완성 후 코드 리뷰/감사**(다차원 병렬 + 적대적 검증).

### 19.4 규모 감
- 코드량: 전체 **8천~1.2만 LOC**(main+preload+renderer+테스트), Phase 0만 ~1.5천~2.5천.
- 기간: Phase 0 며칠, 전체 몇 주 분량. **한 세션에 안 끝남 — 여러 세션 분산.**
- 비용: 반복 깊이에 좌우(고정 수치 단정 안 함). 어려운 부분만 Opus로 아껴 씀.

### 19.5 권장 순서
1. (선택) §18 SDK 검증 워크플로우 → 추측 제거.
2. **Phase 0** 스캐폴딩(Electron+Vite+SQLite) → 읽기전용 대시보드 → 검증.
3. Phase 1 단일 Navi 실행(worktree·승인) → … → Phase 2/3.
4. 각 Phase 끝: 빌드/타입체크/테스트 + 실제 실행 확인. push/머지는 사람 승인.

---

## 20. 장기 비전 — 로컬 에이전트로 확장 (잘 되면)

maestro가 실제로 효율을 입증하면, 더 일반적인 **로컬 자율 에이전트**로 키운다. 단 *지금 짓는 게 아니라*, 결과를 보고 결정하는 **나중 베팅**이다. (선행 사례: OpenClaw, Hermes Agent)

### 20.1 참고 사례
- **OpenClaw** (Peter Steinberger): 로컬·자가호스팅·프라이버시 우선 개인 비서. 네가 쓰는 **메신저 채널**(Telegram/Discord/iMessage 등) 안에서 동작, 외부 LLM 사용, `SKILL.md` 스킬 시스템, 로컬 영속 상태.
- **Hermes Agent** (Nous Research): 에이전트 플랫폼(메모리·스킬·스케줄·메시징). **비동기·자율**, 실행 환경을 로컬/Docker/SSH/클라우드로 끼워끼움, 멀티 프로바이더, **Claude Code에 작업 위임 가능**.
- 의미: maestro는 이미 이들과 DNA 공유(로컬·비동기·Claude·스킬·영속·승인) → 자연스러운 확장이며, **"비동기+로컬+Claude+스킬"이 검증된 패턴**임을 증명.

### 20.2 핵심 원칙 — 일반성으로 경쟁하지 않는다
일반 비서 시장은 붐비고(OpenHands·goose·Cline·Aider…) 펀딩 팀들과 경쟁. → **maestro의 엣지인 "멀티프로젝트 개발 와이어드 관리"를 지킨다.** 저들이 약한 니치: 여러 Navi 동시 지휘 + worktree 격리 + 관리자 계층. 목표는 "더 나은 OpenClaw"가 아니라 **"내 개발 와이어드를 극한까지 잘하는 로컬 에이전트."**

### 20.3 빌려올 것 (단계적으로)
- **OpenClaw → 채널 접근:** 자리 비웠을 때 폰의 Telegram/Discord로 와이어드 지휘·결재. 능동 보고(§5.5)와 직결, 편의 대비 비용 낮음.
- **Hermes → 끼워끼우는 실행 환경:** Navi를 **Docker/컨테이너**에서 구동 → "전부 허용+승인"(§9-4)보다 격리 강화(안전 모델 업그레이드). 멀티 모델/프로바이더, 스케줄링.

### 20.4 지금 막지 않을 준비 (피벗 친화 설계)
- L0 코어·Navi 추상화를 **모델/실행환경 비종속**으로 유지 → 나중에 Docker 실행·다른 모델·채널 프론트를 얹기 쉽게. (가정 하드코딩 금지)
- 스킬/`TASK.md`·이벤트 버스·승인 큐는 이미 일반 에이전트의 빌딩블록.

### 20.5 피벗 시 반드시 업그레이드
- **보안:** 상시 가동 + 채널로 외부 접근 가능한 일반 에이전트는 공격면이 급증. 지금 "전부 허용+승인"은 *지켜보는 와이어드*용 → 채널로 열리면 **더 단단한 권한·인증 모델 필수.**
- 참고: [OpenClaw GitHub](https://github.com/openclaw/openclaw) · [Hermes Agent—Claude Code 위임](https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-claude-code)

---

## 21. Navi 실행 모드 — interactive / autonomous (glass-box)

> 별도 계획서 "Glass-box 자율 코딩 에이전트"를 lain에 편입. 독립 제품이 아니라 **Navi 한 명의 실행 방식에 대한 대안 설계**로 흡수한다. **lain = 오케스트레이션 층(누가 무엇을), 이 모드 = 실행 엔진 층(Navi가 어떻게).**

### 21.0 두 모드
Navi는 작업 성격에 따라 두 방식 중 하나로 돈다.
- **interactive (기본, Phase 1~2):** 현 설계. SDK Claude Code 세션, 실행 중 위험행위를 승인 큐로(§9-4). 명세가 모호하거나 검증 불가능한 작업에 적합.
- **autonomous (glass-box, Phase 3+):** 명세를 빡세게 합의(elicitation)한 뒤 **실행 중 사람 개입 0**. 자동 채점 가능한 작업 전용. 실시간 승인(before)을 glass-box 사후 감사(after)로 대체.

핵심 차이: interactive는 *실행 중* 끼어들어 승인받고, autonomous는 그 개입을 *계획 단계로 미리 흡수*한다. (Claude Code의 실행 중 승인 모델을 계획 단계로 당긴 것이 autonomous.)

### 21.1 autonomous 모드 철학 (= 이 모드를 직접 만드는 유일한 명분)
1. **elicitation-first** — 사람 판단을 실행이 아니라 계획에 몰아넣는다. 명세가 정밀해질 때까지 캐묻고, 그 전엔 실행 안 함.
2. **glass-box** — Navi의 내부 상태·성장이 전부 들여다보인다(자기개선 **+ 가시성**).
3. **hands-off** — 명세 합의 후 실행 중 승인 0.
4. **검증 가능한 것만** — 자동 채점 가능한 작업만 무개입 위임. *이 잣대는 "어떤 작업을 autonomous에 넘기나" 결정에도 동일: 검증할 수 있는 만큼만 위임.*

### 21.2 모드 선택 규칙 (관리자가 판정)
관리자가 TASK.md를 읽고 결정:
- DoD(§7)가 **자동 테스트로 떨어지면 → autonomous** 후보.
- 테스트로 못 적는 모호함이 남으면 → **interactive** (또는 elicitation으로 모호함 해소 후 autonomous).
- 비가역·광역·secret 필요 작업은 autonomous 금지(§21.5 escalate 대상).

### 21.3 elicitation 엔진 (§8 clarifying의 업그레이드 — 차별점의 심장)
lain의 `clarifying`(§8 "모호하면 질문 모아 한 번")을 **기계적 모호함 탐지기**로 강화.
- **멈춤 게이트**: "테스트가 *통과*하냐(실행 後)"가 아니라 "테스트를 *쓸 수 있냐*(실행 前)".
- 동작: 요구사항을 *실행 없이* 합격/불합격 기준(테스트)으로 적어본다 → 적히면 잠금, 안 적히면 그게 모호함 탐지 지점 → 콕 집어 질문 → 반복. 전부 테스트로 적히고 사용자 의도 확인 → **멈춤, 실행으로.**
- 핵심: "테스트로 못 적겠다"가 기계적 모호함 탐지기. 느낌으로 판단 안 함.
- 산출물 = 합격 테스트 묶음 → 그대로 실행의 판사(**spec = test = judge**). 입구(elicit)와 출구(verify)가 같은 부품.
- 자동 테스트로 안 떨어지는 기준은 "구체적·확인 가능한 합격 기준"으로 완화(사람 체크포인트 OK).

### 21.4 glass-box = 이벤트 소싱 (§6 저장소 진화 방향)
lain의 흩어진 로그(audit·messages·project_status)를 **단일 append-only 이벤트 로그**로 통합하는 방향.
- 현재 상태를 저장하지 않고 "무슨 일이 일어났는가"를 시간순으로 쌓고, 상태는 재생(projection)으로 유도.
- 4개 뷰가 전부 이 로그의 projection: ① 도메인 지식(정정 = 정정 이벤트 추가) ② 스킬 목록 ③ 지금 하는 일(로그 끝, 실시간) ④ 성장 추이(시간축 집계).
- 근거: "성장이 보인다"는 *변화의 시계열*이 선행. day-1부터 이벤트로 안 남기면 소급 시각화 불가 → 처음부터 깐다. (풀 CQRS까진 안 감 — append-only 테이블 + 단순 집계.)
- **편입 시점**: §6 스키마를 이벤트 소싱으로 리팩터하는 건 autonomous 착수 시. interactive만 쓰는 Phase 0~2에선 현 스키마 유지.

### 21.5 divergence / escalation 정책 (§9-4 승인 큐의 정교화)
autonomous 실행 중 계획이 깨질 때의 *사전 결정 정책*. lain의 거친 canUseTool 라우팅을 2축으로 정교화.
- **경계 2축**: ① 안전한 default가 있나 ② 되돌릴 수 있나/저-스테이크인가. **둘 다 yes → 자율 결정(+로그), 하나라도 no → escalate(= interactive 승인 큐로 전환).**
- **무조건 escalate**: 테스트 자체가 틀려 보임 / 다른 테스트 깨짐(요구사항 충돌) / 예산·반복 상한 도달.
- **조건부**: 의존성 버그(shim 가능하면 자율, 수정 필요하면 escalate) / 설계 선택(minimal diff·기존 패턴이면 자율, public API·광역·새 의존성이면 escalate) / 컨텍스트 부족(fixture·테스트데이터는 자율, secret·외부서비스는 escalate — **secret 날조 금지**).
- **메타 규칙**: 결정이 (a) 명세를 뒤집거나 (b) 의도 충돌을 판정하거나 (c) 정당히 못 가질 것(secret)을 요구하거나 (d) 비가역/광역이면 escalate. 그 외엔 보수적 default + 로그.

### 21.6 spec-gaming(reward hacking) 방어 (§9 안전장치 확장)
판단 기준을 Navi가 조작 못 하게. *(판단 기준을 피고인이 조작할 수 있으면 judge가 아니다.)*
- 테스트 파일 read-only(권한 차단) / 전체 스위트 그린(타겟 하나 X) / skip·xfail을 그린으로 안 침(`xfail_strict` + skip 카운트 검사) / diff에 테스트 변경 있으면 거부.
- 나중: held-out 테스트, LLM critic 패스, 뮤테이션 테스팅.

### 21.7 빌드 기반 결정 — 결정됨(구현): 후보 A(SDK 재사용)
**후보 A 채택** — autonomous는 별도 raw 루프가 아니라 interactive와 같은 `worker.ts`/`engines.ts` 코어를 공유하고, hands-off는 예고대로 `permissionMode`로 건다. 후보 B(raw 루프)는 미채택. 아래는 결정 배경.
- 판단 기준은 "남의 거냐"가 아니라 **lock-in(갈아끼울 수 있나)**. Navi 실행부를 **인터페이스 뒤에** 두면 밑이 raw든 SDK든 구현 디테일이고 교체 가능.
- 후보 A: **SDK 재사용**(interactive와 코어 공유, hands-off는 `permissionMode`로) — 통합 비용 낮음. / 후보 B: **raw 루프**(hardened 컨텍스트·권한 직접 짐) — 차별점 통제력 높음, 유지보수 직접.

### 21.8 채널 / 스티어링 — lain이 일부 흡수
원 계획의 "채널 seam"(코어를 frontend에서 분리)은 lain에 부분 존재.
- lain은 이미 Electron UI + IPC 이벤트버스(§12) → 채널 어댑터의 한 형태. 텔레그램 등 추가는 §20.3과 합류.
- 스티어링(실행 중 텍스트 주입)은 lain의 인터럽트(§5.7)와 동일 문제 — step 경계에서 inbox 체크. autonomous는 "개입 0"이 원칙이라 스티어링은 escalation 채널로만 제한.
- 음성: 가벼운 명령엔 OK, **명세 정의엔 금지**(저정밀 입력).

### 21.9 로드맵 편입
- **interactive Navi = Phase 1~2** (현 로드맵 §15 그대로).
- **autonomous Navi = Phase 3 이후의 별도 트랙 — 첫 슬라이스 구현·배포됨.** 전제 ① interactive 검증 완료 ② §18 SDK 실측 완료 ③ 이벤트 소싱 리팩터(§21.4) 결정은 전부 충족됐고, 빌드 순서(얇은 수직 슬라이스(red→green 자동채점 task) → spec-gaming 방어 → divergence 정책 → elicitation 엔진 + fuzzy task)도 그대로 밟았다.
- 명시적으로 미룬 것: retrieval/학습 루프 고도화, held-out/critic/뮤테이션, 긴-step abort 스티어링.

### 21.10 미정
- 모드 선택을 관리자 자동 판정에 맡길지 vs 사용자가 task별 핀 고정.
- 이벤트 소싱 전환 시 기존 SQLite 스키마(§6) 마이그레이션 범위.
- autonomous 검증용 fuzzy task의 구체 내용(원 계획에서도 TODO).

---

## 22. 자기개선 — 경험 누적 + retrieval (구현됨 2026-06-13)

> 모델 가중치가 아니라 **검증된 경험을 학습으로 쌓고 다음 작업에 검색해 주입**해서 점점 똑똑해진다. (가중치 학습은 후속.) §21.4 glass-box "성장이 보인다"의 최소 구현.

### 22.1 폐루프
작업 → **verify pass로 review 도달** → 회고(judge가 재사용 학습 추출) → `lessons` 저장 → 다음 Navi 스폰 시 같은 프로젝트 학습을 프롬프트에 주입(retrieval) → 행동 개선. E2E로 전 구간 검증(seed 학습 "결과는 dist/에" → TASK.md에 없는데도 Navi가 dist/에 생성, reuse_count++).

### 22.2 안전장치 (핵심)
- **verify pass한 작업의 학습만 신뢰.** 자동 채점 안 되면(verify_cmd 없음) 회고 건너뜀 — 틀린 학습 누적이 자기개선을 망치므로. autonomous(테스트=판사)와 가장 잘 맞음.
- judge가 보수적으로 0건 내도 정상(TASK.md에 이미 있는 걸 베끼지 않음).

### 22.3 구현 (lessons 테이블)
- `lessons`: project_id·task_id·scope(project|global)·trigger·lesson·reuse_count.
- 회고: `orchestrator.reflect()` — review 도달+pass 시 judge 모델로 0~2건 추출.
- retrieval: `worker.lessonsBlock()` — fresh 스폰 시 프로젝트+global 학습 top-K 주입, reuse_count++.
- UI: 🧠 LESSONS 패널(누적 건수·재사용 횟수·scope 뱃지) = 성장 가시화.

### 22.4 다음 단계 (미구현)
- **임베딩 검색**: 지금은 프로젝트 매칭+재사용순 top-K. 8GB 로컬 임베딩 모델로 의미 검색 → 관련도 향상.
- **학습 정제**: 중복 병합·오래된/안 쓰이는 학습 폐기(reuse_count 0 장기 방치 정리), lain 자체 메모리 consolidate처럼.
- **모델 가중치 학습**(사용자 요청, 후속): 검증된 (task, 성공 diff) 쌍을 로컬 모델 LoRA 데이터로. 8GB 제약·실효성은 실측 후.
- **로컬 하이브리드**: 회고·판정류를 로컬 모델로 내려 비용 0 (트랙 2).

---

## 23. 평가 하네스 — 자기개선 효과 측정 (구현됨 2026-06-13)

> Hermes(NousResearch)의 curator도 스킬 **사용량**은 추적하지만 자기개선이 에이전트를 **실제로 더 낫게 만드는지**는 A/B로 측정 안 함. lain의 차별점: 측정 없는 누적이 아니라 **닫힌 증거**.

### 23.1 동작
`bench/<task>/`(TASK.md + 검증 + 선택적 lessons.json) 묶음을 **학습 off/on 두 조건**으로 격리 실행 → `성공률·1회통과율·평균 턴·평균 비용` 비교. 각 task는 임시 git repo로 materialize → 임시 프로젝트 등록 → `startTask(skipClarify)` → 종결 폴링 → 결과 수집 → 완전 정리(worktree·레지스트리·repo).

### 23.2 첫 측정 결과 (n=2)
| 지표 | 학습 OFF | 학습 ON |
|---|---|---|
| 성공률 | 100% | 100% |
| 1회 통과율 | 100% | 100% |
| 평균 턴 | 8.5 | **7.5** |
| 평균 비용 | $0.112 | **$0.104** |

**해석(중요)**: Navi가 영리해서 검증 명령(판사)을 읽고 역공학 → 학습 없이도 성공. 하지만 학습은 **시행착오를 건너뛰게** 해 턴 12%·비용 7% 절감(dist-convention 10→8턴). → "자기개선은 성공률이 아니라 효율을 올린다"를 측정으로 입증. **검증이 자기설명적이면 학습 효과가 작다**는 것도 평가 하네스가 밝힌 통찰.

### 23.3 구현
- `bench/` fixture(커밋됨, data/ 밖), `src/main/bench.ts` 러너, `bench_runs` 테이블, `bench:run` IPC, 📊 BENCH 패널, `LAIN_BENCH=both|no-lessons|with-lessons` 훅.
- `startTask(skipClarify)` 추가(측정 일관성), `deleteProject`(FK 순서 정리), Windows rmTree retry(.git read-only EPERM).

### 23.4 다음 단계
- **n 키우기·통계**: task 수·반복 늘려 신뢰구간. 지금 n=2는 신호 확인용.
- **검증으로 역공학 안 되는 task**: 런타임 절차 함정(빌드 선행 등) — 학습 효과가 크게 드러나는 시나리오로 자기개선 가치를 선명히.
- **회귀 감지**: 자기개선이 지표를 **악화**시키는 경우(틀린 학습 누적) 자동 경보 — 평가 하네스를 CI처럼 주기 실행.
- **학습 품질 루프 연결(§22 + Hermes curator 차용)**: 평가에서 "도움 안 된 학습"을 폐기·정제하는 피드백.

---

## 24. hermes-agent 2차 벤치마킹 — 이식 로드맵 (2026-06-17)

> 1차(§22/§23, app.asar 추출)에 이어 **전체 소스**(`C:\hermes-agent`, MIT) 기준 2차. 46-에이전트 워크플로우로 7개 스마트 서브시스템을 분석 → 35개 후보를 lain 아키텍처(L0 결정론·`manager.ts`만 SDK·`node:sqlite`·단일 PC·구독) 기준 채점 → 적대적 비평. **원칙: hermes의 파일시스템 모델(`.usage.json` 사이드카·tar 스냅샷·`SKILL.md` 패키지·POSIX 경로)을 버리고 SQLite `lessons` 행을 단일 진실원본으로 클린룸 재구현 — 메커니즘만, 코드 복사 금지.** 모든 폐기는 하드삭제 아닌 soft-archive(복구 가능).

### 24.0 측정 게이트 — lain 차별점 보존
lain의 엣지는 "hermes도 안 하는 효과 A/B 측정". 그런데 ① bench가 설치본 no-op ② 역공학-방지 fixture 부재 ③ 회귀 감지 없음 → 이 셋을 먼저 닫지 않으면 이후 intelligence-class 이식이 전부 "가정 도입". 그래서 Phase 0를 모든 회수·지능 픽의 게이트로 앞세운다.

### 24.1 FTS5/trigram 실측 (§18 — 완료 2026-06-17)
Phase 2(FTS 회수)의 선결 가정을 비평이 "미검증 단언"으로 지적 → 실측함. **Electron 42.4.0 번들 런타임: SQLite 3.53.0, FTS5=YES, trigram=YES, 한국어 `MATCH` 적중, `--experimental-sqlite` 플래그조차 불필요.** (system node 24.14.0/SQLite 3.51.2도 동일.) → `node:sqlite` FTS5 trigram 회수 채택 가능. 단 SQL은 hermes `_sanitize_fts5_query`를 베끼지 말고 결론(trigram·토큰≥3자·`MATCH` 0건시 LIKE/정렬 폴백)만 취해 새로 작성.

### 24.2 로드맵 (5단계, 의존순)
- **Phase 0 — 측정 게이트**: bench fixture `extraResources` 패키징 `S`(설치본 no-op 해소) · 역공학-방지 런타임-함정 task fixture `M` · ~~FTS5/trigram spike `S`~~ ✅완료(§24.1) · **회귀 감지**(bench를 CI처럼 주기 실행, 학습이 지표 악화 시 경보) `M` — §23.4 자인 격차, curator/Phase4 안전망.
- **Phase 1 — 학습 수명주기 백본 + 안전 quick-win** *(전부 native·S/M·저위험·병렬)*: `lessons` 수명주기 상태머신 `active→stale→archived`(결정론 SQL 전이) `S` ← curator·telemetry·provenance 공통 토대 · 사용 텔레메트리 `last_used_at`(recency; `reuse_count` frequency는 기존) `S` · **비밀파일 read/write 데노리스트**(`canUseTool` 결정론 차단) `S·high` ← d9cfa20로 Lain 전저장소 권한 얻어 `.env` 노출면 큼 · **verify 에러 분류 게이트**(재시도 무의미 vs 일시장애) `M·high` · 요약/핸드오프 temporal anchoring + STALE `S` · Navi 프롬프트 워크스페이스 스냅샷(git 상태+verify) `S` · **spec-gaming 강화**(전체스위트 그린·skip/xfail 카운트) `M` ← verify가 판사인데 위조방어가 정규식 한 줄, autonomous+bench 무결성 토대.
- **Phase 2 — 회수 정밀도(FTS) + 효율 가드** *(FTS5 실측 통과 §24.1)*: `lessons` 검색 단순정렬→FTS5 trigram 키워드 매칭 `M`(한국어 trigram 필수, MATCH 0건 폴백) · **교차세션 전문검색 도구**(read-only in-process MCP, `project_id` 스코프) `M·high` ← 과거 작업 되찾는 경로 0 · 도구-루프 가드레일(sha256 시그니처·동일인자 N회 차단) `M·high`.
- **Phase 3 — 학습 품질 루프(Curator)** *(lifecycle·telemetry·bench 선행)*: **idle 트리거 judge curator**(중복병합·미사용 soft-archive, 하드삭제 금지) `M·high` ← §22.4 핵심 격차 · 사용 중 학습 자기교정 patch-on-use(Navi는 신고만, judge가 verify-pass 게이트 뒤 retire/patch) `M·high` · 출처 게이트 `origin=agent|user`(user 학습 불가침, curator PR에 동봉) `S`.
- **Phase 4 — 지능 확장** *(측정 후 opt-in)* ⚠️ verify 밖 학습이라 §22.2("verify pass한 학습만 신뢰")와 긴장 — **회귀감지(Phase0) 없이 도입 금지**: 사용자-교정 신호 기반 background review `M` · judge cadence 사용자 모델(개인화) `M·high` · 하위디렉터리 규약 progressive 주입(SDK PostToolUse 실측 후) `M` · 학습→실행가능 절차 결정화(curator 선행) `M`.

### 24.3 제외 (근거)
- **PTC(프로그래매틱 툴콜)** `XL` — Navi `maxTurns:60`으로 멀티스텝 여유, 보안 회귀 표면 큼.
- **병렬 서브에이전트 위임** — PLAN §548 "프로젝트당 Navi1·직렬 git"과 충돌.
- **manager 컨텍스트 압축·tool-result pruning·tiered cache** — 전제 오류: lain은 이미 전 수집점 절단(`TAIL_CHARS=2000`)·system/user 티어 분리 중.
- **@file 인라인 확장** — 파일첨부 UI 이미 존재.

### 24.5 구현 진척 (2026-06-17 세션)
- ✅ **Phase 0**: FTS5/trigram 실측(§24.1), bench `extraResources` no-op 수정, 회귀 감지(`bench.ts detectRegression` — 학습 ON이 성공률/효율 악화 시 경보, OS 알림).
- ✅ **Phase 1**: 비밀파일 데노리스트(`safety.ts`), 학습 수명주기+telemetry+origin(`applyLessonLifecycle`·scheduler idle 틱), 워크스페이스 스냅샷, verify 실패 분류(`classifyVerifyFailure`), temporal anchoring(매니저 현재시각 헤더·Navi resume STALE), spec-gaming 강화(autonomous verify pass 후 `changedFiles`로 테스트 파일 변경 사후검증 → blocked).
- ✅ **Phase 2**: 도구-루프 가드(`TOOL_LOOP_BLOCK` sha256 시그니처), 교차세션 검색 도구(`searchHistory` — LIKE·project 스코프·worker/manager `search_history` MCP), 학습 콘텐츠-인지 랭킹(`lessonsForProject(…, task.content)` — 작업과 키워드 겹치는 학습 우선). FTS5 trigram은 한국어 2글자 매칭 실패 실측 → 소형 테이블엔 LIKE/JS 스코어링 채택, 대량화 시 FTS 도입.
- ✅ **Phase 3 (Curator 완성)**:
  - patch-on-use 신고 채널(`flagLesson` + Navi `flag_lesson` MCP — 틀린 학습 신고 시 즉시 soft-archive, judge LLM 불필요).
  - **idle judge consolidate**(`scheduler.consolidateLessons` — 중복 학습을 semantic 병합·umbrella 삽입·소스 soft-archive). **opt-in `lessonCurator` 기본 off**, autoPriority 격리 패턴(해시가드·60s abort·작업중 skip·한 틱 최대 3병합·그룹당 2건↑). L0의 두 번째이자 마지막 LLM 예외 — 격리를 코드 불변식으로 강제(§24.4).
  - **provenance 게이트 실효**: curator·flag·lifecycle 전부 `origin='agent'`·비핀만 건드림 → user/pinned 학습 불가침 보장(단 user 학습 *입력* UI는 아직 없음).
  - → **학습 폐루프 완성**: 생성(reflect) → 콘텐츠랭킹 → 노화(lifecycle) → 신고회수(flag) → 정비(curator 병합) → 측정(bench+회귀).
- 🔜 **남음**: 런타임-함정 fixture(§23.4), user 학습 입력 UI(provenance 활용), Phase 4 지능확장(background review·사용자 모델·결정화). **전부 미배포 — `npm run deploy` 일괄 필요.**

### 24.4 이식 불변식 (LLM 경계·IPC)
판단 레이어(`manager`/`worker`/`workerchat`/`orchestrator`/`scheduler`)만 `query()` 호출, 배관(`store`/`ipc`/`collectors`/`registry`)엔 금지. curator/사용자모델 judge는 `scheduler.autoPriority` 격리 패턴(opt-in·sha1 해시가드·abort 복제) 따름 — scheduler가 §4 'L0는 LLM 안 씀'의 유일 예외이므로 두 번째 예외 추가 시 동일 격리를 코드 불변식으로 강제. 새 IPC는 `ipc.ts`+`preload`+`types.ts` 3곳 동기화. 모든 `src/**` 변경은 `npm run deploy`로 설치본 반영.

---

## 25. 플래너 — 제거됨 (2026-07-18 개발자 전향)

> 2026-07-18 개발자 오케스트레이터 전향(§1)으로 코드 전량 제거 — 단독 커밋이라 revert 가능. DB 테이블 `plan_items`/`plan_tags`/`plan_sections`와 기존 설정키만 무해하게 잔존(코드가 읽지 않음). 당시 설계는 이력용으로 [docs/superpowers/specs/2026-07-05-planner-design.md](docs/superpowers/specs/2026-07-05-planner-design.md)에 남아 있다. §2 비목표("캘린더·리마인드 등 일정관리는 만들지 않는다")가 현재 방침.
