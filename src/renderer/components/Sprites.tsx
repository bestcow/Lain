// 스프라이트.
// 관리자: 도트 PNG 에셋(public/manager.png). 파일을 떨구면 자동 표시, 없으면 플레이스홀더.
// (옛 Navi SVG 도트 스프라이트는 ProjectSprite로 대체돼 제거됨 — 여기엔 ManagerSprite만 남는다.)
import { useState } from 'react'

// ── 관리자 (PNG) ──
export function ManagerSprite({ size = 132, busy = false }: { size?: number; busy?: boolean }) {
  const [ok, setOk] = useState(true)
  if (!ok) {
    return (
      <span className="sprite sprite-manager-missing" style={{ height: size }}>
        manager.png
        <br />
        없음
      </span>
    )
  }
  return (
    <span className={`sprite sprite-manager${busy ? ' sprite-glitching' : ''}`}>
      <img
        src="manager.png"
        alt="lain"
        height={size}
        className="mgr-img"
        onError={() => setOk(false)}
      />
    </span>
  )
}
