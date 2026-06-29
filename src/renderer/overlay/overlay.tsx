// 어깨너머 오버레이 렌더러 — 레인 메인 대화의 '최신 1개'만 보여주는 우하단 경량 창.
// 메인창과 같은 chat:event 스트림을 구독하므로 타임라인은 단일(소스 하나, 표시 둘).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatEvent } from '../../shared/types'
import './overlay.css'

const BASE_FONT = 14
const MIN_FONT = 9
const MIN_WIN_H = 56
// 화면 절반까지만 키운다(그 이상은 폰트 축소 후 아래에서 잘림). 스크롤 없이 '한눈에' 보장.
const MAX_WIN_H = Math.max(160, Math.floor((window.screen?.availHeight ?? 900) * 0.5))
// 표시 안전 상한 — 비정상적으로 긴 발화(또는 긴 시드)가 레이아웃을 깨지 않게. 실제 반응은 훨씬 짧다.
const TEXT_CAP = 700

// preload 누락 등으로 window.lain이 없어도 크래시하지 않게 가드.
const lain = (typeof window !== 'undefined' ? window.lain : undefined) as Window['lain'] | undefined

function cap(s: string): string {
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP).trimEnd() + '…' : s
}

function Overlay() {
  const [text, setText] = useState('어깨너머로 지켜보는 중…')
  const [idle, setIdle] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [clipped, setClipped] = useState(false)
  const [faceSrc, setFaceSrc] = useState('../overlay-face.png')
  const cardRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)

  // 초기 시드 — 활성 레인 대화의 마지막 assistant 발화를 띄워 빈 카드 방지.
  useEffect(() => {
    if (!lain) return
    let cancelled = false
    void (async () => {
      try {
        const cid = await lain.getActiveConversation('manager')
        if (!cid) return
        const msgs = await lain.conversationMessages(cid)
        const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content.trim())
        if (!cancelled && last) {
          setText(last.content.trim())
          setIdle(false)
        }
      } catch {
        /* 시드 실패는 무시 — idle 문구 유지 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 라이브 구독 — assistant 발화가 오면 최신 1개로 교체.
  useEffect(() => {
    if (!lain) return
    const off = lain.onChatEvent((ev: ChatEvent) => {
      if (ev.kind === 'assistant' && ev.text.trim()) {
        setText(ev.text.trim())
        setIdle(false)
        setThinking(false)
      } else if (ev.kind === 'result' || ev.kind === 'error') {
        setThinking(false)
      }
    })
    return off
  }, [])

  // 폰트 오토핏 + 창 높이 리사이즈 — 내용에 맞춰 카드가 커지되 화면 절반 넘으면 폰트 축소.
  // 그래도 넘치면 창은 상한에서 멈추고 '아래'에서만 잘린다(얼굴/이름은 top 앵커라 항상 보임) + 페이드 표시.
  useLayoutEffect(() => {
    const card = cardRef.current
    const txt = textRef.current
    if (!card || !txt) return
    let fs = BASE_FONT
    txt.style.fontSize = fs + 'px'
    while (fs > MIN_FONT && card.scrollHeight > MAX_WIN_H) {
      fs -= 1
      txt.style.fontSize = fs + 'px'
    }
    const needed = card.scrollHeight
    const h = Math.min(MAX_WIN_H, Math.max(MIN_WIN_H, Math.ceil(needed)))
    setClipped(needed > MAX_WIN_H + 1)
    try {
      lain?.overlayResize(h)
    } catch {
      /* 리사이즈 IPC 미가용 무시 */
    }
  }, [text])

  return (
    <div
      className="ov-card"
      ref={cardRef}
      onClick={() => {
        try {
          void lain?.openMainWindow()
        } catch {
          /* 무시 */
        }
      }}
      title="레인 창 열기"
    >
      <img
        className={`ov-face${thinking ? ' ov-thinking' : ''}`}
        src={faceSrc}
        alt="lain"
        onError={() => {
          if (faceSrc !== '../manager.png') setFaceSrc('../manager.png')
        }}
      />
      <div className="ov-body">
        <div className="ov-name">Lain</div>
        <div className={`ov-text${idle ? ' ov-idle' : ''}`} ref={textRef}>
          {cap(text)}
        </div>
      </div>
      {clipped && <div className="ov-fade" />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
