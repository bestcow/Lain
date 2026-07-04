// 업데이트 제안 타이밍 게이트 — 순수 판정(의존성·부작용 0, vitest 단위테스트 가능).
// compactgate.ts와 동형: 무거운 본체(electron-updater 배선)는 updater.ts, 판정만 여기 둔다.

// ② "Lain이 업데이트를 자발 제안해도 되는 때인가" — 알림이 켜져 있고(notifyEnabled),
// 지금 작업 중인 Navi가 하나도 없을 때만(workingCount<=0). 작업 중이면 끼어들지 않고 끝날 때까지 보류.
// (사용자가 우려한 "원치 않을 때 업데이트로 업무 지연"을, 자동설치 대신 '한가할 때 제안'으로 푼다.)
export function shouldSurfaceUpdate(workingCount: number, notifyEnabled: boolean): boolean {
  return notifyEnabled && workingCount <= 0
}
