// 경로 단일 출처 — app.getAppPath()는 실행 방식(electron ., electron out/main/index.js)에
// 따라 달라지므로 쓰지 않는다. 번들 위치(out/main) 기준으로 프로젝트 루트를 고정.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export const PROJECT_ROOT = path.join(__dirname, '..', '..')

export const DATA_DIR = app.isPackaged
  ? app.getPath('userData')
  : path.join(PROJECT_ROOT, 'data')

// SDK 에이전트 spawn의 cwd — 패키징본은 PROJECT_ROOT가 app.asar(파일)라 cwd로 못 쓴다.
// 파일 도구 없는 에이전트(Lain 채팅·clarify·scheduler)의 작업 디렉터리로 실제 폴더를 준다.
export const AGENT_CWD = app.isPackaged ? DATA_DIR : PROJECT_ROOT

// §23 벤치 fixture 위치. dev는 repo의 bench/, 패키징본은 extraResources로 푼 실폴더(resources/bench).
// PROJECT_ROOT는 패키징본에서 app.asar(파일) 내부라 materialize의 cpSync가 못 읽으므로 실폴더로 분기.
export const BENCH_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bench')
  : path.join(PROJECT_ROOT, 'bench')

// lain 자기 소스 체크아웃 — 자기-업데이트(deploy_lain·텔레그램 /deploy·시스템 프롬프트 안내)의 대상.
// 순서: LAIN_SELF_DIR env → dev 실행 시 자기 레포(PROJECT_ROOT) → 메인테이너 관례 경로 C:\lain.
// 후보는 "진짜 lain 소스"일 때만 채택(git 체크아웃 + package.json name==='lain') — 다른 PC의
// 무관한 동명 폴더에 git/배포를 치는 사고 방지. 못 찾으면 null = 자기-업데이트 비활성(클론 사용자 기본).
export const SELF_SRC_DIR: string | null = (() => {
  const candidates = [process.env.LAIN_SELF_DIR, PROJECT_ROOT, 'C:\\lain'].filter(
    (c): c is string => !!c,
  )
  for (const c of candidates) {
    try {
      if (!fs.existsSync(path.join(c, '.git'))) continue
      const pkg = JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8'))
      if (pkg?.name === 'lain') return c
    } catch {
      /* 후보 아님 — 다음 */
    }
  }
  return null
})()

// SDK 네이티브 바이너리(@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]) 절대경로.
// pathToClaudeCodeExecutable 미지정 시 SDK는 import.meta.url(=app.asar 내부) 기준으로 이 바이너리를
// 찾는데, 패키징본은 그 경로가 app.asar 안이라 OS가 실행하지 못한다("native binary exists but failed
// to launch" — asar 내부 .exe는 실행 불가). asarUnpack(node_modules/@anthropic-ai/**)된 실제 폴더로
// 바꿔 query 옵션에 명시 지정한다. dev는 PROJECT_ROOT가 실제 폴더라 그대로 동작(자동해석 경로와 동일).
export const CLAUDE_BIN = (() => {
  const rel = path.join(
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  )
  const p = path.join(PROJECT_ROOT, rel)
  return app.isPackaged
    ? p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : p
})()
