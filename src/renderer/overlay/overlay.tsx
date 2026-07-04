// 유저 감시 오버레이 렌더러 — Lain이 '먼저 말을 걸 때(proactive 반응)'만 우하단에 잠깐 떴다 사라지는 경량 창.
// 평소엔 숨김(메인이 창 자체를 숨김). 감시(화면 관찰)는 메인의 watcher가 상시 돌고, 도울 말이 있을 때만 등장.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatEvent } from '../../shared/types'
import './overlay.css'

const BASE_FONT = 14
const MIN_FONT = 9
const MIN_WIN_H = 56
const MAX_WIN_H = Math.max(160, Math.floor((window.screen?.availHeight ?? 900) * 0.5))
const TEXT_CAP = 700
const ANIM_MS = 280 // overlay.css 슬라이드 transition과 일치

// preload 누락 등으로 window.lain이 없어도 크래시하지 않게 가드.
const lain = (typeof window !== 'undefined' ? window.lain : undefined) as Window['lain'] | undefined

function cap(s: string): string {
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP).trimEnd() + '…' : s
}

// 적응형 노출 시간 — 2.5초 + 글자수×0.065초, 4~10초. 짧은 한마디는 짧게, 긴 조언은 길게.
function showMs(text: string): number {
  return Math.max(4000, Math.min(10000, Math.round(2500 + text.length * 65)))
}

type Phase = 'hidden' | 'enter' | 'shown' | 'exit'

function Overlay() {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>('hidden')
  const [clipped, setClipped] = useState(false)
  const [faceSrc, setFaceSrc] = useState('../overlay-face.png')
  const cardRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovering = useRef(false)

  const clearTimers = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    if (exitTimer.current) clearTimeout(exitTimer.current)
    hideTimer.current = null
    exitTimer.current = null
  }, [])

  // 노출 타이머 무장 — 시간 지나면 슬라이드 퇴장 후 창 숨김. 마우스 올려져 있으면 떼면 사라지게 짧게 재무장.
  const armHide = useCallback((ms: number) => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (hovering.current) {
        armHide(1500) // 읽는 중 — 떼면 곧 사라짐
        return
      }
      setPhase('exit')
      exitTimer.current = setTimeout(() => {
        setPhase('hidden')
        try {
          lain?.overlaySetVisible(false)
        } catch {
          /* 무시 */
        }
      }, ANIM_MS)
    }, ms)
  }, [])

  // Lain이 먼저 말을 걸 때(proactive)만 띄운다. 일반 대화 응답(비-proactive)엔 안 뜸.
  useEffect(() => {
    if (!lain) return
    const off = lain.onChatEvent((ev: ChatEvent) => {
      if (ev.kind !== 'assistant' || !ev.proactive || !ev.text.trim()) return
      const t = ev.text.trim()
      setText(t)
      clearTimers()
      try {
        lain.overlaySetVisible(true) // 메인이 창 표시(게이트: 유저 감시 ON && 메인 비활성)
      } catch {
        /* 무시 */
      }
      setPhase('enter')
      // 두 프레임 뒤 shown으로 전환 → 슬라이드 인(enter 클래스가 먼저 페인트되도록)
      requestAnimationFrame(() => requestAnimationFrame(() => setPhase('shown')))
      armHide(showMs(t)) // 말하는 도중 새 반응이 오면 위 clearTimers로 타이머 리셋됨
    })
    return () => {
      off()
      clearTimers()
    }
  }, [armHide, clearTimers])

  // 폰트 오토핏 + 창 높이 리사이즈 — 내용에 맞춰 카드가 커지되 화면 절반 넘으면 폰트 축소.
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
      className={`ov-card ov-${phase}`}
      ref={cardRef}
      onMouseEnter={() => {
        hovering.current = true
        if (hideTimer.current) {
          clearTimeout(hideTimer.current)
          hideTimer.current = null
        }
      }}
      onMouseLeave={() => {
        hovering.current = false
        if (phase === 'shown') armHide(2000)
      }}
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
        className="ov-face"
        src={faceSrc}
        alt="lain"
        onError={() => {
          if (faceSrc !== '../manager.png') setFaceSrc('../manager.png')
        }}
      />
      <div className="ov-body">
        <div className="ov-name">Lain</div>
        <div className="ov-text" ref={textRef}>
          {cap(text)}
        </div>
      </div>
      {clipped && <div className="ov-fade" />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
