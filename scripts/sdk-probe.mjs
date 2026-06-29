// SDK 단독 검증 (PLAN.md §18) — Electron 밖 순수 Node에서 query() 동작 확인
import { query } from '@anthropic-ai/claude-agent-sdk'

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

log('start')
const stream = query({
  prompt: '1+1은? 숫자만 답해.',
  options: {
    maxTurns: 1,
    model: 'sonnet',
    allowedTools: [],
    stderr: (d) => process.stderr.write('[cli-stderr] ' + d),
  },
})

for await (const msg of stream) {
  log(msg.type, msg.subtype ?? '', JSON.stringify(msg).slice(0, 400))
}
log('done')
