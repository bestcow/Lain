// 비밀 파일 데노리스트 (§24 Phase1) — Read/Edit/Write/Grep 등 파일 도구가 시크릿(.env·키·크리덴셜)을
// 모델 컨텍스트/로그/Lain 도달 범위로 끌어오는 것을 결정론으로 차단한다. L0 배관(LLM 호출 없음).
// 런타임 프로세스(npm test 등)가 직접 .env를 읽는 것은 막지 않는다 — 파일 *도구* 호출만 대상.
// d9cfa20로 Lain이 전 저장소 Read/Edit 권한을 얻어 .env 노출 표면이 커진 것을 메운다.
import path from 'node:path'
import os from 'node:os'
import { DATA_DIR } from './paths'

// 경로 인자를 갖는 도구들 — 파일 내용을 모델로 가져오거나(Read/Grep) 파일을 생성/수정(Edit/Write).
// Glob은 파일명만 반환(내용 노출 아님)이라 제외.
export const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Grep'])

// 예시/템플릿은 비밀이 아님 — 화이트리스트 우선 (.env.example, config.sample.json 등).
const EXAMPLE_RE = /(^|[._-])(example|sample|template|dist)(\.|$)/i

// basename 기준 비밀 판정 (Windows path.parse 기반 — POSIX 가정 안 함).
const SECRET_RE: RegExp[] = [
  /^\.env(\.|$)/i, // .env, .env.local, .env.production
  /(^|[._-])secrets?(\.|[._-]|$)/i, // secrets.json, app.secret.ts, secret_key
  /(^|[._-])credentials?(\.|[._-]|$)/i, // credentials, aws_credentials
  /(^|[._-])api[_-]?keys?(\.|[._-]|$)/i, // apikey, api_key (bare 'token'은 디자인/렉서 토큰 오탐이라 제외)
  /(^|[._-])(access|auth|refresh|secret|bearer|id|session|private)[_-]?tokens?(\.|[._-]|$)/i, // auth_token 등 한정 토큰
  /^\.(npmrc|netrc|pgpass|htpasswd)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i, // SSH 개인키
  /\.(pem|key|pfx|p12|keystore|jks|asc|gpg)$/i, // 개인키/인증서
]

/** 파일 경로가 비밀 파일이면 true (basename 기준, 예시/템플릿 제외). */
export function isSecretFile(filePath: string): boolean {
  if (!filePath) return false
  const base = path.basename(filePath.replace(/[\\/]+$/, ''))
  if (!base || EXAMPLE_RE.test(base)) return false
  return SECRET_RE.some((re) => re.test(base))
}

/** canUseTool 입력에서 대상 파일 경로를 뽑는다 (도구별 키가 달라 셋 다 시도). */
export function toolFilePath(input: unknown): string {
  const i = input as Record<string, unknown> | null
  return String(i?.file_path ?? i?.path ?? i?.notebook_path ?? '')
}

/** 파일 도구의 대상이 비밀 파일이면 true — canUseTool에서 한 줄로 게이트. */
export function blocksSecretFile(toolName: string, input: unknown): boolean {
  return FILE_PATH_TOOLS.has(toolName) && isSecretFile(toolFilePath(input))
}

// 테스트 파일 판정 (§21.6 spec-gaming 방어 + §24 사후검증 공용 — 단일 출처).
const TEST_FILE_RE =
  /(^|[\\/])(test|tests|spec|__tests__)([\\/]|.*\.(test|spec)\.)|\.test\.|\.spec\.|_test\.|test_.*\.py/i

/** 경로가 테스트 파일이면 true. autonomous에서 Navi가 '판사'를 못 고치게 막는 데 쓴다. */
export function isTestFile(filePath: string): boolean {
  return !!filePath && TEST_FILE_RE.test(filePath)
}

export const SECRET_DENY_MESSAGE =
  '비밀 파일(.env·키·크리덴셜)은 읽거나 수정할 수 없다(§24 데노리스트). 런타임 프로세스(테스트 등)는 알아서 환경값을 읽으니 파일 내용을 직접 보지 말고 진행하거나, 꼭 필요하면 blocked로 보고해라.'

// ─────────────────────────────────────────────────────────────────────────────
// 출력측 비밀 redaction (PLAN §9-6) — 로그·다이제스트·텔레그램 송신 직전 결정론 1패스.
// LLM 없음. 고신뢰 credential *형상*만 [REDACTED]로. 오탐(URL query/전화번호/form-body)은
// 일부러 제외 — 정상 출력을 깨뜨리는 것보다 새는 게 낫다는 게 아니라, 형상이 명확한 것만 친다.
// store.addMessage/addNaviMessage·title.setAutoTitle 입력의 단일 chokepoint에서 호출.

// 한 줄 형태 credential 토큰 — prefix가 명확한 것만(접두 경계 \b로 시작 고정).
const CRED_TOKEN_RE: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic (sk-ant- 우선 — sk-보다 길어 먼저)
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI 류 sk-
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/g, // GitHub PAT/OAuth/server/user/refresh
  /\bAKIA[0-9A-Z]{12,}/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack bot/user/app/refresh/legacy
  /\bAIza[0-9A-Za-z_-]{16,}/g, // Google API key
  /\bhf_[A-Za-z0-9]{16,}/g, // HuggingFace
  /\bnpm_[A-Za-z0-9]{16,}/g, // npm
  /\b\d{6,}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token (id:secret)
]

// Authorization: Bearer <token> — 헤더 줄 통째로 값만 마스킹.
const BEARER_RE = /\b(Authorization\s*:\s*Bearer\s+|Bearer\s+)[A-Za-z0-9._-]{12,}/gi

// PEM 개인키 블록 — BEGIN…END 사이 본문 전부.
const PEM_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g

// NAME=value — NAME이 비밀스러운 이름일 때만 value 마스킹(따옴표 유무 모두).
// API_KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL 계열만 — generic 변수 대입 오탐 방지.
const ENV_ASSIGN_RE =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)[A-Z0-9_]*)(\s*[=:]\s*)(['"]?)([^\s'"]{4,})\3/gi

// DB 연결 문자열 비밀번호 — scheme://user:PASSWORD@host. 비밀번호 자리만.
const CONNSTR_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s:/@]{2,})(@)/gi

const MASK = '[REDACTED]'

/**
 * 텍스트에서 고신뢰 credential 형상을 [REDACTED]로 치환(원문 비파괴 — 새 문자열 반환).
 * 결정론·순수(LLM 없음). 로그·다이제스트·텔레그램 송신 직전 1패스(PLAN §9-6).
 * 대상: sk-/sk-ant-/ghp_·gho_·ghs_/AKIA/xox[baprs]-/AIza/hf_/npm_/텔레그램 봇토큰,
 *   Authorization: Bearer, BEGIN PRIVATE KEY 블록, NAME=value(NAME이 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL),
 *   DB connstr 비밀번호. URL query·전화번호·form-body는 제외(오탐 방지).
 */
export function redactSecrets(text: string): string {
  if (!text) return text
  let out = text
  // PEM 먼저(여러 줄) — 이후 단일 토큰 규칙이 내부를 건드리지 않게.
  out = out.replace(PEM_RE, MASK)
  for (const re of CRED_TOKEN_RE) out = out.replace(re, MASK)
  out = out.replace(BEARER_RE, (_m, prefix: string) => `${prefix}${MASK}`)
  out = out.replace(ENV_ASSIGN_RE, (_m, name: string, sep: string, q: string) => `${name}${sep}${q}${MASK}${q}`)
  out = out.replace(CONNSTR_RE, (_m, head: string, _pw: string, at: string) => `${head}${MASK}${at}`)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 학습 주입 인젝션 스캔 (§자기개선) — origin='agent' 학습을 프롬프트에 주입하기 전 게이트.
// 단일 PC라 user origin은 신뢰루트(스캔 안 함). agent가 생성한 학습에 프롬프트 탈취 시도가
// 섞여 들어가는 것을 결정론으로 잡는다. 소형 정규식셋 + invisible char + 크기 한도.

const LESSON_MAX_BYTES = 2048 // 단일 학습 2KB 초과는 비정상(정상 학습은 한두 문장).

// 보이지 않는/방향제어 문자 — zero-width, BiDi override 등(프롬프트 위장에 악용).
// U+200B-200D(ZW), U+200E/200F(LRM/RLM), U+202A-202E(BiDi embed/override), U+2060(WJ), U+FEFF(BOM).
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/

const INJECTION_RE: { re: RegExp; reason: string }[] = [
  { re: /ignore\s+(?:all\s+|the\s+)?(?:previous|above|prior)\s+instructions/i, reason: 'ignore-previous-instructions' },
  { re: /disregard\s+(?:all\s+|your\s+|the\s+)?(?:previous\s+)?(?:instructions|rules|guardrails|safety)/i, reason: 'disregard-instructions' },
  { re: /\bsystem\s*prompt\b/i, reason: 'system-prompt-reference' },
  { re: /\byou\s+are\s+now\b/i, reason: 'role-override' },
  { re: /\bmcp__lain__/i, reason: 'tool-impersonation' }, // lain MCP 도구 위장 마커
  { re: /<\/?(?:system|assistant)>/i, reason: 'role-tag-injection' },
]

/**
 * 학습 본문에 프롬프트 인젝션 시도가 있으면 {blocked:true, reason}. 없으면 {blocked:false}.
 * insertLesson에서 origin==='agent'일 때만 호출 → blocked면 status='archived'로 격리(소비처 책임).
 * 결정론·순수(LLM 없음).
 */
export function scanLessonInjection(text: string): { blocked: boolean; reason?: string } {
  return scanInjectionPayload(text, LESSON_MAX_BYTES)
}

const SKILL_MAX_BYTES = 24 * 1024 // 스킬 md는 절차 문서라 학습보다 크다 — 24KB 초과는 비정상

/**
 * 스킬 md/사용자 프로필처럼 프롬프트·도구결과로 재주입되는 에이전트 저작물의 인젝션 스캔(학습루프 T1/T5).
 * 학습과 같은 패턴셋, 크기 한도만 문서 규모(24KB). 결정론·순수.
 */
export function scanSkillInjection(text: string): { blocked: boolean; reason?: string } {
  return scanInjectionPayload(text, SKILL_MAX_BYTES)
}

function scanInjectionPayload(text: string, maxBytes: number): { blocked: boolean; reason?: string } {
  if (!text) return { blocked: false }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { blocked: true, reason: 'oversize' }
  if (INVISIBLE_RE.test(text)) return { blocked: true, reason: 'invisible-chars' }
  for (const { re, reason } of INJECTION_RE) {
    if (re.test(text)) return { blocked: true, reason }
  }
  return { blocked: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// 디렉터리 단위 시크릿 데노리스트 (§안전) — basename 판정(isSecretFile)의 보강.
// HOME 하위 크리덴셜 디렉터리(.ssh/.aws/…)와 lain DATA_DIR 자체를 통째로 막는다.
// 셸/파일 도구가 디렉터리 안의 *어떤* 파일이든(basename이 secret-스럽지 않아도) 못 건드리게.
// 절대경로 전용 — canUseTool 게이트가 절대경로로 정규화한 뒤 호출(상대경로는 isSecretFile 영역).

// HOME 하위 크리덴셜 디렉터리명(basename 매칭).
const SECRET_DIR_NAMES = ['.ssh', '.aws', '.gnupg', '.kube', '.docker']

/** 경로를 비교용으로 정규화 — 후행 구분자 제거 + 소문자 + 구분자 통일(Windows 대소문자 무시). */
function normForCompare(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

/**
 * 절대경로가 시크릿 디렉터리(HOME/.ssh·.aws·.gnupg·.kube·.docker) 또는 lain DATA_DIR
 * 하위(자기 자신 포함)면 true. isSecretFile의 디렉터리 단위 보강 — basename이 평범해도 차단.
 * 결정론·순수(LLM 없음). 절대경로 전용(상대경로는 그대로 false 처리되어 안전).
 *
 * ⚠ 계약: 인자는 **경로 하나**다. 셸 명령문을 통째로 넣으면 내부 path.resolve가 cwd를 앞에
 * 붙여버려 사실상 항상 false다 — 명령문은 blocksSecretCommand를 써라.
 */
export function blocksSecretPath(absPath: string): boolean {
  if (!absPath) return false
  const target = normForCompare(absPath)

  // 1) lain DATA_DIR 자체/하위 — SQLite·저널·시크릿 영속 위치.
  const data = normForCompare(DATA_DIR)
  if (target === data || target.startsWith(`${data}/`)) return true

  // 2) HOME 하위 크리덴셜 디렉터리/하위.
  const home = normForCompare(os.homedir())
  for (const name of SECRET_DIR_NAMES) {
    const dir = `${home}/${name}`
    if (target === dir || target.startsWith(`${dir}/`)) return true
  }
  return false
}

// 셸 토큰화(경량) — 따옴표(" ')로 감싼 구간은 공백을 포함해 한 토큰, 나머지는 공백 분리.
const SHELL_TOKEN_RE = /"([^"]*)"|'([^']*)'|([^\s"']+)/g

/**
 * 토큰에서 절대경로 조각만 뽑는다 — `--file=C:\x`·`2>/etc/x` 같은 접두는 떼고 경로만 남긴다.
 * 상대경로(`data/lain.db`)는 null — blocksSecretPath가 cwd를 붙여 오판하는 것을 막는다.
 */
function absPathIn(token: string): string | null {
  const win = /[A-Za-z]:[\\/]/.exec(token)
  if (win) return token.slice(win.index)
  const posix = /(?:^|[=>|;&])([\\/][^\s]*)/.exec(token)
  return posix ? posix[1] : null
}

/**
 * 셸 명령문에 시크릿 디렉터리를 가리키는 절대경로가 섞여 있으면 true
 * (`type C:\Users\me\.ssh\id_rsa`, `cat C:/lain/data/lain.db` 등).
 * blocksSecretPath는 경로 하나가 계약이라 명령문을 통째로 넘기면 항상 false다 — 호출부가
 * 오용하지 않게 여기서 토큰화(따옴표 보존)한 뒤 절대경로 토큰만 개별로 넘긴다.
 * 결정론·순수(LLM 없음).
 */
export function blocksSecretCommand(cmd: string): boolean {
  if (!cmd) return false
  SHELL_TOKEN_RE.lastIndex = 0 // 전역 정규식 재사용 — 이전 호출의 lastIndex 잔재 제거
  let m: RegExpExecArray | null
  while ((m = SHELL_TOKEN_RE.exec(cmd))) {
    const token = m[1] ?? m[2] ?? m[3] ?? ''
    const p = absPathIn(token)
    if (p && blocksSecretPath(p)) {
      SHELL_TOKEN_RE.lastIndex = 0
      return true
    }
  }
  return false
}
