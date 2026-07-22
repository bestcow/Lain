// preload (PLAN.md §14) — contextBridge로 화이트리스트된 IPC만 노출
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
  Approval,
  ChatEvent,
  LainApi,
  LainSettings,
  Lesson,
  McpServer,
  ProjectView,
  Routine,
  Task,
  TaskEvent,
  NaviChatEvent,
  DiscordStateEvent,
  TtsChunkEvent,
  UpdateStatus,
} from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: LainApi = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  scanProjects: () => ipcRenderer.invoke('projects:scan'),
  addProjectDialog: () => ipcRenderer.invoke('projects:addDialog'),
  setMuted: (id, muted) => ipcRenderer.invoke('projects:setMuted', id, muted),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),
  refreshStatus: (id) => ipcRenderer.invoke('status:refresh', id ?? null),
  runVerify: (id) => ipcRenderer.invoke('verify:run', id),
  listFiles: (projectId) => ipcRenderer.invoke('files:list', projectId),
  listCcSessions: (projectId) => ipcRenderer.invoke('cc:sessions', projectId),
  ccSessionDigest: (projectId, sessionId) => ipcRenderer.invoke('cc:sessionDigest', projectId, sessionId),
  listObservedSessions: (projectId) => ipcRenderer.invoke('observed:sessions', projectId),
  observedSessionDigest: (projectId, engine, sessionId) =>
    ipcRenderer.invoke('observed:sessionDigest', projectId, engine, sessionId),
  engineCapabilities: () => ipcRenderer.invoke('engines:capabilities'),
  adoptObservedSession: (projectId, sourceEngine, sessionId, taskEngine, goal) =>
    ipcRenderer.invoke(
      'observed:adopt',
      projectId,
      sourceEngine,
      sessionId,
      taskEngine,
      goal,
    ),
  sendChat: (text, attachments, conversationId) =>
    ipcRenderer.invoke('chat:send', text, attachments, conversationId),
  stopChat: () => ipcRenderer.invoke('chat:stop'),
  resetManager: () => ipcRenderer.invoke('chat:reset'),
  compactNow: (conversationId) => ipcRenderer.invoke('chat:compact', conversationId),
  onProjectsUpdated: (cb) => subscribe<ProjectView[]>('projects:updated', cb),
  onChatEvent: (cb) => subscribe<ChatEvent>('chat:event', cb),
  getBriefing: () => ipcRenderer.invoke('briefing:get'),
  onBriefingUpdated: (cb) => subscribe<string>('briefing:updated', cb),
  appStartedAt: () => ipcRenderer.invoke('app:startedAt'),
  // Phase 1: tasks
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  dailyUsage: (windowDays) => ipcRenderer.invoke('usage:daily', windowDays),
  recentActivity: (limit) => ipcRenderer.invoke('activity:recent', limit),
  startTask: (projectId) => ipcRenderer.invoke('tasks:start', projectId),
  answerClarify: (taskId, answers) => ipcRenderer.invoke('tasks:answer', taskId, answers),
  resolveReview: (taskId, action, comment) =>
    ipcRenderer.invoke('tasks:resolveReview', taskId, action, comment),
  revertMerge: (taskId) => ipcRenderer.invoke('tasks:revertMerge', taskId),
  cancelTask: (taskId) => ipcRenderer.invoke('tasks:cancel', taskId),
  resumeTask: (taskId) => ipcRenderer.invoke('tasks:resume', taskId),
  setTaskPermissionMode: (taskId, mode) =>
    ipcRenderer.invoke('tasks:setPermissionMode', taskId, mode),
  setTaskThinking: (taskId, level) => ipcRenderer.invoke('tasks:setThinking', taskId, level),
  setTaskDisallowedTools: (taskId, tools) =>
    ipcRenderer.invoke('tasks:setDisallowedTools', taskId, tools),
  setTaskImages: (taskId, images) => ipcRenderer.invoke('tasks:setImages', taskId, images),
  setTaskFastMode: (taskId, on) => ipcRenderer.invoke('tasks:setFastMode', taskId, on),
  setTaskModel: (taskId, model) => ipcRenderer.invoke('tasks:setModel', taskId, model),
  setTaskProvider: (taskId, provider) =>
    ipcRenderer.invoke('tasks:setProvider', taskId, provider),
  rerunTask: (taskId) => ipcRenderer.invoke('tasks:rerun', taskId),
  taskEvents: (taskId) => ipcRenderer.invoke('tasks:events', taskId),
  taskDiff: (taskId) => ipcRenderer.invoke('tasks:diff', taskId),
  listApprovals: () => ipcRenderer.invoke('approvals:list'),
  resolveApproval: (id, approved, answer) =>
    ipcRenderer.invoke('approvals:resolve', id, approved, answer),
  listAutoApprovals: () => ipcRenderer.invoke('approvals:autoList'),
  ackAutoApproval: (id) => ipcRenderer.invoke('approvals:autoAck', id),
  answerQuestion: (questionId, answer) => ipcRenderer.invoke('question:answer', questionId, answer),
  pendingQuestions: () => ipcRenderer.invoke('question:pending'),
  onTasksUpdated: (cb) => subscribe<Task[]>('tasks:updated', cb),
  onTaskEvent: (cb) => subscribe<TaskEvent>('task:event', cb),
  onApprovalsUpdated: (cb) => subscribe<Approval[]>('approvals:updated', cb),
  // 설정
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onboardingStatus: () => ipcRenderer.invoke('onboarding:status'),
  onboardingLogin: () => ipcRenderer.invoke('onboarding:login'),
  workspaceInfo: () => ipcRenderer.invoke('workspace:info'),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  backupData: () => ipcRenderer.invoke('data:backup'),
  autoBackupStatus: () => ipcRenderer.invoke('data:autoBackupStatus'),
  onSettingsUpdated: (cb) => subscribe<LainSettings>('settings:updated', cb),
  onQuip: (cb) => subscribe<{ text: string }>('quip:show', cb),
  // D15 되감기
  editTurnCheckpoints: (turnId) => ipcRenderer.invoke('edits:turnCheckpoints', turnId),
  revertEditTurn: (turnId) => ipcRenderer.invoke('edits:revertTurn', turnId),
  // D13 크로스레포 그룹
  taskGroupInfo: (groupId) => ipcRenderer.invoke('groups:info', groupId),
  resolveGroup: (groupId, action) => ipcRenderer.invoke('groups:resolve', groupId, action),
  // 자동 업데이트
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => subscribe<UpdateStatus>('update:status', cb),
  // Supertonic TTS 테스트 재생 / 모델 상태
  testTts: (text) => ipcRenderer.invoke('tts:test', text),
  importVoice: () => ipcRenderer.invoke('voice:import'),
  openVoicesFolder: () => ipcRenderer.invoke('voice:openFolder'),
  sttVoice: (bytes) => ipcRenderer.invoke('voice:stt', bytes),
  speakTtsStream: (text) => ipcRenderer.invoke('tts:speakStream', text),
  stopTtsSpeak: () => ipcRenderer.invoke('tts:speakStop'),
  onTtsChunk: (cb) => subscribe<TtsChunkEvent>('tts:chunk', cb),
  telegramStatus: () => ipcRenderer.invoke('telegram:status'),
  discordStatus: () => ipcRenderer.invoke('discord:status'),
  onDiscordState: (cb) => subscribe<DiscordStateEvent>('discord:state', cb),
  // §5.6 Navi 직접 채팅
  sendNaviChat: (projectId, text, attachments, conversationId) =>
    ipcRenderer.invoke('workerchat:send', projectId, text, attachments, conversationId),
  stopNaviChat: (projectId) => ipcRenderer.invoke('workerchat:stop', projectId),
  onNaviChatEvent: (cb) => subscribe<NaviChatEvent>('workerchat:event', cb),
  onConversationsUpdated: (cb) => subscribe<string>('conversations:updated', cb),
  // 다중 세션
  listConversations: (target) => ipcRenderer.invoke('conversations:list', target),
  createConversation: (target) => ipcRenderer.invoke('conversations:create', target),
  conversationMessages: (conversationId, limit, beforeId) =>
    ipcRenderer.invoke('conversations:messages', conversationId, limit, beforeId),
  getActiveConversation: (target) => ipcRenderer.invoke('conversations:getActive', target),
  setActiveConversation: (target, conversationId) =>
    ipcRenderer.invoke('conversations:setActive', target, conversationId),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  conversationMessageCount: (id) => ipcRenderer.invoke('conversations:messageCount', id),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', id, title),
  // 채팅 우클릭 메뉴
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  setChapter: (messageId, title) => ipcRenderer.invoke('chapter:set', messageId, title),
  exportConversationMarkdown: (conversationId) =>
    ipcRenderer.invoke('conversations:exportMarkdown', conversationId),
  // 채팅 텍스트 링크화(A3)
  openExternalUrl: (url) => ipcRenderer.invoke('shell:openExternal', url),
  revealPath: (path) => ipcRenderer.invoke('shell:revealPath', path),
  // A15 — Ctrl+F '전체 기간' DB 전문검색 + 히트 주변 구간 로드(점프)
  searchChatHistory: (query, limit) => ipcRenderer.invoke('chat:searchHistory', query, limit),
  messagesAround: (messageId, before, after) =>
    ipcRenderer.invoke('chat:messagesAround', messageId, before, after),
  // §22 자기개선
  listLessons: () => ipcRenderer.invoke('lessons:list'),
  lessonsAbsorbedInto: (umbrellaId) => ipcRenderer.invoke('lessons:absorbedInto', umbrellaId),
  unflagLesson: (id) => ipcRenderer.invoke('lesson:unflag', id),
  archiveLesson: (id) => ipcRenderer.invoke('lesson:archive', id),
  pinLesson: (id, pinned) => ipcRenderer.invoke('lesson:pin', id, pinned),
  addLesson: (lesson) => ipcRenderer.invoke('lesson:add', lesson),
  revertConsolidation: (batch) => ipcRenderer.invoke('lesson:revertConsolidation', batch),
  onLessonsUpdated: (cb) => subscribe<Lesson[]>('lessons:updated', cb),
  // 루틴 (스케줄 작업) CRUD
  listRoutines: () => ipcRenderer.invoke('routines:list'),
  createRoutine: (r) => ipcRenderer.invoke('routines:create', r),
  setRoutineEnabled: (id, enabled) => ipcRenderer.invoke('routines:setEnabled', id, enabled),
  deleteRoutine: (id) => ipcRenderer.invoke('routines:delete', id),
  onRoutinesUpdated: (cb) => subscribe<Routine[]>('routines:updated', cb),
  // 외부 MCP 서버 (CC-FEATURES P1)
  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  addMcpServer: (s) => ipcRenderer.invoke('mcp:add', s),
  updateMcpServer: (id, patch) => ipcRenderer.invoke('mcp:update', id, patch),
  setMcpServerEnabled: (id, enabled) => ipcRenderer.invoke('mcp:setEnabled', id, enabled),
  removeMcpServer: (id) => ipcRenderer.invoke('mcp:remove', id),
  onMcpServersUpdated: (cb) => subscribe<McpServer[]>('mcp:updated', cb),
  // 클로드 플러그인 (CC-FEATURES P1)
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  installPlugin: (id) => ipcRenderer.invoke('plugins:install', id),
  uninstallPlugin: (id) => ipcRenderer.invoke('plugins:uninstall', id),
  onPluginsUpdated: (cb) => subscribe<void>('plugins:updated', cb),
  // §23 평가 하네스
  runBench: (conditions) => ipcRenderer.invoke('bench:run', conditions),
  onBenchProgress: (cb) => subscribe<string>('bench:progress', cb),
  listBenchRuns: () => ipcRenderer.invoke('bench:list'),
  // 창 제어 (frameless — OS 타이틀바를 헤더에 통합)
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  onWindowMaximized: (cb) => subscribe<boolean>('window:maximized', cb),
  // 렌더러 인박스 열림/닫힘 통지 (자리 비움 판단)
  setInboxOpen: (open) => ipcRenderer.send('ui:inbox-state', open),
  // 렌더러 조용한 실패·렌더 예외 보고 → main이 renderer-crash.log에 한 줄 남긴다
  reportError: (payload) => ipcRenderer.invoke('ui:error', payload),
  // 어깨너머 오버레이
  openMainWindow: () => ipcRenderer.invoke('window:openMain'),
  overlayResize: (height) => ipcRenderer.send('overlay:resize', height),
  overlaySetVisible: (visible) => ipcRenderer.send('overlay:setVisible', visible),
  // OS 알림 클릭 → 대기 항목(Inbox) 열기
  onOpenInbox: (cb) => {
    const h = () => cb()
    ipcRenderer.on('ui:open-inbox', h)
    return () => ipcRenderer.removeListener('ui:open-inbox', h)
  },
}

contextBridge.exposeInMainWorld('lain', api)
