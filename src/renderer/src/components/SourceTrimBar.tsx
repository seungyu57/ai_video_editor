import { useEffect, useRef, useState } from 'react'
import type { SourceClip, TimelineClip } from '@shared/types'
import { fmtClock } from '@shared/montage'

const MIN_LEN = 0.2 // 최소 컷 길이(초)

/**
 * 선택한 클립의 원본 전체를 보여주고, AI가 고른 in/out 구간을 핸들로 조절.
 * 드래그 중에는 onScrub 으로 미리보기 프레임을 이동, 놓으면 onCommit 으로 확정.
 */
export function SourceTrimBar({
  clip,
  source,
  onScrub,
  onCommit
}: {
  clip: TimelineClip
  source: SourceClip
  onScrub: (sourceId: string, sourceTime: number) => void
  onCommit: (clipId: string, inSec: number, outSec: number) => void
}): JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null)
  const dur = source.durationSec || Math.max(clip.outSec, 1)
  const [range, setRange] = useState<{ inSec: number; outSec: number }>({
    inSec: clip.inSec,
    outSec: clip.outSec
  })
  // 드래그 핸들러가 최신 range 를 참조하도록 ref 미러(콜백을 setState 밖에서 호출).
  const rangeRef = useRef(range)
  const dragRef = useRef<'in' | 'out' | null>(null)

  // 선택 클립이 바뀌면 로컬 range 동기화.
  useEffect(() => {
    const r = { inSec: clip.inSec, outSec: clip.outSec }
    rangeRef.current = r
    setRange(r)
  }, [clip.id, clip.inSec, clip.outSec])

  function timeFromClientX(clientX: number): number {
    const el = barRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const ratio = (clientX - rect.left) / Math.max(1, rect.width)
    return Math.max(0, Math.min(ratio * dur, dur))
  }

  useEffect(() => {
    function onMove(e: PointerEvent): void {
      if (!dragRef.current) return
      const t = timeFromClientX(e.clientX)
      const cur = rangeRef.current
      let next: { inSec: number; outSec: number }
      if (dragRef.current === 'in') {
        next = { inSec: Math.max(0, Math.min(t, cur.outSec - MIN_LEN)), outSec: cur.outSec }
      } else {
        next = { inSec: cur.inSec, outSec: Math.min(dur, Math.max(t, cur.inSec + MIN_LEN)) }
      }
      // 콜백/상태갱신은 순수하게: ref 갱신 → setState(값) → 바깥에서 onScrub.
      rangeRef.current = next
      setRange(next)
      onScrub(source.id, dragRef.current === 'in' ? next.inSec : next.outSec)
    }
    function onUp(): void {
      if (!dragRef.current) return
      dragRef.current = null
      const r = rangeRef.current
      if (r.inSec !== clip.inSec || r.outSec !== clip.outSec) {
        onCommit(clip.id, r.inSec, r.outSec)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, clip.inSec, clip.outSec, dur, source.id, onScrub, onCommit])

  const inPct = (range.inSec / dur) * 100
  const outPct = (range.outSec / dur) * 100

  return (
    <div className="trim">
      <div className="trim-head">
        <span className="trim-title">{source.name}</span>
        <span className="trim-stat">
          원본 {fmtClock(dur)} · 선택 {fmtClock(range.inSec)}–{fmtClock(range.outSec)} (
          {(range.outSec - range.inSec).toFixed(1)}s)
        </span>
      </div>
      <div
        className="trim-bar"
        ref={barRef}
        onPointerDown={(e) => {
          // 바 클릭 시 해당 위치로 미리보기 이동
          if (e.target === barRef.current) onScrub(source.id, timeFromClientX(e.clientX))
        }}
      >
        <div className="trim-dim" style={{ left: 0, width: `${inPct}%` }} />
        <div className="trim-dim" style={{ left: `${outPct}%`, right: 0 }} />
        <div className="trim-region" style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }}>
          <span className="trim-region-label">AI 추천 구간</span>
        </div>
        <div
          className="trim-handle in"
          style={{ left: `${inPct}%` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
            dragRef.current = 'in'
            onScrub(source.id, range.inSec)
          }}
        />
        <div
          className="trim-handle out"
          style={{ left: `${outPct}%` }}
          onPointerDown={(e) => {
            e.stopPropagation()
            ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
            dragRef.current = 'out'
            onScrub(source.id, range.outSec)
          }}
        />
      </div>
    </div>
  )
}
