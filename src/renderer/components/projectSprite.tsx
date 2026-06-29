// 프로젝트별 도트 캐릭터 — 규칙 기반 자동 생성.
// ① 이름 키워드 → 테마 모티프(내용 연상). ② 매칭 없으면 id 해시 → 대칭 엠블럼(identicon).
// → 지금 프로젝트뿐 아니라 "앞으로 생길 모든 프로젝트"도 같은 방식으로 고유·불변 아이콘을 받는다.
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
  keys: string[]
  map: string[]
  colors: Record<string, string>
}

// 키워드 → 모티프. 위에서부터 먼저 매칭되는 것 사용(구체적 키워드를 앞에).
const THEMES: Motif[] = [
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
    keys: ['secur', 'auth', 'lock', 'vault', 'crypt', 'guard'],
    colors: { '1': '#f0b46b', '2': '#f7d09a' },
    map: ['..22222..', '.2.....2.', '.2.....2.', '111111111', '111111111', '1111.1111', '111...111', '1111.1111', '111111111'],
  },
  {
    keys: ['tarot', 'astro', 'mystic', 'fortune', 'divin', 'moon', 'luna'],
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
    keys: ['asmr', 'audio', 'sound', 'music', 'voice', 'song', 'beat', 'podcast'],
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
    keys: ['waifu', 'maifu', 'love', 'match', 'dating', 'heart', 'romance', 'valentine'],
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

export function spriteFor(project: {
  id: string
  name: string
}): { map: string[]; colors: Record<string, string> } {
  // 키워드 매칭은 '이름'만으로 — id 경로(apps/games/tools)가 false-positive(예: tools→'tool'→gear)를 낸다.
  const n = project.name.toLowerCase()
  for (const t of THEMES) {
    if (t.keys.some((k) => n.includes(k))) return { map: t.map, colors: t.colors }
  }
  // 폴백: 해시 기반 대칭 엠블럼(identicon) — 키워드 없는 프로젝트도 전부 고유·불변.
  return identicon(project.id || project.name)
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
