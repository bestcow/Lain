// /learn 명령 (학습루프 T2, hermes learn_prompt 대응 — 메커니즘만 lain 고유 재구현).
// 핵심: 별도 엔진 없음 — 저작 표준을 박은 프롬프트 하나를 레인의 일반 턴으로 실행한다.
// 레인이 기존 도구(Read/Grep/WebFetch/현재 대화)로 소스를 수집해 mcp__lain__skill_save로 저장한다.
// 순수 함수(L0) — 진입점은 렌더러 슬래시 /learn·텔레그램 /learn(둘 다 sendToManager의 모델 텍스트로).

/** /learn <요청>을 스킬 저작 지시문으로 감싼다. 채팅에 영속되는 사용자 메시지는 원문 '/learn …' 그대로 —
 *  이 지시문은 모델에게만 간다(sendToManager modelText). */
export function buildLearnPrompt(request: string): string {
  const req = (request ?? '').trim()
  return `[/learn — 스킬 저작 지시]
사용자가 다음을 스킬로 학습해 저장하길 원한다:

<learn-request>
${req || '(요청 본문 없음 — 방금 이 대화에서 함께 한 작업을 스킬로 남겨라)'}
</learn-request>

절차:
1. 소스 수집 — 요청 유형에 맞게 기존 도구로 직접 확인한다:
   · 로컬 경로/프로젝트 → Read·Glob·Grep으로 실제 파일을 읽는다.
   · URL/문서 → WebFetch로 원문을 가져온다.
   · "방금/이번 대화에서 한 작업" → 현재 대화 기억을 근거로 쓴다.
   · 붙여넣은 절차 → 그 본문을 근거로 쓴다.
2. 이미 같은 주제의 스킬이 있는지 <skills-index>에서 확인한다. 있으면 mcp__lain__skill_view로 본문을 보고
   새로 만들지(create) 고칠지(patch/replace) 판단한다.
3. mcp__lain__skill_save로 저장한다.

저작 표준(어기지 마라):
- **본 것만 쓴다. 발명 금지** — 직접 확인 못 한 단계·명령·경로는 쓰지 말거나 "(미확인)"을 명시한다.
- name: ascii kebab-case([a-z0-9-], 예: lain-deploy-procedure). 한글·공백 불가 — 표시용 제목은 md 첫 줄 #에.
- description: 60자 이내 한 줄 — 언제 쓰는 스킬인지가 드러나게(인덱스에 이것만 보인다).
- 본문 섹션 순서: # 제목 → ## 언제 쓰나 → ## 전제 조건 → ## 절차(단계별 — 명령·경로·값을 구체적으로) → ## 함정 → ## 검증.
- 분량 상한 약 4,000자 — 넘치면 세부는 원본 경로/URL 참조로 대신한다.
- 시크릿(토큰·키·비밀번호)은 절대 본문에 넣지 마라 — 필요하면 "설정에서 읽는다"고만 쓴다.
4. 저장 후 사용자에게 무엇을 저장했는지 한두 줄로 보고한다(스킬 이름 포함).`
}
