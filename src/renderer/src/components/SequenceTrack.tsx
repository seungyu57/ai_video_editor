import { useLayoutEffect, useRef, useState } from 'react'
import type { SourceClip, TimelineClip } from '@shared/types'
import type { TimelineDiff } from '@shared/editops'
import { buildLayout, fmtClock, niceStep } from '@shared/montage'

const PAD = 12

export function SequenceTrack({
  clips,
  sources,
  selectedClipId,
  montageTime,
  diff,
  onSelect,
  onSeek,
  onReorder,
  onAddSource
}: {
  clips: TimelineClip[]
  sources: SourceClip[]
  selectedClipId: string | null
  montageTime: number
  diff?: TimelineDiff | null
  onSelect: (clip: TimelineClip) => void
  onSeek: (montageTime: number) => void
  onReorder: (clipId: string, toOrder: number) => void
  onAddSource: (sourceId: string, toOrder: number) => void
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const scrubRef = useRef(false)
  const [scrubbing, setScrubbing] = useState(false)
  const [width, setWidth] = useState(800)
  const [dropIdx, setDropIdx] = useState<number | null>(null)

  const { items, total } = buildLayout(clips)
  const sourceById = new Map(sources.map((s) => [s.id, s]))
  const added = new Set(diff?.added ?? [])
  const changed = new Set(diff?.changed ?? [])

  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(w)
    })
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const usable = Math.max(40, width - PAD * 2)
  const pps = total > 0 ? usable / total : 0

  const step = niceStep(total > 0 ? total / 8 : 1)
  const ticks: number[] = []
  for (let t = 0; t <= total + 0.001 && pps > 0; t += step) ticks.push(t)

  function xFromClientX(clientX: number): number {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return clientX - rect.left + el.scrollLeft - PAD
  }

  function seekFromClientX(clientX: number): void {
    if (pps <= 0) return
    onSeek(Math.max(0, Math.min(xFromClientX(clientX) / pps, total)))
  }

  function endScrub(e: React.PointerEvent): void {
    scrubRef.current = false
    setScrubbing(false)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  function computeDropIdx(clientX: number): number {
    if (items.length === 0) return 0
    const x = xFromClientX(clientX)
    let idx = items.findIndex((it) => x < (it.start + it.dur / 2) * pps)
    if (idx < 0) idx = items.length
    return idx
  }

  /** 우리 앱의 드래그(소스 추가 / 블록 재정렬)인지. */
  function isOurDrag(e: React.DragEvent): boolean {
    const types = e.dataTransfer.types
    return types.includes('clipreel/source') || types.includes('clipreel/clip')
  }

  const dropLeft =
    dropIdx === null
      ? 0
      : PAD + (dropIdx >= items.length ? total : items[dropIdx].start) * pps

  return (
    <div className="seq">
      <div className="seq-ruler" onPointerDown={(e) => seekFromClientX(e.clientX)}>
        {ticks.map((t) => (
          <span key={t} className="seq-tick" style={{ left: PAD + t * pps }}>
            {fmtClock(t)}
          </span>
        ))}
      </div>

      <div
        className="seq-track"
        ref={trackRef}
        onPointerDown={(e) => {
          if (e.target === trackRef.current) seekFromClientX(e.clientX)
        }}
        onDragOver={(e) => {
          if (!isOurDrag(e)) return
          e.preventDefault()
          setDropIdx(computeDropIdx(e.clientX))
        }}
        onDragLeave={(e) => {
          // 트랙 전체를 벗어날 때만 마커 제거(자식 블록 위로 이동 시 깜빡임 방지).
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIdx(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          const di = dropIdx ?? computeDropIdx(e.clientX)
          const srcId = e.dataTransfer.getData('clipreel/source')
          if (srcId) {
            onAddSource(srcId, di)
          } else {
            const clipId = e.dataTransfer.getData('clipreel/clip')
            if (clipId) {
              // dropIdx 는 "제거 전" 삽입 위치 → 앞에서 끌어오면 한 칸 보정.
              const fromIdx = items.findIndex((it) => it.clip.id === clipId)
              const target = fromIdx >= 0 && fromIdx < di ? di - 1 : di
              onReorder(clipId, target)
            }
          }
          setDropIdx(null)
        }}
      >
        {items.length === 0 && (
          <div className="seq-hint">
            좌측 소스를 여기로 <b>드래그</b>해 추가하거나, <b>자동편집</b>으로 채우세요.
          </div>
        )}

        {items.map((it, i) => {
          const c = it.clip
          const src = sourceById.get(c.sourceId)
          const w = Math.max(8, it.dur * pps)
          const left = PAD + it.start * pps
          const diffClass = added.has(c.id)
            ? ' diff-added'
            : changed.has(c.id)
              ? ' diff-changed'
              : ''
          return (
            <div
              key={c.id}
              className={`seq-block origin-${c.origin}${c.id === selectedClipId ? ' active' : ''}${diffClass}`}
              style={{ left, width: w, animationDelay: `${Math.min(i * 35, 350)}ms` }}
              title={src?.name}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('clipreel/clip', c.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => setDropIdx(null)}
              onPointerDown={(e) => {
                e.stopPropagation()
                onSelect(c)
              }}
            >
              <div className="sb-name">
                <span className="sb-order">{i + 1}</span>
                {src?.name ?? c.sourceId}
              </div>
              <div className="sb-foot">
                <span>{it.dur.toFixed(1)}s</span>
                {c.reasons[0] && <span className="sb-tag">{c.reasons[0]}</span>}
              </div>
            </div>
          )
        })}

        {dropIdx !== null && <div className="seq-drop" style={{ left: dropLeft }} />}

        {items.length > 0 && (
          <div
            className={`seq-playhead${scrubbing ? ' scrubbing' : ''}`}
            style={{ left: PAD + montageTime * pps }}
            onPointerDown={(e) => {
              e.stopPropagation()
              scrubRef.current = true
              setScrubbing(true)
              e.currentTarget.setPointerCapture(e.pointerId)
              seekFromClientX(e.clientX)
            }}
            onPointerMove={(e) => {
              if (scrubRef.current) seekFromClientX(e.clientX)
            }}
            onPointerUp={(e) => endScrub(e)}
            onPointerCancel={(e) => endScrub(e)}
            onLostPointerCapture={() => {
              scrubRef.current = false
              setScrubbing(false)
            }}
          >
            <div className="seq-playhead-hit" />
            <div className="seq-playhead-knob" />
          </div>
        )}
      </div>
    </div>
  )
}
