// 프로젝트별 도트 캐릭터 — 규칙 기반 자동 생성.
// ① 이름 키워드 → 테마 모티프(내용 연상). ② 매칭 없으면 id 해시 → 대칭 엠블럼(identicon).
// 규칙(정확히):
//  - 키워드 경로의 '그림'은 테마 그룹핑이라 여러 프로젝트가 공유한다(중복이 정상 — 내용을 읽히게 하는 게 목적).
//    대신 '주색'을 id 해시로 회전시켜 같은 테마끼리도 서로 구분된다(보조색은 유지 → 테마 색 계열은 남음).
//  - identicon 경로의 그림은 프로젝트마다 사실상 고유하다.
//  - 어느 경로든 같은 {id, name}이면 결과가 항상 같다(재스캔·재시작해도 아이콘 불변).
// ※ 주색 회전이 도입되면서, 그 이전부터 있던 프로젝트는 키워드 테마 색이 한 번 바뀐다(이후로는 불변).
// 키워드는 '이름'으로만 본다 — id의 카테고리 경로(apps/games/tools)는 false-positive를 낸다.
// 상태(작업/질문/결재)는 스프라이트가 아니라 카드/무대 크롬(테두리·라벨·애니)이 계속 표시한다.
import type { ReactNode } from 'react'

// 픽셀맵('1' 주색 · '2' 보조색 · '.' 빈칸/구멍=눈) → rect
function renderRects(map: string[], colors: Record<string, string>): ReactNode[] {
  const rects: ReactNode[] = []
  map.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const fill = colors[row[x]]
      if (!fill) continue
      rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />)
    }
  })
  return rects
}

interface Motif {
  // 키워드는 이름의 '토큰'과 정확히 같아야 매칭. 끝에 '*'를 붙이면 어간(접두) 매칭
  // — 'secur*'는 security/secure까지 먹지만, 마커 없는 'auth'는 author를 먹지 않는다.
  keys: string[]
  map: string[]
  colors: Record<string, string>
}

// 키워드 → 모티프. 위에서부터 먼저 매칭되는 것 사용(구체적 키워드를 앞에).
export const THEMES: Motif[] = [
  {
    keys: ['chess'],
    colors: { '2': '#c9b6f3' },
    map: ['...222...', '..22222..', '..22222..', '...222...', '....2....', '...222...', '..22222..', '.2222222.', '.2222222.'],
  },
  {
    keys: ['youtube', 'video', 'tube', 'stream', 'media', 'player', 'movie'],
    colors: { '1': '#7a6fa0', '2': '#ff5a82' },
    map: ['111111111', '1.......1', '1.2.....1', '1.22....1', '1.222...1', '1.22....1', '1.2.....1', '1.......1', '111111111'],
  },
  {
    keys: ['secur*', 'auth', 'lock', 'vault', 'crypt*', 'guard'],
    colors: { '1': '#f0b46b', '2': '#f7d09a' },
    map: ['..22222..', '.2.....2.', '.2.....2.', '111111111', '111111111', '1111.1111', '111...111', '1111.1111', '111111111'],
  },
  {
    keys: ['tarot', 'astro*', 'mystic*', 'fortune', 'divin*', 'moon', 'luna'],
    colors: { '1': '#d96bff', '2': '#f0b46b' },
    map: ['..1111...', '.11......', '11.......', '11....2..', '11.......', '11.......', '.11......', '..1111...'],
  },
  {
    keys: ['cow'],
    colors: { '1': '#e8e2f5', '2': '#d96bff' },
    map: ['2.......2', '22.....22', '.1111111.', '1.11111.1', '1.1...1.1', '1.11111.1', '1.12221.1', '.1111111.', '..1...1..'],
  },
  {
    keys: ['git', 'sync', 'merge', 'repo', 'vcs', 'commit', 'branch'],
    colors: { '1': '#66e6b0', '2': '#bff3dd' },
    map: ['.11......', '.11......', '.11......', '.1122....', '.11.22...', '.11..22..', '.11...11.', '.11...11.', '.11...11.', '.11...11.'],
  },
  {
    keys: ['battle', 'combat', 'fight', 'war', 'rpg', 'quest', 'dungeon', 'arena'],
    colors: { '1': '#c9b6f3', '2': '#ff5a82' },
    map: ['....2....', '....2....', '....2....', '....2....', '..11111..', '....1....', '....1....', '....1....', '...111...'],
  },
  {
    keys: ['gear', 'engine', 'ops', 'config', 'setting', 'tool', 'pipeline', 'build'],
    colors: { '1': '#c9b6f3', '2': '#9b8fc2' },
    map: ['..2.2.2..', '.2222222.', '22.....22', '2..111..2', '2.11111.2', '2..111..2', '22.....22', '.2222222.', '..2.2.2..'],
  },
  {
    keys: ['audio', 'sound', 'music', 'voice', 'song', 'beat', 'podcast'],
    colors: { '1': '#5fd0d0', '2': '#b18cf0' },
    map: ['..11111..', '.11...11.', '11.....11', '1.......1', '22.....22', '22.....22', '22.....22'],
  },
  {
    keys: ['reference', 'docs', 'doc', 'wiki', 'note', 'learn', 'study', 'book', 'guide'],
    colors: { '1': '#7fb0ff', '2': '#c9b6f3' },
    map: ['.1111111.', '.1.....1.', '.1.222.1.', '.1.....1.', '.1.222.1.', '.1.....1.', '.1.222.1.', '.1.....1.', '.1111111.'],
  },
  {
    keys: ['portfolio', 'profile', 'resume', 'about', 'bio'],
    colors: { '1': '#b18cf0', '2': '#e8e2f5' },
    map: ['...222...', '..22222..', '..22222..', '...222...', '.........', '....1....', '.1111111.', '111111111', '111111111', '.1111111.'],
  },
  {
    keys: ['blog', 'post', 'chat', 'forum', 'talk', 'board', 'feed', 'comment'],
    colors: { '1': '#7fb0ff', '2': '#66e6b0' },
    map: ['.1111111.', '1.......1', '1.2.2.2.1', '1.......1', '.1111111.', '..1......', '.1.......', '1........'],
  },
  {
    keys: ['love', 'match', 'dating', 'heart', 'romance', 'valentine'],
    colors: { '1': '#ff7fb0', '2': '#ffd0e0' },
    map: ['.11.11...', '1111111..', '1111111..', '1111111..', '.11111...', '..111....', '...1.....'],
  },
  {
    keys: ['titanic', 'ship', 'boat', 'sail', 'voyage', 'ferry', 'cruise', 'ocean'],
    colors: { '1': '#9b8fc2', '2': '#7fb0ff' },
    map: ['....1....', '....1....', '..2211...', '.22221...', '222221...', '....1....', '111111111', '.1111111.', '..11111..'],
  },
  {
    keys: ['home', 'hub', 'dashboard', 'index', 'base', 'root', 'main'],
    colors: { '1': '#b18cf0', '2': '#f0b46b' },
    map: ['....1....', '...111...', '..11111..', '.1111111.', '111111111', '1.11111.1', '1.1.2.1.1', '1.1.2.1.1', '111.2.111'],
  },
  {
    keys: ['agent', 'bot', 'gpt', 'llm', 'neural', 'robot', 'assistant'],
    colors: { '1': '#c9b6f3', '2': '#66e6b0' },
    map: ['...2.2...', '....1....', '.1111111.', '1.1...1.1', '1.11111.1', '1.11111.1', '.1111111.', '..1...1..', '..1...1..'],
  },
]

const PALETTE = ['#b18cf0', '#d96bff', '#66e6b0', '#f0b46b', '#ff5a82', '#7fb0ff', '#c9b6f3', '#5fd0d0']

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// 이름 → 토큰. 구분자(-, _, ., /, 공백)로만 쪼갠다 — 단어 한가운데 낀 문자열은 키워드가 아니다.
function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[-_./\\\s]+/)
    .filter(Boolean)
}

// 토큰 하나가 키워드에 걸리는가. 기본은 완전일치, '*' 마커가 붙은 어간만 접두 허용.
function matches(tokens: string[], key: string): boolean {
  if (key.endsWith('*')) {
    const stem = key.slice(0, -1)
    return tokens.some((t) => t.startsWith(stem))
  }
  return tokens.includes(key)
}

// 색상(hue)만 돌리는 회전 단계(도) — 채도·명도는 보존해 테마의 톤(파스텔 CRT)을 유지한다.
// ±36°로 묶은 이유: 색 계열(보라는 보라, 파랑은 파랑)은 남기면서 옆에 놓으면 구분되는 폭.
const HUE_SHIFTS = [0, 12, -12, 24, -24, 36, -36]

export function spriteFor(project: {
  id: string
  name: string
}): { map: string[]; colors: Record<string, string> } {
  // 키워드 매칭은 '이름'만으로 — id 경로(apps/games/tools)가 false-positive(예: tools→'tool'→gear)를 낸다.
  const tokens = tokenize(project.name)
  for (const t of THEMES) {
    if (t.keys.some((k) => matches(tokens, k))) {
      return { map: t.map, colors: rotateTheme(t.colors, project.id || project.name) }
    }
  }
  // 폴백: 해시 기반 대칭 엠블럼(identicon) — 키워드 없는 프로젝트도 전부 고유·불변.
  return identicon(project.id || project.name)
}

// 같은 테마를 쓰는 프로젝트들을 색으로 갈라준다 — 주색만 회전하고 보조색은 테마 것 그대로 둔다.
// (주색이 없는 테마는 '2'가 사실상 주색이라 그쪽을 돌린다.)
function rotateTheme(colors: Record<string, string>, seed: string): Record<string, string> {
  const primary = colors['1'] ? '1' : '2'
  if (!colors[primary]) return colors
  const shift = HUE_SHIFTS[hashStr(seed) % HUE_SHIFTS.length]
  return { ...colors, [primary]: rotateHue(colors[primary], shift) }
}

// #rrggbb 의 hue만 deg 만큼 회전(S·L 보존).
function rotateHue(hex: string, deg: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m || deg === 0) return hex
  const int = parseInt(m[1], 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  h = (((h + deg) % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const base = l - c / 2
  const [r2, g2, b2] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  const hx = (v: number) =>
    Math.round((v + base) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hx(r2)}${hx(g2)}${hx(b2)}`
}

// GitHub identicon식 — id 해시로 좌반면을 채우고 좌우 대칭 → 프로젝트마다 유일한 9×9 엠블럼.
function identicon(seed: string): { map: string[]; colors: Record<string, string> } {
  const bits = [hashStr(seed), hashStr(seed + '~')] // 64비트 ≥ 좌반면 45셀
  const bit = (i: number) => (bits[(i / 32) | 0] >>> (i % 32)) & 1
  const W = 9
  const HALF = Math.ceil(W / 2) // 5 (가운데 열 포함)
  const map: string[] = []
  let b = 0
  for (let y = 0; y < W; y++) {
    const left: string[] = []
    for (let x = 0; x < HALF; x++) left.push(bit(b++) ? '1' : '.')
    const right = left.slice(0, W - HALF).reverse() // 가운데 열 제외하고 미러
    map.push([...left, ...right].join(''))
  }
  return { map, colors: { '1': PALETTE[bits[0] % PALETTE.length] } }
}

// 스프라이트 주색을 단일 색 문자열로 환원 — 아바타 테두리·무대 도트색 통일용.
export function projectColor(project: { id: string; name: string }): string {
  const { colors } = spriteFor(project)
  return colors['1'] ?? colors['2'] ?? PALETTE[hashStr(project.id || project.name) % PALETTE.length]
}

export function ProjectSprite({
  project,
  px = 3,
}: {
  project: { id: string; name: string }
  px?: number
}) {
  const { map, colors } = spriteFor(project)
  const cols = map.reduce((m, r) => Math.max(m, r.length), 0)
  const rows = map.length
  return (
    <span className="sprite sprite-worker">
      <svg
        width={cols * px}
        height={rows * px}
        viewBox={`0 0 ${cols} ${rows}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label={project.name}
      >
        {renderRects(map, colors)}
      </svg>
    </span>
  )
}
