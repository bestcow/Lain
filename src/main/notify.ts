// 능동 보고 (PLAN.md §5.5) — 네 반응이 필요한 순간만 OS 알림.
// 창이 포커스돼 있으면 침묵(이미 보고 있음), 백그라운드면 네이티브 알림 + 클릭 시 창 복귀.
import { BrowserWindow, Notification } from 'electron'

// §20.3 채널 어댑터 훅 — telegram.ts가 등록한다. notify는 의존성 0을 유지하고
// (orchestrator→notify→telegram→orchestrator 순환 차단), 채널은 콜백으로만 붙인다.
type NotifyHook = (title: string, body: string) => void
let hook: NotifyHook | null = null
export function setNotifyHook(fn: NotifyHook | null): void {
  hook = fn
}
// §C #8 음성 통화 알림 훅 — discord.ts가 등록. 통화 중이면 능동 보고를 음성으로도 읽는다(텔레그램 훅과 독립).
let voiceHook: NotifyHook | null = null
export function setVoiceNotifyHook(fn: NotifyHook | null): void {
  voiceHook = fn
}

// 렌더러 인박스(대기 항목) 열림 상태 — ipc(ui:inbox-state)가 갱신.
// "자리에 있음" 판단을 포커스 단독에서 '포커스 AND 인박스 열림'으로 좁혀, 인박스를 안 보는 동안엔 OS 토스트가 살아있게 한다.
let inboxOpen = false
export function setInboxOpen(open: boolean): void {
  inboxOpen = open
}

export function notifyUser(title: string, body: string): void {
  // 메인창만 고른다 — 어깨너머 오버레이(focusable:false·skipTaskbar)가 [0]일 수 있어
  // 포커스 판정·클릭 복귀·ui:open-inbox가 오버레이로 잘못 가던 것 차단. 의존성 0 유지(타이틀/포커스로 식별).
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  const win = wins.find((w) => w.isFocusable()) ?? wins[0]
  // 채널 미러 (텔레그램 등) — 로컬 포커스와 무관하게 항상 미러. 실패해도 OS 알림에 영향 없게 격리.
  if (hook) {
    try {
      hook(title, body)
    } catch {
      /* 채널 전송 실패는 무시 */
    }
  }
  // 음성 통화 채널(디스코드) — 통화 중이면 음성으로도 읽는다. 실패 격리.
  if (voiceHook) {
    try {
      voiceHook(title, body)
    } catch {
      /* 무시 */
    }
  }
  // OS 토스트 침묵: 창이 포커스돼 있고 인박스까지 열려 있을 때만(이미 대기 항목을 보고 있음).
  // 포커스만 됐고 인박스를 안 보는 중이면 토스트는 띄운다.
  if (win && win.isFocused() && inboxOpen) return
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body: body.slice(0, 200) })
  n.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('ui:open-inbox') // 클릭 → 대기 항목(Inbox) 바로 열기
    }
  })
  n.show()
}
