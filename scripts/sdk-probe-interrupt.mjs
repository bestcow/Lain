// §18 실측: §5.7 인터럽트 — streaming input 모드에서
//  ① 실행 중 query.interrupt()가 현재 턴을 끊는가
//  ② 끊은 뒤 같은 스트림에 새 user 메시지를 밀어넣어 이어지는가 (컨텍스트 유지)
import { query } from '@anthropic-ai/claude-agent-sdk'

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

// 밀어넣기 가능한 user 메시지 큐 (async generator)
const queue = []
let wake = null
let closed = false
function push(text) {
  queue.push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
  wake?.()
}
function close() {
  closed = true
  wake?.()
}
async function* input() {
  while (true) {
    while (queue.length === 0 && !closed) {
      await new Promise((r) => (wake = r))
      wake = null
    }
    if (queue.length > 0) yield queue.shift()
    else if (closed) return
  }
}

push('1부터 30까지 한 줄에 하나씩 천천히 세라. 한 번에 다 말하지 말고 5개마다 잠깐 생각하면서.')

const q = query({
  prompt: input(),
  options: {
    cwd: 'C:/dev/lain/data/tmp',
    allowedTools: [],
    maxTurns: 8,
    model: 'haiku',
    executable: 'node',
  },
})

let sessionId = null
let interrupted = false
let phase = 1

setTimeout(async () => {
  log('>> interrupt() 호출')
  try {
    await q.interrupt()
    interrupted = true
    log('>> interrupt 완료 — 후속 메시지 주입')
    phase = 2
    push('방금 중단시켰다. 어디까지 셌는지 한 줄로만 답하고 끝내라.')
  } catch (e) {
    log('>> interrupt 실패:', e.message)
    close()
  }
}, 4000)

for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    sessionId = msg.session_id
    log('init session', sessionId.slice(0, 8))
  } else if (msg.type === 'assistant') {
    const t = (msg.message?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
    if (t) log(`assistant(p${phase}):`, JSON.stringify(t.slice(0, 100)))
  } else if (msg.type === 'result') {
    log('result:', msg.subtype, `${msg.num_turns}턴 $${(msg.total_cost_usd ?? 0).toFixed(4)}`)
    if (phase === 2) {
      close() // 후속 답까지 받았으면 종료
    }
  }
}
log('스트림 종료. interrupted =', interrupted)
