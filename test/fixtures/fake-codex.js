// 가짜 codex CLI — codex.ts 배관(spawn 인자·stdin 프롬프트·JSONL 스트리밍·종료코드·abort 정리)의
// e2e용 심. LAIN_CODEX_JS로 이 파일을 물리면 codex.ts가 `node <이 파일> exec …`로 실행한다.
// 출력은 실측 codex-cli 0.142.5 `codex exec --json`의 이벤트 형태를 따른다(codex.test.ts의 계약과 동일).
//
// env로 동작을 지정한다:
//   LAIN_FAKE_CODEX_OUT  — 받은 argv/stdin/cwd를 JSON으로 덤프할 경로
//   LAIN_FAKE_CODEX_MODE — 'ok'(기본) | 'fail'(stderr 남기고 코드 2) | 'hang'(3초 생존 후 마커)
//   LAIN_FAKE_CODEX_DONE — 'hang'이 끝까지 살아남았을 때 남기는 마커 경로(= abort 정리 실패 신호)
//
// process.exit는 쓰지 않는다 — 윈도우 파이프 stdout이 비동기라 마지막 줄이 잘린다.
const fs = require('node:fs')

const out = process.env.LAIN_FAKE_CODEX_OUT
const mode = process.env.LAIN_FAKE_CODEX_MODE || 'ok'
const done = process.env.LAIN_FAKE_CODEX_DONE

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n')

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  stdin += d
})
process.stdin.on('end', () => {
  if (out)
    fs.writeFileSync(
      out,
      JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }),
      'utf8',
    )

  if (mode === 'fail') {
    process.stderr.write('codex: stream error\ncodex: giving up\n')
    process.exitCode = 2
    return
  }

  emit({ type: 'thread.started', thread_id: 'th-0001' })
  emit({ type: 'turn.started' })
  emit({ type: 'item.completed', item: { type: 'agent_message', text: '먼저 살펴봤다' } })

  if (mode === 'hang') {
    // abort로 트리 종료되면 이 타이머는 못 돈다 — 마커가 생기면 정리 실패다.
    setTimeout(() => {
      if (done) fs.writeFileSync(done, 'alive', 'utf8')
    }, 3000)
    return
  }

  emit({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'npm test', exit_code: 0, status: 'completed' },
  })
  emit({
    type: 'item.completed',
    item: { type: 'file_change', changes: [{ path: 'C:\\wt\\a.ts', kind: 'add' }], status: 'completed' },
  })
  emit({ type: 'item.completed', item: { type: 'agent_message', text: '끝났다' } })
  emit({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5 },
  })
})
