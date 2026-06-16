import type { HistoryEntry } from '@shared/types'

export function HistoryPanel({ history }: { history: HistoryEntry[] }): JSX.Element {
  return (
    <div className="history">
      <div className="hist-head">편집 히스토리</div>
      {history.length === 0 ? (
        <div className="hist-empty">아직 편집 기록이 없습니다.</div>
      ) : (
        <ol className="hist-list">
          {history.map((h, i) => (
            <li key={i}>
              <span className="hist-label">{h.label}</span>
              <span className="hist-time">
                {new Date(h.at).toLocaleTimeString('ko-KR', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
