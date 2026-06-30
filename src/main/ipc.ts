// IPC 핸들러 (PLAN.md §4) — Renderer ↔ L0. 변경 후엔 projects:updated 푸시.
import { execFile } from 'node:child_process'
import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import {
  listProjects,
  setProjectEnabled,
  hideProject,
  unhideProject,
  getProject,
  listMessages,
  listTasks,
  updateTask,
  listApprovals,
  listTaskEvents,
  getSetting,
  getSettings,
  saveSettings,
  listNaviMessages,
  listConversationPreviews,
  listConversations,
  createConversation,
  listConversationMessages,
  ensureActiveConversation,
  setActiveConversation,
  deleteConversation,
  renameConversation,
  setChapter,
  listLessons,
  getTask,
  flagLesson,
  unflagLesson,
  pinLesson,
  insertLesson,
  revertConsolidationBatch,
  listRoutines,
  insertRoutine,
  setRoutineEnabled,
  deleteRoutine,
  listMcpServers,
  insertMcpServer,
  updateMcpServer,
  setMcpServerEnabled,
  deleteMcpServer,
} from './store'
import { listPlugins, installPlugin, uninstallPlugin } from './plugins'
import {
  getUpdateStatus,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  setUpdateBroadcaster,
  applyUpdaterSettings,
} from './updater'
import { sendToNavi, sendToAllNavis, stopNaviChat } from './navichat'
import { diffBody } from './worktree'
import { setInboxOpen } from './notify'
import { scanProjects, addProject } from './registry'
import { collectStatus, runVerify } from './collectors'
import {
  sendToManager,
  stopManager,
  resetManager,
  bindManager,
  bindManagerRenderer,
  answerUserQuestion,
} from './manager'
import { applyCcHooks, refreshCcLinkIfEnabled } from './cchooks'
import { syncOverlayMode, openMainWindow, resizeOverlay } from './overlay-window'
import { bindTitleRefresh } from './title'
import {
  bindOrchestrator,
  startTask,
  answerClarify,
  resolveReview,
  cancelTask,
  resumeTask,
} from './orchestrator'
import { resolveApproval } from './worker'
import { bindScheduler, rearmScheduler } from './scheduler'
import { restartTelegram, telegramReconcile, telegramStatus } from './telegram'
import { discordStatus, restartDiscord, bindDiscordState } from './discord'
import { refreshTray } from './tray'
import { capTaskImages } from './taskimages'
import { app } from 'electron'
import type { LainSettings } from '../shared/types'

// 앱(main 프로세스) 기동 시각 — 모듈 로드(=프로세스 시작) 시 1회 고정. 렌더러가 크래시 후 자동
// reload(index.ts render-process-gone)돼도 불변이라 '이번 실행' 경계의 단일 출처가 된다. 렌더러가
// 모듈 const로 직접 now를 계산하면 reload마다 경계가 '지금'으로 밀려 이번 세션 메시지가 콜드스타트처럼
// 통째로 숨겨졌다. store.nowStamp와 동일 UTC 'YYYY-MM-DD HH:MM:SS' 포맷으로 맞춘다(문자열 비교 정합).
const APP_STARTED_AT = new Date().toISOString().slice(0, 19).replace('T', ' ')

function broadcast(channel: string, payload: unknown): void {
  // 파괴/크래시 중인 webContents에 send하면 throw → 비동기 콜백(스케줄러·오케스트레이터 등)에서
  // 미처리 예외가 된다. 창별로 가드+try로 한 창 실패가 나머지·호출자를 죽이지 않게 한다.
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, payload)
    } catch {
      /* 렌더러 reload/destroy 찰나 — 무시 */
    }
  }
}

function pushProjects(): void {
  broadcast('projects:updated', listProjects())
  refreshCcLinkIfEnabled() // 클로드코드 연동 — 등록 프로젝트 목록·다이제스트를 훅이 읽는 파일에 반영
}

async function refresh(id: string | null): Promise<void> {
  const targets = id
    ? [getProject(id)].filter((p) => p !== null)
    : listProjects().filter((p) => p.enabled)
  await Promise.all(targets.map((p) => collectStatus(p)))
  pushProjects()
}

export function registerIpc(): void {
  // 자동 업데이트 상태를 렌더러로 흘려보낼 broadcaster 주입(엔진은 index.ts initUpdater에서 시작)
  setUpdateBroadcaster((s) => broadcast('update:status', s))
  // 창 제어 (frameless) — sender의 BrowserWindow에 위임
  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  ipcMain.handle('window:maximizeToggle', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return false
    if (w.isMaximized()) {
      w.unmaximize()
      return false
    }
    w.maximize()
    return true
  })
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  // 어깨너머 오버레이 — 클릭 시 메인창 복귀, 내용 높이에 맞춘 리사이즈(fire-and-forget)
  ipcMain.handle('window:openMain', () => openMainWindow())
  ipcMain.on('overlay:resize', (_e, height: number) => resizeOverlay(Number(height) || 0))

  ipcMain.handle('projects:list', () => listProjects())

  ipcMain.handle('projects:scan', async () => {
    const added = scanProjects()
    await refresh(null)
    return added
  })

  ipcMain.handle('projects:addDialog', async () => {
    const result = await dialog.showOpenDialog({
      title: '프로젝트 폴더 추가',
      defaultPath: 'C:\\workspace',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const project = addProject(result.filePaths[0])
    unhideProject(project.id) // 명시적 추가 → 숨김 해제(전에 제거했던 폴더면 보존된 기록과 함께 복귀)
    await refresh(project.id)
    return listProjects().find((p) => p.id === project.id) ?? null
  })

  ipcMain.handle('projects:setEnabled', (_e, id: string, enabled: boolean) => {
    setProjectEnabled(id, enabled)
    pushProjects()
  })

  // '제거' = 보드에서 숨김(데이터 보존). 하드 삭제 아님 — 같은 폴더 재추가 시 대화·교훈·작업 복원.
  ipcMain.handle('projects:remove', (_e, id: string) => {
    hideProject(id)
    pushProjects()
  })

  ipcMain.handle('projects:push', async (_e, id: string) => {
    const p = getProject(id)
    if (!p || !p.isGit) return { ok: false, output: '프로젝트 없음 또는 git 아님' }
    const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      execFile(
        'git',
        ['push', 'origin', 'HEAD'],
        { cwd: p.path, windowsHide: true, timeout: 30_000 },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            output: err ? (stderr || err.message).trim() : (stdout || '완료').trim(),
          })
        },
      )
    })
    if (result.ok) await refresh(id)
    return result
  })

  ipcMain.handle('status:refresh', (_e, id: string | null) => refresh(id))

  ipcMain.handle('verify:run', async (_e, id: string) => {
    const p = getProject(id)
    if (!p) return
    const done = runVerify(p) // 시작 시 동기적으로 running 기록
    pushProjects()
    await done
    pushProjects()
  })

  ipcMain.handle('chat:history', () => listMessages('manager'))
  ipcMain.handle('chat:previews', () => listConversationPreviews())

  ipcMain.handle('chat:send', async (_e, text: string, attachments?: import('../shared/types').FileAttachment[], conversationId?: string) => {
    // 렌더러 반영은 rendererMirror(bindManagerRenderer)가 conversationId 태깅해 단일 처리.
    // 여기서 다시 broadcast하면 이중 표시되므로 emit은 비워둔다.
    await sendToManager(text, () => {}, false, attachments ?? [], 0, conversationId, 'pc')
  })

  ipcMain.handle('chat:stop', () => {
    stopManager()
  })

  // Lain 세션 새로고침 — 무한세션이라 'Navi 새 대화'가 없어, 옛 스레드로 헛도는 Lain을 리셋하는 전용 수단.
  ipcMain.handle('chat:reset', () => {
    resetManager()
  })

  // ── Phase 1: tasks / approvals ──
  bindOrchestrator(
    (ev) => {
      broadcast('task:event', ev)
      broadcast('approvals:updated', listApprovals()) // 승인 생성/해소가 이벤트에 실려옴
      telegramReconcile() // §20.3 새 승인/질문/결재를 폰으로 즉시 푸시
      refreshTray()
    },
    () => {
      broadcast('tasks:updated', listTasks())
      telegramReconcile()
      refreshTray()
      refreshCcLinkIfEnabled() // 작업 상태 변화 → CC가 읽을 프로젝트 다이제스트 갱신(레인→CC)
    },
    () => pushProjects(), // 판단 요약(§10.2) 반영 시 카드 갱신
  )

  // Lain 와이어드 도구의 부수효과 UI 갱신 — orchestrator 비경유(scan/verify/refresh/approval/message)도
  // 카드·작업·승인 broadcast + 폰 reconcile로 보강한다. (경유 도구는 내부에서 이미 broadcast)
  bindManager({
    refreshProjects: () => pushProjects(),
    refreshTasks: () => {
      broadcast('tasks:updated', listTasks())
      telegramReconcile()
      refreshTray()
      refreshCcLinkIfEnabled() // 작업 상태 변화 → CC가 읽을 프로젝트 다이제스트 갱신(레인→CC)
    },
    refreshApprovals: () => {
      broadcast('approvals:updated', listApprovals())
      telegramReconcile()
    },
    // #1: 레인이 채팅으로 받은 디스코드 설정을 저장(준 값만 패치) + 어댑터 재기동. saveSettings·restartDiscord는
    // 여기(ipc)서만 호출 — manager가 discord/store-쓰기를 직접 import하면 순환참조라 hook으로 주입한다.
    setDiscordConfig: (cfg) => {
      const patch: Partial<import('../shared/types').LainSettings> = {}
      if (cfg.botToken !== undefined) patch.discordBotToken = cfg.botToken
      if (cfg.guildId !== undefined) patch.discordGuildId = cfg.guildId
      if (cfg.voiceChannelId !== undefined) patch.discordVoiceChannelId = cfg.voiceChannelId
      if (cfg.userId !== undefined) patch.discordUserId = cfg.userId
      if (cfg.enabled !== undefined) patch.discordEnabled = cfg.enabled
      saveSettings(patch)
      restartDiscord()
    },
    // Lain의 Navi 메시징(message_navi/broadcast_navis) 매 이벤트를 Navi채팅 패널·승인 카드·폰에
    // 즉시 흘린다 — Navi가 승인 대기로 블록되는 동안에도 승인 카드가 떠야 사용자가 풀 수 있다.
    onNaviEvent: (ev) => {
      broadcast('workerchat:event', ev)
      broadcast('approvals:updated', listApprovals())
      telegramReconcile()
    },
  })

  // 텔레그램·PC·스케줄러 등 모든 출처의 Lain 대화 이벤트를 렌더러로 미러(conversationId 태깅).
  // → 텔레그램發 대화가 PC에 라이브로 뜨고 대화 목록도 갱신된다(§20.3 연동).
  bindManagerRenderer((ev) => broadcast('chat:event', ev))
  // #3: 디스코드 통화 파이프라인 단계를 렌더러로 라이브 broadcast(배지 표시).
  bindDiscordState((ev) => broadcast('discord:state', ev))

  // 대화 제목 자동요약(judge) 완료 → 해당 target의 대화목록/미리보기 새로고침 알림. manager·Navi채팅 공용.
  bindTitleRefresh((target) => broadcast('conversations:updated', target))

  // Phase 3 주기 스캔 — 스캔 결과는 카드에, 자동 우선순위 보고는 관리자 채팅에, 비서 보고(B)는 독에 푸시
  bindScheduler(
    () => pushProjects(),
    (ev) => broadcast('chat:event', ev),
    (text) => broadcast('briefing:updated', text),
  )

  // B — 레인 독 보고(Claude prose). 마지막 생성분을 시작 시 노출.
  // getSetting이 settings 인덱스 손상으로 간헐적 throw하면(recovery.log REINDEX 루프) 핸들러가
  // reject돼 렌더러 briefing이 영영 null로 남는다 → 안전하게 null 반환(다음 생성 push로 채워짐).
  ipcMain.handle('briefing:get', () => {
    try {
      return getSetting('dock_briefing') ?? null
    } catch {
      return null
    }
  })
  ipcMain.handle('app:startedAt', () => APP_STARTED_AT)

  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:start', (_e, projectId: string) => startTask(projectId))
  ipcMain.handle('tasks:answer', (_e, taskId: string, answers: string) =>
    // 사용자 직접 답변(드로어 입력) → 사용자發 sender만 넘긴다. 태그는 answerClarify가 모델에 닿는
    // resume 프롬프트에만 붙이고, 영속 명세(task.content)에는 박지 않는다(명세 오염 방지).
    answerClarify(taskId, answers, 'user'),
  )
  ipcMain.handle('tasks:resolveReview', (_e, taskId: string, action: any) =>
    resolveReview(taskId, action),
  )
  ipcMain.handle('tasks:cancel', (_e, taskId: string) => cancelTask(taskId))
  ipcMain.handle('tasks:resume', (_e, taskId: string) => resumeTask(taskId)) // B3 error 상태 수동 재개
  // P2 권한모드 — 작업별 도구 실행 권한 강도 변경. 진행 중 쿼리엔 즉시 반영 안 되고 다음 재개부터 적용.
  ipcMain.handle(
    'tasks:setPermissionMode',
    (_e, taskId: string, mode: import('../shared/types').TaskPermissionMode) => {
      updateTask(taskId, { permissionMode: mode })
      broadcast('tasks:updated', listTasks())
    },
  )
  // P2 thinking 예산 / 금지 도구 — 다음 재개부터 적용.
  ipcMain.handle(
    'tasks:setThinking',
    (_e, taskId: string, level: import('../shared/types').ThinkingLevel) => {
      updateTask(taskId, { thinkingLevel: level })
      broadcast('tasks:updated', listTasks())
    },
  )
  ipcMain.handle('tasks:setDisallowedTools', (_e, taskId: string, tools: string[]) => {
    updateTask(taskId, { disallowedTools: tools })
    broadcast('tasks:updated', listTasks())
  })
  // B17 이미지 입력 — 작업 입력 이미지 첨부. cap(장수·크기·이미지만)을 메인에서 강제. 다음 실행/재개부터 Navi가 봄.
  ipcMain.handle(
    'tasks:setImages',
    (_e, taskId: string, images: import('../shared/types').FileAttachment[]) => {
      updateTask(taskId, { images: capTaskImages(images ?? []) })
      broadcast('tasks:updated', listTasks())
    },
  )
  // B4 fast-mode — Opus 빠른 출력 모드 토글. 다음 실행/재개부터 적용.
  ipcMain.handle('tasks:setFastMode', (_e, taskId: string, on: boolean) => {
    updateTask(taskId, { fastMode: on })
    broadcast('tasks:updated', listTasks())
  })
  ipcMain.handle('tasks:events', (_e, taskId: string) => listTaskEvents(taskId))

  // §24 작업 worktree 전체 diff 본문 — task→project 해석 후 worktree.diffBody. 절단은 렌더러가.
  ipcMain.handle('tasks:diff', (_e, taskId: string) => {
    const task = getTask(taskId)
    if (!task) return ''
    const project = getProject(task.projectId)
    if (!project) return ''
    return diffBody(project, taskId)
  })

  // §5.6 Navi 직접 채팅 — 승인 큐가 이벤트에 실려올 수 있어 approvals도 같이 푸시.
  // projectId '@all'은 전체 broadcast (cap 적용 fan-out).
  ipcMain.handle('workerchat:send', (_e, projectId: string, text: string, attachments?: import('../shared/types').FileAttachment[], conversationId?: string) => {
    const emit = (ev: unknown) => {
      broadcast('workerchat:event', ev)
      broadcast('approvals:updated', listApprovals())
      telegramReconcile() // §20.3 Navi 직접 채팅 승인도 폰으로
    }
    return projectId === '@all'
      ? sendToAllNavis(text, emit)
      : sendToNavi(projectId, text, emit, conversationId, attachments ?? [])
  })
  ipcMain.handle('workerchat:history', (_e, projectId: string) =>
    projectId === '@all' ? [] : listNaviMessages(projectId),
  )
  // §5.6 Navi 직접 채팅 응답 정지 — stopManager 미러(SDK abort)
  ipcMain.handle('workerchat:stop', (_e, projectId: string) => stopNaviChat(projectId))

  // 다중 세션
  ipcMain.handle('conversations:list', (_e, target: string) => listConversations(target))
  ipcMain.handle('conversations:create', (_e, target: string) => {
    const id = createConversation(target)
    setActiveConversation(target, id)
    return id
  })
  ipcMain.handle('conversations:messages', (_e, conversationId: string) =>
    listConversationMessages(conversationId),
  )
  ipcMain.handle('conversations:getActive', (_e, target: string) => ensureActiveConversation(target))
  ipcMain.handle('conversations:setActive', (_e, target: string, conversationId: string) =>
    setActiveConversation(target, conversationId),
  )
  ipcMain.handle('conversations:delete', (_e, id: string) => deleteConversation(id))
  ipcMain.handle('conversations:rename', (_e, id: string, title: string) =>
    renameConversation(id, title),
  )
  ipcMain.handle('chapter:set', (_e, messageId: number, title: string | null) =>
    setChapter(messageId, title),
  )
  // 클립보드는 메인에서 처리(샌드박스 렌더러/preload는 clipboard 모듈 미노출)
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))

  // 인박스 열림/닫힘 통지 — notify가 "자리 비움"·알림 재진입 억제 판단에 사용(단방향)
  ipcMain.on('ui:inbox-state', (_e, open: boolean) => setInboxOpen(open))

  ipcMain.handle('lessons:list', () => listLessons())

  // §24 교훈 수명주기 — 변경 후 lessons:updated push로 모든 패널 동기화.
  ipcMain.handle('lesson:flag', (_e, id: number) => {
    const ok = flagLesson(id)
    broadcast('lessons:updated', listLessons())
    return ok
  })
  ipcMain.handle('lesson:unflag', (_e, id: number) => {
    const ok = unflagLesson(id)
    broadcast('lessons:updated', listLessons())
    return ok
  })
  ipcMain.handle('lesson:pin', (_e, id: number, pinned: boolean) => {
    const ok = pinLesson(id, pinned)
    broadcast('lessons:updated', listLessons())
    return ok
  })
  // 사용자 직접 추가 — origin:'user' 강제, scope 미지정 시 'project', taskId 없음(직접 입력).
  ipcMain.handle(
    'lesson:add',
    (_e, l: { projectId: string; scope?: 'project' | 'global'; trigger: string; lesson: string }) => {
      insertLesson({
        projectId: l.projectId,
        taskId: '',
        scope: l.scope ?? 'project',
        trigger: l.trigger,
        lesson: l.lesson,
        origin: 'user',
      })
      broadcast('lessons:updated', listLessons())
    },
  )
  // §curation revert — batch의 umbrella archive + 흡수 교훈 active 복구. 복구 수 반환, 이후 패널 동기화.
  ipcMain.handle('lesson:revertConsolidation', (_e, batch: string) => {
    const n = revertConsolidationBatch(batch)
    broadcast('lessons:updated', listLessons())
    return n
  })

  // §루틴 CRUD — 선언적 스케줄 작업. 변경 후 routines:updated push로 패널 동기화(scheduler가 디스패치).
  ipcMain.handle('routines:list', () => listRoutines())
  ipcMain.handle(
    'routines:create',
    (
      _e,
      r: { projectId?: string | null; title: string; prompt: string; cron: string },
    ) => {
      const id = insertRoutine(r)
      broadcast('routines:updated', listRoutines())
      return id
    },
  )
  ipcMain.handle('routines:setEnabled', (_e, id: string, enabled: boolean) => {
    setRoutineEnabled(id, enabled)
    broadcast('routines:updated', listRoutines())
  })
  ipcMain.handle('routines:delete', (_e, id: string) => {
    deleteRoutine(id)
    broadcast('routines:updated', listRoutines())
  })

  // 외부 MCP 서버 CRUD (CC-FEATURES P1) — 등록=사용자, 사용=cascade(query 사이트가 머지). 변경 후 mcp:updated push.
  ipcMain.handle('mcp:list', () => listMcpServers())
  ipcMain.handle('mcp:add', (_e, s: import('../shared/types').McpServerInput) => {
    const r = insertMcpServer(s)
    if (r.id) broadcast('mcp:updated', listMcpServers())
    return r
  })
  ipcMain.handle(
    'mcp:update',
    (_e, id: string, patch: Partial<import('../shared/types').McpServerInput>) => {
      const r = updateMcpServer(id, patch)
      if (r.ok) broadcast('mcp:updated', listMcpServers())
      return r
    },
  )
  ipcMain.handle('mcp:setEnabled', (_e, id: string, enabled: boolean) => {
    setMcpServerEnabled(id, enabled)
    broadcast('mcp:updated', listMcpServers())
  })
  ipcMain.handle('mcp:remove', (_e, id: string) => {
    deleteMcpServer(id)
    broadcast('mcp:updated', listMcpServers())
  })

  // 클로드 플러그인 (CC-FEATURES P1) — 설치/제거는 claude CLI 셸아웃(느릴 수 있어 async). 성공 시 목록 갱신 통지.
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:install', async (_e, id: string) => {
    const r = await installPlugin(id)
    if (r.ok) broadcast('plugins:updated', undefined)
    return r
  })
  ipcMain.handle('plugins:uninstall', async (_e, id: string) => {
    const r = await uninstallPlugin(id)
    if (r.ok) broadcast('plugins:updated', undefined)
    return r
  })

  // §23 평가 하네스 — 진행 메시지를 스트림하고 집계를 반환
  ipcMain.handle('bench:run', async (_e, conditions?: ('no-lessons' | 'with-lessons')[]) => {
    const { runBench } = await import('./bench')
    return runBench(new Date().toISOString(), {
      conditions,
      onProgress: (msg) => broadcast('bench:progress', msg),
    })
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<LainSettings>) => {
    const s = saveSettings(patch)
    // Phase 3 부수효과: 스캔 타이머 재장전 + 로그인 자동 시작(트레이로) 반영
    if (patch.scanIntervalMin !== undefined) rearmScheduler()
    if (patch.autoStart !== undefined)
      app.setLoginItemSettings({ openAtLogin: s.autoStart, args: ['--hidden'] })
    // §20.3 텔레그램 설정 변경 시 어댑터 재시작 (enabled/token/chatId 중 하나라도)
    if (
      patch.telegramEnabled !== undefined ||
      patch.telegramBotToken !== undefined ||
      patch.telegramChatId !== undefined
    )
      restartTelegram()
    // §20.3 디스코드 설정 변경 시 어댑터 재시작
    if (
      patch.discordEnabled !== undefined ||
      patch.discordBotToken !== undefined ||
      patch.discordGuildId !== undefined ||
      patch.discordVoiceChannelId !== undefined ||
      patch.discordUserId !== undefined
    )
      restartDiscord()
    // 클로드코드 연동 토글 변경 시 훅 설치/제거 + 감시 적용
    if (patch.ccHooksEnabled !== undefined) applyCcHooks()
    // 어깨너머 토글 변경 시 오버레이/감시 즉시 재평가
    if (patch.overlayMonitoringEnabled !== undefined) syncOverlayMode()
    // 자동 다운로드 토글 변경을 업데이트 엔진에 반영
    if (patch.updateAutoDownload !== undefined) applyUpdaterSettings()
    return s
  })

  // 자동 업데이트 — ④ UI 버튼/상태 (감지·다운로드·설치)
  ipcMain.handle('update:status', () => getUpdateStatus())
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => installUpdate())

  // Supertonic TTS — 설정 테스트 재생(현재 보이스·속도로 한 문장 합성 → base64 WAV) + 모델 준비/다운로드 상태
  ipcMain.handle('tts:test', async (_e, text?: string) => {
    const tts = await import('./tts')
    const s = getSettings()
    const buf = await tts.synthesizeSupertonic(text || '안녕, 나 레인이야. 지금 이 목소리로 말해.', {
      voice: s.supertonicVoice,
      speed: s.supertonicSpeed,
      step: s.supertonicStep,
    })
    return buf.toString('base64')
  })
  ipcMain.handle('tts:supertonicStatus', async () => {
    const { supertonicStatus } = await import('./supertonic-proc')
    return supertonicStatus()
  })

  ipcMain.handle('telegram:status', () => telegramStatus())

  ipcMain.handle('discord:status', () => discordStatus())

  ipcMain.handle('approvals:list', () => listApprovals())
  ipcMain.handle('approvals:resolve', (_e, id: number, approved: boolean, answer?: string) => {
    resolveApproval(id, approved, answer)
    broadcast('approvals:updated', listApprovals())
  })

  // 인라인 질문(ask_user) 답 제출 — 대기 중인 Lain 턴을 깨운다.
  ipcMain.handle('question:answer', (_e, questionId: string, answer: string[]) =>
    answerUserQuestion(questionId, answer),
  )
}
