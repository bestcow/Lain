// 앱 종료 시퀀스 오케스트레이션 (순수 — electron 미의존, 단위 테스트 가능).
//
// 목표 순서(안정성 감사 지적 교정):
//   ① 타이머·폴러·감시 전부 정지
//   ② 창 상태 등 마지막 쓰기 — Electron이 before-quit 뒤 창 close 핸들러에서 수행(우리 코드 밖)
//   ③ closeStore는 모든 쓰기가 끝난 뒤 가장 마지막(will-quit)
//
// 기존 버그: closeStore가 before-quit에서 돌아, Electron이 그 '뒤'에 실행하는 창 close 핸들러의
// setSetting('window_bounds')이 이미 닫힌 DB에 쓰려다 조용히 삼켜졌다(무해화). 순서를 바로잡아
// bounds 쓰기가 열린 DB에 닿게 하고, 그래도 닫힌 DB 쓰기가 관측되면 드러낸다(isStoreClosed).
//
// 격리·멱등: 한 정지 단계가 throw해도 나머지·closeStore가 스킵되지 않게 각 단계를 try로 감싼다
// (기존 before-quit은 격리가 없어 stopTelegram이 터지면 closeStore까지 못 갔다). before-quit·will-quit는
// deploy --quit·window-all-closed 등으로 중복 fire될 수 있어 각 페이즈를 1회만 실행한다.

export interface ShutdownSteps {
  /** ① 정지: 배경 활동 정지 함수. 삽입 순서대로 격리 실행된다(이름은 로그/검증용). */
  stops: Record<string, () => void>
  /** ③ 마지막: DB 닫기(모든 쓰기 후). */
  closeStore: () => void
  /** 격리된 단계가 throw하면 호출(로그용). 종료 흐름은 막지 않는다. */
  onError?: (phase: 'stop' | 'finalize', step: string, e: unknown) => void
}

export interface Shutdown {
  /** before-quit 단계 — 모든 배경 활동 정지(멱등). 실행된 단계 이름을 순서대로 반환(검증용). */
  stopBackground(): string[]
  /** will-quit 단계 — DB 닫기(멱등, 반드시 stopBackground 뒤). */
  finalize(): void
  /** DB가 이미 닫혔는지 — 종료 뒤 늦은 쓰기(닫힌 DB write) 감지용. */
  isStoreClosed(): boolean
}

export function createShutdown(steps: ShutdownSteps): Shutdown {
  let stopped = false
  let closed = false

  const runIsolated = (phase: 'stop' | 'finalize', name: string, fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      steps.onError?.(phase, name, e)
    }
  }

  function stopBackground(): string[] {
    if (stopped) return []
    stopped = true
    const order: string[] = []
    for (const [name, fn] of Object.entries(steps.stops)) {
      order.push(name)
      runIsolated('stop', name, fn)
    }
    return order
  }

  function finalize(): void {
    if (closed) return
    // 방어: before-quit을 못 거치고 바로 will-quit이 와도 배경 정지부터 보장(③은 항상 ① 뒤).
    if (!stopped) stopBackground()
    closed = true
    runIsolated('finalize', 'closeStore', steps.closeStore)
  }

  return { stopBackground, finalize, isStoreClosed: () => closed }
}
