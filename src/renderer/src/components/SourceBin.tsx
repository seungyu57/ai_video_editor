import type { SourceClip } from '@shared/types'
import { fmtClock } from '@shared/timeline'

export function SourceBin({
  sources,
  busy,
  selectedSourceId,
  onPick,
  onDragSource
}: {
  sources: SourceClip[]
  busy: boolean
  selectedSourceId: string | null
  onPick: (s: SourceClip) => void
  onDragSource: (id: string | null) => void
}): JSX.Element {
  return (
    <aside className="col-left">
      <div className="list-head">
        미디어 {sources.length}
        {busy && <span className="spin"> · 작업 중…</span>}
      </div>
      {sources.length === 0 && !busy && (
        <div className="empty">
          상단 <b>📂 가져오기</b>로 클립 폴더를 선택하세요.
        </div>
      )}
      <ul className="bin-list">
        {sources.map((s) => (
          <li
            key={s.id}
            className={`bin-item${s.id === selectedSourceId ? ' active' : ''}${s.error ? ' has-err' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('clipreel/source', s.id)
              e.dataTransfer.effectAllowed = 'copy'
              onDragSource(s.id)
            }}
            onDragEnd={() => onDragSource(null)}
            onClick={() => onPick(s)}
            title="타임라인으로 드래그해 추가"
          >
            <div className="bin-thumb">🎞</div>
            <div className="bin-meta">
              <div className="bin-name">{s.name}</div>
              <div className="bin-stats">
                {fmtClock(s.durationSec)} · {s.resolution || '메타 없음'}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  )
}
