// 상호작용 대사(Ambient Quips) 말풍선 — main의 quip:show를 구독해 레인 캐릭터 위에 짧은 한마디를
// 띄우고, 글자수 비례 시간(2.5s + 60ms/자, cap 8s) 후 페이드아웃한다(오버레이의 적응형 표시시간과 동형).
// 채팅 로그엔 남지 않는 플레이버 표시 전용 — 대화 맥락은 main이 매니저 인지 버퍼로 잇는다('하나의 레인').
import { useEffect, useState } from 'react'

export function LainBubble() {
  const [quip, setQuip] = useState<{ text: string; seq: number } | null>(null)
  useEffect(
    () =>
      window.lain.onQuip(({ text }) => {
        setQuip((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 })) // seq로 리마운트 → 애니메이션 재시작
      }),
    [],
  )
  if (!quip) return null
  const ms = Math.min(8000, 2500 + quip.text.length * 60)
  return (
    <div
      key={quip.seq}
      className="lain-bubble"
      style={{ animationDuration: `${ms}ms` }}
      onAnimationEnd={() => setQuip(null)}
      role="status"
    >
      {quip.text}
    </div>
  )
}
