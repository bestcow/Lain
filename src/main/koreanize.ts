// 한국어 전용 TTS용 음차 필터 — Supertonic은 lang='ko'로 합성하므로, 텍스트에 영어/숫자/기호가 섞이면
// 한국어 음소화기가 이상한 억양으로 발음한다. 합성 '직전' 입력만 한글 음차로 바꾼다(화면 텍스트는 불변).
//
// 우선순위: (1) 큐레이션 사전(자주 쓰는 용어, 정확) → (2) 약어(대문자 연속, 글자별) → (3) 규칙 폴백(근사).
// 폴백은 임의 영어를 '근사' 한글로 옮기는 best-effort다(완벽하지 않음). 품질은 사전 확장으로 끌어올린다.
// 순수 함수 — Electron/store 의존 없음(vitest 단위테스트 가능). 통합은 tts.ts(synthesizeSupertonic).

// ── 한글 자모 합성 ──────────────────────────────────────────────
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ']
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']

function compose(cho: string, jung: string, jong = ''): string {
  const ci = CHO.indexOf(cho)
  const ji = JUNG.indexOf(jung)
  const ki = jong ? JONG.indexOf(jong) : 0
  if (ci < 0 || ji < 0 || ki < 0) return ''
  return String.fromCharCode(0xac00 + (ci * 21 + ji) * 28 + ki)
}

// 받침으로 자연스러운 자음(비음·유음). 그 외 자음은 종성 대신 '으' 음절로 푼다(영어 외래어 관습).
const CODA_OK = new Set(['ㄴ', 'ㅁ', 'ㅇ', 'ㄹ'])

// ── 큐레이션 사전(소문자 키) — lain·기술 용어 위주. 자유 확장. ──
const DICT: Record<string, string> = {
  // lain/제품
  lain: '레인', navi: '나비', supertonic: '슈퍼토닉', discord: '디스코드', telegram: '텔레그램',
  // git/개발 워크플로
  deploy: '디플로이', commit: '커밋', build: '빌드', branch: '브랜치', merge: '머지', push: '푸시',
  pull: '풀', rebase: '리베이스', repo: '레포', repository: '레포지토리', github: '깃허브', git: '깃',
  clone: '클론', checkout: '체크아웃', diff: '디프', staging: '스테이징', release: '릴리스',
  // 런타임/언어
  npm: '엔피엠', node: '노드', electron: '일렉트론', typescript: '타입스크립트', javascript: '자바스크립트',
  python: '파이썬', react: '리액트', vite: '비트', sqlite: '에스큐엘라이트',
  // 일반 개발
  error: '에러', warning: '워닝', log: '로그', test: '테스트', debug: '디버그', server: '서버',
  client: '클라이언트', token: '토큰', api: '에이피아이', json: '제이슨', file: '파일', folder: '폴더',
  update: '업데이트', install: '인스톨', setup: '셋업', config: '컨피그', default: '디폴트', cache: '캐시',
  model: '모델', voice: '보이스', code: '코드', review: '리뷰', task: '태스크', status: '스테이터스',
  fix: '픽스', feature: '피처', chat: '챗', message: '메시지', prompt: '프롬프트', script: '스크립트',
  // 흔한 영어
  ok: '오케이', user: '유저', email: '이메일', online: '온라인', download: '다운로드', upload: '업로드',
  start: '스타트', stop: '스탑', done: '던', open: '오픈', close: '클로즈', link: '링크',
  app: '앱', web: '웹', url: '유알엘', ui: '유아이', pr: '피아르', cpu: '씨피유', ai: '에이아이',
}

// 알파벳 글자 이름(약어·단일 문자용)
const ALPHA: Record<string, string> = {
  a: '에이', b: '비', c: '씨', d: '디', e: '이', f: '에프', g: '지', h: '에이치', i: '아이',
  j: '제이', k: '케이', l: '엘', m: '엠', n: '엔', o: '오', p: '피', q: '큐', r: '아르',
  s: '에스', t: '티', u: '유', v: '브이', w: '더블유', x: '엑스', y: '와이', z: '지',
}

// ── 숫자 → 한글(사이노 한자어) ──
const DIGIT = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구']
const SMALL_UNIT = ['', '십', '백', '천']
const BIG_UNIT = ['', '만', '억', '조', '경']

function digitByDigit(s: string): string {
  return s.split('').map((d) => DIGIT[Number(d)] ?? '').join('')
}

function sinoUnder10k(n: number): string {
  // 0~9999
  let out = ''
  const s = String(n)
  const len = s.length
  for (let i = 0; i < len; i++) {
    const d = Number(s[i])
    const pos = len - 1 - i // 0=일,1=십,2=백,3=천
    if (d === 0) continue
    // 십·백·천 자리에서 1은 '일'을 생략(십, 백, 천)
    out += (d === 1 && pos > 0 ? '' : DIGIT[d]) + SMALL_UNIT[pos]
  }
  return out
}

function sinoNumber(n: number): string {
  if (n === 0) return '영'
  let out = ''
  let group = 0
  while (n > 0) {
    const part = n % 10000
    if (part > 0) out = sinoUnder10k(part) + BIG_UNIT[group] + out
    n = Math.floor(n / 10000)
    group++
  }
  return out
}

function readNumber(tok: string): string {
  const clean = tok.replace(/,/g, '')
  const [intPart, fracPart] = clean.split('.')
  let intRead: string
  // 자릿수 과다·선행 0 → 자릿수 그대로 읽기(전화번호·ID 등)
  if (intPart.length > 8 || (/^0\d/.test(intPart))) intRead = digitByDigit(intPart)
  else intRead = sinoNumber(Number(intPart))
  if (fracPart !== undefined && fracPart !== '') return `${intRead} 점 ${digitByDigit(fracPart)}`
  return intRead
}

// ── 영어 → 한글 규칙 폴백(근사) ──
type Phon = { t: 'C'; cho: string } | { t: 'V'; jung: string }

const VOW: Record<string, string> = { a: 'ㅏ', e: 'ㅔ', i: 'ㅣ', o: 'ㅗ', u: 'ㅜ', y: 'ㅣ' }
const VDIG: Record<string, string> = {
  oo: 'ㅜ', ee: 'ㅣ', ea: 'ㅣ', ie: 'ㅣ', oa: 'ㅗ', ai: 'ㅐ', ay: 'ㅔ', ey: 'ㅣ',
  ow: 'ㅗ', ou: 'ㅜ', au: 'ㅓ', aw: 'ㅓ',
}
const CON: Record<string, string> = {
  b: 'ㅂ', c: 'ㅋ', d: 'ㄷ', f: 'ㅍ', g: 'ㄱ', h: 'ㅎ', j: 'ㅈ', k: 'ㅋ', l: 'ㄹ', m: 'ㅁ',
  n: 'ㄴ', p: 'ㅍ', q: 'ㅋ', r: 'ㄹ', s: 'ㅅ', t: 'ㅌ', v: 'ㅂ', x: 'ㅅ', z: 'ㅈ', w: '',
}
const CDIG: Record<string, string> = {
  sh: 'ㅅ', ch: 'ㅊ', th: 'ㅅ', ph: 'ㅍ', ck: 'ㄱ', ng: 'ㅇ', wh: 'ㅎ', kn: 'ㄴ', gh: '',
}

function transliterate(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!w) return ''
  // 묵음 e: 자음+e로 끝나면 끝 e 제거 (code→cod, make→mak)
  if (w.length > 2 && w.endsWith('e') && !'aeiou'.includes(w[w.length - 2])) w = w.slice(0, -1)

  const phon: Phon[] = []
  let i = 0
  while (i < w.length) {
    const two = w.slice(i, i + 2)
    if (VDIG[two]) { phon.push({ t: 'V', jung: VDIG[two] }); i += 2; continue }
    if (two in CDIG) { const c = CDIG[two]; if (c) phon.push({ t: 'C', cho: c }); i += 2; continue }
    const ch = w[i]
    if (VOW[ch]) { phon.push({ t: 'V', jung: VOW[ch] }); i++; continue }
    if (ch in CON) { const c = CON[ch]; if (c) phon.push({ t: 'C', cho: c }); i++; continue }
    i++
  }

  // 음절 조립: 자음=초성(다음 모음 대기), 모음 없으면 '으'로 풀기, 비음·유음은 앞 음절 받침으로.
  const syl: { cho: string; jung: string; jong: string }[] = []
  let pending: string | null = null // 모음을 기다리는 초성
  const flush = (): void => {
    if (pending === null) return
    const last = syl[syl.length - 1]
    if (last && last.jong === '' && CODA_OK.has(pending)) last.jong = pending
    else syl.push({ cho: pending, jung: 'ㅡ', jong: '' })
    pending = null
  }
  for (const p of phon) {
    if (p.t === 'V') {
      syl.push({ cho: pending ?? 'ㅇ', jung: p.jung, jong: '' })
      pending = null
    } else {
      if (pending !== null) flush()
      pending = p.cho
    }
  }
  flush()

  return syl.map((s) => compose(s.cho, s.jung, s.jong)).join('')
}

function readWord(W: string): string {
  const lower = W.toLowerCase().replace(/[^a-z]/g, '')
  if (!lower) return ''
  if (DICT[lower]) return DICT[lower]
  // 약어(대문자 연속, 짧음) → 글자별
  if (/^[A-Z]+$/.test(W) && W.length <= 4) return W.split('').map((c) => ALPHA[c.toLowerCase()] ?? '').join('')
  if (lower.length === 1) return ALPHA[lower] ?? ''
  const t = transliterate(lower)
  return t || lower.split('').map((c) => ALPHA[c] ?? '').join('') // 변환 실패 시 글자별
}

// 자주 쓰는 기호 → 한글(helper.js가 일부를 영어로 바꾸기 전에 선처리: 예 '@'→' at ').
const SYM: Record<string, string> = {
  '@': '앳', '%': '퍼센트', '&': '앤드', '+': '플러스', '$': '달러', '#': '샵',
}

/** 한국어 TTS 입력용 음차. 영어 단어·숫자·일부 기호를 한글로, 한글/공백/문장부호는 그대로. */
export function koreanizeForTTS(text: string): string {
  if (!text) return text
  // 1) 기호 선처리
  let out = text.replace(/[@%&+$#]/g, (m) => ` ${SYM[m] ?? ''} `)
  // 2) 영어 단어 / 숫자 → 한글
  out = out.replace(/[A-Za-z]+|\d[\d,]*(?:\.\d+)?/g, (m) => {
    if (/^\d/.test(m)) return readNumber(m)
    return readWord(m)
  })
  // 3) 기호 선처리로 생긴 중복 공백 정리
  return out.replace(/ {2,}/g, ' ').trim()
}
