# 2026-07-07 전방위 UX·오케스트레이터 감사 — 실행 추적 문서

> 출처: ultracode 워크플로 감사(에이전트 7, 6각도: chat-ux·app-ux·visualization·orchestrator·public-readiness·cc-parity + 완결성 비평). 75건 → 중복 병합 후 **69건**.
> 근거의 파일:줄 번호는 **감사 시점(커밋 `be1725e`, 2026-07-07) 기준** — 구현 전 반드시 현재 코드로 재확인할 것.
>
> **실행 규칙**: 항목 완료 시 `[x]` 체크. 각 항목은 근거 코드 확인 → 구현 → `npm run typecheck` + 테스트 → 체크 순. IPC 추가 시 ipc.ts+preload/index.ts+shared/types.ts 3곳 동기화(CLAUDE.md). src/** 변경 세션은 `npm run deploy`로 마감.

## 실행 순서 (권장 6단계)

| 단계 | 내용 | 항목 |
|---|---|---|
| **1. 퀵윈** | S급 전부 — 며칠 내 체감 반전 | A2 A3 A5 A7 A11 A14 A16 A17 A18 · B1 B2 B3 B6 B7 B8 B12 B13 B14 B15 B16 · C2 C5 C8 C10 · D3 D4 D5 D10 D11 · E1 E3 E4 E7 E9 E10 |
| **2. 채팅 개편** | CC급 채팅 (M급) | A1 A4 A6 A8 A9 A10 A12 A13 A15 |
| **3. 사용감·시각화** | M급 | B4 B5 B9 B10 B11 · C1 C3 C4 C6 C7 C9 |
| **4. 오케스트레이터 1단계** | 큐·정책·plan 배선 | D1 D6 D7 D8 D9 D12 |
| **5. 공개 준비** | M급 | E2 E5 E6 E8 |
| **6. 오케스트레이터 2단계** | L급 — **착수 전 별도 설계 세션 필수** | D2 D13 D14 D15 |

## A. 채팅 — Claude Code 패리티

- [ ] **A1. 마크다운 렌더링이 코드펜스·인라인 코드뿐 — 볼드·헤딩·리스트·테이블이 전부 평문 노출** `상·M`
  - 현재: src/renderer/lib/markdown.tsx(108줄 전체)의 MessageBody는 코드펜스(```)·인라인 백틱·diff 줄배경만 처리한다(1행 주석에 '경량 렌더…외부 의존 0' 명시). renderText(76-91행)는 인라인 코드 분리와 검색 하이라이트만 하므로 **볼드**, ## 헤딩, - 리스트, 표, > 인용은 별표·샵 기호가 그대로 화면에 찍힌다. 레인이 마크다운으로 답하면 raw 텍스트로 보인다.
  - 개선: MessageBody에 블록 파서를 추가해 볼드/이탤릭·헤딩·순서/비순서 리스트·인용(>)·수평선·표를 렌더한다. 외부 의존 0 원칙을 유지하려면 기존 FENCE 분리 구조 위에 줄 단위 경량 파서를 얹으면 되고, 아니면 react-markdown 채택. 검색 하이라이트(query)는 텍스트 노드에만 적용하는 현 구조 유지.
  - 근거: src/renderer/lib/markdown.tsx
- [ ] **A2. 레인 응답 중 도구 활동이 실시간으로 안 보임 — 긴 턴 동안 깜빡이는 ▋ 커서뿐** `상·S`
  - 현재: main(manager.ts 2040-2051행)은 tool_use마다 'Read 경로', '$ 명령' 형식 회색 라인을 relay하지만, 렌더러(App.tsx 421-425행)가 이를 의도적으로 무시한다('매니저 라이브 tool 라인은 채팅에 즉시 표시하지 않는다 — result 후 DB 재로드로 노출' 주석). busy 표시는 ChatPanel.tsx 207-212행의 깜빡이는 ▋ 하나. 레인이 수십 개 도구를 도는 몇 분짜리 턴 동안 사용자는 뭘 하는지 전혀 볼 수 없다. Claude Code는 도구별 축약 라인+스피너를 실시간 표시한다. (Navi 직통 채팅은 tool 라인을 라이브 표시함 — App.tsx 471-483행, 비대칭.)
  - 개선: 이미 도착하는 kind:'tool' 이벤트를 버리지 말고 busy 버블 자리에 '현재 도구 라인'(마지막 1줄 또는 최근 N줄 접이식)으로 라이브 표시한다. result 시 DB 재로드가 실 행으로 대체하는 기존 흐름은 그대로 두면 중복 없음. 경과 시간(n초)을 곁들이면 Claude Code 스피너와 동급.
  - 근거: src/renderer/App.tsx:421-425, src/renderer/components/ChatPanel.tsx:207-212, src/main/manager.ts:2040-2051
- [ ] **A3. URL·파일 경로가 클릭 안 됨 — 링크화 자체가 없다** `상·S`
  - 현재: markdown.tsx renderText는 인라인 코드와 검색 하이라이트만 만들 뿐 <a> 생성이 없고, renderer 전체에서 openExternal/openPath 호출이 전무하다(grep 결과 PlannerPanel.tsx 591행의 <a> 하나뿐 — 채팅과 무관). 레인이 'src/main/ipc.ts:120 봐' 또는 URL을 답해도 사용자가 직접 복사해 열어야 한다. Claude Code(데스크톱)는 경로 클릭→에디터 열기, URL 클릭→브라우저를 지원한다.
  - 개선: renderText에서 URL 정규식과 파일 경로 패턴(백틱 안 경로 포함, `경로:줄번호`)을 감지해 클릭 가능한 span으로 렌더. URL은 shell.openExternal, 파일은 shell.showItemInFolder 또는 설정된 에디터로 열기 IPC(ipc.ts+preload+types.ts 3곳 동기화) 추가. 인라인 코드로 감싼 경로가 많으니 msg-inline-code에 경로 감지 시 클릭 핸들러만 달아도 체감이 크다.
  - 근거: src/renderer/lib/markdown.tsx:76-91, src/renderer/components/PlannerPanel.tsx:591
- [ ] **A4. TodoWrite 진행 체크리스트가 어디에도 렌더되지 않음 — 장시간 작업 관찰성 공백** `상·M`
  - 현재: Claude Code는 에이전트의 TodoWrite 체크리스트를 실시간 진행표로 렌더하지만, lain은 src 전체에 TodoWrite 처리 코드가 없다(grep 0건 — 플래너의 별개 todo만 존재). 레인 채팅은 formatToolUse(src/main/manager.ts:1224-1245)의 default 분기로 도구 이름만 한 줄 출력하고, Navi 작업은 worker.ts:572에서 input JSON을 120자로 잘라 회색 로그로만 남긴다. TaskDrawer의 이벤트 스트림(TaskDrawer.tsx:514-527)도 평면 로그라 '지금 몇 단계 중 몇 번째인지'를 알 수 없다.
  - 개선: worker.ts/manager.ts의 tool_use 스트림에서 TodoWrite input(todos 배열)을 파싱해 구조화 이벤트(kind='todo')로 영속·emit하고, TaskDrawer 상단에 체크리스트 위젯(✓ 완료/▸ 진행 중/○ 대기 + n/m 카운터), NaviTile에 진행률, 레인 채팅에는 접이식 진행 칩으로 렌더한다. 오케스트레이터는 '여러 Navi가 지금 어디까지 왔나'가 핵심 가치라 체감 효과가 가장 크다.
  - 근거: src/main/worker.ts:572, src/main/manager.ts:1224-1245, src/renderer/components/TaskDrawer.tsx:514-527
- [ ] **A5. 컨텍스트 잔량·비용 표시 없음 — 무한세션인데 compact 임박을 알 수 없다** `중·S`
  - 현재: 표시는 '오늘 N tok' 누계뿐(App.tsx 1121·1509·1713행, tokensUsed+taskTokens). ChatEvent result에 costUsd가 이미 실려 오지만(shared/types.ts 407행, manager.ts 2075행) 렌더러는 ev.tokens만 쓰고 costUsd를 버린다(App.tsx 427행). 컨텍스트 윈도 사용률(%)·compact까지 남은 여유는 어디에도 없다 — compact 발생 후에야 tool 라인으로 흔적이 남는다(manager.ts 1792행). Claude Code는 context left %와 세션 비용을 상시 표시한다. InputModeBar 189행의 사용량 orb는 '사용량 (곧)' 플레이스홀더.
  - 개선: 이미 오는 costUsd를 누적해 '오늘 N tok · $X.XX'로 확장하고, 무한세션 최근 usage(입력 토큰)를 컨텍스트 한도 대비 % 게이지로 InputModeBar의 orb 자리에 렌더. compact 임계 접근 시 색 경고. 데이터가 이미 파이프라인에 있어 renderer 표시 작업이 대부분.
  - 근거: src/renderer/App.tsx:427,1121, src/shared/types.ts:407, src/renderer/components/InputModeBar.tsx:189
  - (병합) **컨텍스트 사용량 게이지가 플레이스홀더로 방치 — 데이터는 이미 다 있음**: orb를 실제 게이지로 배선: getConversationContextTokens/임계값 비율을 IPC로 노출해 채움 링+퍼센트로 표시하고, 임계 근접 시 색 경고. 클릭 메뉴 또는 /compact 슬래시로 sendToManager의 기존 압축 경로(summarizeWorldState→세션 교체)를 즉시 수동 실행. 데이터·압축 로직이 전부 있어서 배선만 하면 된다 — '언제 기억이 잘리나'를 사용자가 예측할 수 있게 된다. — 근거: src/renderer/components/InputModeBar.tsx:189, src/main/manager.ts:1773-1802,2072, src/renderer/components/SlashMenu.tsx:13-24
- [ ] **A6. 레인의 직접 파일 편집에 diff 미리보기가 없음 — 실제 레포를 무확인 수정** `상·M`
  - 현재: Claude Code는 Edit마다 인라인 diff를 보여주고 default 모드에선 승인을 받는다. lain의 레인은 등록된 모든 레포를 additionalDirectories로 직접 수정하는데(manager.ts:1934), canUseTool은 시크릿·시스템 파괴·ExitPlanMode 외엔 전부 자동 allow(manager.ts:2016)이고 채팅에는 'Edit <경로>' 한 줄만 남는다(manager.ts:1231-1235). Navi 작업은 worktree 격리+TaskDrawer diff 뷰(TaskDrawer.tsx:169-229)가 있지만, 레인 직접 편집은 격리도 diff도 없어 무엇이 어떻게 바뀌었는지 볼 수단이 없다.
  - 개선: Edit input에 이미 old_string/new_string이 있으므로 tool 이벤트에 diff를 동봉해 ChatPanel에서 접이식 diff로 렌더한다(TaskDrawer의 diff-add/del 스타일 재사용). 나아가 managerPermissionMode='default'일 때는 ExitPlanMode 카드(manager.ts:1992-2015)와 동형으로 편집 승인 카드를 띄우면 Claude Code 패리티가 완성된다 — 레인이 실레포를 만지는 구조라 glass-box 가치가 크다.
  - 근거: src/main/manager.ts:1231-1235,1934,1944-2016, src/renderer/components/TaskDrawer.tsx:169-229
  - (병합) **Edit/Write 도구의 diff 뷰어 없음 — 뭘 고쳤는지 한 줄 요약뿐**: tool_use input에 old_string/new_string이 이미 들어 있으니(Edit), main에서 요약 라인 대신 구조화 payload(파일·old·new 축약)를 이벤트에 실어 renderer가 접이식 diff 카드로 렌더한다. 기존 diff-add/diff-del 스타일 재사용 가능. 승인 카드(NaviChatPanel ApprovalCard)에도 같은 diff를 붙이면 승인 판단 품질이 올라간다. — 근거: src/main/manager.ts:1224-1245, src/main/navichat.ts:66-85, src/renderer/lib/markdown.tsx:45-69
- [ ] **A7. 레인의 도구 '호출'만 기록되고 '결과(성공/실패)'는 어디에도 없음 — '했다'는 주장을 검증할 수단 부재** `상·S`
  - 현재: manager.ts 스트림 루프는 tool_use 블록을 formatToolUse로 한 줄 저장·relay(manager.ts:2041-2052)하지만 tool_result(is_error 포함)는 전혀 파싱하지 않는다 — tool_result 파싱은 worker.ts(199-208)에만 있고 그것도 spec-gaming 감지용이다. 화면에는 '🔧 Edit(...)' 호출 라인만 남고 그 Edit이 실패했는지, start_task가 거절됐는지는 DB에도 UI에도 흔적이 없다. 레인이 실레포를 직접 수정하고 작업을 지휘하는 구조에서, 레인이 '수정했다/시작해뒀다'고 말한 것이 실제 실패였을 때 사용자가 대화창만으로 알아챌 방법이 없다(glass-box 원칙과 정면 배치).
  - 개선: manager 스트림의 user(tool_result) 메시지를 파싱(worker.ts extractToolResults 패턴 재사용)해, is_error인 결과는 해당 tool 라인 뒤에 '→ ✗ <에러 요약>' tool 메시지를 영속·relay하고 성공은 침묵(노이즈 방지)한다. 턴 종료 시 실패 건수가 있으면 result 이벤트에 failedTools 카운트를 실어 채팅 하단에 '이번 턴 도구 실패 N건' 배지를 띄운다.
  - 근거: src/main/manager.ts:2038-2066, src/main/worker.ts:199-208
- [ ] **A8. 코드블록 구문 강조 없음 — 언어 태그를 떼서 버린다** `중·M`
  - 현재: markdown.tsx 99-104행이 펜스의 언어 태그(```ts 등)를 정규식으로 제거만 하고 어디에도 안 쓴다. CodeBlock(43-73행)은 단색 <pre><code>이며 diff 줄배경만 예외. highlight.tsx는 이름과 달리 검색어 <mark> 처리용이지 구문 강조가 아니다. Claude Code는 언어별 컬러 하이라이팅을 제공한다.
  - 개선: 펜스 언어 태그를 CodeBlock에 전달하고 경량 하이라이터를 붙인다. 외부 의존 0을 유지하려면 주요 언어(ts/js/py/json/bash) 키워드·문자열·주석 3분류 정도의 자체 토크나이저로도 체감이 크고, 아니면 highlight.js 일부 언어만 번들. CRT 그린 테마 변수(var(--…))로 색을 잡아 톤 유지.
  - 근거: src/renderer/lib/markdown.tsx:43-73,99-104, src/renderer/components/highlight.tsx
- [ ] **A9. Navi 직통 채팅에 스트리밍이 없음 — 응답이 통짜로 한 번에 떨어짐** `중·M`
  - 현재: 레인 채팅은 assistant_delta 라이브 버블이 있으나(App.tsx 362-383행), Navi 직통 채팅 이벤트 처리(App.tsx 464-513행)는 assistant/tool/result/error만 있고 delta가 없다. src/main/navichat.ts에도 includePartialMessages/stream_event가 전무(grep 0건). 긴 Navi 답변은 완성될 때까지 ▋만 깜빡이다 한 덩어리로 나타난다.
  - 개선: navichat.ts의 query()에 includePartialMessages를 켜고 최상위 텍스트 증분을 NaviChatEvent에 'assistant_delta'로 추가(shared/types.ts 계약 갱신), App.tsx의 매니저 streamingRef 패턴을 Navi 쪽에도 복제한다. 매니저 구현이 이미 검증된 선례라 이식 작업.
  - 근거: src/renderer/App.tsx:464-513, src/main/navichat.ts
  - (병합) **Navi 직접 채팅에 토큰 스트리밍 없음 — 레인 채팅과 체감 격차**: navichat.ts query에 includePartialMessages를 켜고 text_delta를 NaviChatEvent('assistant_delta' kind 추가)로 흘려, NaviChatPanel에 레인과 동일한 라이브 버블을 붙인다. 레인 쪽 구현(스트리밍+최종 assistant 확정 패턴)을 그대로 이식하면 된다. — 근거: src/main/navichat.ts, src/main/manager.ts:1928,2035, src/renderer/components/NaviChatPanel.tsx:159-164
- [ ] **A10. Navi 직접 채팅은 응답 중 입력이 거절됨 — 레인에만 있는 메시지 큐** `중·M`
  - 현재: 레인 채팅은 응답 중 입력을 대기열에 쌓고(App.tsx:855-874, 플레이스홀더에 '큐 N' 표시) ⏳ 태그+✕ 취소까지 지원한다(ChatPanel.tsx:186-201). 작업 중 Navi 인터럽트도 된다(navichat.ts:128-136 §5.7). 그러나 Navi 직접 채팅이 '채팅 응답 중'일 때는 큐잉 없이 '이 Navi가 이전 메시지를 처리 중이다'로 거절된다(navichat.ts:171) — 주석에도 '하단 레인 전용 큐'로 명시(App.tsx:855).
  - 개선: 드릴(Navi 워크스페이스) 입력에도 프로젝트별 로컬 큐를 붙인다: busy면 낙관 표시+큐 적재, result 수신 시 자동 전송, 레인과 동일한 ⏳/✕ UI. App.tsx의 기존 큐 로직을 naviId 키 맵으로 일반화하면 된다. Claude Code의 '작업 중 입력 대기열' 패리티.
  - 근거: src/main/navichat.ts:171, src/renderer/App.tsx:855-874, src/renderer/components/ChatPanel.tsx:186-201
- [ ] **A11. Navi 직통 채팅에 대화 내 검색이 없음 — 패널은 지원하는데 UI가 막혀 있다** `중·S`
  - 현재: 검색바는 레인 채팅에만 렌더된다(App.tsx 1960행 'searchOpen && chatTarget !== @all', 611행 주석 '드릴 중엔 열어도 아무것도 안 뜬다 → 가드'). NaviChatPanel은 query/activeHitId props와 하이라이트를 이미 지원하지만 호출부(App.tsx 1785-1786행)가 query="" activeHitId={null}로 하드코딩. Navi와 긴 작업 대화를 나눈 뒤 과거 내용을 찾을 방법이 스크롤뿐이다.
  - 개선: 레인 채팅의 검색바 JSX·searchHits 로직(App.tsx 1080-1094행 searchHitIds 재사용)을 드릴 뷰에도 렌더하고 naviMsgs를 대상으로 연결한다. 패널 쪽 수용부가 완성돼 있어 App.tsx 배선만 하면 됨.
  - 근거: src/renderer/App.tsx:611,1779-1787,1960, src/renderer/components/NaviChatPanel.tsx:27-28
- [ ] **A12. @파일 자동완성 없음 — 프로젝트 파일을 대화에 참조하려면 파일피커·드래그뿐** `중·M`
  - 현재: 자동완성은 '/' 슬래시 명령 10개가 전부(SlashMenu.tsx 13-24행, App.tsx 1219행 — '/'로 시작할 때만 팝업). Claude Code의 @파일명 fuzzy 완성(입력 중 프로젝트 파일 검색→경로 삽입)이 없어, 파일을 언급하려면 경로를 손으로 치거나 +메뉴/드래그로 통째 첨부해야 한다. Navi 입력창은 슬래시조차 없다(App.tsx 1322행 주석 '슬래시·검색 없음').
  - 개선: 입력 중 '@' 감지 시 SlashMenu와 같은 팝업으로 파일명 fuzzy 매칭(레인 채팅=등록 프로젝트 전체, Navi 드릴=해당 프로젝트 cwd). main에 파일 목록 IPC(레지스트리 cwd 기준 glob, .gitignore 존중) 추가. 선택 시 상대경로 텍스트 삽입 — 레인/Navi가 경로를 읽고 스스로 Read하므로 첨부 변환 불필요.
  - 근거: src/renderer/components/SlashMenu.tsx:13-24, src/renderer/App.tsx:1219,1322
- [ ] **A13. 메시지 편집·재전송 없음 — 오타 하나 고치려면 전체를 다시 타이핑** `중·M`
  - 현재: 우클릭 메뉴(App.tsx 790-800행)는 '메시지 복사·컨텍스트로 첨부·인용해서 답장·챕터 고정' 4개뿐. 직전 user 메시지를 수정해 재전송하는 경로가 없다(↑ 히스토리 회상으로 텍스트를 불러올 수는 있으나 이전 대화 흐름은 그대로 남음). Claude Code의 더블 Esc 되감기(메시지 선택→수정→그 지점부터 재실행) 같은 체크포인트/포크도 없다 — 레인 리셋(App.tsx 1660-1675행)은 세션 전체 초기화뿐.
  - 개선: 1단계(S): 우클릭에 '수정해서 재전송' 추가 — user 메시지를 입력창에 채우고 포커스(quoteReply 패턴 재사용). 2단계(M): 무한세션 특성상 완전 되감기는 어렵지만, 마지막 턴 한정 '이 답변 다시'(직전 user 재전송+이전 assistant 흐리게 표시)는 가능. 무한세션 구조(월드스테이트 누적)와의 정합은 PLAN.md 검토 필요.
  - 근거: src/renderer/App.tsx:790-800,1660-1675
- [ ] **A14. Esc로 응답 정지 불가 — 정지는 마우스로 ■ 버튼뿐** `하·S`
  - 현재: 정지는 입력창 옆 ■ 버튼(App.tsx 2162-2175행, haltAndClearQueue+stopChat)만. 전역 Esc 핸들러(App.tsx 572-600행)는 오버레이 닫기 전용이고, 나머지 Escape 처리 두 곳(1254행 슬래시 팝업, 1978행 검색바)도 닫기뿐 — 키보드로 진행 중 응답을 끊을 수 없다. Claude Code는 Esc 한 번으로 턴을 중단한다.
  - 개선: 전역 Esc 체인(572행) 최후순위에 'managerBusy면 haltAndClearQueue()+window.lain.stopChat()' 분기 추가(오버레이·검색·슬래시가 다 닫힌 상태에서만). 드릴 뷰에선 해당 Navi stopNaviChat 매핑. 기존 정지 로직 재사용이라 몇 줄 수준.
  - 근거: src/renderer/App.tsx:572-600,2162-2175
  - (병합) **Esc로 응답 정지 불가 — 정지가 마우스 전용**: 전역 keydown에서 managerBusy(또는 드릴 중 naviBusy)이고 열린 오버레이가 없으면 Esc가 haltAndClearQueue()+stopChat()(드릴이면 stopNaviChat)을 호출하게 한다. 기존 Esc 체인의 맨 뒤에 분기 하나 추가로 끝난다. — 근거: src/renderer/App.tsx:571-592,2162-2175, src/main/manager.ts:279-308
- [ ] **A15. 지난 대화가 UI에서 접근 불가 — 최근 200개 로드 한정, 위로 스크롤 페이징도 DB 전문 검색 UI도 없음** `중·M`
  - 현재: PC 채팅은 conversations:messages가 limit 인자 없이 listConversationMessages 기본 200개만 반환(ipc.ts:408-410, store.ts:1383)하고, 렌더러엔 offset 파라미터도 '위로 스크롤해 더 불러오기'도 없다. Ctrl+F 검색(searchHitIds, chat.ts:38-42)은 이미 로드된 배열의 substring 매치라 200개 밖 과거 대화는 검색조차 안 된다. 정작 DB 전문 검색 searchChatHistory(store.ts:2106)는 존재하는데 텔레그램 /search(telegram.ts:747)와 레인의 도구(manager.ts:1192)에만 연결돼 있고 PC UI에는 미노출 — 폰에서는 되는 과거 검색이 PC에서는 안 되는 역전 상태다.
  - 개선: ① conversations:messages에 beforeId/limit 파라미터를 추가하고, 채팅 스크롤 최상단 도달 시 이전 페이지를 prepend하는 '이전 대화 불러오기'를 단다(스크롤 위치 보존). ② Ctrl+F 검색바에 '전체 기간' 토글을 추가해 searchChatHistory IPC(신규 1개)로 DB 전문 검색 결과를 띄우고, 히트 클릭 시 해당 구간을 로드해 점프한다.
  - 근거: src/main/ipc.ts:408-410, src/main/store.ts:1383-1391·2106, src/renderer/lib/chat.ts:38-42, src/main/telegram.ts:747
- [ ] **A16. 대화 내보내기·공유 수단이 메시지 1건 복사뿐 — 대화/구간 단위 저장 불가** `중·S`
  - 현재: 채팅 우클릭 메뉴는 '메시지 복사'(단건, App.tsx:792)·컨텍스트 첨부·인용·챕터 고정 4종이 전부고, 대화 전체나 선택 구간을 markdown/텍스트로 내보내는 기능이 렌더러·ipc 어디에도 없다(ipc.ts에 export/saveDialog 관련 채널 0건). 레인과 논의한 설계 결정이나 작업 지시 이력을 다른 곳(이슈·문서·동료)에 옮기려면 메시지를 하나씩 복사해 수동 조립해야 한다. 후보 목록의 '데이터 백업(DB zip)'과는 다른 문제 — 이것은 사람이 읽을 대화 산출물의 공유다.
  - 개선: ① 우클릭에 '여기까지 복사'(해당 메시지까지 화면 로드분을 'User:/Lain:' 접두 markdown으로 클립보드) 추가 — copyText IPC 재사용으로 반나절. ② 세션 목록/헤더 메뉴에 '대화 내보내기(.md)' — listConversationMessages 전체를 파일로 저장(showSaveDialog IPC 1개). 챕터(m.chapter)를 헤딩으로 살리면 정리된 문서가 된다.
  - 근거: src/renderer/App.tsx:790-800, src/main/ipc.ts(내보내기 채널 부재), src/main/store.ts:1383
- [ ] **A17. 긴 출력 접기 없음 + 도구 라인이 잘린 채 복구 불가** `하·S`
  - 현재: 긴 코드블록·긴 답변이 전부 펼쳐진 채 쌓인다(markdown.tsx CodeBlock에 max-height/접기 없음). 도구 명령은 main에서 잘라 저장한다 — navichat.ts 78행 command 60자, manager.ts 1238행 160자 slice — 원문이 DB에도 없어서 나중에 펼쳐볼 방법 자체가 없다. Claude Code는 긴 도구 출력을 축약하고 ctrl+o로 확장한다.
  - 개선: ① CodeBlock에 N줄 초과 시 접기(펼치기 토글, 복사 버튼은 전체 코드 유지 — 이미 code 전문을 가짐). ② 도구 라인은 표시용 축약과 별개로 원문(또는 512자 정도)을 저장하고 클릭 시 전개. tool 메시지 role은 이미 분리돼 있어 스타일 추가만.
  - 근거: src/renderer/lib/markdown.tsx:43-73, src/main/navichat.ts:78, src/main/manager.ts:1238
- [ ] **A18. 레인 채팅에서 서브에이전트/백그라운드 태스크가 안 보임 — worker에만 구현됨** `하·S`
  - 현재: Navi 작업 스트림은 task_started/task_notification/task_progress system 메시지를 ⑂ 칩으로 가시화한다(worker.ts:752-765, TaskDrawer KIND_PREFIX '⑂'). 그러나 레인 본체 스트림 루프는 system 메시지 중 init만 처리해(manager.ts:2026-2028) 레인이 Workflow/Agent 도구로 띄운 서브에이전트·백그라운드 작업의 진행이 채팅에 전혀 안 뜬다 — 서브에이전트 텍스트도 parent_tool_use_id 필터로 제외(manager.ts:2032). Claude Code는 백그라운드 태스크 상태 칩을 상시 노출한다.
  - 개선: worker.ts의 task_* subtype 처리 블록을 manager 스트림 루프에 미러해 '⑂ 시작/진행/완료' tool 라인으로 relay하고, ChatPanel에서 진행 중 태스크를 칩으로 묶어 표시한다. 레인이 에이전트를 부리는 동안의 침묵 구간이 사라진다.
  - 근거: src/main/manager.ts:2026-2037, src/main/worker.ts:752-765

## B. 기본 사용감 — 엉성함 제거

- [ ] **B1. 결재 '폐기'가 확인 없이 원클릭으로 실행되는 비가역 파괴 동작** `상·S`
  - 현재: AttentionInbox.tsx:249-251과 TaskDrawer.tsx:487-489의 '폐기' 버튼이 클릭 즉시 window.lain.resolveReview(id,'discard')를 호출한다. 확인 다이얼로그가 전혀 없고, '병합'·'브랜치' 버튼 바로 옆에 붙어 있다. AttentionInbox.tsx:217 주석 스스로 "비가역 폐기(discard)는 키보드에서 제외(오발동 방지)"라고 인정하면서 마우스 클릭은 무방비다. 반면 내비 제거는 App.tsx:2242-2264에 커스텀 확인창(pendingRemove)이 이미 있다.
  - 개선: 폐기 클릭 시 기존 confirm-window 패턴(App.tsx pendingRemove)을 재사용해 '이 작업의 브랜치·변경사항을 폐기할까? 되돌릴 수 없다' 확인창을 띄운다. 작업 제목·diffStat 요약을 같이 보여주면 오클릭 피해를 원천 차단한다.
  - 근거: src/renderer/components/AttentionInbox.tsx:249, src/renderer/components/TaskDrawer.tsx:487, src/renderer/App.tsx:2242
- [ ] **B2. 작업 콘솔(TaskDrawer) 로그가 스크롤 위치를 무시하고 매번 바닥으로 강제 이동** `상·S`
  - 현재: TaskDrawer.tsx:269-271이 events.length가 바뀔 때마다 무조건 bottomRef.scrollIntoView를 호출한다. working/autonomous 작업은 이벤트를 대량 스트리밍하므로(App.tsx:323 주석, 상한 2000), 사용자가 위로 스크롤해 이전 로그를 읽는 중에도 계속 바닥으로 끌려 내려간다. ChatPanel.tsx:102는 '바닥 근처(<80px)일 때만 추종 + 점프 버튼' 스티키 로직을 이미 구현해 두었는데 TaskDrawer에는 적용돼 있지 않다.
  - 개선: ChatPanel의 near-bottom 추종 패턴을 TaskDrawer 로그에 이식한다: 스크롤이 바닥 근처일 때만 자동 추종, 위로 올라가 있으면 '↓ 최신' 점프 버튼 표시. 기존 코드 복제 수준이라 반나절 안에 끝난다.
  - 근거: src/renderer/components/TaskDrawer.tsx:269-271, src/renderer/components/ChatPanel.tsx:102-112
- [ ] **B3. 인박스가 새 항목 도착 시 답변 입력 중인 포커스를 강탈** `상·S`
  - 현재: AttentionInbox.tsx:264-268이 total(승인+질문+결재 합계)이 변할 때마다 첫 행에 무조건 focus()를 건다. 질문 답변(ir-ans input)을 타이핑하는 도중 다른 Navi의 승인이 도착하면 입력 포커스가 첫 행으로 튕겨 타이핑이 끊긴다. 한글 IME 조합 중이면 조합 중이던 글자도 깨진다. 여러 Navi가 동시에 도는 이 앱의 핵심 시나리오에서 재현 확률이 높다.
  - 개선: 포커스 이동 전에 document.activeElement가 INPUT/TEXTAREA(또는 인박스 내부 요소)인지 검사해, 사용자가 이미 상호작용 중이면 재포커스를 건너뛴다. 행이 '처리돼 사라진' 경우(total 감소)에만 다음 행으로 포커스를 옮기도록 조건을 좁힌다.
  - 근거: src/renderer/components/AttentionInbox.tsx:264-268
- [ ] **B4. 렌더러가 memo 0의 단일 거대 컴포넌트 — 키 입력·스트리밍 델타마다 채팅 800개+타일 전체 재렌더** `상·M`
  - 현재: App.tsx(2,271줄) 한 컴포넌트가 입력창(value={input}, App.tsx:2116)·메시지·프로젝트·작업 상태를 전부 들고 있고, 렌더러 전체에 React.memo가 한 건도 없다(grep 결과 useMemo 4곳뿐, memo() 0). 키 입력마다 setInput → App 전체 리렌더 → ChatPanel의 최대 800개(MAX_CHAT, App.tsx:81) 메시지가 MessageBody 마크다운 파싱(markdown.tsx:94-108, 정규식 split)을 매번 다시 수행하고 NaviTile 그리드·StageView도 함께 재렌더된다. 스트리밍 중에는 assistant_delta마다 messages 배열 전체를 map(App.tsx:369)해 같은 비용이 델타 빈도로 반복된다. 하드웨어 가속도 꺼져 있어(index.ts:68 disableHardwareAcceleration) 소프트웨어 렌더링 부담이 그대로 체감된다.
  - 개선: ① 메시지 행을 memo화된 MessageRow 컴포넌트로 추출(content·chapter·query 등 프리미티브 prop 비교) — 델타 중에도 마지막 1개만 리렌더되게. ② 입력창을 자체 state를 가진 하위 컴포넌트로 분리해 타이핑이 App 리렌더를 유발하지 않게 한다(전송 시에만 상위로 올림). ③ ChatPanel·NaviTile에 React.memo 적용. 상주 앱 특성상 긴 세션에서 타이핑 지연·스트리밍 버벅임이 눈에 띄게 줄어든다.
  - 근거: src/renderer/App.tsx:81-85·362-383·2116, src/renderer/lib/markdown.tsx:94-108, src/renderer/components/ChatPanel.tsx:36, src/main/index.ts:68
- [ ] **B5. ask_user 질문 카드가 PC 렌더러에만 존재 — 텔레그램 발화 턴은 영구 블록, 렌더러 리로드 시 질문 유실** `상·M`
  - 현재: manager.ts의 ask_user 도구는 rendererMirror({kind:'question'})로 PC 렌더러에만 카드를 띄우고 waitForUserAnswer(manager.ts:380)로 타임아웃 없이 대기한다. 텔레그램 routeToManager의 emit은 'assistant'/'error'만 처리(telegram.ts:640-646)해 'question' 이벤트가 폰에 전혀 전달되지 않는다 — 폰에서 시작한 턴에 레인이 ask_user를 부르면 typing 표시만 계속되고 답할 방법이 없다. 또 pendingQuestion은 렌더러 useState에만 존재(App.tsx:124, 재조회 IPC 없음)하고 질문은 답변 후에만 DB 저장(manager.ts:423)되므로, 렌더러 크래시 자동 reload(index.ts:127-135, 실제 반복 발생 이력) 시 카드가 사라져 그 턴이 영구 교착된다.
  - 개선: ① 텔레그램 미러: 'question' 이벤트를 기존 승인 푸시와 동일한 inline_keyboard(콜백 data에 questionId|보기 인덱스)로 폰에도 전송 — 승인 버튼 인프라(callback_data 라우팅) 재사용. ② main에 pendingQuestion을 보관하고 question:pending 조회 IPC 추가 — 렌더러 마운트 시 재요청해 리로드에도 카드 복원. ③ waitForUserAnswer에 설정 가능한 타임아웃(만료 시 '(응답 없음)'으로 resolve)을 달아 교착을 원천 차단.
  - 근거: src/main/manager.ts:380-431, src/main/telegram.ts:636-656, src/renderer/App.tsx:124·442, src/main/index.ts:127-135
- [ ] **B6. 음성 입력(PTT) 실패가 전부 무음 처리 — 말했는데 아무 일도 안 일어남** `중·S`
  - 현재: App.tsx:945-980의 PTT 경로에서 실패가 모두 조용히 삼켜진다: 1.5KB 미만 녹음 무시(948), 피크 진폭 0.045 미만 무음 게이트 드롭(965), STT 예외 catch 후 '/* STT 실패 무시 */'(971-973), 마이크 권한 거부도 setRecording(false)만(978-980). 사용자는 버튼을 누르고 말한 뒤 뗐는데 화면에 아무것도 안 나타나며, 원인(무음 판정인지, Groq 키 문제인지, 권한인지)을 알 방법이 없다.
  - 개선: 실패 분기마다 입력창 근처에 짧은 비차단 힌트를 띄운다: '너무 짧아/작게 들렸어 — 다시', 'STT 실패: <사유>', '마이크 권한이 거부됨 — 시스템 설정 확인'. 기존 채팅에 tool 라인을 낙관 추가하는 append 헬퍼를 재사용하면 신규 UI 없이 가능하다.
  - 근거: src/renderer/App.tsx:945-980
- [ ] **B7. 음성 답변(TTS)이 조건부 무음·무통보 목소리 변경 — 켜놨는데 왜 안 읽는지/왜 딴 목소리인지 알 수 없음** `중·S`
  - 현재: ① speech.ts spokenText(27-31): <<say:>> 태그가 없고 본문이 100자 초과면 빈 문자열을 반환 — 음성 토글을 켜도 그 응답은 아무 표시 없이 무음 스킵된다(레인이 태그를 빼먹으면 사용자는 고장으로 인식). ② tts.ts synthesizeBackend(105-108): gpt-sovits/supertonic 실패 시 catch 후 무통보로 edge 폴백 — 설정한 커스텀 보이스 대신 갑자기 SunHi 목소리가 나오는데 이유가 어디에도 안 뜬다('설정 표시=실제 일치' 원칙 위배). ③ 재생 중임을 나타내는 UI가 전무하고 정지 수단도 음성 토글 off가 유일(App.tsx:2146-2158) — 재생 전용 정지/다시 듣기 버튼 없음.
  - 개선: ① say 태그 부재+장문일 때 첫 문장(마침표 기준 ~100자)을 읽는 폴백을 spokenText에 추가. ② synthesizeBackend가 폴백 발생 여부를 반환하게 하고, 렌더러가 입력창 옆에 '⚠ 로컬 TTS 실패 — edge로 대체' 일시 힌트를 표시. ③ 재생 중 voiceout 버튼을 재생 표시(파형/점멸)로 바꾸고 클릭=현재 재생 정지(토글 유지), 메시지 우클릭에 '이 메시지 읽기'를 추가한다.
  - 근거: src/shared/speech.ts:26-31, src/main/tts.ts:78-109, src/renderer/App.tsx:398-419·2146-2158
- [ ] **B8. 창 크기·위치가 매번 초기화 + 오버레이가 주 모니터 고정 — 멀티모니터에서 매일 창 재배치** `중·S`
  - 현재: 메인 창은 매 실행 고정 1280x840·OS 기본 위치로 생성되고(index.ts:75-91) getBounds 저장/복원 코드가 index.ts에 전혀 없다 — 트레이 상주로 껐다 켜도(재시작·deploy·업데이트마다) 사용자가 키워둔 크기와 보조 모니터 배치가 초기화된다. 어깨너머 오버레이도 screen.getPrimaryDisplay() 하드코딩(overlay-window.ts:31·110)이라 사용자가 보조 모니터에서 작업 중이면 레인의 선제 발화 슬라이드가 안 보는 주 모니터에 뜬다.
  - 개선: ① close/resize 시 win.getBounds()를 settings에 저장하고 기동 시 복원(모니터 해제 대비 screen.getDisplayMatching으로 화면 밖 좌표 보정) — 상용 Electron 앱 표준 패턴. ② 오버레이는 screen.getDisplayNearestPoint(screen.getCursorScreenPoint())로 커서가 있는(=사용자가 보는) 디스플레이의 workArea에 띄운다.
  - 근거: src/main/index.ts:72-124, src/main/overlay-window.ts:31·110-114
- [ ] **B9. 네이티브 alert/confirm 혼용 — CRT 테마 이탈 + 대화 삭제는 undo 없는 하드 삭제** `중·M`
  - 현재: App.tsx:641이 작업 시작 실패를 OS 기본 alert()로, App.tsx:730(대화 삭제)·1666(Lain 세션 리셋)이 window.confirm()으로 처리한다. OS 네이티브 다이얼로그라 앱의 CRT 테마와 완전히 이질적이고 렌더러를 블로킹한다. 같은 앱 안에서 내비 제거만 커스텀 confirm-window(App.tsx:2242)를 쓰는 불일치. 대화 삭제는 확인 후 deleteConversation으로 즉시 하드 삭제되며 실행취소 수단이 없다.
  - 개선: ① alert/confirm 3곳을 기존 confirm-window 컴포넌트로 교체(재사용 가능한 useConfirm 훅으로 뽑으면 한 번에 정리). ② 대화 삭제는 소프트 삭제(deleted 플래그 + 5초 '실행취소' 토스트) 또는 최소한 삭제 대상 제목·메시지 수를 확인창에 표시.
  - 근거: src/renderer/App.tsx:641, src/renderer/App.tsx:730, src/renderer/App.tsx:1666, src/renderer/App.tsx:2242
- [ ] **B10. 키보드 단축키가 풍부한데 발견 수단이 0 — 단축키 도움말 부재** `중·M`
  - 현재: 구현된 단축키가 많다: Ctrl+K/P 팔레트(App.tsx:594-608), Ctrl+F 대화 검색(610-628), ↑/↓ 입력 히스토리(1263-1297), Esc 닫기 체인(572-592), 인박스 y/n/Enter 승인·거절(AttentionInbox.tsx:103-112), 결재 m/b(215-225). 그러나 이를 알려주는 UI가 어디에도 없다 — 팔레트 항목에 단축키 표기가 없고, 도움말 오버레이·치트시트·툴팁 언급도 없다. 인박스 y/n 같은 강력한 기능은 코드를 읽지 않으면 존재 자체를 모른다.
  - 개선: ① CommandPalette 항목 우측에 단축키 뱃지 추가(PaletteItem에 hotkey 필드). ② '?' 키(입력창 밖) 또는 팔레트의 '단축키 도움말' 항목으로 전체 단축키를 보여주는 오버레이 1장 추가. ③ 인박스 헤더에 'y 승인 · n 거절 · m 병합' 한 줄 힌트 표기.
  - 근거: src/renderer/App.tsx:594-628, src/renderer/components/AttentionInbox.tsx:103-112,215-225, src/renderer/components/CommandPalette.tsx
- [ ] **B11. 환경설정에 검색이 없고 항목 분류가 어긋남 — 원하는 설정 찾기 어려움** `중·M`
  - 현재: PrefsModal은 7개 카테고리(PrefsModal.tsx:20-28)에 약 60개 설정 행이 있지만 설정 검색 입력이 없다(파일 전체 확인). 분류도 어긋난 곳이 있다: '동시 작업 cap'(608-618)은 실행/자동화 설정인데 '모델' 카테고리에 있고, '플래너' 카테고리 안에 '── 플래너' 구분 헤더가 중복으로 남아 있다(784-786). 텔레그램 STT용 Groq 키는 '텔레그램' 카테고리에만 있어(1154-1166) PC 마이크 버튼이 요구하는 키(App.tsx:2135-2139)를 음성 카테고리에서 찾으면 못 찾는다.
  - 개선: ① 모달 상단에 설정명·힌트 텍스트를 대상으로 하는 검색 필드를 추가하고, 매치 시 카테고리를 자동 전환·하이라이트. ② '동시 작업 cap'을 자동화·고급으로 이동, 중복 헤더 제거, Groq 키를 음성·통화 카테고리에서도 링크(같은 설정 참조)로 노출.
  - 근거: src/renderer/components/PrefsModal.tsx:20-28,608-618,784,1154
- [ ] **B12. SCAN·REFRESH 실패가 조용히 사라짐 — catch 없는 try/finally** `중·S`
  - 현재: App.tsx:1031-1047의 refreshAll·scan이 try/finally로 refreshing만 원복하고 catch가 없다. IPC가 reject되면 unhandled rejection으로 사라지고 사용자에게는 버튼이 잠깐 비활성됐다 돌아올 뿐 실패 사실 자체가 보이지 않는다. 초기 로드의 listProjects·conversationMessages 등 다수의 .then() 체인(298-316)도 .catch 없이 실패 시 화면이 그냥 비어 보인다.
  - 개선: refreshAll/scan에 catch를 추가해 실패 시 채팅에 '[error] 현황 수집 실패: <사유>' tool 라인(기존 append 패턴)이나 헤더 옆 일시 배지로 표시. 초기 로드 체인에도 공통 catch를 달아 최소한 콘솔+화면 한 줄로 알린다.
  - 근거: src/renderer/App.tsx:1031-1047,298-316
- [ ] **B13. 내비 타일·세션 행이 키보드로 접근 불가 — 마우스 전용 핵심 표면** `중·S`
  - 현재: NaviTile.tsx:33-37의 타일은 onClick만 있는 div로 role·tabIndex·키 핸들러가 없어 Tab 포커스 자체가 불가능하다. SessionList.tsx:96-103의 세션 행은 role="button"은 있지만 tabIndex와 Enter 처리가 없어 스크린리더에 버튼이라고 알리면서 키보드로는 못 누른다. ContextMenu.tsx는 화살표 키 탐색이 없다(Esc만 처리, 46-62행). 반면 인박스 행(AttentionInbox.tsx:102)은 tabIndex=0 + 키 핸들러가 제대로 있어 앱 내 일관성도 깨진다. 전역 focus-visible 스타일은 이미 존재(styles.css:2019)해 포커스만 가능해지면 링은 공짜다.
  - 개선: NaviTile 루트에 role="button" tabIndex={0} + Enter/Space로 onFocus(p.id) 호출을 추가하고, SessionList 행에도 동일 처리. ContextMenu에 ↑↓/Enter 키 탐색을 추가하면 우클릭 메뉴도 키보드 완결된다.
  - 근거: src/renderer/components/NaviTile.tsx:33-37, src/renderer/components/SessionList.tsx:96-103, src/renderer/components/ContextMenu.tsx:46-62, src/renderer/styles.css:2019
- [ ] **B14. 텔레그램에서 보낸 사진·파일이 무반응으로 증발 — PC는 이미지 첨부를 지원하는데 폰만 막힘** `중·S`
  - 현재: telegram.ts handleMessage(560-565)는 m.text가 비면 voice/audio만 handleVoice로 넘기고 그 외(m.photo·m.document·caption 포함)는 조용히 return — 폰에서 스크린샷을 보내면 에러 안내조차 없이 무시된다. 반면 PC 쪽은 FileAttachment 파이프라인이 완비돼 있고(sendToManager attachments 인자, manager.ts:1626·1861에서 이미지 블록 변환) Ctrl+V 붙여넣기(App.tsx:1308)까지 지원한다. 인바운드 파일 다운로드 코드도 이미 존재한다(handleVoice의 getFile→fetch, telegram.ts:516-523). '자리 비웠을 때 폰으로 지휘'가 목적인 표면에서 '이 화면 봐줘'가 불가능하다.
  - 개선: handleMessage에 m.photo(최대 해상도 요소)·m.document 분기를 추가 — handleVoice의 getFile 다운로드 경로를 재사용해 base64 FileAttachment로 변환하고, m.caption(없으면 '이 이미지 봐줘')을 본문으로 routeToManager에 attachments와 함께 전달한다(sendToManager는 이미 attachments를 받음). 미지원 mime이면 '지원하지 않는 파일 형식' 회신으로 최소한 무시는 없앤다.
  - 근거: src/main/telegram.ts:559-565·505-557, src/main/manager.ts:1626·1861, src/renderer/App.tsx:1308
- [ ] **B15. 초기 로딩과 빈 상태 미구분 — 기존 사용자에게 '프로젝트 없음' 플래시** `하·S`
  - 현재: projects 초기값이 [](App.tsx:95)이고 사이드바는 projects.length===0이면 즉시 '등록된 프로젝트 없음 — SCAN…' 안내(1579-1590)를 그리므로, listProjects IPC가 돌아오기 전 매 기동마다 빈 상태 안내가 잠깐 번쩍인다. TaskDrawer의 이벤트 로그(515-528)도 taskEvents 로드 전이나 이벤트 0건일 때 아무 안내 없이 빈 공백이다. 로딩 표시가 있는 곳은 PrefsModal의 '로딩...'(591) 정도다.
  - 개선: projects를 null 초기값(미로드)으로 두고 null이면 아무것도(또는 은은한 로딩 라인) 렌더, []일 때만 빈 상태 안내를 보여준다. TaskDrawer 로그에도 '이벤트 로딩 중…' / '아직 이벤트 없음 — Navi 시작 대기' 빈 상태 한 줄을 추가한다.
  - 근거: src/renderer/App.tsx:95,1579-1590, src/renderer/components/TaskDrawer.tsx:515-528
- [ ] **B16. PrefsModal 인라인 하드코딩 색상 — amber/mono 테마에서 이질적** `하·S`
  - 현재: 앱은 CSS 변수 기반 3테마(wired/amber/mono, styles.css:134·148)를 지원하는데 PrefsModal은 구분선 '#1c3a2c'(208·418·784·1096행), 에러 '#f88'(354·476행), 성공 '#8f8'(476행)을 인라인 style로 박아 두었다. 테마를 amber/mono로 바꿔도 설정창의 이 부분만 wired 시절 녹색 계열로 남아 테마 전환이 반쪽이 된다.
  - 개선: 인라인 색을 CSS 변수(--border, --warn, --ok 등 기존 토큰)로 치환하고, 반복되는 '── 섹션 헤더' 인라인 스타일은 .settings-section-divider 클래스 하나로 뽑는다.
  - 근거: src/renderer/components/PrefsModal.tsx:208,354,418,476,784,1096, src/renderer/styles.css:134-148

## C. 시각화 — 수집만 하고 안 보여주는 데이터

- [ ] **C1. 작업 중인 내비 타일에 '무엇을 하는지'가 안 보임 — 작업 제목·경과시간·라이브 활동 부재** `상·M`
  - 현재: NaviTile.tsx:31의 meta 줄은 stack · gitBranch · '변경 N'만 표시하고, 진행 중 task가 있어도 상태 라벨('작업 중') 외엔 아무것도 안 보여준다. PLAN.md §12.3은 '현재 작업 한 줄 제목(예: OAuth 리팩터링)' 표시를 명시했으나 미구현. 데이터는 이미 있다: task.title·createdAt(경과시간, TaskDrawer.tsx:99 fmtElapsed는 드로어 전용), worker.ts:572가 도구 호출마다 tool 이벤트를 emit·영속하지만 App.tsx:322가 열려 있는 드로어의 taskId가 아니면 이벤트를 버려서 보드 레벨에선 라이브 활동이 전혀 안 보인다. 여러 Navi 동시 작업 시 드로어를 하나씩 열어봐야 각자 뭘 하는지 안다.
  - 개선: NaviTile에 진행 중 task가 있으면 meta 줄을 task.title로 교체하고 경과시간(fmtElapsed 재사용)·턴/토큰(task.turns·tokens 이미 renderer에 있음)을 병기. App에서 taskId별 마지막 tool/status 이벤트 한 줄을 Map으로 유지해(onTaskEvent에서 openTaskId 조건 제거, 타일용 최소 상태만 갱신) 타일 하단에 '▸ Edit routes.py' 식 라이브 한 줄을 흘려준다. 신규 IPC 불필요 — 기존 tasks:event 브로드캐스트 재사용.
  - 근거: src/renderer/components/NaviTile.tsx:31, src/renderer/App.tsx:322, src/main/worker.ts:572, PLAN.md §12.3
- [ ] **C2. project_status 수집 필드 대부분이 UI 미표시 — todoCount·lastCommit·ahead/behind(개별)·testOutputTail** `상·S`
  - 현재: collectors.ts가 프로젝트마다 todoCount(TODO/FIXME 합계, 51-57행), lastCommit/lastCommitAt(32-37행), ahead/behind(40-48행), testOutputTail(runVerify, 82-89행)을 수집해 project_status에 저장하지만 렌더러 grep 결과 사용처는 App.tsx:1063의 ahead 집계('미푸시 N' 카운트) 단 한 곳. 개별 프로젝트가 몇 커밋 안 푸시됐는지, 마지막 커밋이 언제인지(방치 감지), TODO가 몇 개인지, 검증 실패 시 출력 꼬리가 뭔지 모두 화면 어디에도 없다. §10.2 판단 요약(project_status.summary)도 Lain 다이제스트(manager.ts:219)에만 들어가고 사용자에겐 안 보인다.
  - 개선: NaviTile meta에 ahead>0이면 '↑N', behind>0이면 '↓N', todoCount>0이면 'TODO N'을 추가하고 마지막 커밋 상대시간('3일 전')을 툴팁 또는 두 번째 줄로. 검증 실패 타일은 클릭/툴팁으로 testOutputTail을 보여준다(별도 수집 없이 이미 ProjectView.status로 renderer에 도착해 있는 데이터의 표시만 추가).
  - 근거: src/main/collectors.ts:32-57,74-89, src/renderer/App.tsx:1063, src/renderer/components/NaviTile.tsx:31
- [ ] **C3. 완료 작업 이력/타임라인 뷰 부재 — done/cancelled 작업이 UI에서 증발** `상·M`
  - 현재: tasks 테이블은 상태·tokens·costUsd·turns·summary·diffStat·createdAt을 영속하고 task_events도 작업당 500건까지 조회 가능(store.ts listTaskEvents, ipc.ts:372 tasks:events)하지만, App.tsx:1054 activeTaskOf가 done/cancelled를 제외하고 TaskDrawer 진입점이 활성 작업뿐이라 결재를 끝낸 순간 그 작업은 화면 어디서도 다시 볼 수 없다. PLAN.md §12.6 화면 목록 4번 '작업 이력/로그 뷰(task별 타임라인·비용)'가 미구현. '어제 그 작업 뭐였지, 뭘 병합했지'를 확인할 방법이 채팅 로그 검색뿐.
  - 개선: 인박스/메뉴에 'HISTORY' 패널 추가 — listTasks()가 이미 전 상태를 반환하므로 done/cancelled 포함 최근 작업을 날짜순 리스트(프로젝트·제목·결과·턴·토큰·소요시간)로 보여주고, 행 클릭 시 기존 TaskDrawer를 읽기 전용으로 재사용해 이벤트 로그·summary·diffStat을 연다. 신규 백엔드 없이 기존 IPC 두 개(tasks:list, tasks:events) 재사용.
  - 근거: src/renderer/App.tsx:1054,1077, src/main/ipc.ts:327,372, PLAN.md §12.6
- [ ] **C4. 토큰 사용량 '오늘' 표기가 사실과 다르고, 일별/작업별 추이 시각화가 없음** `중·M`
  - 현재: App.tsx:1121이 '오늘 X tok'로 표시하는 값은 tokensUsed(렌더러 로드 이후 채팅 result 누적, 132·427행) + taskTokens(listTasks가 반환하는 최근 100개 작업의 전 기간 토큰 합, 1059행)로, '오늘'이 아니라 '이번 실행 채팅 + 역대 작업 100개'다. tasks 테이블에 tokens·cost_usd·created_at이 작업별로 영속돼 있어 일별 집계가 가능한데 어떤 추이 뷰도 없고, costUsd는 UI 어디에도 안 나온다(아카이브 md 메타에만).
  - 개선: ① 라벨 즉시 수정: created_at 기준 오늘 작업만 합산하는 간단한 파생 계산으로 '오늘'을 정확히. ② store에 일별 집계 쿼리(SELECT date(created_at), SUM(tokens) FROM tasks GROUP BY 1) IPC 하나 추가해 헤더 토큰 클릭 시 최근 14일 미니 바차트 + 프로젝트별 상위 소비 목록을 팝오버로 표시.
  - 근거: src/renderer/App.tsx:132,427,1059,1121, src/main/store.ts:109-127(tasks 스키마)
  - (병합) **비용·사용량 리포트 부재 — costUsd를 수집만 하고 버림**: 일/주 단위 사용량 패널(또는 /usage 슬래시): 레인 턴·작업별 토큰/턴/비용을 프로젝트별로 집계해 표시한다. 매니저 턴 토큰의 영속 컬럼 추가가 필요하므로 규모는 중간 — 다중 Navi 동시 가동 시 '어느 프로젝트가 토큰을 태우는지' 파악용으로 가치가 있다. — 근거: src/main/manager.ts:2073-2078, src/main/worker.ts:45-55,743-747, src/renderer/App.tsx:1121,1509
- [ ] **C5. 승인 대기 항목의 '언제부터 기다렸는지'가 안 보임** `중·S`
  - 현재: approvals.created_at은 스키마(store.ts:128-135)와 Approval 타입(shared/types.ts:117)에 있고 listApprovals로 renderer까지 도착하지만, AttentionInbox 행(ApprovalRow·ClarifyRow·ReviewRow)은 payload와 프로젝트 라벨만 렌더하고 대기 시간을 표시하지 않는다. Navi는 waitApproval에서 통째로 멈춰 있는데(worker.ts:664-696) 사용자가 자리를 비웠다 오면 어떤 승인이 30초짜리고 어떤 게 2시간째 작업을 세워두고 있는지 구분이 안 된다. 헤더 INBOX 칩도 개수만 있고 최장 대기 신호가 없다.
  - 개선: 인박스 각 행에 TaskDrawer의 fmtElapsed를 재사용해 '12분째' 배지를 붙이고, 임계(예: 10분) 초과 행은 강조색. 헤더 INBOX 칩 툴팁에 최장 대기 시간을 표기. 데이터·IPC 추가 없음 — 이미 오는 createdAt의 표시만.
  - 근거: src/renderer/components/AttentionInbox.tsx:39-129, src/shared/types.ts:111-118, src/main/worker.ts:664-696
- [ ] **C6. 전역 활동 피드(타임라인) 부재 — task_events·cc_events가 쌓이기만 함** `중·M`
  - 현재: task_events는 모든 작업의 status/tool/text/error를 영속하고(store.ts:136-142), cc_events는 lain 밖에서 돌린 Claude Code 세션의 SessionStart/End를 프로젝트별로 수집한다(store.ts:143-149, cchooks 훅 연동). 그러나 cc_events는 Lain의 도구(manager.ts:484 listRecentCcEvents)로만 노출되고 사용자 UI에는 어디에도 없으며, task_events도 드로어를 연 단일 작업 것만 보인다. '오늘 이 머신에서 무슨 일이 있었나'(작업 시작/완료/에러, 외부 CC 세션 포함)를 한 줄 타임라인으로 볼 곳이 없다.
  - 개선: 사이드 컬럼 하단 또는 별도 패널에 최근 활동 피드 추가 — task_events(kind=status 중 생성/세션종료/검토대기/에러)와 cc_events를 시간 역순으로 합쳐 '14:02 lain 작업 생성 · 13:40 hermes CC 세션 종료' 식 20줄. store에 통합 조회 함수 하나 + IPC 하나면 된다.
  - 근거: src/main/store.ts:136-149,1472-1491, src/main/manager.ts:484
- [ ] **C7. 학습(학습) 계보·실주입 데이터가 수집되지만 패널에 안 보임** `중·M`
  - 현재: lessons에 inject_count(실제 프롬프트 주입 횟수), absorbed_into(큐레이터 병합 계보), consolidation_batch, cited 기반 reuse bump(orchestrator.ts:693 bumpLessonReuse — 인용 계보 추적)까지 수집한다(store.ts:284-295). 그러나 LessonsPanel과 LessonDetail은 reuseCount·lastUsedAt·상태만 표시하고 injectCount(shared/types.ts:225에 타입까지 있음)와 병합 계보(어떤 학습들이 이 umbrella로 흡수됐나)는 렌더하지 않는다. 메모리에도 '그래프 시각화 잔여'로 기록된 미완 항목. '주입은 많이 되는데 한 번도 인용 안 되는 죽은 학습'을 식별할 수 없다.
  - 개선: ① LessonDetail에 '주입 N회 / 인용 N회'를 병기하고 주입 대비 인용 0인 학습에 시각 표시(정리 후보). ② 큐레이터 병합 학습은 absorbed_into 역참조로 흡수된 원본 목록을 상세 모달에 나열(간단한 트리 — 풀 그래프는 다음 단계).
  - 근거: src/main/store.ts:284-295, src/renderer/components/LessonsPanel.tsx:100,222-232, src/shared/types.ts:223-225, src/main/orchestrator.ts:685-695
- [ ] **C8. verify 실행 중 상태가 보드에 안 보임 — 'running'을 처리하는 분기가 없음** `중·S`
  - 현재: runVerify는 시작 시 testState='running'을 저장하지만(collectors.ts:74), 타일 상태를 결정하는 naviStatus(StageView.tsx:24-29)는 fail/pass만 분기하고 running은 dirtyFiles 유무에 따라 '미커밋' 또는 '대기'로 떨어진다. verify는 최대 5분(collectors.ts:79 timeout) 도는데 그동안 사용자는 검증이 돌고 있는지 알 수 없고, 커맨드 팔레트에서 verify를 눌러도 화면에 아무 반응이 없어 중복 실행하기 쉽다.
  - 개선: naviStatus에 testState==='running' 분기 추가 — '검증 중' 라벨 + busy 애니 그룹(kind:'busy'). 한 함수의 분기 하나라 즉시 가능.
  - 근거: src/renderer/components/StageView.tsx:24-29, src/main/collectors.ts:72-91
- [ ] **C9. diff 뷰에 변경 파일 목록 요약이 없음 — 전문 스크롤만 가능** `하·M`
  - 현재: TaskDrawer의 TaskDiffSection(B1)은 diff 전문을 줄 단위 색상으로 렌더하고 복사도 지원하지만, 파일 단위 접기/목록이 없어 큰 diff는 통짜 스크롤이다. main 쪽엔 changedFiles(worktree.ts:172)가 이미 있어 파일 목록을 결정론으로 뽑는데 spec-gaming 검사(orchestrator.ts:570)에만 쓰이고 UI에는 노출되지 않는다. 결재 판단의 핵심인 '어떤 파일들이 얼마나 바뀌었나' 개요를 훑을 수 없다.
  - 개선: taskDiff 응답을 파일 헤더('diff --git') 기준으로 파싱해 파일별 접이식 섹션 + 상단에 파일 목록(+N/-M) 요약을 붙인다. 렌더러 파싱만으로 가능(신규 IPC 불필요), 또는 changedFiles를 IPC로 노출해 목록을 먼저 그리고 본문은 지연 로드.
  - 근거: src/renderer/components/TaskDrawer.tsx:169-229, src/main/worktree.ts:172, src/main/orchestrator.ts:570
- [ ] **C10. 벤치 이력이 영속되는데 조회 UI가 없음 — 패널이 매번 빈 상태로 시작** `하·S`
  - 현재: bench_runs 테이블은 run_id·조건별 성공/1회통과/턴/비용/토큰을 created_at과 함께 영속하지만(store.ts:160-170, INSERT store.ts:2729), IPC는 bench:run 하나뿐(ipc.ts:534)이고 목록 조회가 없다. BenchPanel은 마운트 시 summary=null로 시작해(BenchPanel.tsx:16) 방금 돌린 런의 요약만 보여준다. '자기개선 효과를 A/B로 측정'이 목적인 화면인데, 몇 분·토큰을 들여 쌓은 과거 런과의 추이 비교(학습 ON 성공률이 지난달보다 올랐나)를 볼 수 없다.
  - 개선: bench:list IPC 추가(run_id별 그룹 요약 반환) — BenchPanel 마운트 시 마지막 런 요약을 즉시 표시하고, 하단에 런별 성공률 추이를 시간순 소형 리스트/스파크라인으로 나열.
  - 근거: src/main/store.ts:160-170,2725-2735, src/main/ipc.ts:534, src/renderer/components/BenchPanel.tsx:16-38

## D. 오케스트레이터 완성도

- [ ] **D1. 작업 대기 큐 부재 — 동시성 초과·프로젝트 중복 시 즉시 거절되고 끝** `상·M`
  - 현재: startTask는 프로젝트에 활성 작업이 있으면 '이미 진행 중인 작업이 있다'로, 동시 실행이 concurrencyCap(기본 2)에 닿으면 '동시 실행 N개 제한' 에러로 즉시 거절한다(orchestrator.ts:179, 182-186). 거절된 작업을 적재하는 큐가 없어 Lain이나 사용자가 기억했다가 재시도해야 한다. TaskState에 'ready'가 정의돼 있으나(shared/types.ts:50-53) 어떤 코드도 이를 설정하지 않고 크래시 복원 필터에서만 참조된다(orchestrator.ts:295). PLAN.md §17도 '프로젝트 작업 중 새 TASK — 큐 적재 vs 거절'을 미해결로 명시.
  - 개선: 'queued' 상태(또는 미사용 'ready' 재활용)를 추가해 cap 초과·프로젝트 중복 시 거절 대신 큐에 적재하고, finishWork/cancelTask/resolveReview에서 슬롯이 비면 큐를 드레인해 자동 착수한다. Task에 priority 정수 필드를 추가해 드레인 순서를 정하고, list_tasks에 큐 순서를 노출하며 Lain 도구(reorder_queue)로 순서 조정을 허용한다. '레인에게 할 일 5개를 던져두면 알아서 순서대로 처리'가 가능해진다.
  - 근거: src/main/orchestrator.ts:179-186, src/shared/types.ts:50-53, PLAN.md §17
- [ ] **D2. 작업 간 의존성(A 끝나면 B)·다단계 플랜 표현 부재** `상·L`
  - 현재: Task 인터페이스에 dependsOn/parent/그룹 필드가 전혀 없다(shared/types.ts:80-109). Lain의 위임 수단은 start_task 단발뿐이며(manager.ts:489-552), '마이그레이션 끝나면 소비자 코드 수정' 같은 연쇄는 Lain이 세션 기억으로 챙겨야 하는데 무한세션 압축·앱 재시작 시 유실될 수 있다. Routine은 cron 반복 전용이라(shared/types.ts:122-132) 조건부 연쇄를 표현하지 못한다.
  - 개선: Task에 dependsOn(선행 task id 배열)을 추가하고, 선행 작업이 done(병합 완료)되면 오케스트레이터가 자동 착수한다(1번 큐와 결합). 나아가 '플랜' 영속 객체(순서 있는 task 명세 목록 + 단계별 진행 조건)를 도입하고 plan 도구로 Lain이 다단계 계획을 세워 등록하면, 계획이 DB에 남아 Lain 세션과 무관하게 L0이 결정론으로 진행시킨다 — 단발 위임 오케스트레이터에서 계획 실행 오케스트레이터로의 핵심 격차.
  - 근거: src/shared/types.ts:80-109, src/main/manager.ts:489-552, src/main/orchestrator.ts
- [ ] **D3. 실행 에러(error 상태) 작업의 자동 재시도·에스컬레이션 정책 부재** `상·S`
  - 현재: verify 실패에는 재시도 2회 + 마지막 회차 모델 티어업 + flake 1회 무료 재시도 + 환경블로커 즉시 blocked 분류까지 정교하게 있다(orchestrator.ts:441-559). 반면 runNavi 자체가 throw하면 setState('error')로 방치되고(orchestrator.ts:397-401, 751-754), 복구는 사용자가 수동으로 resumeTask를 눌러야만 한다(orchestrator.ts:734-743, error 상태 전용). 스트림 내 일시적 API 에러(529 등) 백오프 재시도만 있고(worker.ts:768-781), 그 외 에러는 자동 복구 경로가 없다.
  - 개선: error 상태에 자동 재개 1~2회(백오프 후 기존 resumeTask 경로 재사용, 재시도 횟수를 task에 영속해 무한루프 방지)를 넣고, 그래도 실패하면 원인 요약을 담은 에스컬레이션 이벤트를 Lain 채팅에 푸시한다. 밤새 돌린 작업이 일시 장애로 error에 떨어져 아침까지 놀고 있는 상황을 없앤다.
  - 근거: src/main/orchestrator.ts:397-401, 734-755, src/main/worker.ts:768-781
- [ ] **D4. 승인 30분 무응답 = 자동 거절 — 자리 비움·야간 무인 실행에 취약** `중·S`
  - 현재: APPROVAL_TIMEOUT_MS = 30분이고 만료 시 무조건 rejected 처리된다(worker.ts:168, 246-260). Navi는 '사용자가 거절했다'는 메시지를 받아 우회를 시도하거나 blocked로 빠진다. 알림은 최초 1회뿐(notifyUser — 텔레그램 미러 포함, notify.ts:25-58)이고 만료 전 재알림이 없다.
  - 개선: 타임아웃을 설정으로 노출하고, 만료 동작을 '거절'이 아니라 '보류'로 바꾼다 — 작업을 일시정지(세션·worktree 보존)하고 사용자가 응답하면 그 지점부터 재개. 만료 임박(예: 25분) 시 텔레그램 재알림 1회. '거절당했다'는 잘못된 신호로 Navi가 차선 우회를 하는 것보다, 무인 오케스트레이터답게 기다렸다 이어가는 게 맞다.
  - 근거: src/main/worker.ts:168, 246-260, src/main/notify.ts:25-58
- [ ] **D5. TASK.md 발견이 OS 알림에서 끝남 — 자동 착수(hands-off intake) 옵션 없음** `중·S`
  - 현재: 주기 스캔이 새 TASK.md를 발견하면 '▶로 작업을 시작할 수 있다' 알림만 띄운다(scheduler.ts:393-397). autoPriority도 채팅 보고까지만이고(scheduler.ts:258-263) 착수 행동은 못 한다. autonomous 모드·elicitation 게이트·verify 판사 체계는 전부 구현돼 있는데, 입구(착수)만 항상 사람/Lain의 명시 조작을 요구한다.
  - 개선: opt-in 설정 'TASK.md 자동 착수'를 추가 — 스캔이 새 TASK.md를 발견했을 때 mode:autonomous 마커가 있고 프로젝트에 verify_cmd가 있으면 startTask를 자동 호출한다. 기존 elicitation 게이트(모호하면 질문 후 대기)·승인 큐·spec-gaming 방어를 그대로 타므로 안전장치는 유지된다. 'TASK.md 던져두고 자리 뜨면 돌아왔을 때 리뷰 대기'라는 오케스트레이터 본연의 흐름이 완성된다.
  - 근거: src/main/scheduler.ts:393-397, src/main/orchestrator.ts:162-255
- [ ] **D6. 장기 작업의 체크포인트·중간보고 부재 — Lain과 다이제스트는 최종 보고만 받음** `중·M`
  - 현재: Navi 이벤트는 UI 작업 드로어로 스트리밍되지만, Lain·다이제스트에 닿는 것은 종료 시 report.summary뿐이다(orchestrator.ts:584-588 saveStatus). runNavi는 maxTurns 60을 한 번에 끝까지 돌고(worker.ts:556), 핸드오프 md 작성도 '재개 경계'에서만 트리거된다(worker.ts:483-509). 진행 중 상태를 물으려면 message_navi 인터럽트(abort+resume)로 작업을 끊는 수밖에 없다.
  - 개선: N턴/N분마다 결정론 체크포인트(경과 턴·누적 토큰·최근 커밋 수·diffStat)를 task에 기록하고 status-digest에 '진행중: 12턴·커밋 3·+240/-31' 형태로 노출한다. Lain과 사용자가 인터럽트 없이 진행을 파악하고, 이상 징후(턴만 늘고 diff 0)를 조기 감지할 수 있다. 선택적으로 체크포인트마다 WIP 커밋을 강제해 크래시 시 손실을 줄인다.
  - 근거: src/main/worker.ts:483-556, src/main/orchestrator.ts:584-588
- [ ] **D7. 전역 사용량 가드·작업별 토큰 예산 미구현 (§9b 계획 잔여)** `중·M`
  - 현재: 리소스 제약은 concurrencyCap(store.ts:2800)과 하드코딩된 maxTurns 60(worker.ts:556)뿐이다. task가 tokens/costUsd/turns를 기록하지만(shared/types.ts:100-102) 어떤 코드도 이 값을 근거로 행동하지 않는다. PLAN §9b의 'Max 한도 근접 시 신규 스폰 억제 + 진행 작업 안전 정지'에 해당하는 구현이 없고(전 소스 grep 확인), 429는 transient 재시도에서 의도적으로 제외돼(retry.ts:4) 한도 초과 시 대응 정책이 사실상 공백이다.
  - 개선: ① 작업별 토큰 예산(설정, 초과 시 핸드오프 md를 남기고 일시정지+보고) ② 시간창 기반 전역 사용량 누적 카운터 — 한도 근접 시 신규 스폰 억제·judge류를 저티어로 강등. 병렬 작업 여러 개가 한도를 태워 정작 급한 작업이 막히는 상황을 예방한다.
  - 근거: src/main/worker.ts:556, src/main/store.ts:2800, src/main/retry.ts:4, PLAN.md §9b
- [ ] **D8. 결재 병합이 ff-only 한정 + 병합 후 롤백 수단 없음** `중·M`
  - 현재: tryMerge는 메인 체크아웃이 clean하고 fast-forward 가능할 때만 병합하고, 아니면 '브랜치만 남김 — 직접 머지해라'로 사람에게 넘긴다(worktree.ts:188-202). 분기 후 메인에 커밋이 하나라도 생기면(멀티 작업 병렬 시 흔함) 자동 병합이 항상 실패한다. 병합 후 되돌리는(revert) 와이어드 경로도 없다 — resolve_review 설명 자체가 '비가역'이라 명시(manager.ts:764-766). PLAN §17도 merge-back 흐름을 미확정으로 남김.
  - 개선: ① ff 불가 시 worktree 쪽에서 main을 rebase 후 verify 재실행→ff 재시도하는 자동 경로(충돌 시에만 사람에게)를 추가 — 병렬 작업 시대에 ff-only는 병목. ② done 작업 카드에 '병합 되돌리기'(해당 커밋 범위 git revert) 도구를 추가해 승인→리뷰→롤백의 사람 개입 3종 세트를 완성한다.
  - 근거: src/main/worktree.ts:188-202, src/main/manager.ts:764-780, PLAN.md §17
- [ ] **D9. Navi 작업의 plan 모드가 타입만 있고 미배선 — 계획 승인 없이 바로 실행** `중·M`
  - 현재: 레인 채팅에는 plan 모드가 완비돼 있다(InputModeBar.tsx:76-81 '계획' 옵션 → agentopts.ts:71-72 SDK 직결 → ExitPlanMode 승인 카드 manager.ts:1992-2015). 반면 Navi 작업은 TaskPermissionMode 타입에 'plan'이 선언돼 있고 주석에 'Phase B 실측 후 배선'이라 적혀 있지만(types.ts:66-67), TaskDrawer 셀렉트에 plan 옵션이 없고(TaskDrawer.tsx:313-317 default/acceptEdits/bypass만), worker.ts canUseTool에 ExitPlanMode 분기가 없어 설정돼도 계획이 무심사 통과된다(worker.ts:708 최종 allow).
  - 개선: TaskDrawer 권한 셀렉트에 plan을 추가하고, worker canUseTool에 ExitPlanMode → 승인 큐(insertApproval kind='plan') 라우팅을 넣어 계획 전문을 승인 카드로 보여준 뒤 진행하게 한다. 위험하거나 방향이 애매한 위임 작업에서 'Navi가 엉뚱한 접근으로 토큰을 태우는' 것을 시작 전에 끊을 수 있다 — 기존 승인 큐 인프라(PC+텔레그램 버튼) 그대로 재사용.
  - 근거: src/shared/types.ts:66-67, src/renderer/components/TaskDrawer.tsx:313-317, src/main/worker.ts:551,708
- [ ] **D10. 작업별 모델 선택 UI 없음 — modelOverride 배관은 이미 존재** `중·S`
  - 현재: Claude Code는 세션 중 /model로 모델을 바꾼다. lain 레인은 입력창 바에서 모델·effort·fast를 즉시 전환할 수 있지만(InputModeBar.tsx:97-172), Navi 작업은 전역 설정 naviModel 하나로 고정이다. runNavi에 opts.modelOverride 배관이 이미 있는데(worker.ts:352-355,557) 현재는 orchestrator의 실패 시 자동 에스컬레이션만 쓰고, TaskDrawer 헤더에는 권한/thinking/fast만 있고 모델 셀렉트가 없다(TaskDrawer.tsx:305-345).
  - 개선: Task에 modelOverride 필드(빈 값=전역)를 추가하고 TaskDrawer 헤더에 모델 드롭다운을 붙여 다음 실행/재개부터 반영(기존 thinking/fast 토글과 동일 패턴). 무거운 작업만 상위 티어로, 기계적 작업은 하위 티어로 작업 단위 제어가 가능해진다.
  - 근거: src/main/worker.ts:352-355,557, src/renderer/components/TaskDrawer.tsx:305-345, src/renderer/components/InputModeBar.tsx:97-172
- [ ] **D11. 완료·폐기 작업의 원클릭 재실행(re-run) 부재** `하·S`
  - 현재: TASK.md는 outcome·비용·턴 메타와 함께 DATA_DIR/done에 아카이브되고(orchestrator.ts:799-810) task.content(합격 기준 포함)도 DB에 남지만, done/cancelled 작업을 같은 명세로 다시 시작하는 경로가 없다 — resumeTask는 error 상태 전용(orchestrator.ts:736). 재실행하려면 명세를 손으로 복사해 start_task를 새로 불러야 한다.
  - 개선: rerun_task(task_id) 도구·카드 버튼 추가 — 보존된 content(elicitation으로 확정된 합격 기준 포함)로 새 task를 생성해 착수한다. 회귀 재현, '지난번 그 작업 다시 돌려줘' 류 반복 지시, 벤치(§23)와의 연계까지 감사 로그 기반 재현성이 완성된다.
  - 근거: src/main/orchestrator.ts:734-743, 799-810
- [ ] **D12. 엔진 추상화가 if-분기 하드코딩 — 제3 엔진 추가 비용 큼, codex 기능 패리티 공백** `하·M`
  - 현재: TaskEngine이 'claude' | 'codex' 유니언으로 박제돼 있고(shared/types.ts:78), worker.runNavi 서두의 if-분기로 codex 러너에 위임한다(worker.ts:371-379). codex 엔진은 승인 큐·ask_manager·학습/스킬 주입이 없고 autonomous 미지원(codex.ts:14-16, orchestrator.ts:223-230). Gemini CLI·로컬 llama.cpp 워커 등 제3 엔진을 붙이려면 types/worker/orchestrator/manager(start_task enum) 네 곳을 고쳐야 한다.
  - 개선: NaviEngine 인터페이스(run/resume/abort + capability 플래그: approvals·askManager·autonomous·lessons)로 추출하고 오케스트레이터는 capability 기반으로 분기한다. codex처럼 승인 콜백이 없는 엔진에도 최소한 실행 명령의 사후 감사 로그(command_execution 이벤트는 이미 수집됨, codex.ts:78-81)를 승인 이력과 같은 화면에 노출해 안전 관측 격차를 좁힌다.
  - 근거: src/shared/types.ts:78, src/main/worker.ts:371-379, src/main/codex.ts:14-16, src/main/orchestrator.ts:223-230
- [ ] **D13. 크로스 프로젝트 작업 불가 — 한 요청이 여러 repo에 걸치면 수동 분해·수동 정합** `중·L`
  - 현재: Task는 단일 projectId에 묶이고(shared/types.ts:82) worktree도 그 프로젝트 하나만 만든다(orchestrator.ts:383). 공용 타입 변경 + 소비자 repo 2곳 수정 같은 요청은 Lain이 start_task를 repo별로 따로 호출하고 순서·인터페이스 정합을 스스로 챙겨야 하며, 리뷰·병합도 각각 따로여서 한쪽만 병합되는 반쪽 상태가 생길 수 있다.
  - 개선: task group(공유 명세 + repo별 child task) 도입 — 그룹 단위로 동시 착수하고, 리뷰 카드에서 전체 diff를 한눈에 보고, 모든 child가 verify pass일 때만 일괄 병합(all-or-nothing)한다. 멀티 repo를 굴리는 이 앱의 전제(여러 프로젝트 지휘)에서 자연히 발생하는 요청 유형이다.
  - 근거: src/shared/types.ts:82, src/main/orchestrator.ts:383, src/main/worktree.ts:20-80
- [ ] **D14. 여러 Navi 협업(작업 분할·결과 병합) 부재 — 프로젝트당 활성 작업 1개 강제** `중·L`
  - 현재: activeTaskForProject 검사로 프로젝트당 활성 task 1개만 허용된다(orchestrator.ts:179). worktree는 taskId별 독립 폴더·브랜치라(worktree.ts:24-43) 기술적으로는 같은 repo 병렬 작업이 가능하지만 정책이 막고 있다. broadcast_navis는 메시지 fan-out일 뿐(manager.ts:823-826) 작업 분할이 아니고, 큰 작업을 서브태스크로 쪼개 여러 Navi에 나눠 돌리고 결과를 합치는 메커니즘은 없다.
  - 개선: 1단계로 '파일 영역이 겹치지 않는' 같은 프로젝트 병렬 task를 opt-in 허용(병합 순서는 큐 순서대로 ff/rebase). 2단계로 부모 task를 서브태스크로 분해해 병렬 실행 후 통합 브랜치에서 verify하는 fan-out/fan-in을 2번(의존성)·1번(큐) 위에 얹는다. 대형 리팩터의 체감 소요 시간을 크게 줄인다.
  - 근거: src/main/orchestrator.ts:179, src/main/worktree.ts:24-43, src/main/manager.ts:823-826
- [ ] **D15. 되감기(rewind) 부재 — 레인 직접 편집은 되돌릴 수단이 없음** `중·L`
  - 현재: Claude Code는 편집마다 체크포인트를 남겨 /rewind로 코드·대화를 복원한다. lain의 Navi 작업은 worktree 격리+폐기(discard)로 안전하지만(TaskDrawer.tsx:480-490 검토 3버튼), 레인이 additionalDirectories로 실레포를 직접 수정한 것(manager.ts:1934)은 체크포인트·언두가 전혀 없다 — git이 있어도 커밋 전 변경이 사용자 변경과 섞이면 선별 복구가 어렵다.
  - 개선: 레인 canUseTool의 Edit/Write 통과 시점에 대상 파일을 턴 단위로 백업(DATA_DIR/checkpoints/<턴id>/, git 레포면 수정 전 blob 기록)하고, 채팅 메시지 우클릭 메뉴에 '이 턴의 편집 되돌리기'를 추가한다. 전체 /rewind(대화까지 복원)는 과하고, 파일 복원만으로도 '레인이 망친 편집'의 복구 수단이 생긴다.
  - 근거: src/main/manager.ts:1934,1944-2016, src/renderer/components/TaskDrawer.tsx:480-490

## E. 공개 레포 준비

- [ ] **E1. README에 설치본(Releases) 다운로드 경로가 없다 — 첫 진입이 소스 빌드뿐** `상·S`
  - 현재: README.md:35-43 '빠른 시작'은 git clone → npm install → npm run dev/dist만 안내한다. 반면 electron-builder.yml:36-41에 GitHub Releases publish 설정이 있고 src/main/updater.ts는 electron-updater로 Releases를 피드 삼는 자동 업데이트 엔진까지 완비돼 있다 — 즉 배포 인프라는 릴리스 기반인데 README는 Releases에서 Setup exe를 받는 경로를 한 줄도 언급하지 않는다. Node/Git 셋업이 안 된 일반 사용자는 진입 자체가 막힌다.
  - 개선: 빠른 시작 최상단에 'Releases에서 Lain Setup x.y.z.exe 다운로드 → 실행'을 1순위 경로로 추가하고, 소스 빌드는 개발자용 보조로 내린다. 자동 업데이트가 내장돼 있어 한 번 설치하면 계속 최신을 받는다는 점도 명시한다.
  - 근거: README.md:35-43, electron-builder.yml:36-41, src/main/updater.ts:93-131
- [ ] **E2. 온보딩 1단계 'Claude 연결'이 설치본 신규 사용자에게 막다른 길** `상·M`
  - 현재: OnboardingModal.tsx:56-62는 미로그인 시 '터미널에서 claude를 한 번 실행해 로그인'하라고 안내하지만, 설치본으로 시작한 사용자는 claude CLI가 PATH에 없다(앱이 번들한 claude.exe는 asar.unpacked 내부 전용 — src/main/paths.ts:48-59). Claude Code 설치 명령은 온보딩·README 어디에도 없다(README.md:33은 문서 링크뿐). 결과: 설치 직후 1단계 ❌에서 따라 할 수 없는 지시를 받고 멈춘다.
  - 개선: 온보딩 1단계에 ① Claude Code 설치 명령(npm install -g @anthropic-ai/claude-code)을 코드 블록으로 표기하고 ② '로그인 터미널 열기' 버튼을 추가해 번들 CLAUDE_BIN으로 cmd 창(claude /login)을 직접 띄워 CLI 미설치자도 그 자리에서 로그인→'다시 확인'까지 완주하게 한다.
  - 근거: src/renderer/components/OnboardingModal.tsx:56-62, src/main/ipc.ts:691-702, src/main/paths.ts:48-59
- [ ] **E3. README에 실제 앱 화면이 한 장도 없다** `상·S`
  - 현재: assets/에는 로고 2장(lain.png, lain-face.png)뿐이고 README.md의 이미지도 이 로고들이 전부다. 대화창·프로젝츠 창·플래너·오버레이 조언 등 실제 UI 스크린샷/GIF가 0장 — CRT 네온 테마·도트 캐릭터라는 강한 비주얼 자산이 있는데도 기능 소개(README.md:16-25)가 텍스트 나열로만 끝난다. GitHub 첫 방문자의 체류·설치 전환에 직결된다.
  - 개선: 핵심 화면 3~4장(레인 대화+캐릭터, 프로젝츠 작업 흐름(worktree→review→merge), 플래너, 오버레이 슬라이드)과 10초 데모 GIF를 assets/에 추가하고 ' Lain이 하는 일' 각 항목 옆에 삽입한다.
  - 근거: README.md:1-25, assets/ (lain.png·lain-face.png 2개뿐)
- [ ] **E4. 온보딩·플래너 등 신규 사용자 경험 핵심이 '미공개' 적립 상태 — 공개 설치본에 미반영** `상·S`
  - 현재: 이 체크아웃 기준 package.json:3 버전은 1.0.0이고, CHANGELOG.md:5-24 '[미공개]' 섹션에 첫 실행 온보딩·플래너·시스템 파괴 명령 승인 게이트·Codex 엔진이 적립돼 있다. 즉 1.0.0(2026-07-04) 설치본을 받은 신규 사용자는 온보딩 위저드 없이 시작한다 — 첫인상 개선분이 릴리스로 안 나간 상태.
  - 개선: 릴리스 절차(버전 bump → CHANGELOG 승격 → 릴리스 게이트 → npm run dist -- --publish)를 실행해 온보딩 포함 설치본을 조기 릴리스한다. 신규 사용자 유입 전에 나가야 효과가 있는 변경들이다.
  - 근거: package.json:3, CHANGELOG.md:5-24
- [ ] **E5. API 키 사용자를 위한 입력 UI가 없다 — 시스템 환경변수 수동 편집 강요** `중·M`
  - 현재: ipc.ts:698-700의 온보딩 검사는 ANTHROPIC_API_KEY 환경변수를 정식 로그인 수단으로 인정하지만, 이 키를 입력할 곳이 앱 안에 없다 — PrefsModal '모델' 섹션(PrefsModal.tsx:606-651)에도 키 필드가 없어 구독 없는 사용자는 Windows 시스템 환경변수를 직접 편집하고 앱을 재시작해야 한다.
  - 개선: 환경설정 모델 섹션에 'Anthropic API 키' 시크릿 필드(기존 TelegramField 컴포넌트 재사용, howto에 console.anthropic.com 안내)를 추가하고, 저장값을 SDK spawn env에 주입한다(로컬 티어 env를 주입하는 agentopts.ts 패턴 재사용). 온보딩 1단계도 '구독 로그인 / API 키' 양 갈래로 제시.
  - 근거: src/main/ipc.ts:691-702, src/renderer/components/PrefsModal.tsx:606-651, src/main/agentopts.ts:13-37
- [ ] **E6. 워크스페이스 자동 스캔이 환경변수 전용 + UI 문구는 'C:\workspace' 하드코딩** `중·M`
  - 현재: 스캔 루트는 LAIN_WORKSPACE/LAIN_SCAN_DIRS/LAIN_EXTRA_DIRS 환경변수로만 바꿀 수 있고(registry.ts:8-15) 앱 내 설정이 없다. 빈 상태 안내도 '등록된 프로젝트 없음 — SCAN C:\workspace'로 고정(App.tsx:1581)이라 env를 바꾼 사용자에게도 남의 경로를 보여주고, 폴더 추가 다이얼로그 defaultPath도 'C:\workspace' 고정(ipc.ts:169)이다. 일반 사용자에게 시스템 환경변수 편집은 높은 문턱.
  - 개선: 환경설정 '일반'에 워크스페이스 루트·스캔 하위폴더 설정을 추가(환경변수는 오버라이드로 유지)하고, 빈 상태 문구와 다이얼로그 기본 경로를 실제 설정값으로 동적 표시한다. 온보딩 2단계에도 '폴더 추가' 옆에 '워크스페이스 스캔' 버튼을 함께 둔다.
  - 근거: src/main/registry.ts:8-15, src/renderer/App.tsx:1581, src/main/ipc.ts:166-171
  - (병합) **UI에 'C:\workspace' 하드코딩 — LAIN_WORKSPACE 설정과 표기 불일치**: main이 실제 DEV_ROOT를 IPC(getSettings 또는 전용 채널)로 렌더러에 내려주고, SCAN title·빈 상태 문구·defaultPath가 그 값을 표시하도록 바꾼다. '설정 표시=실제 일치' 원칙과 같은 맥락. — 근거: src/renderer/App.tsx:1522,1581, src/main/registry.ts:7-8, src/main/ipc.ts:169
- [ ] **E7. 영문 README 부재 — i18n 부재의 현실적 최소 대응이 빠져 있다** `중·S`
  - 현재: README.md:14에 '🇰🇷 한국어 전용' 선언과 영어 요약 1문단(9-12행)이 전부다. UI 문자열·시스템 프롬프트·에러 메시지 전부 한국어 하드코딩이고 i18n 스캐폴딩은 없다(렌더러 전반). GitHub 검색·트렌딩으로 유입되는 비한국어권 방문자는 프로젝트가 뭘 하는지조차 파악하기 어렵다.
  - 개선: 전면 i18n은 대공사(L)이므로 우선 README.en.md를 추가한다 — 기능·요구사항·스크린샷·'UI는 현재 한국어 전용' 명시. 본문 README 상단에 언어 스위치 링크. UI i18n은 로드맵 항목으로만 명시해 기대치를 관리한다.
  - 근거: README.md:9-14, src/renderer/ 전반(하드코딩 한국어 문자열)
- [ ] **E8. 데이터 백업·이식 수단이 없다 — 개인화 자산이 쌓일수록 리스크** `중·M`
  - 현재: 설정·대화·학습·플래너 등 모든 개인화 데이터가 %APPDATA%\lain의 SQLite+저널에 쌓이는데, 앱 내 '데이터 폴더 열기'·백업 내보내기·복원 기능이 없다(보이스 폴더 열기만 존재 — ipc.ts:675-683). README.md:76도 저장 위치만 언급한다. store.ts에 WAL 손상 자동복구 코드(quick_check→REINDEX 등)가 여럿인 것 자체가 손상이 실재하는 리스크임을 보여준다 — '길들인' 데이터를 잃으면 이 앱의 핵심 가치가 소멸한다.
  - 개선: 환경설정 '일반'에 '데이터 폴더 열기' 버튼(voice:openFolder 패턴 재사용)과 '백업 내보내기' 버튼(wal_checkpoint(TRUNCATE) 후 db·저널을 zip으로 저장)을 추가하고, README에 백업/PC 이사 절차를 1단락 문서화한다.
  - 근거: src/main/ipc.ts:675-683, src/main/store.ts:596-740(손상 복구 코드), README.md:76
- [ ] **E9. 비Windows에서 소스 실행 시 명시적 가드가 없다 — 불명확한 산발 실패** `하·S`
  - 현재: README.md:31은 Windows 전용을 명시하고 electron-builder.yml도 win 타깃뿐이지만, macOS/Linux에서 npm run dev 하면 부팅은 진행된다 — paths.ts:53이 비win32 바이너리명을 처리해 '되는 것처럼' 보이다가 watcher의 상주 PowerShell, where.exe(codex.ts:35), deploy.ps1 등이 각자 불명확한 에러로 실패한다. 공개 레포에선 이 경로로 유입되는 이슈 노이즈가 생긴다.
  - 개선: main 부팅 최초에 process.platform !== 'win32'면 명시 다이얼로그('Lain은 현재 Windows 전용입니다 — 화면 감시·배포 등 일부 기능이 동작하지 않습니다')를 한 번 띄우고 계속/종료를 선택하게 한다. README에도 배지로 표기.
  - 근거: src/main/index.ts:200-315, src/main/paths.ts:52-53, src/main/codex.ts:35, electron-builder.yml:27-29
- [ ] **E10. 온보딩 'claude 실행 파일 없음' 메시지가 진단 정보 없이 재설치만 권한다** `하·S`
  - 현재: OnboardingModal.tsx:54는 번들 claude.exe 미발견 시 '설치가 손상됐을 수 있어요. 재설치를 권합니다'만 띄운다. 소스 실행 사용자(플랫폼별 optional dependency @anthropic-ai/claude-agent-sdk-*가 npm install에서 누락된 경우)에게는 잘못된 처방이고, 어떤 파일이 어느 경로에 없는지도 알려주지 않아 이슈 리포트도 빈손이 된다.
  - 개선: onboarding:status 응답에 기대 경로(CLAUDE_BIN)를 포함해 메시지에 표기하고, 비패키징(dev) 실행이면 'npm install을 다시 실행해 플랫폼별 SDK 바이너리를 받으세요'로 분기 안내한다.
  - 근거: src/renderer/components/OnboardingModal.tsx:53-55, src/main/ipc.ts:691-702, src/main/paths.ts:48-59

---
*생성: 2026-07-07, 감사 원본 JSON은 세션 스크래치패드(휘발) — 본 문서가 유일한 영속본.*
