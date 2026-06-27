import { useLayoutEffect, useRef, useState } from 'react'
import type { SourceClip, TimelineClip, Track } from '@shared/types'
import {
  clipEnd,
  fmtClock,
  niceStep,
  snap,
  snapCandidates,
  timelineDur,
  totalDuration,
  tracksByKind
} from '@shared/timeline'

const SNAP_PX = 8
const RULER_H = 26

export interface TimelinePanelProps {
  tracks: Track[]
  clips: TimelineClip[]
  sources: SourceClip[]
  fps: number
  pxPerSec: number
  setPxPerSec: (v: number | ((p: number) => number)) => void
  snapEnabled: boolean
  selectedClipIds: Set<string>
  /** AI 제안에서 바뀐 클립 id(편집본 미리보기 시 강조). */
  changedClipIds?: string[]
  playheadSec: number
  draggingSourceId: string | null
  onSelectClip: (id: string | null, additive?: boolean) => void
  onSplitPlayhead: () => void
  onRemoveClip: (id: string) => void
  onRippleDeleteClip: (id: string) => void
  onSetClipSpeed: (id: string, rate: number) => void
  onUnlinkClip: (id: string) => void
  onLinkSelected: () => void
  onSeek: (t: number, autoplay?: boolean) => void
  onShowFrame: (sourceId: string, sourceTime: number) => void
  onMoveClip: (id: string, toTrackId: string, toStartSec: number, moveLinked: boolean) => void
  onMoveClips: (ids: string[], startDelta: number, moveLinked: boolean) => void
  onTrimLeft: (id: string, newStartSec: number) => void
  onTrimRight: (id: string, newEndSec: number) => void
  onCloseGap: (trackId: string, gapStart: number, gapEnd: number) => void
  onAddSource: (sourceId: string, trackId: string, startSec: number) => void
  onToggleSnap: () => void
  onAddTrack: (kind: 'video' | 'audio') => void
  onMoveTrack: (trackId: string, dir: 'up' | 'down') => void
  onRemoveTrack: (trackId: string) => void
  onReorderTrack: (trackId: string, beforeTrackId: string | null) => void
  onSetTrackFlag: (trackId: string, flags: Partial<Pick<Track, 'enabled' | 'locked' | 'muted'>>) => void
}

type MoveGesture = {
  kind: 'move'
  id: string
  pointerId: number
  grabOffset: number
  startClientX: number
  startClientY: number
  moved: boolean
  curTrack: string
  curStart: number
  group: boolean
}
type TrimGesture = { kind: 'trim'; id: string; edge: 'in' | 'out'; pointerId: number; curStart: number; curEnd: number }
type ScrubGesture = { kind: 'scrub'; pointerId: number }
type Gesture = MoveGesture | TrimGesture | ScrubGesture | null

export function TimelinePanel(props: TimelinePanelProps): JSX.Element {
  const {
    tracks, clips, sources, fps, pxPerSec, setPxPerSec, snapEnabled,
    selectedClipIds, changedClipIds, playheadSec, draggingSourceId,
    onSelectClip, onSplitPlayhead, onRemoveClip, onRippleDeleteClip, onSetClipSpeed, onUnlinkClip,
    onLinkSelected, onSeek, onShowFrame, onMoveClip, onMoveClips, onTrimLeft, onTrimRight,
    onCloseGap, onAddSource, onToggleSnap, onAddTrack, onMoveTrack, onRemoveTrack, onReorderTrack, onSetTrackFlag
  } = props

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lanesRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<Gesture>(null)
  const pendingZoomRef = useRef<{ time: number; offsetX: number } | null>(null)

  const [drag, setDrag] = useState<{ id: string; track: string; start: number; snappedTo: number | null; linked: boolean; group: boolean } | null>(null)
  const [trim, setTrim] = useState<{ id: string; left: number; right: number; snappedTo: number | null } | null>(null)
  const [dropGhost, setDropGhost] = useState<{ trackId: string; start: number; width: number } | null>(null)
  const [trackDrop, setTrackDrop] = useState<{ id: string; below: boolean } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; clip: TimelineClip } | null>(null)

  const total = totalDuration(clips)
  const sourceById = new Map(sources.map((s) => [s.id, s]))
  const trackById = new Map(tracks.map((t) => [t.id, t]))

  const { video, audio } = tracksByKind(tracks)
  const ordered = [...video, ...audio]
  let acc = 0
  const lanes = ordered.map((t) => {
    const lane = { track: t, top: acc, height: t.height }
    acc += t.height
    return lane
  })
  const lanesHeight = acc
  const laneOf = (id: string): { track: Track; top: number; height: number } | undefined =>
    lanes.find((l) => l.track.id === id)
  const contentWidth = Math.max(total + 6, 20) * pxPerSec

  function xToSec(clientX: number): number {
    const el = scrollRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left + el.scrollLeft) / pxPerSec)
  }
  function trackAtY(clientY: number): { track: Track; top: number; height: number } | null {
    const el = lanesRef.current
    if (!el || lanes.length === 0) return null
    const y = clientY - el.getBoundingClientRect().top
    for (const l of lanes) if (y >= l.top && y < l.top + l.height) return l
    return y < 0 ? lanes[0] : lanes[lanes.length - 1]
  }
  function snapTime(value: number, excludeId: string | null, alt: boolean): { sec: number; snappedTo: number | null } {
    if (!snapEnabled || alt) return { sec: value, snappedTo: null }
    const cands = snapCandidates(excludeId ? clips.filter((c) => c.id !== excludeId) : clips, [playheadSec])
    return snap(value, cands, SNAP_PX / pxPerSec)
  }

  // 줌(커서 기준 앵커)
  useLayoutEffect(() => {
    const p = pendingZoomRef.current
    const el = scrollRef.current
    if (p && el) {
      el.scrollLeft = p.time * pxPerSec - p.offsetX
      pendingZoomRef.current = null
    }
  }, [pxPerSec])

  function onWheel(e: React.WheelEvent): void {
    const el = scrollRef.current
    if (!el) return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const offsetX = e.clientX - rect.left
      const time = (offsetX + el.scrollLeft) / pxPerSec
      const next = Math.max(0.5, Math.min(500, pxPerSec * (e.deltaY < 0 ? 1.15 : 0.87)))
      pendingZoomRef.current = { time, offsetX }
      setPxPerSec(next)
    } else {
      el.scrollLeft += e.deltaY + e.deltaX
    }
  }
  function fitZoom(): void {
    const el = scrollRef.current
    if (!el || total <= 0) return
    setPxPerSec(Math.max(0.5, Math.min(500, (el.clientWidth - 20) / total)))
  }

  // ── 제스처 시작 ──
  function startMove(e: React.PointerEvent, clip: TimelineClip): void {
    if (e.button !== 0) return // 우클릭은 컨텍스트 메뉴로
    if (trackById.get(clip.trackId)?.locked) return
    e.stopPropagation()
    // 이미 다중 선택에 포함된 클립을 잡으면 선택 유지(그룹 이동). 아니면 선택(Shift=추가).
    const group = selectedClipIds.size > 1 && selectedClipIds.has(clip.id) && !e.shiftKey
    if (!group) onSelectClip(clip.id, e.shiftKey)
    lanesRef.current?.setPointerCapture(e.pointerId)
    gestureRef.current = {
      kind: 'move', id: clip.id, pointerId: e.pointerId,
      grabOffset: xToSec(e.clientX) - clip.startSec,
      startClientX: e.clientX, startClientY: e.clientY,
      moved: false, curTrack: clip.trackId, curStart: clip.startSec, group
    }
  }
  function startTrim(e: React.PointerEvent, clip: TimelineClip, edge: 'in' | 'out'): void {
    if (trackById.get(clip.trackId)?.locked) return
    e.stopPropagation()
    onSelectClip(clip.id)
    lanesRef.current?.setPointerCapture(e.pointerId)
    gestureRef.current = { kind: 'trim', id: clip.id, edge, pointerId: e.pointerId, curStart: clip.startSec, curEnd: clipEnd(clip) }
    setTrim({ id: clip.id, left: clip.startSec, right: clipEnd(clip), snappedTo: null })
  }
  function startScrub(e: React.PointerEvent): void {
    onSelectClip(null)
    lanesRef.current?.setPointerCapture(e.pointerId)
    gestureRef.current = { kind: 'scrub', pointerId: e.pointerId }
    onSeek(snapTime(xToSec(e.clientX), null, e.altKey).sec, false)
  }

  // ── 컨테이너 레벨 이동/종료(캡처가 lanes 에 있어 자식 언마운트와 무관) ──
  function lanesMove(e: React.PointerEvent): void {
    const g = gestureRef.current
    if (!g) return
    if (g.kind === 'move') {
      const clip = clips.find((c) => c.id === g.id)
      if (!clip) return
      if (!g.moved && Math.abs(e.clientX - g.startClientX) < 3 && Math.abs(e.clientY - g.startClientY) < 3) return
      g.moved = true
      const dur = timelineDur(clip)
      const raw = Math.max(0, xToSec(e.clientX) - g.grabOffset)
      const sStart = snapTime(raw, clip.id, e.altKey)
      const sEnd = snapTime(raw + dur, clip.id, e.altKey)
      let start = raw
      let snappedTo: number | null = null
      if (sStart.snappedTo !== null && (sEnd.snappedTo === null || Math.abs(sStart.sec - raw) <= Math.abs(sEnd.sec - (raw + dur)))) {
        start = sStart.sec
        snappedTo = sStart.snappedTo
      } else if (sEnd.snappedTo !== null) {
        start = sEnd.sec - dur
        snappedTo = sEnd.snappedTo
      }
      start = Math.max(0, start)
      // 그룹 이동은 시간만(각자 트랙 유지) → 트랙 변경 안 함.
      let dest = g.group ? trackById.get(clip.trackId)! : trackAtY(e.clientY)?.track
      if (!dest || dest.kind !== trackById.get(clip.trackId)?.kind || dest.locked) dest = trackById.get(clip.trackId)!
      g.curTrack = dest.id
      g.curStart = start
      setDrag({ id: clip.id, track: dest.id, start, snappedTo, linked: !(e.ctrlKey || e.metaKey), group: g.group })
    } else if (g.kind === 'trim') {
      const clip = clips.find((c) => c.id === g.id)
      if (!clip) return
      const sp = clip.speed > 0 ? clip.speed : 1
      const s = snapTime(xToSec(e.clientX), clip.id, e.altKey)
      if (g.edge === 'in') {
        const newStart = Math.max(0, Math.min(s.sec, g.curEnd - 0.05))
        g.curStart = newStart
        setTrim({ id: clip.id, left: newStart, right: g.curEnd, snappedTo: s.snappedTo })
        onShowFrame(clip.sourceId, clip.inSec + (newStart - clip.startSec) * sp)
      } else {
        const newEnd = Math.max(g.curStart + 0.05, s.sec)
        g.curEnd = newEnd
        setTrim({ id: clip.id, left: g.curStart, right: newEnd, snappedTo: s.snappedTo })
        onShowFrame(clip.sourceId, clip.inSec + (newEnd - clip.startSec) * sp)
      }
    } else {
      onSeek(snapTime(xToSec(e.clientX), null, e.altKey).sec, false)
    }
  }
  function endGesture(e: React.PointerEvent): void {
    const g = gestureRef.current
    gestureRef.current = null
    lanesRef.current?.releasePointerCapture?.(e.pointerId)
    if (g?.kind === 'move' && g.moved) {
      const linked = !(e.ctrlKey || e.metaKey)
      if (g.group) {
        const grabbed = clips.find((c) => c.id === g.id)
        const delta = grabbed ? g.curStart - grabbed.startSec : 0
        onMoveClips([...selectedClipIds], delta, linked)
      } else {
        onMoveClip(g.id, g.curTrack, g.curStart, linked)
      }
    } else if (g?.kind === 'trim') {
      if (g.edge === 'in') onTrimLeft(g.id, g.curStart)
      else onTrimRight(g.id, g.curEnd)
    }
    setDrag(null)
    setTrim(null)
  }

  // ── 룰러 스크럽(별도 안정 엘리먼트) ──
  function rulerDown(e: React.PointerEvent): void {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    gestureRef.current = { kind: 'scrub', pointerId: e.pointerId }
    onSeek(snapTime(xToSec(e.clientX), null, e.altKey).sec, false)
  }
  function rulerMove(e: React.PointerEvent): void {
    if (gestureRef.current?.kind === 'scrub') onSeek(snapTime(xToSec(e.clientX), null, e.altKey).sec, false)
  }
  function rulerUp(e: React.PointerEvent): void {
    if (gestureRef.current?.kind === 'scrub') {
      ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      gestureRef.current = null
    }
  }

  // ── 빈 드롭 ──
  function isSourceDrag(e: React.DragEvent): boolean {
    return e.dataTransfer.types.includes('clipreel/source')
  }
  function laneDragOver(e: React.DragEvent): void {
    if (!isSourceDrag(e)) return
    e.preventDefault()
    const lane = trackAtY(e.clientY)
    if (!lane || lane.track.kind !== 'video' || lane.track.locked) {
      setDropGhost(null)
      return
    }
    const dur = draggingSourceId ? sourceById.get(draggingSourceId)?.durationSec ?? 4 : 4
    const start = snapTime(xToSec(e.clientX), null, e.altKey).sec
    setDropGhost({ trackId: lane.track.id, start, width: Math.max(8, dur * pxPerSec) })
  }
  function laneDrop(e: React.DragEvent): void {
    e.preventDefault()
    const sourceId = e.dataTransfer.getData('clipreel/source')
    const lane = trackAtY(e.clientY)
    if (sourceId && lane && lane.track.kind === 'video' && !lane.track.locked) {
      onAddSource(sourceId, lane.track.id, snapTime(xToSec(e.clientX), null, e.altKey).sec)
    }
    setDropGhost(null)
  }

  const secPerTick = niceStep(80 / pxPerSec)
  const ticks: number[] = []
  for (let t = 0; t <= total + secPerTick + 0.001; t += secPerTick) ticks.push(t)

  const snapLine = drag?.snappedTo ?? trim?.snappedTo ?? null
  const tipSec = drag ? drag.start : trim ? trim.left : null
  const tipText = drag ? fmtClock(drag.start, fps) : trim ? `${(trim.right - trim.left).toFixed(2)}s` : ''

  // 드래그 중 함께 움직이는 클립 집합(그룹 선택 + 링크 짝) 및 시간 delta.
  const draggedClip = drag ? clips.find((c) => c.id === drag.id) ?? null : null
  const dragDelta = drag && draggedClip ? drag.start - draggedClip.startSec : 0
  const movingIds = new Set<string>()
  if (drag && draggedClip) {
    if (drag.group) selectedClipIds.forEach((id) => movingIds.add(id))
    else movingIds.add(drag.id)
    if (drag.linked) {
      const linkIds = new Set(
        [...movingIds].map((id) => clips.find((c) => c.id === id)?.linkId).filter(Boolean)
      )
      clips.forEach((c) => {
        if (c.linkId && linkIds.has(c.linkId)) movingIds.add(c.id)
      })
    }
  }

  return (
    <div className="timeline-panel">
      <div className="tl-toolbar">
        <div className="tl-tools">
          <button className="primary" onClick={onSplitPlayhead} title="재생바 위치에서 자르기 (C / Ctrl+K)">
            ✂ 자르기
          </button>
          <span className="sep" />
          <button className={snapEnabled ? 'on' : ''} onClick={onToggleSnap} title="스냅(S)">🧲 스냅</button>
          <button onClick={onLinkSelected} disabled={selectedClipIds.size < 2} title="선택한 클립 링크/해제(Shift로 여러 개 선택)">
            🔗 링크
          </button>
        </div>
        <div className="tl-zoom">
          <button onClick={() => setPxPerSec((p) => Math.max(0.5, p * 0.8))} title="축소(-)">−</button>
          <button onClick={fitZoom} title="맞춤">맞춤</button>
          <button onClick={() => setPxPerSec((p) => Math.min(500, p * 1.25))} title="확대(+)">＋</button>
          <span className="sep" />
          <button onClick={() => onAddTrack('video')} title="비디오 트랙 추가">＋비디오</button>
          <button onClick={() => onAddTrack('audio')} title="오디오 트랙 추가">＋오디오</button>
        </div>
      </div>

      <div className="tl-body">
        <div className="tl-headers" style={{ paddingTop: RULER_H }}>
          {lanes.map(({ track, height }) => {
            const idxs = tracks.filter((t) => t.kind === track.kind).map((t) => t.index)
            const canUp = track.index < Math.max(...idxs)
            const canDown = track.index > Math.min(...idxs)
            const dropCls =
              trackDrop?.id === track.id ? (trackDrop.below ? ' drop-below' : ' drop-above') : ''
            return (
              <div
                key={track.id}
                className={`tl-head-row${track.locked ? ' locked' : ''}${dropCls}`}
                style={{ height }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('clipreel/track', track.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => setTrackDrop(null)}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes('clipreel/track')) return
                  e.preventDefault()
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setTrackDrop({ id: track.id, below: e.clientY > rect.top + rect.height / 2 })
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes('clipreel/track')) return
                  e.preventDefault()
                  const draggedId = e.dataTransfer.getData('clipreel/track')
                  const dragged = tracks.find((t) => t.id === draggedId)
                  setTrackDrop(null)
                  if (!dragged || dragged.kind !== track.kind || draggedId === track.id) return
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  const below = e.clientY > rect.top + rect.height / 2
                  const sameKindVisual = lanes.map((l) => l.track).filter((t) => t.kind === track.kind)
                  const i = sameKindVisual.findIndex((t) => t.id === track.id)
                  const beforeId = below ? sameKindVisual[i + 1]?.id ?? null : track.id
                  onReorderTrack(draggedId, beforeId)
                }}
                title="드래그해서 트랙 순서 변경"
              >
                <div className="th-order">
                  <button onClick={() => onMoveTrack(track.id, 'up')} disabled={!canUp} title="위로">▲</button>
                  <button onClick={() => onMoveTrack(track.id, 'down')} disabled={!canDown} title="아래로">▼</button>
                </div>
                <span className="th-name">⠿ {track.name}</span>
                <div className="th-flags">
                  <button className={track.enabled ? 'on' : ''} onClick={() => onSetTrackFlag(track.id, { enabled: !track.enabled })} title="표시">👁</button>
                  <button className={track.locked ? 'on' : ''} onClick={() => onSetTrackFlag(track.id, { locked: !track.locked })} title="잠금">🔒</button>
                  <button className="th-del" onClick={() => onRemoveTrack(track.id)} title="트랙 삭제(클립도 함께)">🗑</button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="tl-scroll" ref={scrollRef} onWheel={onWheel}>
          <div className="tl-content" style={{ width: contentWidth, height: RULER_H + lanesHeight }}>
            <div className="tl-ruler" style={{ height: RULER_H }} onPointerDown={rulerDown} onPointerMove={rulerMove} onPointerUp={rulerUp}>
              {ticks.map((t) => (
                <span key={t} className="tl-tick" style={{ left: t * pxPerSec }}>{fmtClock(t)}</span>
              ))}
            </div>

            <div
              className="tl-lanes"
              ref={lanesRef}
              style={{ top: RULER_H, height: lanesHeight }}
              onPointerMove={lanesMove}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              onDragOver={laneDragOver}
              onDrop={laneDrop}
              onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropGhost(null) }}
            >
              {lanes.map(({ track, top, height }) => (
                <div
                  key={track.id}
                  className={`tl-lane ${track.kind}${track.locked ? ' locked' : ''}`}
                  style={{ top, height }}
                  onPointerDown={(e) => { if (e.target === e.currentTarget) startScrub(e) }}
                >
                  {clips.filter((c) => c.trackId === track.id).map((clip) => {
                    const isTrimming = trim?.id === clip.id
                    const isDragSource = movingIds.has(clip.id)
                    const startSec = isTrimming ? trim!.left : clip.startSec
                    const dur = isTrimming ? trim!.right - trim!.left : timelineDur(clip)
                    const selected = selectedClipIds.has(clip.id)
                    const changed = changedClipIds?.includes(clip.id)
                    const w = Math.max(2, dur * pxPerSec)
                    const src = sourceById.get(clip.sourceId)
                    return (
                      <div
                        key={clip.id}
                        className={`tl-clip${track.kind === 'audio' ? ' audio' : ''}${selected ? ' selected' : ''}${clip.origin === 'ai' ? ' ai' : ''}${changed ? ' changed' : ''}${isDragSource ? ' drag-source' : ''}`}
                        style={{ left: startSec * pxPerSec, width: w }}
                        onPointerDown={(e) => startMove(e, clip)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          onSelectClip(clip.id)
                          setMenu({ x: e.clientX, y: e.clientY, clip })
                        }}
                        title={src?.name}
                      >
                        <div className="tl-handle l" onPointerDown={(e) => startTrim(e, clip, 'in')} />
                        <div className="tl-clip-label">
                          {src?.name ?? clip.sourceId}
                          {clip.speed !== 1 ? `  ${clip.speed}×` : ''}
                        </div>
                        {w > 52 && <div className="tl-clip-dur">{fmtClock(timelineDur(clip))}</div>}
                        <div className="tl-handle r" onPointerDown={(e) => startTrim(e, clip, 'out')} />
                      </div>
                    )
                  })}

                  {dropGhost && dropGhost.trackId === track.id && (
                    <div className="tl-dropghost" style={{ left: dropGhost.start * pxPerSec, width: dropGhost.width }} />
                  )}

                  {!track.locked &&
                    (() => {
                      const onTrack = clips
                        .filter((c) => c.trackId === track.id)
                        .sort((a, b) => a.startSec - b.startSec)
                      const gaps: { start: number; end: number }[] = []
                      let cursor = 0
                      for (const c of onTrack) {
                        if (c.startSec - cursor > 0.05) gaps.push({ start: cursor, end: c.startSec })
                        cursor = Math.max(cursor, clipEnd(c))
                      }
                      return gaps
                        .filter((g) => (g.end - g.start) * pxPerSec > 26)
                        .map((g) => (
                          <button
                            key={`gap-${g.start.toFixed(3)}`}
                            className="tl-gap-remove"
                            style={{ left: ((g.start + g.end) / 2) * pxPerSec }}
                            title="이 여백 제거 (뒤 클립을 당겨 메움)"
                            onPointerDown={(e) => {
                              e.stopPropagation()
                              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                            }}
                            onPointerUp={(e) => {
                              e.stopPropagation()
                              ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
                              onCloseGap(track.id, g.start, g.end)
                            }}
                          >
                            ✕
                          </button>
                        ))
                    })()}
                </div>
              ))}

              {/* 드래그 고스트: 함께 움직이는 모든 클립(그룹/링크) 미리보기 */}
              {drag &&
                [...movingIds]
                  .map((id) => clips.find((c) => c.id === id))
                  .filter((c): c is TimelineClip => !!c)
                  .map((c) => {
                    // 단일(비그룹)에서 잡은 클립만 트랙 변경 가능, 나머지는 시간 delta.
                    const onGrabbed = c.id === drag.id && !drag.group
                    const trackId = onGrabbed ? drag.track : c.trackId
                    const start = onGrabbed ? drag.start : c.startSec + dragDelta
                    const lane = laneOf(trackId)
                    if (!lane) return null
                    return (
                      <div
                        key={`ghost-${c.id}`}
                        className={`tl-clip ghost${c.id !== drag.id ? ' audio-ghost' : ''}`}
                        style={{ left: Math.max(0, start) * pxPerSec, top: lane.top + 6, height: lane.height - 12, width: Math.max(2, timelineDur(c) * pxPerSec) }}
                      >
                        <div className="tl-clip-label">{sourceById.get(c.sourceId)?.name ?? ''}</div>
                      </div>
                    )
                  })}
            </div>

            {snapLine !== null && (
              <div className="tl-snapline" style={{ left: snapLine * pxPerSec, height: RULER_H + lanesHeight }} />
            )}
            {tipSec !== null && (
              <div className="tl-tip" style={{ left: tipSec * pxPerSec, top: 2 }}>{tipText}</div>
            )}

            <div className="tl-playhead" style={{ left: playheadSec * pxPerSec, height: RULER_H + lanesHeight }}>
              <div
                className="tl-playhead-hit"
                onPointerDown={rulerDown}
                onPointerMove={rulerMove}
                onPointerUp={rulerUp}
              />
              <div className="tl-playhead-knob" />
            </div>
          </div>
        </div>
      </div>

      {menu && (
        <>
          <div
            className="tl-menu-backdrop"
            onPointerDown={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}
          />
          <div className="tl-menu" style={{ left: menu.x, top: menu.y }}>
            <button onClick={() => { onRemoveClip(menu.clip.id); setMenu(null) }}>삭제</button>
            <button onClick={() => { onRippleDeleteClip(menu.clip.id); setMenu(null) }}>리플 삭제 (뒤 당김)</button>
            {menu.clip.linkId && (
              <button onClick={() => { onUnlinkClip(menu.clip.id); setMenu(null) }}>링크 해제</button>
            )}
            <div className="tl-menu-sep" />
            <div className="tl-menu-label">속도</div>
            <div className="tl-menu-speeds">
              {[0.5, 1, 1.5, 2].map((r) => (
                <button
                  key={r}
                  className={menu.clip.speed === r ? 'on' : ''}
                  onClick={() => { onSetClipSpeed(menu.clip.id, r); setMenu(null) }}
                >
                  {r}×
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
