// §18 Phase 1 실측: worktree 격리 + canUseTool 라우팅 + acceptEdits + 커밋
import { query } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const tmp = 'C:/dev/lain/data/tmp'
const repo = path.join(tmp, 'probe-repo')
const wt = path.join(tmp, 'probe-wt')

// 클린 준비
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(repo, { recursive: true })
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
git(repo, 'init', '-b', 'main')
fs.writeFileSync(path.join(repo, 'README.md'), '# probe\n')
git(repo, 'add', '.')
git(repo, 'commit', '-m', 'init', '--no-gpg-sign')
git(repo, 'worktree', 'add', '-b', 'lain/probe', wt, 'HEAD')
console.log('[setup] worktree ready:', wt)

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)
const permCalls = []

const stream = query({
  prompt:
    'hello.txt 파일을 만들어 내용으로 "hi"를 쓰고, git add 후 "probe: hello" 메시지로 커밋해라. 커밋 후 `git push`도 시도해봐라. 끝나면 한 줄로 보고해라.',
  options: {
    cwd: wt,
    permissionMode: 'acceptEdits',
    maxTurns: 12,
    model: 'sonnet',
    executable: 'node',
    canUseTool: async (toolName, input, { decisionReason, title }) => {
      const desc = JSON.stringify(input).slice(0, 120)
      permCalls.push(toolName)
      log(`[perm] ${toolName} ${desc} (${title ?? decisionReason ?? ''})`)
      const cmd = String(input?.command ?? '')
      if (/git\s+push|rm\s+-rf|reset\s+--hard/.test(cmd)) {
        log('[perm] → DENY (위험 분류)')
        return { behavior: 'deny', message: 'push는 사람 승인이 필요하다. 승인 대기 큐로 보냈다고 가정하고 작업을 마무리해라.' }
      }
      return { behavior: 'allow', updatedInput: input }
    },
  },
})

for await (const msg of stream) {
  if (msg.type === 'assistant') {
    const text = (msg.message?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
    if (text) log('[assistant]', text.slice(0, 150))
  } else if (msg.type === 'result') {
    log('[result]', msg.subtype, 'turns:', msg.num_turns, 'cost:', msg.total_cost_usd?.toFixed(4))
  }
}

// 검증
console.log('--- 검증 ---')
console.log('perm calls:', permCalls.join(', ') || '(없음)')
console.log('worktree hello.txt:', fs.existsSync(path.join(wt, 'hello.txt')) ? 'OK' : 'MISSING')
console.log('main repo hello.txt:', fs.existsSync(path.join(repo, 'hello.txt')) ? '오염!!' : '격리 OK')
console.log('worktree last commit:', git(wt, 'log', '-1', '--format=%s'))
console.log('main branch last commit:', git(repo, 'log', '-1', '--format=%s'))
