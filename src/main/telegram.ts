// §20.3 텔레그램 채널 어댑터 — 자리 비웠을 때 폰으로 와이어드 지휘·결재.
// 의존성 0: Telegram Bot API는 HTTPS뿐 → Node(Electron 42) 전역 fetch로 long-polling.
// 인증: 허용 채팅 ID 화이트리스트 1개(§20.5). 그 외 채팅은 무시.
// 아웃바운드: notify 훅 미러(에러·TASK.md·우선순위 등) + 승인/결재/명확화 액션 푸시(인라인 버튼).
// 인바운드: PC와 동일 조작 — 승인·답변·관리자/Navi 채팅·작업 시작/취소/검증/스캔/현황.
// 안전: 봇 토큰은 시크릿 — 로그/메시지에 절대 노출하지 않는다(§9-6).
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { DATA_DIR } from './paths'
import { appendCapped } from './logfile'
import {
  getSettings,
  getSetting,
  setSetting,
  listProjects,
  listTasks,
  getTask,
  getProject,
  listApprovals,
  getConversation,
  ensureActiveConversation,
  listConversationMessages,
} from './store'
import { resolveApproval } from './worker'
import { startTask, answerClarify, resolveReview, cancelTask } from './orchestrator'
import { sendToNavi, sendToAllNavis } from './navichat'
import { sendToManager, buildDigest } from './manager'
import { scanProjects } from './registry'
import { collectStatus, runVerify } from './collectors'
import { setNotifyHook } from './notify'
import type { TelegramStatus } from '../shared/types'

const LOG = path.join(DATA_DIR, 'telegram.log')
function tlog(m: string): void {
  try {
    // 봇 토큰(<id>:<hash>)이 메시지에 섞여 들어와도 로그에 남기지 않는다 (§9-6 시크릿 보호)
    const safe = m.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '<token-redacted>')
    appendCapped(LOG, `${new Date().toISOString()} ${safe}\n`)
  } catch {
    /* 로그 실패 무시 */
  }
}

// ── 상태 ──
let running = false
let genId = 0 // 폴 루프 세대 — stop/restart 시 증가시켜 기존 루프 무효화
let controller: AbortController | null = null
let botUsername: string | null = null
let lastError: string | null = null
// 부트스트랩 대기 — 미허용 채팅이 마지막으로 보낸 chat id. telegramChatId 설정 시 null로 비움.
let pendingChatId: string | null = null

// 이미 폰으로 민 항목 (중복 푸시 방지) — 해소되면 정리
const sentApprovals = new Set<number>()
const sentReview = new Set<string>()
const sentBlocked = new Set<string>()
const sentDone = new Set<string>()
let lastDigestSig = '' // C — 결정 대기 다이제스트: 대기 집합이 바뀔 때만 1회 재공지
/** Lain 기동 시각 — 이전 완료 작업을 재시작 때마다 재알림하지 않도록 비교 기준 */
const tgStartMs = Date.now()
// 답장(reply)으로 답을 받을 봇 메시지 → 무엇에 대한 답인지
type AskCtx = { kind: 'approval'; id: number } | { kind: 'clarify'; taskId: string }
const askByMsg = new Map<number, AskCtx>()

// ── 세션 배지 추적 — 세션이 바뀔 때만 배지·키보드 표시 (중복 방지) ──
let lastNotifiedConv: string | null = null

/** 상시 노출 Reply Keyboard — Lain은 단일 총괄 세션이라 세션 전환/생성 버튼은 없다. 현황만. */
const REPLY_KEYBOARD = {
  keyboard: [[
    { text: '💬 현황' },
  ]],
  resize_keyboard: true,
  is_persistent: true,
} as const

/** Lain은 단일 총괄 세션 — 폰·PC가 같은 하나를 공유한다. 항상 그 canonical 대화를 반환(나뉜 세션 없음). */
function tgActiveConv(): string {
  return ensureActiveConversation('manager')
}

/** 인라인 버튼 라벨 — 제목 우선, 없으면 마지막 메시지, 둘 다 없으면 '(새 대화)'. 개행 제거·40자 절단. */
export function sessionLabel(c: { title: string; lastContent: string | null }): string {
  const base = (c.title && c.title.trim()) || (c.lastContent ?? '').trim() || '(새 대화)'
  return base.replace(/\s*\n\s*/g, ' ').slice(0, 40)
}

/** 세션 선택 콜백 파싱(순수) — 'c|new'=새 세션, 'c|<convId>'=선택, 그 외 null. */
export function parseSessionCallback(
  data: string,
): { kind: 'new' } | { kind: 'pick'; id: string } | null {
  if (data === 'c|new') return { kind: 'new' }
  if (data.startsWith('c|')) {
    const id = data.slice(2)
    return id ? { kind: 'pick', id } : null
  }
  return null
}

/** 선택한 세션의 최근 대화 몇 줄 — "어떤 대화인지" 즉시 보이게. */
function sessionContext(convId: string): string {
  const msgs = listConversationMessages(convId, 4)
  if (msgs.length === 0) return '(빈 세션 — 메시지를 보내면 시작된다)'
  return msgs
    .map((m) => {
      const who = m.role === 'user' ? '🧑' : m.role === 'assistant' ? '🤖' : '·'
      return `${who} ${m.content.replace(/\s*\n\s*/g, ' ').slice(0, 140)}`
    })
    .join('\n')
}

// ── Bot API 래퍼 ──
async function api(
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const token = getSettings().telegramBotToken
  if (!token) throw new Error('no token')
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params ?? {}),
    signal,
  })
  const json: any = await res.json()
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`) // 토큰 비노출
  return json.result
}

function toTelegramHtml(md: string): string {
  // 텔레그램은 마크다운을 렌더하지 않아 **, `, ###, - 가 그대로 노이즈로 보인다. HTML parse_mode용으로
  // 변환하되 코드펜스는 split으로 분리해 escape만 한다(내부 마크다운 변환 제외 — placeholder 충돌 없음).
  // 표(| 셀 |)는 <pre> 고정폭으로, 목록은 • 불릿으로 변환한다.
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  function convertTable(lines: string[]): string {
    const rows = lines
      .filter(l => !/^\s*\|[\s:|-]+\|\s*$/.test(l)) // separator 행 제거
      .map(l => l.split('|').slice(1, -1).map(c => c.trim()))
    if (rows.length === 0) return esc(lines.join('\n'))
    const [header, ...body] = rows
    const fmt = (r: string[]) => r.map(c => esc(c)).join(' │ ')
    // <pre> 없이 plain text — 모바일에서 자연스럽게 줄바꿈되어 가독성 유지
    return [`<b>${fmt(header ?? [])}</b>`, ...body.map(fmt)].join('\n')
  }

  const processLine = (line: string): string => {
    let s = esc(line)
    s = s.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`) // 인라인 코드
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>') // **볼드**
    s = s.replace(/^\s*#{1,6}\s+(.+?)\s*$/, '<b>$1</b>') // ### 헤더 → 볼드
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // [텍스트](url) → 텍스트 (url)
    s = s.replace(/^(\s*)[-*]\s+/, '$1• ') // - / * 불릿 → •
    return s
  }

  return md
    .split(/(```[\w-]*\n?[\s\S]*?```)/g)
    .map((part, idx) => {
      if (idx % 2 === 1) {
        const code = part.replace(/^```[\w-]*\n?/, '').replace(/```\s*$/, '').replace(/\n+$/, '')
        return `<pre>${esc(code)}</pre>` // 코드블록 → 고정폭
      }
      // 표 블록 감지 (| 로 시작하는 연속 줄 2개 이상) → convertTable
      const lines = part.split('\n')
      const out: string[] = []
      let tableBuf: string[] = []
      const flushTable = () => {
        if (tableBuf.length >= 2) out.push(convertTable(tableBuf))
        else tableBuf.forEach(l => out.push(processLine(l)))
        tableBuf = []
      }
      for (const line of lines) {
        if (/^\s*\|/.test(line)) tableBuf.push(line)
        else { flushTable(); out.push(processLine(line)) }
      }
      flushTable()
      return out.join('\n')
    })
    .join('')
}

/** 코드블록 경계에서 텍스트 분할 — 블록 중간 절단 방지. */
function splitAtCodeBoundary(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let remain = text
  while (remain.length > limit) {
    const chunk = remain.slice(0, limit)
    // 코드펜스 닫힘이 limit 직후 400자 이내면 거기까지 포함 (블록 통째로)
    const fenceClose = remain.indexOf('\n```', limit)
    const cutAt =
      fenceClose > 0 && fenceClose < limit + 400
        ? fenceClose + 4
        : chunk.lastIndexOf('\n\n') > limit / 2
          ? chunk.lastIndexOf('\n\n')
          : limit
    parts.push(remain.slice(0, cutAt))
    remain = remain.slice(cutAt).trimStart()
  }
  if (remain) parts.push(remain)
  return parts
}

/** 허용 채팅으로 메시지 전송 — 텔레그램 가독성용 HTML 변환, 거부 시 평문 폴백. 반환=message_id. */
async function send(text: string, replyMarkup?: unknown): Promise<number | null> {
  const chatId = getSettings().telegramChatId
  if (!chatId) return null
  const html = toTelegramHtml(text.slice(0, 3800))
  try {
    const msg = await api('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    })
    return msg?.message_id ?? null
  } catch (e) {
    // HTML 파싱 거부 등 → 평문으로 폴백(전달 보장)
    tlog(`send html fail, fallback plain: ${(e as Error).message}`)
    try {
      const msg = await api('sendMessage', {
        chat_id: chatId,
        text: text.slice(0, 4000),
        reply_markup: replyMarkup,
        disable_web_page_preview: true,
      })
      return msg?.message_id ?? null
    } catch (e2) {
      lastError = String((e2 as Error).message)
      tlog(`send fail: ${lastError}`)
      return null
    }
  }
}

/** 긴 메시지를 코드블록 경계에서 분할해 순차 전송 — replyMarkup은 마지막 파트에만. */
async function sendLong(text: string, replyMarkup?: unknown): Promise<void> {
  const parts = splitAtCodeBoundary(text, 3600)
  for (let i = 0; i < parts.length; i++) {
    await send(parts[i], i === parts.length - 1 ? replyMarkup : undefined)
  }
}

/** B — 레인 응답이 '■ <프로젝트> — …' 섹션을 2개 이상 담으면 프로젝트별 메시지로 분할(시각·맥락 분리).
 *  SYSTEM_PROMPT의 멀티프로젝트 출력 계약과 짝 — 단일 프로젝트/일반 대화는 그대로 sendLong. */
async function sendManagerReply(text: string): Promise<void> {
  const parts = text.split(/\n(?=■\s)/) // '■ '로 시작하는 줄 앞에서 분할(서두는 parts[0])
  const sectionCount = parts.filter((p) => /^■\s/.test(p)).length
  if (sectionCount < 2) {
    await sendLong(text)
    return
  }
  for (const part of parts) {
    const t = part.trim()
    if (t) await sendLong(t)
  }
}

// ── 아웃바운드 미러 (notify 훅) ──
// 액션류(승인·질문·결재)는 reconcile가 버튼과 함께 따로 푸시하므로 평문 중복을 피한다.
function onNotify(title: string, body: string): void {
  if (/승인 필요|질문|결재 대기/.test(title)) return
  void send(`${title}\n${body}`)
}

// ── 미해결 액션 reconcile (DB에서 유도 → 버튼과 함께 푸시) ──
async function reconcile(): Promise<void> {
  if (!getSettings().telegramChatId) return
  try {
    // C) 결정 대기 통합 다이제스트 — 여러 건이 걸쳐 대기 중이면 '전체 할 일'을 한 줄로 먼저 공지(오케스트레이션 한눈).
    //    대기 집합(서명)이 바뀔 때만 1회. 단건이면 개별 메시지로 충분하니 생략.
    {
      const pa = listApprovals().filter((a) => a.state === 'pending')
      const bl = listTasks().filter((t) => t.state === 'blocked')
      const rv = listTasks().filter((t) => t.state === 'review')
      const total = pa.length + bl.length + rv.length
      const sig = [
        ...pa.map((a) => 'a' + a.id),
        ...bl.map((t) => 'b' + t.id),
        ...rv.map((t) => 'r' + t.id),
      ]
        .sort()
        .join(',')
      if (total >= 2 && sig !== lastDigestSig) {
        lastDigestSig = sig
        const projs = [...new Set([...bl.map((t) => t.projectId), ...rv.map((t) => t.projectId)])]
        const kinds: string[] = []
        if (rv.length) kinds.push(`결재 ${rv.length}`)
        if (bl.length) kinds.push(`질문 ${bl.length}`)
        if (pa.length) kinds.push(`승인 ${pa.length}`)
        await send(
          `🔔 **너의 결정 대기 ${total}건** — ${kinds.join(' · ')}` +
            (projs.length ? `\n프로젝트: ${projs.join(', ')}` : '') +
            `\n아래 각 항목 버튼으로 처리해줘.`,
        )
      } else if (total < 2) {
        lastDigestSig = '' // 0~1건으로 줄면 리셋 → 다시 여러 건 쌓일 때 재공지
      }
    }

    // 1) pending 승인 (위험 명령 = 버튼 / Navi 질문 = 답장)
    const pending = listApprovals().filter((a) => a.state === 'pending')
    for (const a of pending) {
      if (sentApprovals.has(a.id)) continue
      sentApprovals.add(a.id)
      if (a.kind === 'question') {
        const mid = await send(
          `❓ Navi 질문 — task ${a.taskId}\n${a.payload}\n\n↩ 이 메시지에 답장하면 Navi에 전달.`,
          { inline_keyboard: [[{ text: '❌ 거절', callback_data: `a${a.id}n` }]] },
        )
        if (mid) askByMsg.set(mid, { kind: 'approval', id: a.id })
      } else {
        await send(`⚠ 승인 필요 [${a.kind}] — task ${a.taskId}\n${a.payload}`, {
          inline_keyboard: [
            [
              { text: '✅ 승인', callback_data: `a${a.id}y` },
              { text: '❌ 거절', callback_data: `a${a.id}n` },
            ],
          ],
        })
      }
    }
    const pendingIds = new Set(pending.map((a) => a.id))
    for (const id of [...sentApprovals]) if (!pendingIds.has(id)) sentApprovals.delete(id)

    // 2) blocked 작업 (명확화 질문)
    const blocked = listTasks().filter((t) => t.state === 'blocked')
    for (const t of blocked) {
      if (sentBlocked.has(t.id)) continue
      sentBlocked.add(t.id)
      const mid = await send(
        // force_reply: 입력창이 자동으로 답장 모드로 열려 어느 프로젝트 질문인지 명확
        `❓ **[${t.projectId}]** 명확화\n\n${t.questions.join('\n\n')}`,
        { force_reply: true, selective: true, input_field_placeholder: `${t.projectId}에 답변` },
      )
      if (mid) askByMsg.set(mid, { kind: 'clarify', taskId: t.id })
    }
    for (const id of [...sentBlocked]) {
      const t = getTask(id)
      if (!t || t.state !== 'blocked') sentBlocked.delete(id)
    }

    // 3) review 작업 (결재 — 병합/브랜치만/폐기)
    const review = listTasks().filter((t) => t.state === 'review')
    for (const t of review) {
      if (sentReview.has(t.id)) continue
      sentReview.add(t.id)
      const lines = [
        `📋 결재 대기 — ${t.projectId} (task ${t.id})`,
        t.title,
        t.summary ? `\n${t.summary.slice(0, 800)}` : '',
        t.diffStat ? `diff: ${t.diffStat}` : '',
        t.verifyResult ? `verify: ${t.verifyResult}` : '',
      ].filter(Boolean)
      await send(lines.join('\n'), {
        inline_keyboard: [
          [
            { text: '🔀 병합', callback_data: `r|merge|${t.id}` },
            { text: '🌿 브랜치만', callback_data: `r|keep|${t.id}` },
            { text: '🗑 폐기', callback_data: `r|discard|${t.id}` },
          ],
        ],
      })
    }
    for (const id of [...sentReview]) {
      const t = getTask(id)
      if (!t || t.state !== 'review') sentReview.delete(id)
    }

    // 4) done / error / cancelled 완료 알림 — Lain 기동 이후 상태 변경된 것만
    const finished = listTasks().filter(
      (t) =>
        (t.state === 'done' || t.state === 'error' || t.state === 'cancelled') &&
        new Date(t.updatedAt).getTime() >= tgStartMs &&
        !sentDone.has(t.id),
    )
    for (const t of finished) {
      sentDone.add(t.id)
      const emoji = t.state === 'done' ? '✅' : t.state === 'error' ? '❌' : '🚫'
      const label = t.state === 'done' ? '완료' : t.state === 'error' ? '오류' : '취소됨'
      const lines = [
        `${emoji} ${label} — ${t.projectId}`,
        t.title,
        t.summary ? `\n${t.summary.slice(0, 400)}` : '',
      ].filter(Boolean)
      // 완료 시 후속 액션 버튼 — 새 작업 시작·verify
      let markup: unknown
      if (t.state === 'done') {
        const p = getProject(t.projectId)
        const btns: { text: string; callback_data: string }[] = [
          { text: '▶ 새 작업', callback_data: `act|go|${t.projectId}` },
        ]
        if (p?.verifyCmd) btns.push({ text: '✅ verify', callback_data: `act|verify|${t.projectId}` })
        markup = { inline_keyboard: [btns] }
      }
      await send(lines.join('\n'), markup)
    }
  } catch (e) {
    tlog(`reconcile fail: ${(e as Error).message}`)
  }
}

// ── 인바운드: 콜백(버튼) ──
async function handleCallback(cb: any): Promise<void> {
  const data: string = cb.data ?? ''
  const ack = (text?: string) =>
    api('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {})
  try {
    if (/^a\d+[yn]$/.test(data)) {
      const yes = data.endsWith('y')
      const id = Number(data.slice(1, -1))
      const still = listApprovals().find((a) => a.id === id && a.state === 'pending')
      if (!still) return void ack('이미 처리됨')
      resolveApproval(id, yes)
      askByMsg.forEach((v, k) => {
        if (v.kind === 'approval' && v.id === id) askByMsg.delete(k)
      })
      await ack(yes ? '승인됨' : '거절됨')
      await editDone(cb, yes ? '✅ 승인됨' : '❌ 거절됨')
    } else if (data.startsWith('r|')) {
      const [, act, taskId] = data.split('|')
      const action = act === 'merge' ? 'merge' : act === 'keep' ? 'keep-branch' : 'discard'
      const t = getTask(taskId)
      if (!t || t.state !== 'review') return void ack('검토 상태가 아님')
      const res = await resolveReview(taskId, action)
      await ack(res.slice(0, 180))
      await editDone(cb, `📋 ${action}: ${res.slice(0, 200)}`)
    } else if (data.startsWith('c|')) {
      // 단일 세션 — 옛 세션 선택/생성 콜백. 나뉜 세션이 없으니 안내만(폰·PC 한 대화 공유).
      await ack()
      await send(
        'Lain은 하나의 총괄 세션이다 — 나뉜 세션은 없다. 그냥 메시지를 보내면 이어진다.',
        REPLY_KEYBOARD,
      )
    } else if (data.startsWith('act|')) {
      // 인라인 버튼 액션 — act|<action>[|<projectId>]
      const [, action, projectId = ''] = data.split('|')
      if (action === 'status') {
        await ack()
        await send(buildDigest(listProjects()), {
          inline_keyboard: [[
            { text: '🔄 새로고침', callback_data: 'act|status' },
            { text: '📋 작업목록', callback_data: 'act|tasks' },
          ]],
        })
      } else if (action === 'tasks') {
        await ack()
        await send(tasksText(), {
          inline_keyboard: [[
            { text: '🔄 새로고침', callback_data: 'act|tasks' },
            { text: '📊 현황', callback_data: 'act|status' },
          ]],
        })
      } else if (action === 'go') {
        if (!projectId) return void ack('프로젝트 id 없음')
        const res = await startTask(projectId)
        await ack(res.error ? `⚠ ${res.error.slice(0, 40)}` : `▶ task ${res.taskId}`)
      } else if (action === 'verify') {
        const p = projectId ? getProject(projectId) : null
        if (p?.verifyCmd) {
          void runVerify(p).then(() => send(`✅ verify 완료: ${projectId}`))
          await ack('verify 시작')
        } else {
          await ack('verify 명령 없음')
        }
      } else {
        await ack()
      }
    } else {
      await ack()
    }
  } catch (e) {
    tlog(`cb fail: ${(e as Error).message}`)
    await ack('처리 실패')
  }
}

async function editDone(cb: any, suffix: string): Promise<void> {
  const m = cb.message
  if (!m) return
  await api('editMessageText', {
    chat_id: m.chat.id,
    message_id: m.message_id,
    text: `${(m.text ?? '').slice(0, 3500)}\n\n— ${suffix}`,
  }).catch(() => {})
}

// ── 인바운드: 음성 메시지 (STT) ──
async function handleVoice(m: any): Promise<void> {
  const groqKey = getSetting('groq_api_key')
  if (!groqKey) return void send('⚠ STT 비활성 — 설정(CFG)에서 Groq API 키를 등록해라')

  const fileObj = m.voice ?? m.audio
  if (fileObj.file_size > 24_000_000) return void send('⚠ 음성 파일이 너무 크다 (25MB 초과)')

  await send('🎙 음성 인식 중…')
  try {
    // 1. Telegram 파일 경로 취득
    const fileInfo = await api('getFile', { file_id: fileObj.file_id })
    const filePath: string = fileInfo.file_path

    // 2. 오디오 다운로드 (토큰은 URL에만 — 로그 비노출 §9-6)
    const token = getSettings().telegramBotToken
    const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
    if (!audioRes.ok) throw new Error(`download ${audioRes.status}`)
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer())

    // 3. Groq Whisper API (무료 — console.groq.com/keys)
    const ext = filePath.split('.').pop() ?? 'ogg'
    const mimeMap: Record<string, string> = {
      ogg: 'audio/ogg', mp3: 'audio/mpeg', mp4: 'audio/mp4',
      m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm',
    }
    const form = new FormData()
    form.append('file', new Blob([audioBuffer], { type: mimeMap[ext] ?? 'audio/ogg' }), `voice.${ext}`)
    form.append('model', 'whisper-large-v3')

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: form,
    })
    if (!resp.ok) {
      const errBody = await resp.text()
      throw new Error(`groq-whisper ${resp.status}: ${errBody.slice(0, 200)}`)
    }
    const { text: transcript } = (await resp.json()) as { text: string }
    if (!transcript?.trim()) return void send('⚠ 텍스트 인식 실패 (무음 또는 잡음)')

    // 4. 인식 결과 에코 후 텍스트 파이프라인으로 처리
    await send(`🎤 "${transcript}"`)
    await handleMessage({ ...m, text: transcript })
  } catch (e) {
    tlog(`handleVoice fail: ${(e as Error).message}`)
    void send(`⚠ 음성 인식 오류: ${(e as Error).message.slice(0, 200)}`)
  }
}

// ── 인바운드: 메시지 ──
async function handleMessage(m: any): Promise<void> {
  const text: string = (m.text ?? '').trim()
  if (!text) {
    if (m.voice ?? m.audio) await handleVoice(m)
    return
  }

  // 답장으로 질문/명확화 답변
  const rep = m.reply_to_message?.message_id
  if (rep && askByMsg.has(rep)) {
    const ctx = askByMsg.get(rep)!
    if (ctx.kind === 'approval') {
      const still = listApprovals().find((a) => a.id === ctx.id && a.state === 'pending')
      if (still) {
        resolveApproval(ctx.id, true, text)
        await send('↩ Navi에 전달됨')
      } else await send('이미 처리된 질문')
    } else {
      const t = getTask(ctx.taskId)
      if (t && t.state === 'blocked') {
        // 텔레그램 답장은 사용자發 → 'user' sender. 태그는 answerClarify가 모델에 닿는 프롬프트에만 붙인다.
        await answerClarify(ctx.taskId, text, 'user')
        await send('↩ 답변 전달 — 작업 재개')
      } else await send('이미 처리된 질문')
    }
    askByMsg.delete(rep)
    return
  }

  // ── Reply Keyboard 버튼 인터셉트 — Lain은 단일 총괄 세션(나뉜 세션·목록 없음) ──
  // '💬 현재 세션'은 옛(박제된) 키보드 라벨 — 같이 흡수하고, 응답에 REPLY_KEYBOARD를 실어 새 키보드로 자가치유한다.
  if (text === '💬 현황' || text === '💬 현재 세션') {
    const conv = tgActiveConv()
    const c = getConversation(conv)
    return void send(`💬 ${c ? sessionLabel(c) : conv}\n\n${sessionContext(conv)}`, REPLY_KEYBOARD)
  }
  // 옛 키보드(➕ 새 세션·📋 세션 목록)를 눌렀을 때 — 단일 세션이라 전환/생성 없음. 안내만(폰·PC 한 대화 공유).
  if (text === '➕ 새 세션' || text === '📋 세션 목록') {
    return void send(
      'Lain은 하나의 총괄 세션이다 — 나뉜 세션·목록은 없다. 그냥 메시지를 보내면 이어서 대화한다.',
      REPLY_KEYBOARD,
    )
  }

  if (text.startsWith('/')) return handleCommand(text)
  if (text.startsWith('@')) return handleNaviChat(text)

  const conv = tgActiveConv() // 단일 총괄 세션 — 항상 canonical 대화

  // 세션이 바뀌었을 때만 배지 + Reply Keyboard 표시 (재시작 후 첫 메시지 포함)
  if (conv !== lastNotifiedConv) {
    const c = getConversation(conv)
    const label = c?.lastContent ? `💬 ${sessionLabel(c)}` : '🆕 새 세션 시작'
    await send(label, REPLY_KEYBOARD)
    lastNotifiedConv = conv
  }
  return routeToManager(text, conv)
}

async function routeToManager(text: string, conversationId: string): Promise<void> {
  // emit은 텔레그램 봇 회신 전용. PC 렌더러 반영은 manager의 rendererMirror가 conversationId 태깅해 처리(중복 아님).
  // origin='telegram' → 폰에서 친 메시지도 PC의 해당 세션·목록에 라이브로 뜬다(§20.3 동기화).
  // 응답중 표시: 텔레그램 typing은 ~5초만 유지 → 4초마다 재전송, 첫 회신 도착 또는 finally에서 정지.
  const chatId = getSettings().telegramChatId
  const sendTyping = () => {
    if (chatId) void api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  }
  let typing: ReturnType<typeof setInterval> | null = null
  const stopTyping = () => {
    if (typing) {
      clearInterval(typing)
      typing = null
    }
  }
  sendTyping()
  typing = setInterval(sendTyping, 4000)
  try {
    await sendToManager(
      text,
      (ev) => {
        if (ev.kind === 'assistant') {
          stopTyping()
          void sendManagerReply(ev.text)
        } else if (ev.kind === 'error') {
          stopTyping()
          void send(`⚠ ${ev.message}`)
        }
      },
      false,
      [],
      0,
      conversationId,
      'telegram',
    )
  } finally {
    stopTyping()
  }
}

async function handleNaviChat(text: string): Promise<void> {
  const sp = text.indexOf(' ')
  if (sp < 0) return void send('형식: @<프로젝트id> <메시지>  또는  @all <메시지>')
  const target = text.slice(1, sp)
  const body = text.slice(sp + 1).trim()
  if (!body) return void send('메시지가 비어있다')
  const emit = (ev: any) => {
    if (ev.kind === 'assistant') void send(`[${ev.projectId}] ${ev.text}`)
    else if (ev.kind === 'error') void send(`⚠ ${ev.message}`)
  }
  const res =
    target === 'all' ? await sendToAllNavis(body, emit) : await sendToNavi(target, body, emit)
  if (res?.error) void send(`⚠ ${res.error}`)
}

const HELP = `lain 텔레그램 — 폰에서 와이어드 지휘·결재.

Lain은 하나의 총괄 세션이다 (폰·PC가 같은 대화 공유). 나뉜 세션·목록·전환 없음.
💬 현황 버튼 — 지금 맥락 보기.
평문 → Lain과 그대로 대화(이어짐)

@<프로젝트id> <메시지> → 해당 Navi에게 (idle만)
@all <메시지> → 전체 Navi broadcast

/status  현황 다이제스트
/tasks   진행 중 작업
/projects  프로젝트 목록
/go <프로젝트id> [작업내용]  작업 시작 (작업내용 없으면 TASK.md)
/cancel <taskId>  작업 취소
/verify <프로젝트id>  검증 실행
/scan  프로젝트 재스캔
/approvals  미해결 승인/결재 다시 보기
/deploy  lain 재빌드 & 재시작 (소스 변경 반영, 커밋된 것만)
/help  이 도움말

승인·결재는 알림 메시지의 버튼으로, 질문 답변은 그 메시지에 답장(reply)으로.`

async function handleCommand(text: string): Promise<void> {
  const sp = text.indexOf(' ')
  const cmd = (sp < 0 ? text : text.slice(0, sp)).toLowerCase()
  const arg = sp < 0 ? '' : text.slice(sp + 1).trim()
  switch (cmd) {
    case '/start':
      return void send(HELP, REPLY_KEYBOARD)
    case '/help':
      return void send(HELP)
    case '/sessions':
    case '/session':
    case '/new':
      // Lain은 단일 총괄 세션 — 세션 목록·생성 개념 폐기. 그냥 평문을 보내면 그 하나에서 이어진다.
      return void send(
        'Lain은 하나의 총괄 세션이다 — 나뉜 세션·목록은 없다. 그냥 메시지를 보내면 이어서 대화한다.',
        REPLY_KEYBOARD,
      )
    case '/status':
    case '/s':
      return void send(buildDigest(listProjects()), {
        inline_keyboard: [[
          { text: '🔄 새로고침', callback_data: 'act|status' },
          { text: '📋 작업목록', callback_data: 'act|tasks' },
        ]],
      })
    case '/tasks':
    case '/t':
      return void send(tasksText(), {
        inline_keyboard: [[
          { text: '🔄 새로고침', callback_data: 'act|tasks' },
          { text: '📊 현황', callback_data: 'act|status' },
        ]],
      })
    case '/projects':
    case '/p':
      return void send(projectsText())
    case '/approvals':
      return reconcile()
    case '/go': {
      if (!arg) return void send('형식: /go <프로젝트id> [작업내용]')
      // arg를 첫 공백으로 분리 — pid + (선택)작업내용. content 있으면 즉석 작업, 없으면 기존 TASK.md 경로.
      const gsp = arg.indexOf(' ')
      const pid = gsp < 0 ? arg : arg.slice(0, gsp)
      const content = gsp < 0 ? '' : arg.slice(gsp + 1).trim()
      const res = await startTask(pid, content ? { content } : {})
      return void send(res.error ? `⚠ ${res.error}` : `▶ 작업 시작 — task ${res.taskId}`)
    }
    case '/cancel': {
      if (!arg) return void send('형식: /cancel <taskId>')
      const t = getTask(arg)
      if (!t) return void send('해당 task 없음')
      cancelTask(arg)
      return void send(`취소: ${arg}`)
    }
    case '/verify': {
      if (!arg) return void send('형식: /verify <프로젝트id>')
      const p = getProject(arg)
      if (!p) return void send('프로젝트 없음')
      if (!p.verifyCmd) return void send('verify 명령이 없는 프로젝트')
      void runVerify(p).then(() => send(`verify 완료: ${arg}`))
      return void send(`verify 실행 중: ${arg}`)
    }
    case '/scan': {
      const n = scanProjects()
      await Promise.all(listProjects().filter((p) => p.enabled).map((p) => collectStatus(p)))
      return void send(`스캔 완료 — 새 프로젝트 ${n}건`)
    }
    case '/deploy': {
      // 흔한 silent 실패(미커밋)를 즉시 잡아 알린다 — 배포 가드가 dirty 트리를 거부하기 때문.
      try {
        const dirty = execFileSync('git', ['-C', 'C:\\lain', 'status', '--porcelain'], {
          encoding: 'utf8',
        }).trim()
        if (dirty)
          return void send(
            '⚠ 배포 거부: C:\\lain에 커밋 안 된 변경이 있다. PC에서 커밋 후 다시 /deploy.\n' +
              dirty.split('\n').slice(0, 8).join('\n'),
          )
      } catch (e) {
        return void send(`배포 전 git 확인 실패: ${String((e as Error).message).slice(0, 120)}`)
      }
      // detached로 스폰 → lain 종료돼도 deploy.ps1이 끝까지 실행. 모든 출력은 %APPDATA%\lain\deploy.log에 남는다.
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\lain\\scripts\\deploy.ps1'],
        { detached: true, stdio: 'ignore', cwd: 'C:\\lain' },
      )
      ps.unref()
      return void send(
        '🔨 배포 시작 — C:\\lain에서 빌드·패키지 후 lain 자동 재시작(1~2분). 봇이 잠깐 끊겼다 돌아온다.\n' +
          '※ 결과·실패원인은 %APPDATA%\\lain\\deploy.log로 확인.',
      )
    }
    default:
      return void send(`알 수 없는 명령: ${cmd}\n\n${HELP}`)
  }
}

function tasksText(): string {
  const active = listTasks().filter(
    (t) => !['done', 'cancelled', 'error'].includes(t.state),
  )
  if (active.length === 0) return '진행 중 작업 없음'
  return active
    .map((t) => `${stateGlyph(t.state)} ${t.projectId} [${t.state}] task ${t.id}\n  ${t.title}`)
    .join('\n')
}

function projectsText(): string {
  const ps = listProjects().filter((p) => p.enabled)
  if (ps.length === 0) return '등록된 프로젝트 없음 — /scan'
  return ps
    .map((p) => {
      const s = p.status
      const tag = s?.hasTaskMd ? ' ▶TASK.md' : ''
      return `${p.id}${s?.gitBranch ? ` (${s.gitBranch})` : ''} test:${s?.testState ?? '?'}${tag}`
    })
    .join('\n')
}

function stateGlyph(state: string): string {
  return (
    {
      clarifying: '…',
      blocked: '❓',
      ready: '○',
      working: '●',
      review: '📋',
    } as Record<string, string>
  )[state] ?? '·'
}

// ── 디스패치 + 인증 ──
function authorized(chatId: unknown): boolean {
  const allowed = getSettings().telegramChatId
  return !!allowed && String(chatId) === allowed
}

async function dispatch(update: any): Promise<void> {
  const msg = update.message ?? update.edited_message
  const cb = update.callback_query
  const fromChat = msg?.chat?.id ?? cb?.message?.chat?.id

  // 부트스트랩(§20.5): 허용 채팅 미설정이면 채팅 ID만 안내, 명령 실행 안 함.
  if (!getSettings().telegramChatId) {
    if (fromChat != null) pendingChatId = String(fromChat) // 설정 UI 자동감지용 — 마지막으로 본 미허용 채팅
    if (msg)
      await api('sendMessage', {
        chat_id: fromChat,
        text: `lain 연결 대기.\n이 채팅 ID: ${fromChat}\n설정(CFG)의 '텔레그램 채팅ID'에 등록하면 명령을 받는다.`,
      }).catch(() => {})
    return
  }
  if (!authorized(fromChat)) {
    tlog(`unauthorized chat ${fromChat}`)
    if (cb) await api('answerCallbackQuery', { callback_query_id: cb.id, text: '권한 없음' }).catch(() => {})
    return
  }
  if (cb) return handleCallback(cb)
  if (msg) return handleMessage(msg)
}

// ── 폴 루프 ──
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}

// 텔레그램 오프셋 — DB가 아닌 fsync 파일로 영속한다. 무한루프 사고(2026-06-20)의 근본 차단:
// (1) 오프셋을 dispatch '뒤'에 저장하면, dispatch가 restart_lain/deploy_lain으로 앱을 종료시킬 때
//     저장이 막혀 오프셋이 안 올라가고 같은 메시지가 재시작마다 무한 재처리됐다.
// (2) DB WAL의 오프셋 값은 손상 복구로 폐기되면 되돌아갔다(이중 위험).
// → 파일에 fsync로, 그리고 dispatch '전에' 저장해 둘 다 막는다. (처리 도중 종료된 1건은 재전달 안 됨 — 루프보다 안전)
const OFFSET_FILE = (): string => path.join(DATA_DIR, 'telegram_offset')
function readOffset(): number {
  try {
    const v = Number(fs.readFileSync(OFFSET_FILE(), 'utf8').trim())
    if (Number.isFinite(v)) return v
  } catch {
    /* 파일 없음 — DB 설정에서 1회 마이그레이션 */
  }
  const s = Number(getSetting('telegram_offset') ?? '0')
  return Number.isFinite(s) ? s : 0
}
function writeOffset(n: number): void {
  try {
    const fd = fs.openSync(OFFSET_FILE(), 'w')
    try {
      fs.writeSync(fd, String(n))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* 파일 실패해도 아래 DB 기록으로 폴백 */
  }
  try {
    setSetting('telegram_offset', String(n)) // 가시성·호환용(파일이 진실의 출처)
  } catch {
    /* 무시 */
  }
}

async function poll(gen: number, signal: AbortSignal): Promise<void> {
  let offset = readOffset()
  while (gen === genId && !signal.aborted) {
    try {
      const updates: any[] = await api(
        'getUpdates',
        { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
        signal,
      )
      lastError = null
      for (const u of updates) {
        offset = u.update_id + 1
        // ⚠️ 오프셋을 dispatch '전에' 영속한다 — dispatch가 restart_lain/deploy_lain으로 앱을 종료시켜도
        // 같은 메시지를 재처리하지 않게(무한루프 차단, 2026-06-20). fsync 파일이라 WAL 폐기에도 안전.
        writeOffset(offset)
        try {
          await dispatch(u)
        } catch (e) {
          tlog(`dispatch fail: ${(e as Error).message}`)
        }
      }
      await reconcile() // 폴 직후 미해결 액션 재확인 (이벤트 훅과 이중 안전)
    } catch (e) {
      if (signal.aborted) break
      const m = (e as Error).message
      if (m !== lastError) tlog(`poll fail: ${m}`) // 같은 에러 3초마다 무한 로깅 방지 — 변화 시에만
      lastError = m
      await sleep(3000, signal)
    }
  }
}

// ── Bot Commands 등록 (§20.3) — / 자동완성 팝업 활성화 ──
async function registerCommands(): Promise<void> {
  try {
    await api('setMyCommands', {
      commands: [
        { command: 'status',    description: '현황 다이제스트' },
        { command: 'tasks',     description: '진행 중 작업 목록' },
        { command: 'projects',  description: '프로젝트 목록' },
        { command: 'approvals', description: '미해결 승인·결재 다시 보기' },
        { command: 'go',        description: '작업 시작: <프로젝트id> [작업내용]' },
        { command: 'cancel',    description: '작업 취소: <taskId>' },
        { command: 'verify',    description: '검증 실행: <프로젝트id>' },
        { command: 'scan',      description: '프로젝트 재스캔' },
        { command: 'deploy',    description: 'Lain 재빌드·재시작' },
        { command: 'help',      description: '도움말' },
      ],
    })
    tlog('commands registered')
  } catch (e) {
    tlog(`registerCommands fail: ${(e as Error).message}`)
  }
}

// ── 수명주기 ──
export async function startTelegram(): Promise<void> {
  stopTelegram()
  const s = getSettings()
  if (!s.telegramEnabled || !s.telegramBotToken) return
  setNotifyHook(onNotify)
  const gen = ++genId
  running = true
  controller = new AbortController()
  try {
    const me = await api('getMe')
    botUsername = me?.username ?? null
    lastError = null
    tlog(`started @${botUsername}`)
    void registerCommands()
  } catch (e) {
    lastError = (e as Error).message
    tlog(`getMe fail: ${lastError}`)
  }
  void poll(gen, controller.signal)
  void reconcile() // 시작 시 미해결 액션 한 번 밀기
}

export function stopTelegram(): void {
  genId++ // 기존 루프 무효화
  running = false
  controller?.abort()
  controller = null
  setNotifyHook(null)
  sentApprovals.clear()
  sentReview.clear()
  sentBlocked.clear()
  sentDone.clear()
  askByMsg.clear()
  lastNotifiedConv = null // 재시작 후 첫 메시지에 배지 다시 표시
  pendingChatId = null
}

export function restartTelegram(): void {
  void startTelegram()
}

/** 오케스트레이터/스케줄러 이벤트 시 즉시 미해결 액션 푸시 (폴 주기 무관). */
export function telegramReconcile(): void {
  if (running) void reconcile()
}

/** Lain 관리자가 직접 텔레그램으로 메시지를 전송한다. 봇/채팅 미설정이면 false 반환. */
export async function sendTelegram(text: string): Promise<boolean> {
  const mid = await send(text)
  return mid !== null
}

/**
 * 로컬 이미지 파일을 텔레그램으로 전송한다(sendPhoto, multipart). 봇/채팅 미설정·파일 없음 시 false.
 * caption은 텔레그램 제한(1024자)으로 절단. JSON api()와 달리 FormData라 별도 fetch.
 */
export async function sendTelegramPhoto(filePath: string, caption?: string): Promise<boolean> {
  const { telegramBotToken: token, telegramChatId: chatId } = getSettings()
  if (!token || !chatId) return false
  try {
    const buf = fs.readFileSync(filePath)
    const ext = (path.extname(filePath).slice(1) || 'png').toLowerCase()
    const mime =
      ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as Record<string, string>)[ext] ??
      'image/png'
    const form = new FormData()
    form.append('chat_id', chatId)
    if (caption) form.append('caption', caption.slice(0, 1024))
    form.append('photo', new Blob([buf], { type: mime }), `image.${ext}`)
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
    })
    const json: any = await res.json()
    if (!json.ok) throw new Error(json.description ?? String(res.status)) // 토큰 비노출
    return true
  } catch (e) {
    lastError = String((e as Error).message)
    tlog(`sendPhoto fail: ${lastError}`)
    return false
  }
}

export function telegramStatus(): TelegramStatus {
  const s = getSettings()
  const chatLinked = !!s.telegramChatId
  return {
    running: running && s.telegramEnabled && !!s.telegramBotToken,
    username: botUsername,
    chatLinked,
    lastError,
    // 연결되면 노출 안 함 — 미연결일 때만 마지막으로 본 미허용 채팅 id를 설정 UI에 제안
    pendingChatId: chatLinked ? null : pendingChatId,
  }
}
