// preload (PLAN.md §14) — contextBridge로 화이트리스트된 IPC만 노출
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
  Approval,
  ChatEvent,
  LainApi,
  Lesson,
  McpServer,
  ProjectView,
  Routine,
  Task,
  TaskEvent,
  NaviChatEvent,
  DiscordStateEvent,
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
  setEnabled: (id, enabled) => ipcRenderer.invoke('projects:setEnabled', id, enabled),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),
  pushProject: (id) => ipcRenderer.invoke('projects:push', id),
  refreshStatus: (id) => ipcRenderer.invoke('status:refresh', id ?? null),
  runVerify: (id) => ipcRenderer.invoke('verify:run', id),
  sendChat: (text, attachments, conversationId) =>
    ipcRenderer.invoke('chat:send', text, attachments, conversationId),
  stopChat: () => ipcRenderer.invoke('chat:stop'),
  resetManager: () => ipcRenderer.invoke('chat:reset'),
  chatHistory: () => ipcRenderer.invoke('chat:history'),
  onProjectsUpdated: (cb) => subscribe<ProjectView[]>('projects:updated', cb),
  onChatEvent: (cb) => subscribe<ChatEvent>('chat:event', cb),
  getBriefing: () => ipcRenderer.invoke('briefing:get'),
  onBriefingUpdated: (cb) => subscribe<string>('briefing:updated', cb),
  appStartedAt: () => ipcRenderer.invoke('app:startedAt'),
  // Phase 1: tasks
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  startTask: (projectId) => ipcRenderer.invoke('tasks:start', projectId),
  answerClarify: (taskId, answers) => ipcRenderer.invoke('tasks:answer', taskId, answers),
  resolveReview: (taskId, action) => ipcRenderer.invoke('tasks:resolveReview', taskId, action),
  cancelTask: (taskId) => ipcRenderer.invoke('tasks:cancel', taskId),
  resumeTask: (taskId) => ipcRenderer.invoke('tasks:resume', taskId),
  setTaskPermissionMode: (taskId, mode) =>
    ipcRenderer.invoke('tasks:setPermissionMode', taskId, mode),
  setTaskThinking: (taskId, level) => ipcRenderer.invoke('tasks:setThinking', taskId, level),
  setTaskDisallowedTools: (taskId, tools) =>
    ipcRenderer.invoke('tasks:setDisallowedTools', taskId, tools),
  setTaskImages: (taskId, images) => ipcRenderer.invoke('tasks:setImages', taskId, images),
  setTaskFastMode: (taskId, on) => ipcRenderer.invoke('tasks:setFastMode', taskId, on),
  taskEvents: (taskId) => ipcRenderer.invoke('tasks:events', taskId),
  taskDiff: (taskId) => ipcRenderer.invoke('tasks:diff', taskId),
  listApprovals: () => ipcRenderer.invoke('approvals:list'),
  resolveApproval: (id, approved, answer) =>
    ipcRenderer.invoke('approvals:resolve', id, approved, answer),
  answerQuestion: (questionId, answer) => ipcRenderer.invoke('question:answer', questionId, answer),
  onTasksUpdated: (cb) => subscribe<Task[]>('tasks:updated', cb),
  onTaskEvent: (cb) => subscribe<TaskEvent>('task:event', cb),
  onApprovalsUpdated: (cb) => subscribe<Approval[]>('approvals:updated', cb),
  // 설정
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  telegramStatus: () => ipcRenderer.invoke('telegram:status'),
  discordStatus: () => ipcRenderer.invoke('discord:status'),
  onDiscordState: (cb) => subscribe<DiscordStateEvent>('discord:state', cb),
  // §5.6 Navi 직접 채팅
  sendNaviChat: (projectId, text, attachments, conversationId) =>
    ipcRenderer.invoke('workerchat:send', projectId, text, attachments, conversationId),
  stopNaviChat: (projectId) => ipcRenderer.invoke('workerchat:stop', projectId),
  naviChatHistory: (projectId) => ipcRenderer.invoke('workerchat:history', projectId),
  onNaviChatEvent: (cb) => subscribe<NaviChatEvent>('workerchat:event', cb),
  onConversationsUpdated: (cb) => subscribe<string>('conversations:updated', cb),
  conversationPreviews: () => ipcRenderer.invoke('chat:previews'),
  // 다중 세션
  listConversations: (target) => ipcRenderer.invoke('conversations:list', target),
  createConversation: (target) => ipcRenderer.invoke('conversations:create', target),
  conversationMessages: (conversationId) =>
    ipcRenderer.invoke('conversations:messages', conversationId),
  getActiveConversation: (target) => ipcRenderer.invoke('conversations:getActive', target),
  setActiveConversation: (target, conversationId) =>
    ipcRenderer.invoke('conversations:setActive', target, conversationId),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', id, title),
  // 채팅 우클릭 메뉴
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  setChapter: (messageId, title) => ipcRenderer.invoke('chapter:set', messageId, title),
  // §22 자기개선
  listLessons: () => ipcRenderer.invoke('lessons:list'),
  flagLesson: (id) => ipcRenderer.invoke('lesson:flag', id),
  unflagLesson: (id) => ipcRenderer.invoke('lesson:unflag', id),
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
  // 창 제어 (frameless — OS 타이틀바를 헤더에 통합)
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  onWindowMaximized: (cb) => subscribe<boolean>('window:maximized', cb),
  // 렌더러 인박스 열림/닫힘 통지 (자리 비움 판단)
  setInboxOpen: (open) => ipcRenderer.send('ui:inbox-state', open),
  // 어깨너머 오버레이
  openMainWindow: () => ipcRenderer.invoke('window:openMain'),
  overlayResize: (height) => ipcRenderer.send('overlay:resize', height),
  // OS 알림 클릭 → 대기 항목(Inbox) 열기
  onOpenInbox: (cb) => {
    const h = () => cb()
    ipcRenderer.on('ui:open-inbox', h)
    return () => ipcRenderer.removeListener('ui:open-inbox', h)
  },
}

contextBridge.exposeInMainWorld('lain', api)
