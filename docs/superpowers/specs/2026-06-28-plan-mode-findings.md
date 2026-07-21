# plan 모드 스파이크 findings (2026-06-28)

> Task 7. SDK 타입(sdk.d.ts) + 공식 문서 1차 조사. **실제 query 구동은 미실시(아래 권고).**

## SDK 동작 (sdk.d.ts:1701, 2045 + 문서)

1. **도구 실행**: plan 모드 = "no actual tool execution". 읽기 도구(Read/Glob/Grep)는 실행, **파일 수정·쓰기 Bash는 보류** → `canUseTool` 콜백으로 라우팅(allow rule 매칭돼도 plan에선 자동승인 안 됨).
2. **계획 감지(핵심)**: 모델이 계획을 완성하면 **`ExitPlanMode` 도구를 호출** → `canUseTool(name='ExitPlanMode', input)`로 들어온다. 이게 "계획 제시" 신호. (input에 계획 텍스트가 실리는지는 **실측 필요** — 문서 미명시.)
3. **canUseTool**: ExitPlanMode를 `{behavior:'allow'}` 또는 `{behavior:'deny', message}`로 응답. deny면 모델이 계획 수정 재시도.
4. **수락→실행 전환(핵심·불확실)**: 표준 패턴 문서에 **명시 없음**. 후보 ① `query.setPermissionMode('acceptEdits')` mid-session ② sessionId를 `acceptEdits`로 resume + "계획 실행". ⚠️ **알려진 버그**: ExitPlanMode allow해도 plan 모드가 제대로 안 끝나는 케이스(GH #15755), reject 시 모델이 막힘(#26930).
5. **streaming input**: 불필요. 단발 prompt + canUseTool로 충분.

## 레인 배선에 필요한 것 (예상 작업량)

- `managerAgentOptions`에서 `'plan'` 폴백 제거 → SDK `permissionMode:'plan'` 직결.
- 레인 `canUseTool`에 **ExitPlanMode 감지** 분기 추가(현재는 시크릿 차단만) → 계획을 채팅에 표시.
- **계획 표시 + 승인 UI**(채팅 인라인 카드, `ask_user` 패턴 재사용 가능) → 승인 시 실행 전환.
- **실행 전환**: lain은 세션 resume을 이미 광범위하게 쓰므로 ②(sessionId acceptEdits resume)가 패턴에 맞음. 단 ExitPlanMode allow 후 동작은 **실측 확인 필수**.
- InputModeBar 권한 셀렉트에 '계획' 추가.

## 리스크 / 권고

- **불확실성**: 수락→실행 전환이 SDK 문서 불완전 + 버그 이슈. **실제 query 구동 실측 없이는 배선 확신 불가**.
- **작업량**: canUseTool 분기 + 계획 표시/승인 UI + resume 전환 — Phase A의 단순 옵션 추가보다 큼.
- **권고**: ① 실제 구동 스파이크(dev 훅 또는 독립 스크립트로 `permissionMode:'plan'` 1턴, ExitPlanMode input·전환 동작 로그)로 확증 → 배선. 또는 ② plan 보류(권한 3단으로 두고 후속). 둘 중 사용자 판단 필요.

## ✅ 실측 결과 (2026-06-28, 독립 스크립트 plan-spike.mjs 실제 구동)

`permissionMode:'plan'` + 모든 도구 allow 콜백으로 파일 수정 요청 1턴 실행. 관찰:

1. **읽기 도구 실행**: Glob·Read·Bash(읽기)가 돌고, 모델이 파일 파악.
2. **계획 파일 자동 작성**: `~/.claude/plans/<slug>.md`에 계획을 Write(canUseTool 안 거침 — plan 모드 내부 허용).
3. **ExitPlanMode에 계획 전문 포함(핵심·문서와 다름)**: `canUseTool('ExitPlanMode', { plan: '<계획 마크다운 전문>', planFilePath: '...' })`. → **input.plan을 그대로 사용자에게 보여주면 된다**(별도 파일 읽기 불필요).
4. **allow → 자동 실행 전환(핵심)**: ExitPlanMode를 `{behavior:'allow'}` 하니 **같은 query 스트림 안에서** 모델이 곧바로 Write/Edit를 실행 → 파일이 실제로 `world`로 바뀜. **setPermissionMode/resume 불필요.** (claude-code-guide가 불확실하다던 전환이 이걸로 해소.)
5. **deny 시**: (미실측이나 문서대로) 모델이 계획 수정 재시도 예상.

### 배선 결론 (Task 8)

- `managerAgentOptions`: `managerPermissionMode==='plan'`이면 SDK `'plan'` 직결(폴백 제거).
- 레인 `canUseTool`: `name==='ExitPlanMode'` 감지 → `input.plan`을 채팅 카드로 표시 + **사용자 승인까지 블록**(ask_user 동형 패턴) → 승인=`allow`(그 즉시 실행 전환), 거부=`deny`(계획 수정).
- 세션 resume·setPermissionMode 배선 **불필요** — canUseTool 블로킹 하나로 끝.
- UI: InputModeBar 권한 셀렉트에 '계획' 추가 + 계획 카드 렌더(ask_user 카드 재사용 검토).
