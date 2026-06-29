// 앱 진입 (PLAN.md §14) — BrowserWindow 생성, 스토어/IPC 초기화
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'
import {
  initStore,
  listProjects,
  listTasks,
  getTask,
  listTaskEvents,
  getSettings,
  saveSettings,
  clearOrphanApprovals,
  closeStore,
  ensureActiveConversation,
  getConversationContextTokens,
  getConversationWorldState,
  getSetting,
  setSetting,
} from './store'
import { registerIpc } from './ipc'
import { notifyUser } from './notify'
import { scanProjects, addProject } from './registry'
import { collectStatus } from './collectors'
import { sendToManager, reactToObservation } from './manager'
import { setObserveHandler, stopWatcher } from './watcher'
import { sendToNavi } from './navichat'
import { startTask, answerClarify, recoverTasks, cancelTask } from './orchestrator'
import { gcWorktrees } from './worktree'
import { setupTray, isQuitting } from './tray'
import {
  createOverlayWindow,
  destroyOverlayWindow,
  setMainWindowGetter,
  syncOverlayMode,
} from './overlay-window'
import { rearmScheduler, runScanOnce, briefNow } from './scheduler'
import { applyCcHooks } from './cchooks'
import { startTelegram, stopTelegram } from './telegram'
import { startDiscord, stopDiscord } from './discord'
import { DATA_DIR } from './paths'
import { appendCapped } from './logfile'
import { initUpdater } from './updater'

// 최후 안전망 — 메인은 텔레그램 폴러·스케줄러·Navi·watcher 등 fire-and-forget 비동기가 많다.
// 그 중 하나라도 미처리 거부/예외로 새면 Node 기본 동작상 데몬 전체(트레이·작업·승인큐)가 죽는다.
// 로그만 남기고 살린다(시크릿 미노출 — message/stack만). 등록은 가능한 한 일찍.
process.on('unhandledRejection', (reason) => {
  appendCapped(
    path.join(DATA_DIR, 'crash.log'),
    `${new Date().toISOString()} unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
  )
})
process.on('uncaughtException', (err) => {
  appendCapped(
    path.join(DATA_DIR, 'crash.log'),
    `${new Date().toISOString()} uncaughtException: ${err?.message}\n${err?.stack ?? ''}\n`,
  )
})

// 이 머신의 GPU 컴포지터(Viz)가 화면 출력을 검게 만드는 문제 우회 —
// capturePage(오프스크린)는 정상인데 온스크린만 검은 증상 + UnknownVizError.
// UI는 CSS뿐이라 소프트웨어 렌더링으로 충분하다.
app.disableHardwareAcceleration()

let mainWin: BrowserWindow | null = null

function createWindow(): void {
  // 자동 시작(--hidden)이면 트레이로만 기동 (§12.5b)
  const startHidden = process.argv.includes('--hidden')
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Lain',
    backgroundColor: '#07060e',
    autoHideMenuBar: true,
    // OS 타이틀바 제거 — 컨트롤은 앱 헤더(.manager-bar)에 통합. 리사이즈 보더는 유지.
    titleBarStyle: 'hidden',
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
    },
  })
  mainWin = win
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
    // 메인이 진짜 닫히면(트레이 숨김이 아님) 오버레이·감시도 정리 — window-all-closed/종료 정상화 + 고아 PS 방지.
    stopWatcher()
    destroyOverlayWindow()
  })
  // 커스텀 타이틀바 최대화 아이콘 동기화 (네이티브 더블클릭 최대화 포함)
  win.on('maximize', () => win.webContents.send('window:maximized', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized', false))
  // 어깨너머 — 메인창 가시성 변화에 맞춰 오버레이/감시 on/off 재평가
  win.on('hide', () => syncOverlayMode())
  win.on('minimize', () => syncOverlayMode())
  win.on('restore', () => syncOverlayMode())
  win.on('show', () => syncOverlayMode())
  win.on('focus', () => syncOverlayMode())
  // Phase 3 트레이 상주: 닫기 = 숨김 (설정 closeToTray, 종료는 트레이 메뉴/before-quit)
  // getSettings()가 손상 DB에서 throw해도 close 핸들러가 깨져 '종료 불능'이 되지 않게 가드(기본=트레이 상주).
  win.on('close', (e) => {
    let closeToTray = true
    try {
      closeToTray = getSettings().closeToTray
    } catch {
      /* 손상 DB — 기본값(트레이 상주)으로 진행 */
    }
    if (!isQuitting() && closeToTray) {
      e.preventDefault()
      win.hide()
    }
  })
  // §15b 복원력: 렌더러 프로세스가 죽으면(GPU 크래시 등) 로그 남기고 자동 reload.
  // Navi는 main 프로세스에서 돌므로 영향 없음 — UI만 살리면 된다.
  win.webContents.on('render-process-gone', (_e, details) => {
    appendCapped(
      path.join(DATA_DIR, 'renderer-crash.log'),
      `${new Date().toISOString()} ${JSON.stringify(details)}\n`,
    )
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') {
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reload()
      }, 1000)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 개발용: LAIN_SHOT=<png 경로>면 로드 후 자기 화면을 캡처해 저장 (헤드리스 검증용)
  const shotPath = process.env.LAIN_SHOT
  if (shotPath) {
    const log = (m: string) => fs.appendFileSync(shotPath + '.log', m + '\n')
    log(`shot armed: ${shotPath}`)
    win.webContents.once('did-finish-load', () => {
      log('did-finish-load')
      let tries = 0
      const attempt = async () => {
        tries++
        try {
          // LAIN_SHOT_CLICK=<CSS 셀렉터>면 캡처 전에 1회 클릭 (패널/드로어 검증용)
          const clickSel = process.env.LAIN_SHOT_CLICK
          if (clickSel && tries === 1) {
            await win.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(clickSel)})?.click()`,
            )
            await new Promise((r) => setTimeout(r, 500))
          }
          // LAIN_SHOT_JS=<JS>면 캡처 전에 1회 실행 (셀렉트 전환 등 클릭으로 안 되는 조작)
          const shotJs = process.env.LAIN_SHOT_JS
          if (shotJs && tries === 1) {
            const jsResult = await win.webContents.executeJavaScript(shotJs)
            log(`js: ${JSON.stringify(jsResult)}`)
            await new Promise((r) => setTimeout(r, 500))
          }
          const img = await win.webContents.capturePage()
          fs.writeFileSync(shotPath, img.toPNG())
          log(`saved ${img.getSize().width}x${img.getSize().height} (try ${tries})`)
        } catch (e) {
          log(`capture try ${tries} failed: ${e}`)
          if (tries < 4) setTimeout(attempt, 2000)
        }
      }
      setTimeout(attempt, 2500)
    })
  }
}

// 단일 인스턴스 보장 — 이미 실행 중이면 새 인스턴스는 종료하고 기존 창을 복원·포커스한다.
// 중복 실행(창 2개)과 텔레그램 getUpdates 409 충돌(폴러는 봇 토큰당 1개여야 함)을 원천 차단.
// 자동시작·아이콘 더블클릭·외부 실행이 겹쳐도 항상 1개만 산다.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', (_e, argv) => {
  // deploy가 `lain.exe --quit`로 graceful 종료를 요청 — before-quit가 WAL을 메인 DB에 체크포인트(TRUNCATE)해
  // 강제종료(Stop-Process -Force)로 인한 WAL 손상/폐기를 피한다(설정 유실의 상류 트리거 제거).
  if (argv.includes('--quit')) return void app.quit()
  const win = mainWin
  if (!win) return void createWindow()
  if (win.isMinimized()) win.restore()
  win.show() // 트레이로 숨어 있었으면 다시 표시
  win.focus()
})

app.whenReady().then(async () => {
  // 2번째 인스턴스는 락을 못 얻어 곧 종료되므로 스토어/창/텔레그램 초기화를 건너뛴다(이중 폴러 방지).
  if (!hasInstanceLock) return
  // 미실행 상태에서 deploy가 --quit로 호출한 경우(우리가 primary): 띄울 것 없이 즉시 종료.
  if (process.argv.includes('--quit')) return void app.quit()
  // 부팅 단계 격리 — 한 단계가 throw해도 나머지(특히 텔레그램 원격 lifeline·트레이·스케줄러)를 막지 않는다.
  // 손상 DB 부팅(quick_check 실패→REINDEX 후 잔여 손상)에서 getSettings 등이 터져 텔레그램까지 못 가
  // '반쪽 초기화'로 응답 불능이 되던 회귀를 차단(2026-06-22 사고). 실패 단계는 recovery.log에 남긴다.
  const bootStep = (name: string, fn: () => void) => {
    try {
      fn()
    } catch (e) {
      try {
        fs.appendFileSync(
          path.join(DATA_DIR, 'recovery.log'),
          `${new Date().toISOString()} 부팅 단계 '${name}' 실패(격리·계속): ${e}\n`,
        )
      } catch {
        /* 로그 실패 무시 */
      }
    }
  }

  // initStore는 코어 — 격리하면 db가 undefined로 남아 이후가 '빈 DB 좀비'가 된다. 직접 호출(자체 손상 복구
  // 보유: read-only 프로브·WAL 폐기·REINDEX). 진짜로 throw하면 DB 불능이라 부팅 중단이 명확한 게 낫다.
  // 나머지 post-init 단계만 격리해 '반쪽 부팅'(텔레그램 미기동)을 막는다 — 이게 실제 사고의 원인이었다.
  initStore()
  bootStep('registerIpc', () => registerIpc())

  // 고아 worktree 정리 (§15b GC) — 활성 task에 없는 잔재 제거
  try {
    const active = new Set(
      listTasks()
        .filter((t) => !['done', 'cancelled', 'error'].includes(t.state))
        .map((t) => t.id),
    )
    gcWorktrees(active, listProjects())
  } catch {
    /* GC 실패는 치명적이지 않음 */
  }

  // 개발용: LAIN_AUTOSCAN=1이면 창 띄우기 전에 스캔+현황 수집 (검증용)
  if (process.env.LAIN_AUTOSCAN) {
    scanProjects()
    await Promise.all(listProjects().filter((p) => p.enabled).map((p) => collectStatus(p)))
  }

  bootStep('createWindow', () => createWindow())

  // 어깨너머 오버레이 — 창 생성(숨김) + 메인창 getter 등록 + 현재 상태 평가(토글 OFF면 no-op)
  bootStep('overlay', () => {
    createOverlayWindow()
    setMainWindowGetter(() => mainWin)
    setObserveHandler((obs) => void reactToObservation(obs)) // L0 watcher → L1 반응
    syncOverlayMode()
  })

  // §20.3 텔레그램 — 원격 제어 lifeline을 트레이·스케줄러보다 '먼저' 확보(앞 단계 실패에 가장 취약하던 위치 교정).
  bootStep('startTelegram', () => void startTelegram())
  // §20.3 디스코드 음성 통화 어댑터 — 설정 활성 시에만 로그인(미설정이면 즉시 no-op)
  bootStep('startDiscord', () => void startDiscord())

  // Phase 3: 트레이 상주 + 주기 스캔 (§15, §12.5b) — 각각 격리
  bootStep('setupTray', () => setupTray(() => mainWin, createWindow))
  bootStep('rearmScheduler', () => rearmScheduler())
  // 자동 업데이트 엔진 — 패키징본만 동작(dev no-op). 부팅 8초 후 1회 + 6시간 주기 체크.
  bootStep('updater', () => initUpdater())
  // 클로드코드 연동(개선 #2) — 켜져 있으면 훅 설치 + inbox 감시 시작(꺼졌으면 잔여 훅 제거). 격리.
  bootStep('ccHooks', () => applyCcHooks())
  // 시작 시 레인 브리핑 1회 생성(프로덕션엔 startup 스캔이 없어 주기 스캔 전까지 브리핑이 비던 것 교정).
  // 약간 지연 — 렌더러가 onBriefingUpdated 리스너를 등록한 뒤 push가 닿도록(생성 결과는 setting에도 영속).
  setTimeout(() => void briefNow(), 2500)
  // DB 재발 손상 지연 통지 — repairIndexesIfCorrupt는 창 생성 전(initStore)에 돌아 직접 notify를 못 띄운다.
  // 자동치유가 3회 연속 실패하면 setting 플래그(db_corrupt_pending_notify)에 진단을 남겨두는데, 창·notify가
  // 준비된 지금(부팅 후반) 그 플래그를 읽어 한 번 띄우고 클리어한다. 격리(try) — 통지 실패가 부팅을 안 깬다.
  setTimeout(() => {
    try {
      const pending = getSetting('db_corrupt_pending_notify')
      if (pending) {
        notifyUser('DB 점검 필요', pending)
        setSetting('db_corrupt_pending_notify', '')
      }
    } catch {
      /* 통지 실패는 무시 */
    }
  }, 2500)

  // 크래시 복원 (§15b) — 고아 승인 정리 후 미완 task 재개
  try {
    const orphans = clearOrphanApprovals()
    const recovered = recoverTasks()
    if (recovered > 0) {
      fs.appendFileSync(
        path.join(DATA_DIR, 'recovery.log'),
        `${new Date().toISOString()} recovered=${recovered} orphan_approvals=${orphans}\n`,
      )
    }
  } catch (e) {
    try {
      fs.appendFileSync(
        path.join(DATA_DIR, 'recovery.log'),
        `${new Date().toISOString()} recovery failed: ${e}\n`,
      )
    } catch {
      /* 로그 실패 무시 — 이중 throw로 whenReady가 reject되지 않게 */
    }
  }
  // 패키징 실행에서만 — dev는 electron.exe 경로라 로그인 항목 등록이 무의미. getSettings()가 손상 DB에서
  // throw해도 whenReady가 reject되지 않게 격리(이후 dev 훅·activate 등록이 죽지 않게).
  bootStep('loginItem', () => {
    if (!process.env.ELECTRON_RENDERER_URL)
      app.setLoginItemSettings({ openAtLogin: getSettings().autoStart, args: ['--hidden'] })
  })

  // 개발용: LAIN_TASK_TEST=<프로젝트 경로>면 그 폴더를 등록하고 TASK.md로 작업 시작 (E2E 검증)
  // LAIN_TASK_ANSWER가 있으면 blocked(명확화 질문) 시 자동 답변 1회.
  const taskTest = process.env.LAIN_TASK_TEST
  if (taskTest) {
    const logPath = path.join(DATA_DIR, 'task-test.log')
    const tlog = (m: string) => fs.appendFileSync(logPath, m + '\n')
    const project = addProject(taskTest)
    tlog(`project: ${project.id}`)
    void startTask(project.id).then((res) => {
      tlog(`start: ${JSON.stringify(res)}`)
      const autoAnswer = process.env.LAIN_TASK_ANSWER
      if (!res.taskId || !autoAnswer) return
      let answered = false
      const timer = setInterval(() => {
        const t = getTask(res.taskId!)
        if (!t || ['review', 'done', 'error', 'cancelled'].includes(t.state)) {
          clearInterval(timer)
          tlog(`final: ${t?.state}`)
          return
        }
        if (t.state === 'blocked' && !answered) {
          answered = true
          tlog(`auto-answer: ${t.questions.join(' / ')}`)
          void answerClarify(t.id, autoAnswer)
        }
      }, 5000)
    })
  }

  // 개발용: LAIN_INTERRUPT_TEST="<프로젝트경로>|<인터럽트메시지>"면 작업 시작 후
  // working+세션 잡히면 인터럽트 1회 주입 (§5.7 검증). 결과는 data/interrupt-test.log.
  const itTest = process.env.LAIN_INTERRUPT_TEST
  if (itTest) {
    const sep = itTest.indexOf('|')
    const itPath = itTest.slice(0, sep)
    const itMsg = itTest.slice(sep + 1)
    const logPath = path.join(DATA_DIR, 'interrupt-test.log')
    fs.writeFileSync(logPath, `hook-start ${new Date().toISOString()}\n`)
    const project = addProject(itPath)
    void startTask(project.id).then((res) => {
      fs.appendFileSync(logPath, `start ${JSON.stringify(res)}\n`)
      if (!res.taskId) return
      let sent = false
      const timer = setInterval(() => {
        const t = getTask(res.taskId!)
        if (!t || ['review', 'done', 'error', 'cancelled'].includes(t.state)) {
          clearInterval(timer)
          fs.appendFileSync(logPath, `final ${t?.state}\n`)
          return
        }
        if (t.state === 'working' && t.naviSessionId && !sent) {
          sent = true
          void sendToNavi(project.id, itMsg, () => {}).then((r) =>
            fs.appendFileSync(logPath, `interrupt-sent ${JSON.stringify(r)}\n`),
          )
        }
      }, 2000)
    })
  }

  // 개발용: LAIN_BENCH=<conditions>면 부팅 직후 평가 하네스 실행 (§23).
  // 예: LAIN_BENCH=both / LAIN_BENCH=no-lessons / LAIN_BENCH=with-lessons
  const benchEnv = process.env.LAIN_BENCH
  if (benchEnv) {
    const logPath = path.join(DATA_DIR, 'bench-test.log')
    const conditions =
      benchEnv === 'no-lessons'
        ? (['no-lessons'] as const)
        : benchEnv === 'with-lessons'
          ? (['with-lessons'] as const)
          : (['no-lessons', 'with-lessons'] as const)
    fs.writeFileSync(logPath, `bench start ${new Date().toISOString()}\n`)
    import('./bench')
      .then(({ runBench }) => runBench(new Date().toISOString(), { conditions: [...conditions] }))
      .then((summary) => {
        fs.appendFileSync(logPath, `SUMMARY ${JSON.stringify(summary.byCondition)}\n`)
        fs.appendFileSync(logPath, `done ${new Date().toISOString()}\n`)
      })
      .catch((e) => fs.appendFileSync(logPath, `bench failed: ${e}\n${e?.stack ?? ''}\n`))
  }

  // 개발용: LAIN_SCAN_TEST=1이면 부팅 직후 주기 스캔 1회 (autoPriority 검증용)
  if (process.env.LAIN_SCAN_TEST) {
    void runScanOnce().then(() =>
      fs.appendFileSync(
        path.join(DATA_DIR, 'scan-test.log'),
        `done ${new Date().toISOString()}\n`,
      ),
    )
  }

  // 개발용: LAIN_WORKERCHAT_TEST="<프로젝트경로>|<메시지>"면 Navi 직접 채팅 E2E (§5.6 검증용)
  const wcTest = process.env.LAIN_WORKERCHAT_TEST
  if (wcTest) {
    const sep = wcTest.indexOf('|')
    const wcPath = wcTest.slice(0, sep)
    const wcMsg = wcTest.slice(sep + 1)
    const logPath = path.join(DATA_DIR, 'workerchat-test.log')
    const lines: string[] = [`hook-start ${new Date().toISOString()}`]
    fs.writeFileSync(logPath, lines.join('\n'))
    const wcProject = addProject(wcPath)
    void sendToNavi(wcProject.id, wcMsg, (ev) => {
      lines.push(JSON.stringify(ev))
      fs.writeFileSync(logPath, lines.join('\n'))
    }).then((res) => {
      lines.push(`done ${JSON.stringify(res)}`)
      fs.writeFileSync(logPath, lines.join('\n'))
    })
  }

  // 개발용: LAIN_CHAT_TEST="메시지"면 관리자에게 보내고 이벤트를 파일로 기록 (SDK 검증용)
  const chatTest = process.env.LAIN_CHAT_TEST
  if (chatTest) {
    const logPath = path.join(DATA_DIR, 'chat-test.log')
    const lines: string[] = [`hook-start ${new Date().toISOString()}`]
    fs.writeFileSync(logPath, lines.join('\n'))
    void sendToManager(chatTest, (ev) => {
      lines.push(JSON.stringify(ev))
      fs.writeFileSync(logPath, lines.join('\n'))
    })
  }

  // 개발용: LAIN_COMPACT_TEST=<임계>(또는 1)이면 무한세션 압축을 라이브 검증한다.
  //   임계를 낮춰 매니저를 2턴 구동 — 턴1=사실 기억(이후 context_tokens 기록), 턴2 진입 시 shouldCompact가
  //   발화해 world_state 압축·세션 리셋·<world-state> 재주입. 턴2가 그 사실을 회상하면 '압축을 건넌 연속성' 실측.
  //   결과는 compact-test.log (압축 발화·world_state·연속성). 격리 데이터(dev=C:\lain\data)라 설치본 무영향.
  const compactTest = process.env.LAIN_COMPACT_TEST
  if (compactTest) {
    const logPath = path.join(DATA_DIR, 'compact-test.log')
    const lines: string[] = [`compact-test start ${new Date().toISOString()}`]
    const flush = () => fs.writeFileSync(logPath, lines.join('\n'))
    flush()
    void (async () => {
      try {
        const n = Number(compactTest)
        const lowThreshold = Number.isFinite(n) && n > 1 ? Math.floor(n) : 500
        saveSettings({ contextCompactThreshold: lowThreshold })
        const conv = ensureActiveConversation('manager')
        const SECRET = '7391'
        lines.push(`threshold→${lowThreshold} conv=${conv}`); flush()
        lines.push('--- turn1: 사실 기억 ---'); flush()
        await sendToManager(
          `기억해라: 비밀코드는 ${SECRET}. 다른 말 없이 "기억함"만 한 줄로 답해.`,
          (ev) => { lines.push('1:' + JSON.stringify(ev)); flush() },
          false, [], 0, conv,
        )
        lines.push(`turn1 done · context_tokens=${getConversationContextTokens(conv)}`); flush()
        lines.push('--- turn2: 회상 (진입 시 압축 트리거 기대) ---'); flush()
        await sendToManager(
          '방금 기억하라고 한 비밀코드가 뭐였지? 숫자만 답해.',
          (ev) => { lines.push('2:' + JSON.stringify(ev)); flush() },
          false, [], 0, conv,
        )
        const ws = getConversationWorldState(conv)
        lines.push(`world_state(len=${ws?.length ?? 0}): ${(ws ?? '').replace(/\n/g, ' ').slice(0, 500)}`)
        lines.push(`compact-test done ${new Date().toISOString()}`); flush()
      } catch (e) {
        lines.push(`ERROR ${String(e)}`); flush()
      }
    })()
  }

  // 개발용: LAIN_TASKHANDOFF_TEST=<임계>(또는 1)이면 worker(A 자율작업) 유한세션 핸드오프 스왑을 라이브 검증한다.
  //   naviHandoffThreshold를 낮추고, verify(test)가 *항상 실패*하는 자체 git 픽스처로 작업을 시작 → 첫 verify-retry가
  //   '재개 경계'가 되어, 턴1에서 쌓인 점유가 임계를 넘으면 worker가 세션을 갈아끼운다(핸드오프 md 작성·세션 리셋).
  //   실측: 턴1 세션id → '🔄 세션 교체' 이벤트 → 새 세션id(≠턴1)·handoffMd·미러파일. 결과는 taskhandoff-test.log.
  //   격리 데이터(dev=PROJECT_ROOT/data)라 설치본 무영향. 스왑 확인 후 task는 취소(불필요한 SDK 비용 차단).
  const thTest = process.env.LAIN_TASKHANDOFF_TEST
  if (thTest) {
    const logPath = path.join(DATA_DIR, 'taskhandoff-test.log')
    const lines: string[] = [`taskhandoff-test start ${new Date().toISOString()}`]
    const flush = () => fs.writeFileSync(logPath, lines.join('\n'))
    flush()
    void (async () => {
      try {
        const n = Number(thTest)
        const threshold = Number.isFinite(n) && n > 1 ? Math.floor(n) : 500
        saveSettings({ naviHandoffThreshold: threshold })
        // 자체 픽스처 — test가 항상 실패하는 git 프로젝트(verifyCmd = scripts.test). 첫 verify-retry가 스왑 경계.
        // 위치는 DATA_DIR 밖(os.tmpdir): worktree(WT_ROOT=DATA_DIR/wt)는 어쩔 수 없이 DATA_DIR 하위지만,
        // 프로젝트 자체를 밖에 두고 TASK를 *파일 조작 없이 npm test만 실행*하게 해 secret_denied(차단 latch→blocked)를 피한다.
        const dir = path.join(os.tmpdir(), `lain-handoff-e2e-${Date.now().toString(36)}`)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, 'package.json'),
          JSON.stringify(
            { name: 'handoff-swap', version: '0.0.0', scripts: { test: 'node -e "console.error(\'FAIL: 검증은 의도적으로 항상 실패한다\'); process.exit(1)"' } },
            null,
            2,
          ),
        )
        fs.writeFileSync(
          path.join(dir, 'TASK.md'),
          '# 핸드오프 스왑 E2E (진단 전용)\n\n파일을 읽거나 만들거나 고치지 마라. 오직 `npm test`만 실행해서 그 결과(통과/실패)를 한 줄로 보고하고 끝내라.\n',
        )
        const sh = (c: string) => execSync(c, { cwd: dir, stdio: 'ignore' })
        sh('git init -q')
        sh('git add -A')
        sh('git -c user.email=a@b.c -c user.name=lain commit -qm init')
        lines.push(`threshold→${threshold} fixture=${dir}`); flush()

        const project = addProject(dir)
        lines.push(`project=${project.id} verifyCmd=${project.verifyCmd}`); flush()
        const res = await startTask(project.id, { mode: 'autonomous', skipClarify: true })
        lines.push(`start ${JSON.stringify(res)}`); flush()
        if (!res.taskId) { lines.push('no taskId — abort'); flush(); return }
        const taskId = res.taskId

        let firstSession = ''
        let swapSeen = false
        let newSession = ''
        let answered = false
        const startMs = Date.now()
        const timer = setInterval(() => {
          const t = getTask(taskId)
          if (!t) return
          if (!firstSession && t.naviSessionId) {
            firstSession = t.naviSessionId
            lines.push(`turn1 session=${firstSession}`); flush()
          }
          // 막힘(세션·worktree 보유) → 1회 자동답변 → answerClarify가 launch2 resume으로 재개 = 스왑 경계.
          // 거기서 점유(contextTokens)가 임계(500)를 넘으면 worker가 세션을 갈아끼운다(핸드오프 스왑).
          if (t.state === 'blocked' && t.naviSessionId && t.worktreePath && !answered) {
            answered = true
            lines.push(`blocked — at-block contextTokens=${t.contextTokens ?? 0} → 자동답변으로 재개 경계 강제`); flush()
            void answerClarify(taskId, '테스트는 무시하고, 지금까지 확인한 내용으로 작업을 done 상태로 마무리해라.')
          }
          const events = listTaskEvents(taskId, 300)
          const swap = events.find((e) => e.kind === 'status' && String(e.text).includes('세션 교체'))
          if (swap && !swapSeen) {
            swapSeen = true
            lines.push(`SWAP DETECTED: ${swap.text}`)
            lines.push(`handoffMd=${t.handoffMd ? `len ${t.handoffMd.length}` : 'null'}`)
            lines.push(`mirror exists=${fs.existsSync(path.join(DATA_DIR, 'handoffs', `task-${taskId}.md`))}`)
            flush()
          }
          if (swapSeen && !newSession && t.naviSessionId && t.naviSessionId !== firstSession) {
            newSession = t.naviSessionId
            lines.push(`turn2 session=${newSession} (≠턴1 ${firstSession}) — 세션 스왑·연속성 확인`); flush()
            void cancelTask(taskId) // 스왑 확인 — 더 돌릴 필요 없음(SDK 비용 차단)
          }
          const elapsed = Date.now() - startMs
          if (['review', 'done', 'error', 'cancelled'].includes(t.state) || (swapSeen && newSession) || elapsed > 10 * 60_000) {
            clearInterval(timer)
            lines.push(`final state=${t.state} swapSeen=${swapSeen} newSession=${newSession || '(none)'}`)
            lines.push(`taskhandoff-test done ${new Date().toISOString()}`)
            flush()
          }
        }, 3000)
      } catch (e) {
        lines.push(`ERROR ${String(e)}\n${(e as Error)?.stack ?? ''}`); flush()
      }
    })()
  }

  app.on('activate', () => {
    // 상주 오버레이창 때문에 getAllWindows()는 0이 안 되므로 메인창 존재로 판정.
    if (!mainWin || mainWin.isDestroyed()) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 트레이 상주 중이면 창이 다 닫혀도 백그라운드 유지 (§12.5b). 손상 DB throw 시 기본=상주.
  let closeToTray = true
  try {
    closeToTray = getSettings().closeToTray
  } catch {
    /* 손상 DB — 기본값 유지 */
  }
  if (!closeToTray) app.quit()
})

app.on('before-quit', () => {
  // §20.3 텔레그램 폴 루프 정리 (abort)
  stopTelegram()
  stopDiscord()
  // 어깨너머 상주 PowerShell·오버레이 정리 — 안 죽이면 종료/배포 반복마다 고아 PS가 쌓인다.
  stopWatcher()
  destroyOverlayWindow()
  // WAL을 메인에 합치고 DB를 닫는다 — WAL이 비대한 채 방치되다 다음 강제종료에 손상되는 경로를 줄인다.
  closeStore()
})
