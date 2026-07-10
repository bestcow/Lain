// IPC 핸들러 (PLAN.md §4) — Renderer ↔ L0. 변경 후엔 projects:updated 푸시.
import { execFile } from 'node:child_process'
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import {
  listProjects,
  setProjectMuted,
  hideProject,
  unhideProject,
  getProject,
  listMessages,
  listTasks,
  dailyTaskUsage,
  listRecentActivity,
  updateTask,
  listApprovals,
  listTaskEvents,
  getSetting,
  getSettings,
  saveSettings,
  backupDatabase,
  listNaviMessages,
  listConversationPreviews,
  listConversations,
  createConversation,
  listConversationMessages,
  searchChatHistory,
  messagesAround,
  getConversation,
  ensureActiveConversation,
  setActiveConversation,
  deleteConversation,
  conversationMessageCount,
  renameConversation,
  setChapter,
  listLessons,
  getTask,
  flagLesson,
  unflagLesson,
  archiveLesson,
  pinLesson,
  insertLesson,
  revertConsolidationBatch,
  lessonsAbsorbedInto,
  listRoutines,
  insertRoutine,
  setRoutineEnabled,
  deleteRoutine,
  listMcpServers,
  insertMcpServer,
  updateMcpServer,
  setMcpServerEnabled,
  deleteMcpServer,
  listPlanItems,
  upsertPlanItem,
  archivePlanItem,
  setPlanItemDone,
  listPlanTags,
  upsertPlanTag,
  deletePlanTag,
  listPlanSections,
  upsertPlanSection,
  deletePlanSection,
  listBenchRuns,
  lastChatActivityAt,
  getTaskGroup,
  tasksForGroup,
} from './store'
import { emitQuip, bindQuipSinks } from './quips'
import { turnEditSummary, revertTurn } from './rewind'
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
import { scanProjects, addProject, workspaceRoot, workspaceInfo } from './registry'
import { collectStatus, runVerify } from './collectors'
import { walkProjectFiles, MAX_FILES } from './filewalk'
import {
  sendToManager,
  stopManager,
  resetManager,
  compactManagerNow,
  bindManager,
  bindManagerRenderer,
  bindSettingsBroadcast,
  answerUserQuestion,
  listPendingQuestions,
  pushManagerNotice,
  emitManagerCard,
} from './manager'
import { encodeEditDiffLine } from '../shared/editdiff'
import { buildLearnPrompt } from './learnprompt'
import { applyCcHooks, refreshCcLinkIfEnabled } from './cchooks'
import { syncOverlayMode, openMainWindow, resizeOverlay, setOverlayVisible } from './overlay-window'
import { bindTitleRefresh } from './title'
import {
  bindOrchestrator,
  startTask,
  answerClarify,
  resolveReview,
  resolveGroup,
  revertMerge,
  cancelTask,
  resumeTask,
  rerunTask,
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
  // 상호작용 대사(quips) 싱크 주입 — 말풍선 broadcast + 매니저 인지 버퍼('하나의 레인', 순환 import 회피 bind 패턴)
  bindQuipSinks(
    (payload) => broadcast('quip:show', payload),
    (text) => pushManagerNotice(text),
  )
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
  // 유저 감시 — 렌더러가 proactive 반응 시 오버레이 표시/숨김 요청(게이트는 main에서)
  ipcMain.on('overlay:setVisible', (_e, visible: boolean) => setOverlayVisible(!!visible))

  ipcMain.handle('projects:list', () => listProjects())

  ipcMain.handle('projects:scan', async () => {
    const added = scanProjects()
    if (added > 0) emitQuip('project_add', { count: added })
    await refresh(null)
    return added
  })

  // E6 — 유효 워크스페이스 정보(env 오버라이드 반영). 빈상태 문구·SCAN 제목·기본경로 동적 표시용.
  ipcMain.handle('workspace:info', () => workspaceInfo())

  ipcMain.handle('projects:addDialog', async () => {
    const result = await dialog.showOpenDialog({
      title: '프로젝트 폴더 추가',
      defaultPath: workspaceRoot(), // E6 — 하드코딩 'C:\workspace' 대신 유효 루트
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const project = addProject(result.filePaths[0])
    unhideProject(project.id) // 명시적 추가 → 제거 해제(전에 제거했던 폴더면 보존된 기록과 함께 복귀)
    setProjectMuted(project.id, false) // 명시적 추가 → '숨김'도 해제(다시 보이게 하려는 의도)
    emitQuip('project_add')
    await refresh(project.id)
    return listProjects().find((p) => p.id === project.id) ?? null
  })

  // '숨김' — 레인 관리(수집·작업)는 유지, 레인이 먼저 화제로 꺼내지만 않는다. (구 대기실 setEnabled 대체)
  ipcMain.handle('projects:setMuted', (_e, id: string, muted: boolean) => {
    setProjectMuted(id, muted)
    pushProjects()
  })

  // '제거' = 보드에서 숨김(데이터 보존). 하드 삭제 아님 — 같은 폴더 재추가 시 대화·교훈·작업 복원.
  ipcMain.handle('projects:remove', (_e, id: string) => {
    hideProject(id)
    emitQuip('project_remove')
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

  // A12 — @파일 자동완성 파일 목록. projectId 지정 시 그 프로젝트만(Navi 드릴, 상대경로 그대로),
  // 미지정 시 등록된 모든(enabled) 프로젝트를 훑어 'projectId/상대경로'로 접두(레인 채팅 범위).
  // 렌더러가 @ 진입 시 1회만 호출하고 이후 fuzzy 필터는 렌더러 쪽에서 처리(매 키 재-glob 금지).
  ipcMain.handle('files:list', (_e, projectId?: string) => {
    if (projectId) {
      const p = getProject(projectId)
      return p ? walkProjectFiles(p.path) : []
    }
    const projects = listProjects().filter((p) => p.enabled)
    const out: string[] = []
    for (const p of projects) {
      if (out.length >= MAX_FILES) break
      for (const rel of walkProjectFiles(p.path, MAX_FILES - out.length)) out.push(`${p.id}/${rel}`)
    }
    return out
  })

  ipcMain.handle('chat:history', () => listMessages('manager'))
  ipcMain.handle('chat:previews', () => listConversationPreviews())

  ipcMain.handle('chat:send', async (_e, text: string, attachments?: import('../shared/types').FileAttachment[], conversationId?: string) => {
    // 렌더러 반영은 rendererMirror(bindManagerRenderer)가 conversationId 태깅해 단일 처리.
    // 여기서 다시 broadcast하면 이중 표시되므로 emit은 비워둔다.
    // /learn (학습루프 T2) — 채팅엔 '/learn …' 원문이 남고, 모델에겐 스킬 저작 지시문(modelText)이 간다.
    const learn = /^\/learn(\s|$)/.test(text) ? buildLearnPrompt(text.slice(6).trim()) : undefined
    // quips — 심야 활동·오랜만 복귀. 사용자 활동의 결정론 진입점(메시지 추가 전 = lastChatActivityAt가
    // 아직 '직전' 활동)이라 여기서 감지한다. 발화는 말풍선+매니저 버퍼라 바로 이어지는 이 턴이 맥락을 안다.
    try {
      const last = lastChatActivityAt() // UTC 'YYYY-MM-DD HH:MM:SS'
      const lastMs = last ? Date.parse(last.replace(' ', 'T') + 'Z') : Number.NaN
      if (Number.isFinite(lastMs) && Date.now() - lastMs >= 3 * 86_400_000)
        emitQuip('long_absence', { days: Math.floor((Date.now() - lastMs) / 86_400_000) })
      else if (new Date().getHours() < 4) emitQuip('late_night') // 00~04시(로컬) — 쿨다운 20h ≒ 1일 1회
    } catch {
      /* 플레이버 — 실패 무해 */
    }
    await sendToManager(text, () => {}, false, attachments ?? [], 0, conversationId, 'pc', undefined, 0, learn)
  })

  ipcMain.handle('chat:stop', () => {
    stopManager()
  })

  // Lain 세션 새로고침 — 무한세션이라 'Navi 새 대화'가 없어, 옛 스레드로 헛도는 Lain을 리셋하는 전용 수단.
  ipcMain.handle('chat:reset', () => {
    resetManager()
    emitQuip('manager_reset')
  })

  // A5 — /compact 수동 압축: 임계 도달 전에도 사용자가 직접 요청. 자동 압축과 동일 로직(performCompact) 재사용.
  ipcMain.handle('chat:compact', (_e, conversationId?: string) => compactManagerNow(conversationId))

  // ── Phase 1: tasks / approvals ──
  bindOrchestrator(
    (ev) => {
      broadcast('task:event', ev)
      // A4 — TodoWrite 진행 체크리스트: worker.ts가 task.todos 스냅샷을 갱신했지만 state는 안 바뀌므로
      // (working 유지) 기존 setState 경로의 tasks:updated가 안 나간다. NaviTile 진행률(n/m)이 실시간
      // 갱신되게 todo 이벤트에 한해 여기서 직접 브로드캐스트(추가 IPC 없이 기존 tasks:updated 재사용).
      if (ev.kind === 'todo') broadcast('tasks:updated', listTasks())
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
    // 레인 도구(플래너 CRUD)發 변경을 렌더러에 브로드캐스트 — CRUD IPC 핸들러와 동일 채널.
    refreshPlanner: () => broadcast('planner:updated', null),
  })

  // 텔레그램·PC·스케줄러 등 모든 출처의 Lain 대화 이벤트를 렌더러로 미러(conversationId 태깅).
  // → 텔레그램發 대화가 PC에 라이브로 뜨고 대화 목록도 갱신된다(§20.3 연동).
  bindManagerRenderer((ev) => broadcast('chat:event', ev))
  // 레인 도구(set_user_title 등)가 설정을 바꾸면 렌더러로 방송 → 라벨 등 라이브 반영.
  bindSettingsBroadcast(() => broadcast('settings:updated', getSettings()))
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
  // C4 — 토큰 사용량 일별 집계용 원시 행(로컬 날짜 버킷팅은 렌더러). 창은 표시일수(14)보다 하루 넓게(15).
  ipcMain.handle('usage:daily', (_e, windowDays?: number) => dailyTaskUsage(windowDays ?? 15))
  // C6 — 전역 활동 피드 원시 행(task_events 의미있는 kind + cc_events). 시간 역순 병합은 렌더러.
  ipcMain.handle('activity:recent', (_e, limit?: number) => listRecentActivity(limit ?? 20))
  ipcMain.handle('tasks:start', (_e, projectId: string) => startTask(projectId))
  ipcMain.handle('tasks:answer', (_e, taskId: string, answers: string) =>
    // 사용자 직접 답변(드로어 입력) → 사용자發 sender만 넘긴다. 태그는 answerClarify가 모델에 닿는
    // resume 프롬프트에만 붙이고, 영속 명세(task.content)에는 박지 않는다(명세 오염 방지).
    answerClarify(taskId, answers, 'user'),
  )
  ipcMain.handle('tasks:resolveReview', (_e, taskId: string, action: any) =>
    resolveReview(taskId, action),
  )
  // D8 — 병합 되돌리기(비파괴 revert). 성공 시 task 갱신 브로드캐스트.
  ipcMain.handle('tasks:revertMerge', async (_e, taskId: string) => {
    const res = await revertMerge(taskId)
    broadcast('tasks:updated', listTasks())
    return res
  })
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
  // D10 — 작업별 모델 고정('' = 전역 naviModel). 다음 실행/재개부터 적용.
  ipcMain.handle(
    'tasks:setModel',
    (_e, taskId: string, model: import('../shared/types').ModelTier | '') => {
      updateTask(taskId, { modelOverride: model })
      broadcast('tasks:updated', listTasks())
    },
  )
  // D11 — done/cancelled 작업을 같은 명세로 재실행(원본 보존, 새 task 생성).
  ipcMain.handle('tasks:rerun', async (_e, taskId: string) => {
    const r = await rerunTask(taskId)
    broadcast('tasks:updated', listTasks())
    return r
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
  // A15 — beforeId(옵션)로 위로 스크롤 페이징: 그 id보다 오래된 메시지 limit개를 더 가져온다.
  ipcMain.handle(
    'conversations:messages',
    (_e, conversationId: string, limit?: number, beforeId?: number) =>
      listConversationMessages(conversationId, limit ?? 200, beforeId),
  )
  // A15 — Ctrl+F '전체 기간' 토글용 DB 전문검색(레인 대화, scope='manager') — store.searchChatHistory 그대로 노출.
  ipcMain.handle('chat:searchHistory', (_e, query: string, limit?: number) =>
    searchChatHistory(query, limit ?? 20),
  )
  // A15 — 전체기간 검색 히트 클릭 시 그 메시지가 속한 대화의 주변 구간을 시간순으로 로드(점프용).
  ipcMain.handle('chat:messagesAround', (_e, messageId: number, before?: number, after?: number) =>
    messagesAround(messageId, before ?? 30, after ?? 30),
  )
  ipcMain.handle('conversations:getActive', (_e, target: string) => ensureActiveConversation(target))
  ipcMain.handle('conversations:setActive', (_e, target: string, conversationId: string) =>
    setActiveConversation(target, conversationId),
  )
  ipcMain.handle('conversations:delete', (_e, id: string) => {
    deleteConversation(id)
    emitQuip('conv_delete')
  })
  // B9 — 삭제 확인창 정확도: 워터마크·limit 무관 전건 메시지 수(deleteConversation이 지우는 실제 개수).
  ipcMain.handle('conversations:messageCount', (_e, id: string) => conversationMessageCount(id))
  ipcMain.handle('conversations:rename', (_e, id: string, title: string) =>
    renameConversation(id, title),
  )
  ipcMain.handle('chapter:set', (_e, messageId: number, title: string | null) =>
    setChapter(messageId, title),
  )
  // 클립보드는 메인에서 처리(샌드박스 렌더러/preload는 clipboard 모듈 미노출)
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))

  // A16 — 대화 전체를 markdown(.md)으로 저장. listConversationMessages 기본 limit(200)은 화면 표시용
  // 절단이라 여기선 Number.MAX_SAFE_INTEGER로 넘겨 전체 이력을 가져온다.
  ipcMain.handle('conversations:exportMarkdown', async (_e, conversationId: string) => {
    const conv = getConversation(conversationId)
    const messages = listConversationMessages(conversationId, Number.MAX_SAFE_INTEGER)
    const { messagesToMarkdown } = await import('../shared/exportMarkdown')
    const md = messagesToMarkdown(messages, conv?.title || undefined)
    const safeName = (conv?.title || '대화').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const result = await dialog.showSaveDialog({
      title: '대화 내보내기',
      defaultPath: `${safeName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false }
    const fs = await import('node:fs')
    try {
      fs.writeFileSync(result.filePath, md, 'utf8')
    } catch (e) {
      // 디스크 풀·권한 등 저장 실패 — 렌더러가 사용자에게 알릴 수 있게 사유 반환(무피드백 방지)
      return { ok: false, error: (e as Error).message }
    }
    return { ok: true, filePath: result.filePath }
  })

  // 채팅 텍스트 링크화(A3) — URL/경로 클릭은 반드시 main 경유(렌더러는 shell 직접 접근 불가).
  // http/https만 허용(스킴 화이트리스트) — file:/javascript: 등은 렌더러가 애초에 링크화 안 하지만
  // 방어적으로 여기서도 재검증한다(다른 호출 경로가 생겨도 안전).
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'scheme-not-allowed' }
    await shell.openExternal(url)
    return { ok: true }
  })
  // 파일 경로 열기 — 폴더에서 선택 상태로 보여준다(openPath로 바로 실행하면 실행파일 오클릭 위험,
  // 소스/문서 열람 목적엔 showItemInFolder가 더 안전 — 탐색기만 열고 실행은 사용자 재확인 후).
  // 상대경로는 렌더러가 cwd를 모르므로, 절대경로가 아니면 등록 프로젝트 루트들을 순회해 첫 존재 매치를 찾는다.
  ipcMain.handle('shell:revealPath', async (_e, rawPath: string) => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const resolved = path.isAbsolute(rawPath)
      ? rawPath
      : (() => {
          for (const p of listProjects()) {
            const candidate = path.resolve(p.path, rawPath)
            // 프로젝트 루트 밖으로 새어나가는 상대경로(../..)는 거부 — 임의 파일 탐색기 노출 방지
            const rel = path.relative(p.path, candidate)
            if (rel.startsWith('..') || path.isAbsolute(rel)) continue
            if (fs.existsSync(candidate)) return candidate
          }
          return null
        })()
    if (!resolved || !fs.existsSync(resolved)) return { ok: false, error: 'not-found' }
    shell.showItemInFolder(resolved)
    return { ok: true }
  })

  // 인박스 열림/닫힘 통지 — notify가 "자리 비움"·알림 재진입 억제 판단에 사용(단방향)
  ipcMain.on('ui:inbox-state', (_e, open: boolean) => setInboxOpen(open))

  ipcMain.handle('lessons:list', () => listLessons())
  // C7 — 병합 통합본(umbrella)에 흡수된 원본 교훈 목록(absorbed_into 역참조). 상세창 계보 표시용.
  ipcMain.handle('lessons:absorbedInto', (_e, umbrellaId: number) => lessonsAbsorbedInto(umbrellaId))

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
  // 수동 미사용(보관) — 상세창의 '미사용으로'. flagLesson과 달리 pinned·user 학습도 항상 보관(사용자 의지).
  ipcMain.handle('lesson:archive', (_e, id: number) => {
    const ok = archiveLesson(id)
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

  // C10 — 영속된 벤치 이력 조회(run_id별 집계). 시간순(오래된 런 먼저).
  ipcMain.handle('bench:list', async () => {
    const { aggregate } = await import('./bench')
    return listBenchRuns().map((run) => aggregate(run.runId, run.results, run.startedAt))
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<LainSettings>) => {
    const prev = getSettings() // quips — '실제로 값이 바뀐' 변경만 반응하기 위한 이전 값 캡처
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
    // 상호작용 대사(quips) — 설정 '전이'에만 반응(같은 값 재저장·슬라이더 중간 통과 노이즈는 전이 비교로 걸러짐)
    if (prev.overlayMonitoringEnabled !== s.overlayMonitoringEnabled)
      emitQuip(s.overlayMonitoringEnabled ? 'monitor_on' : 'monitor_off')
    if (s.gptSovitsSpeed >= 1.9 && prev.gptSovitsSpeed < 1.9) emitQuip('tts_speed_max')
    if (prev.naviModel !== s.naviModel || prev.managerModel !== s.managerModel)
      emitQuip('model_change')
    // 묵언 진입은 0에서 판정하면 자기모순으로 영영 침묵 — 직전 값으로 '마지막 한마디' 특례(§7)
    if (s.chattiness === 0 && prev.chattiness > 0) emitQuip('chattiness_min', {}, prev.chattiness)
    if (s.chattiness === 4 && prev.chattiness < 4) emitQuip('chattiness_max')
    broadcast('settings:updated', s) // 다른 창·컴포넌트가 최신 설정을 라이브로 반영(userTitle 라벨 등)
    return s
  })

  // 자동 업데이트 — ④ UI 버튼/상태 (감지·다운로드·설치)
  ipcMain.handle('update:status', () => getUpdateStatus())
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => installUpdate())

  // TTS 테스트 재생 — 현재 설정 엔진(edge/supertonic/gpt-sovits)으로 한 문장 합성 → data URI.
  // mime 포함 data URI로 반환한다(edge=mp3, 나머지=wav) — 렌더러가 컨테이너를 추측하지 않게.
  ipcMain.handle('tts:test', async (_e, text?: string) => {
    const tts = await import('./tts')
    const { audio, mime } = await tts.synthesizeBackend(
      text || '안녕, 나 레인이야. 지금 이 목소리로 말해.',
      getSettings(),
    )
    return `data:${mime};base64,${audio.toString('base64')}`
  })
  ipcMain.handle('tts:supertonicStatus', async () => {
    const { supertonicStatus } = await import('./supertonic-proc')
    return supertonicStatus()
  })

  // PC 네이티브 음성 — 렌더러 마이크 녹음(webm) → Groq Whisper(ko) STT. 키 없으면 no-key.
  ipcMain.handle('voice:stt', async (_e, bytes: Uint8Array) => {
    const s = getSettings()
    if (!s.groqApiKey) return { error: 'no-key' } as const
    try {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/webm' }), 'voice.webm')
      form.append('model', 'whisper-large-v3')
      form.append('language', 'ko') // 한국어 고정(제3언어 오인 방지)
      const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.groqApiKey}` },
        body: form,
      })
      if (!resp.ok) return { error: `stt ${resp.status}` }
      const { text } = (await resp.json()) as { text: string }
      const { isLikelyWhisperHallucination } = await import('./stt-filter')
      const clean = (text ?? '').trim()
      return { text: isLikelyWhisperHallucination(clean) ? '' : clean } // 환청 차단

    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  })
  // PC 네이티브 음성 — 임의 텍스트를 현재 설정 엔진으로 합성 → data URI(mime 포함).
  // 예전엔 Supertonic 고정이라 ttsBackend=gpt-sovits로 바꿔도 PC 창 음성이 안 바뀌었음 → 디스패처로 통일.
  // fallback: true면 설정한 로컬 엔진이 실패해 edge로 대체됐다는 뜻(B7-2) — 렌더러가 통보.
  ipcMain.handle('tts:speak', async (_e, text: string) => {
    if (!text || !text.trim()) return { uri: '' }
    const tts = await import('./tts')
    const { audio, mime, fallback } = await tts.synthesizeBackend(text, getSettings())
    return { uri: `data:${mime};base64,${audio.toString('base64')}`, fallback }
  })

  // 개인 보이스(로컬) 가져오기 — '찾아보기'로 파일 선택 → %APPDATA%\lain\voices\ 로 복사.
  // 스타일 JSON이면 바로 사용 가능(custom 보이스로 등록), 오디오면 보관만(빌더로 JSON 변환 필요).
  ipcMain.handle('voice:import', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { DATA_DIR } = await import('./paths')
    const result = await dialog.showOpenDialog({
      title: '개인 보이스 파일 가져오기',
      properties: ['openFile'],
      filters: [
        { name: 'Supertonic 스타일/샘플', extensions: ['json', 'wav', 'mp3', 'flac', 'ogg', 'm4a'] },
        { name: '모든 파일', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const src = result.filePaths[0]
    const base = path.basename(src).replace(/[^A-Za-z0-9._-]/g, '_') // 파일명 정규화(공백·비ASCII 제거)
    const voicesDir = path.join(DATA_DIR, 'voices')
    fs.mkdirSync(voicesDir, { recursive: true })
    const dest = path.join(voicesDir, base)
    fs.copyFileSync(src, dest)
    const kind = base.toLowerCase().endsWith('.json') ? 'json' : 'audio'
    if (kind === 'json') {
      // 유효성 — 진짜 Supertonic 보이스 스타일(style_ttl/style_dp)인지. 아니면(전사·다른 형식) 거부·삭제.
      let valid = false
      try {
        const raw = JSON.parse(fs.readFileSync(dest, 'utf8'))
        valid = !!(raw && raw.style_ttl && raw.style_dp)
      } catch {
        valid = false
      }
      if (!valid) {
        try {
          fs.unlinkSync(dest)
        } catch {
          /* ignore */
        }
        return { file: base, kind, error: 'not-voice-style' } as const
      }
      saveSettings({ supertonicVoice: 'custom', supertonicCustomVoice: base })
    } else {
      saveSettings({ supertonicCustomSample: base }) // 오디오 샘플 영구 기록
    }
    return { file: base, kind } as { file: string; kind: 'json' | 'audio' }
  })
  // 개인 보이스 폴더 열기 — 사용자가 저장된 샘플을 직접 확인·백업할 수 있게.
  ipcMain.handle('voice:openFolder', async () => {
    const path = await import('node:path')
    const fs = await import('node:fs')
    const { DATA_DIR } = await import('./paths')
    const dir = path.join(DATA_DIR, 'voices')
    fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return dir
  })

  // E8 — 데이터 폴더 열기(설정·대화·교훈·플래너가 쌓이는 %APPDATA%\lain). 사용자가 직접 확인·백업.
  ipcMain.handle('data:openFolder', async () => {
    const { DATA_DIR } = await import('./paths')
    await shell.openPath(DATA_DIR)
    return DATA_DIR
  })

  // E8 — 백업 내보내기. 사용자가 고른 경로로 lain.sqlite(WAL 병합 후)를 복사. 외부 의존 없음.
  ipcMain.handle('data:backup', async () => {
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T-]/g, '') // YYYYMMDDHHMMSS
    const result = await dialog.showSaveDialog({
      title: '데이터 백업 내보내기',
      defaultPath: `lain-backup-${stamp}.sqlite`,
      filters: [{ name: 'SQLite DB', extensions: ['sqlite'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const r = backupDatabase(result.filePath)
    if (r.ok) emitQuip('backup_export')
    return r
  })

  // D15 되감기 — 레인 직접 편집의 턴 체크포인트 요약(확인창 목록)/복원(편집 diff 카드 '이 턴 편집 되돌리기')
  ipcMain.handle('edits:turnCheckpoints', (_e, turnId: string) => turnEditSummary(turnId))
  ipcMain.handle('edits:revertTurn', (_e, turnId: string) => {
    const r = revertTurn(turnId)
    // 재리뷰 #4 — '복원의 복원' 진입점 노출: 복원 직전 스냅샷 그룹(r<ts>)을 카드로 채팅에 남긴다.
    // 이 카드의 '이 턴 편집 되돌리기'가 곧 un-revert — 없으면 revertTurnId가 UI 어디에도 실리지 않아
    // 확인창이 약속한 "복원 직전 상태도 되돌릴 수 있다"가 성립하지 않았다.
    if (r.ok && r.revertTurnId && r.files.length) {
      emitManagerCard(
        encodeEditDiffLine({
          tool: 'Write',
          filePath: `${r.files.length}개 파일`,
          label: `↩ 복원 직전 상태 (${r.files.length}개 파일) — 되돌리기 취소용`,
          lines: r.files.map((f) => ({ kind: 'ctx' as const, text: f })),
          truncated: false,
          turnId: r.revertTurnId,
        }),
        r.conversationId || undefined,
      )
    }
    return r
  })

  // D13 크로스레포 그룹 — 결재 패널용 정보 + 일괄 결재.
  ipcMain.handle('groups:info', (_e, groupId: string) => {
    const g = getTaskGroup(groupId)
    if (!g) return null
    const children = tasksForGroup(groupId).map((t) => ({
      taskId: t.id,
      projectId: t.projectId,
      title: t.title,
      state: t.state,
      verifyResult: t.verifyResult,
    }))
    return { id: g.id, title: g.title, children }
  })
  ipcMain.handle('groups:resolve', async (_e, groupId: string, action: 'merge' | 'keep-branch' | 'discard') => {
    const res = await resolveGroup(groupId, action)
    broadcast('tasks:updated', listTasks())
    pushProjects()
    return res
  })

  ipcMain.handle('telegram:status', () => telegramStatus())

  ipcMain.handle('discord:status', () => discordStatus())

  // 온보딩(첫 실행 위저드) — 결정론 검사만: 번들 claude 바이너리 존재 + 로그인 자격증명
  // (구독 OAuth ~/.claude/.credentials.json 또는 ANTHROPIC_API_KEY). LLM 호출 없음.
  ipcMain.handle('onboarding:status', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { CLAUDE_BIN } = await import('./paths')
    return {
      claudeBin: fs.existsSync(CLAUDE_BIN),
      loggedIn:
        fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json')) ||
        Boolean(process.env.ANTHROPIC_API_KEY) ||
        // E5 — 앱에 저장한 API 키도 정식 인증 수단(spawn env로 주입됨). 시스템 env가 아니어도 인정.
        Boolean(getSettings().anthropicApiKey.trim()),
      // E10 진단용 — 미발견 시 어떤 경로를 봤는지 표기 + dev/패키징 분기 안내에 사용.
      claudeBinPath: CLAUDE_BIN,
      isPackaged: app.isPackaged,
    }
  })

  // E2 — 온보딩 '로그인 터미널 열기'. 번들 CLAUDE_BIN으로 가시 콘솔에 `claude auth login`(구독 OAuth)을
  // 직접 띄운다 — claude CLI가 PATH에 없는 설치본 사용자도 그 자리에서 로그인→'다시 확인'까지 완주.
  // 결정론(프로세스 스폰만, LLM 없음). Windows: 경로 공백까지 안전하게 런처 .cmd를 DATA_DIR(정리된
  // 경로)에 쓰고 `start "" "<bat>"`로 새 콘솔을 연다(spawn+cmd 이중파싱 따옴표 함정 회피, 실측 검증).
  ipcMain.handle('onboarding:login', async () => {
    const fs = await import('node:fs')
    const { spawn } = await import('node:child_process')
    const { CLAUDE_BIN } = await import('./paths')
    if (!fs.existsSync(CLAUDE_BIN))
      return { ok: false, error: '내장 Claude 실행 파일을 찾지 못했습니다.' }
    try {
      if (process.platform !== 'win32') {
        // 현재 Windows 전용 — 그 외 플랫폼은 콘솔 가시성 보장 없이 실행만 시도.
        spawn(CLAUDE_BIN, ['auth', 'login'], { detached: true, stdio: 'ignore' }).unref()
        return { ok: true }
      }
      // 새 콘솔에 `claude auth login`(구독 OAuth)을 띄운다. 실행 파일 경로는 명령 문자열에 넣지 않고
      // %CLAUDE_BIN% 환경변수로만 참조한다 — 경로에 비ASCII(CJK 사용자명 등)가 있어도 cmd 코드페이지에
      // 걸리지 않는다(env는 CreateProcessW로 유니코드 전달, 명령 문자열은 순수 ASCII). /k로 창을 열어둬
      // 사용자가 로그인 결과·에러를 확인하게 한다. (spawn+cmd 따옴표 함정 회피, 실측 검증)
      const child = spawn(`start "lain - Claude login" cmd /k ""%CLAUDE_BIN%" auth login"`, {
        shell: true,
        windowsHide: false,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CLAUDE_BIN },
      })
      child.on('error', () => {})
      child.unref()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ── 플래너 — CRUD는 결정론 직통, 변경은 planner:updated 브로드캐스트(레인 도구發 포함) ──
  ipcMain.handle('planner:list', () => ({ items: listPlanItems(), tags: listPlanTags(), sections: listPlanSections() }))
  ipcMain.handle('planner:upsertItem', (_e, input) => {
    const id = upsertPlanItem(input)
    broadcast('planner:updated', null)
    // quips — 이번 주(월~일) 일정·마감이 6개 이상이면 한마디. startAt은 로컬 'YYYY-MM-DDTHH:mm'
    // 고정 포맷이라 문자열 비교가 시간순과 일치한다(타임존 파싱 함정 회피).
    try {
      const now = new Date()
      const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
      const next = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7)
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00`
      const lo = fmt(mon)
      const hi = fmt(next)
      const count = listPlanItems().filter((it) => it.startAt && it.startAt >= lo && it.startAt < hi).length
      if (count >= 6) emitQuip('busy_week', { count })
    } catch {
      /* 플레이버 — 실패 무해 */
    }
    return id
  })
  ipcMain.handle('planner:deleteItem', (_e, id: number) => {
    archivePlanItem(id)
    broadcast('planner:updated', null)
  })
  ipcMain.handle('planner:setDone', (_e, id: number, done: boolean) => {
    setPlanItemDone(id, done)
    broadcast('planner:updated', null)
  })
  ipcMain.handle('planner:upsertTag', (_e, input) => {
    const id = upsertPlanTag(input)
    broadcast('planner:updated', null)
    return id
  })
  ipcMain.handle('planner:deleteTag', (_e, id: number) => {
    deletePlanTag(id)
    broadcast('planner:updated', null)
  })
  ipcMain.handle('planner:upsertSection', (_e, input) => {
    const id = upsertPlanSection(input)
    broadcast('planner:updated', null)
    return id
  })
  ipcMain.handle('planner:deleteSection', (_e, id: number) => {
    deletePlanSection(id)
    broadcast('planner:updated', null)
  })

  ipcMain.handle('approvals:list', () => listApprovals())
  ipcMain.handle('approvals:resolve', (_e, id: number, approved: boolean, answer?: string) => {
    resolveApproval(id, approved, answer)
    broadcast('approvals:updated', listApprovals())
  })

  // 인라인 질문(ask_user) 답 제출 — 대기 중인 Lain 턴을 깨운다.
  ipcMain.handle('question:answer', (_e, questionId: string, answer: string[]) =>
    answerUserQuestion(questionId, answer),
  )

  // B5 — 대기 중 인라인 질문 조회. 렌더러 마운트/리로드 시 재요청해 카드를 복원한다(pendingQuestion은 main 인메모리).
  ipcMain.handle('question:pending', () => listPendingQuestions())
}
