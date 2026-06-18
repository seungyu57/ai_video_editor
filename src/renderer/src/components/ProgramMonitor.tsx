import { fmtClock } from '@shared/timeline'

export function ProgramMonitor({
  videoRef,
  playing,
  playheadSec,
  gap,
  total,
  fps,
  hasClips,
  onToggle
}: {
  videoRef: React.RefObject<HTMLVideoElement>
  playing: boolean
  playheadSec: number
  gap: boolean
  total: number
  fps: number
  hasClips: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <section className="program-monitor">
      <div className="player-wrap">
        <video ref={videoRef} className="player" playsInline />
        {(gap || !hasClips) && <div className="program-black" />}
        {!hasClips && (
          <div className="preview-overlay">
            좌측 미디어를 아래 타임라인으로 <b>드래그</b>해 편집을 시작하세요.
          </div>
        )}
      </div>
      <div className="transport">
        <button className="play-btn" onClick={onToggle} disabled={!hasClips} title={playing ? '일시정지(Space)' : '재생(Space)'}>
          {playing ? '⏸' : '▶'}
        </button>
        <span className="tcode">
          {fmtClock(playheadSec, fps)} / {fmtClock(total)}
        </span>
        <span className="monitor-note">미리보기 = 최상위 비디오 트랙 · 전체 레이어는 내보내기 시 합성</span>
      </div>
    </section>
  )
}
