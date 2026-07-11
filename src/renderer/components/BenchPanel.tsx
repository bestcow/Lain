// §23 평가 하네스 — 자기개선 효과를 A/B로 측정해 보여준다.
// no-lessons vs with-lessons의 성공률·1회통과율·평균 턴·비용 나란히.
import { useEffect, useRef, useState } from 'react'
import type { BenchSummary } from '../../shared/types'
import { fmtTokens } from '../App'
import { Icon } from './icons'

const COND_LABEL: Record<string, string> = {
  'no-lessons': '학습 OFF',
  'with-lessons': '학습 ON',
}

export function BenchPanel({ onClose }: { onClose: () => void }) {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [summary, setSummary] = useState<BenchSummary | null>(null)
  // C10 — 영속 이력(시간순, 오래된 런 먼저). 마운트 시 즉시 로드해 방금 돌린 런만 보이는 문제 해소.
  const [history, setHistory] = useState<BenchSummary[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = window.lain.onBenchProgress((msg) => setLog((p) => [...p, msg]))
    return off
  }, [])
  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, [log.length])

  // C10 — 마운트 시 이력 조회 + 마지막 런을 즉시 요약으로 표시.
  useEffect(() => {
    window.lain
      .listBenchRuns()
      .then((runs) => {
        setHistory(runs)
        if (runs.length > 0) setSummary(runs[runs.length - 1])
      })
      .catch(() => {
        /* 이력 없음/조회 실패 — 빈 상태로 둔다 */
      })
  }, [])

  const run = () => {
    setRunning(true)
    setSummary(null)
    setLog(['벤치 시작 — Navi를 여러 번 돌립니다(몇 분, 토큰 소모).'])
    window.lain
      .runBench()
      .then((s) => {
        setSummary(s)
        setHistory((prev) => [...prev, s])
      })
      .catch((e) => setLog((p) => [...p, `실패: ${e}`]))
      .finally(() => setRunning(false))
  }

  const conds = summary ? Object.keys(summary.byCondition) : []

  return (
    <div className="drawer panel bench-panel">
      <div className="drawer-head">
        <span className="drawer-title">[ wired://bench — 평가 하네스 §23 ]</span>
        <button onClick={run} disabled={running}>
          {running ? (
            '실행 중...'
          ) : (
            <>
              <Icon name="play" size={14} /> 벤치 실행
            </>
          )}
        </button>
        <button onClick={onClose}><Icon name="x-circle" size={18} /></button>
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

      {/* C10 — 런별 성공률 추이(시간순, 최신이 위). 방금 돌린 런만 보이던 문제 해소. */}
      {history.length > 0 && (
        <div className="bench-trend">
          <div className="bench-trend-label">이력 · {history.length}건</div>
          <div className="bench-trend-list">
            {history
              .slice()
              .reverse()
              .map((s) => (
                <div key={s.runId} className="bench-trend-row">
                  {/* startedAt은 store.listBenchRuns가 bench_runs.created_at(SQLite datetime('now'),
                      'YYYY-MM-DD HH:MM:SS')을 그대로 준다 — 'T' 구분자 없음. 방금 실행분은 runBench가
                      new Date().toISOString()을 넘겨 'T' 포함 ISO라 두 포맷이 섞일 수 있어 공백/T 모두 대비. */}
                  <span className="dim">{s.startedAt.replace('T', ' ').slice(0, 16)}</span>
                  <span className="bench-trend-run">{s.runId}</span>
                  {Object.keys(s.byCondition).map((c) => (
                    <span key={c} className="bench-trend-cond">
                      {COND_LABEL[c] ?? c} {Math.round(s.byCondition[c].successRate * 100)}%
                    </span>
                  ))}
                  {s.regression && <span className="bench-trend-warn" title={s.regression}>⚠</span>}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
