// §23 평가 하네스 — 자기개선 효과를 A/B로 측정해 보여준다.
// no-lessons vs with-lessons의 성공률·1회통과율·평균 턴·비용 나란히.
import { useEffect, useRef, useState } from 'react'
import type { BenchSummary } from '../../shared/types'
import { fmtTokens } from '../App'

const COND_LABEL: Record<string, string> = {
  'no-lessons': '교훈 OFF',
  'with-lessons': '교훈 ON',
}

export function BenchPanel({ onClose }: { onClose: () => void }) {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [summary, setSummary] = useState<BenchSummary | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = window.lain.onBenchProgress((msg) => setLog((p) => [...p, msg]))
    return off
  }, [])
  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, [log.length])

  const run = () => {
    setRunning(true)
    setSummary(null)
    setLog(['벤치 시작 — Navi를 여러 번 돌립니다(몇 분, 토큰 소모).'])
    window.lain
      .runBench()
      .then((s) => setSummary(s))
      .catch((e) => setLog((p) => [...p, `실패: ${e}`]))
      .finally(() => setRunning(false))
  }

  const conds = summary ? Object.keys(summary.byCondition) : []

  return (
    <div className="drawer panel bench-panel">
      <div className="drawer-head">
        <span className="drawer-title">[ wired://bench — 평가 하네스 §23 ]</span>
        <button onClick={run} disabled={running}>
          {running ? '실행 중...' : '▶ 벤치 실행'}
        </button>
        <button onClick={onClose}>✕</button>
      </div>

      {summary && conds.length > 0 && (
        summary.regression ? (
          <div className="bench-alert">{summary.regression}</div>
        ) : (
          <div className="bench-ok">회귀 없음</div>
        )
      )}

      {summary && conds.length > 0 && (
        <table className="bench-table">
          <thead>
            <tr>
              <th>지표</th>
              {conds.map((c) => (
                <th key={c}>{COND_LABEL[c] ?? c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['성공률', (m: any) => `${Math.round(m.successRate * 100)}%`],
                ['1회 통과율', (m: any) => `${Math.round(m.firstPassRate * 100)}%`],
                ['평균 턴', (m: any) => m.avgTurns.toFixed(1)],
                ['평균 토큰', (m: any) => fmtTokens(m.avgTokens)],
                ['n', (m: any) => String(m.n)],
              ] as const
            ).map(([label, fmt]) => (
              <tr key={label}>
                <td className="dim">{label}</td>
                {conds.map((c) => (
                  <td key={c}>{fmt(summary.byCondition[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="bench-log">
        {log.map((l, i) => (
          <div key={i} className="bench-log-line">
            {l}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
