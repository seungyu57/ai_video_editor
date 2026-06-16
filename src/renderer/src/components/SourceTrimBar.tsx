import { useEffect, useRef, useState } from 'react'
import type { ProjectSettings, SourceClip, TimelineClip } from '@shared/types'
import { fmtClock } from '@shared/montage'

const MIN_LEN = 0.2 // 최소 컷 길이(초)

/**
 * 선택한 클립의 원본 전체를 보여주고, 현재 in/out 을 핸들로 조절.
 * 별도로 AI 추천 구간을 점선 밴드로 표시하고, "AI 추천 적용" 버튼으로 그 구간만 남기도록 트림.
 */
export function SourceTrimBar({
  clip,
  source,
  settings,
  onScrub,
  onCommit
}: {
  clip: TimelineClip
  source: SourceClip
  settings: ProjectSettings
  onScrub: (sourceId: string, sourceTime: number) => void
  onCommit: (clipId: string, inSec: number, outSec: number) => void
}): JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null)
  const dur = source.durationSec || Math.max(clip.outSec, 1)
  const [range, setRange] = useState<{ inSec: number; outSec: number }>({
    inSec: clip.inSec,
    outSec: clip.outSec
  })
  const [ai, setAi] = useState<{ inSec: number; outSec: number } | null>(null)
  const rangeRef = useRef(range)
  const dragRef = useRef<'in' | 'out' | null>(null)

  // 선택 클립이 바뀌면 로컬 range 동기화.
  useEffect(() => {
    const r = { inSec: clip.inSec, outSec: clip.outSec }
    rangeRef.current = r
    setRange(r)
  }, [clip.id, clip.inSec, clip.outSec])

  // 선택한 소스의 AI 추천 구간을 비동기로 가져와 점선 밴드로 표시.
  useEffect(() => {
    let cancelled = false
    setAi(null)
    window.clipreel
      .analyzeSuggest(source, settings)
      .then((r) => {
        if (!cancelled) setAi(r)
      })
      .catch(() => {
        if (!cancelled) setAi(null)
      })
    return () => {
      cancelled = true
    }
  }, [source.id, settings.preRollSec, settings.postRollSec])

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
  const aiInPct = ai ? (ai.inSec / dur) * 100 : 0
  const aiOutPct = ai ? (ai.outSec / dur) * 100 : 0
  // 이미 AI 구간과 거의 동일하면 버튼 비활성.
  const matchesAi =
    !!ai && Math.abs(ai.inSec - range.inSec) < 0.05 && Math.abs(ai.outSec - range.outSec) < 0.05

  return (
    <div className="trim">
      <div className="trim-head">
        <span className="trim-title">{source.name}</span>
        <div className="trim-right">
          <span className="trim-stat">
            원본 {fmtClock(dur)} · 선택 {fmtClock(range.inSec)}–{fmtClock(range.outSec)} (
            {(range.outSec - range.inSec).toFixed(1)}s)
          </span>
          <button
            className="trim-apply"
            disabled={!ai || matchesAi}
            title="이 클립을 AI 추천 구간으로 자릅니다"
            onClick={() => ai && onCommit(clip.id, ai.inSec, ai.outSec)}
          >
            ✨ AI 추천 적용
          </button>
        </div>
      </div>
      <div
        className="trim-bar"
        ref={barRef}
        onPointerDown={(e) => {
          if (e.target === barRef.current) onScrub(source.id, timeFromClientX(e.clientX))
        }}
      >
        <div className="trim-dim" style={{ left: 0, width: `${inPct}%` }} />
        <div className="trim-dim" style={{ left: `${outPct}%`, right: 0 }} />

        {ai && (
          <div
            className="trim-ai"
            style={{ left: `${aiInPct}%`, width: `${Math.max(0, aiOutPct - aiInPct)}%` }}
          >
            <span className="trim-ai-label">AI 추천</span>
          </div>
        )}

        <div className="trim-region" style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }}>
          <span className="trim-region-label">선택 구간</span>
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
