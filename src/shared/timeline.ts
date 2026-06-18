// 타임라인 엔진 (순수, node 비의존). 경계 규약: 반열림 [start, end) — 인접 클립은 겹치지 않음.

import type { Track, TimelineClip } from './types'

export const EPS = 1e-4

/** 프레임 그리드로 양자화. */
export function qf(sec: number, fps: number): number {
  if (!(fps > 0)) return sec
  return Math.round(sec * fps) / fps
}

/** 타임라인 상의 클립 길이(초). */
export function timelineDur(c: TimelineClip): number {
  const sp = c.speed > 0 ? c.speed : 1
  return Math.max(0.01, (c.outSec - c.inSec) / sp)
}

export function clipEnd(c: TimelineClip): number {
  return c.startSec + timelineDur(c)
}

/** 타임라인 시각 → 해당 클립의 원본 시각. */
export function sourceTimeAt(c: TimelineClip, tlTime: number): number {
  const sp = c.speed > 0 ? c.speed : 1
  return c.inSec + Math.max(0, tlTime - c.startSec) * sp
}

export function totalDuration(clips: TimelineClip[]): number {
  let max = 0
  for (const c of clips) max = Math.max(max, clipEnd(c))
  return max
}

export function clipsOnTrack(clips: TimelineClip[], trackId: string): TimelineClip[] {
  return clips.filter((c) => c.trackId === trackId).sort((a, b) => a.startSec - b.startSec)
}

/** 비디오는 위(높은 index)부터, 오디오는 아래(낮은 index)부터. */
export function tracksByKind(tracks: Track[]): { video: Track[]; audio: Track[] } {
  return {
    video: tracks.filter((t) => t.kind === 'video').sort((a, b) => b.index - a.index),
    audio: tracks.filter((t) => t.kind === 'audio').sort((a, b) => a.index - b.index)
  }
}

/** trackId 위에서 [start,end) 가 t 를 포함하는 클립. */
export function clipAtTimeOnTrack(
  clips: TimelineClip[],
  trackId: string,
  t: number
): TimelineClip | null {
  for (const c of clips) {
    if (c.trackId !== trackId) continue
    if (t >= c.startSec - EPS && t < clipEnd(c) - EPS) return c
  }
  return null
}

/** TOP-WINS: t 에서 클립이 있는 가장 위(높은 index) enabled 비디오 트랙. null = 검은 공백. */
export function activeVideoClipAt(
  clips: TimelineClip[],
  tracks: Track[],
  t: number
): { clip: TimelineClip; track: Track } | null {
  const { video } = tracksByKind(tracks)
  for (const track of video) {
    if (!track.enabled) continue
    const clip = clipAtTimeOnTrack(clips, track.id, t)
    if (clip) return { clip, track }
  }
  return null
}

/** t 에서 소리를 내는 모든 enabled·non-muted 클립(오디오 트랙 + 비디오 트랙의 내장 오디오). */
export function activeAudioClipsAt(
  clips: TimelineClip[],
  tracks: Track[],
  t: number
): { clip: TimelineClip; track: Track }[] {
  const out: { clip: TimelineClip; track: Track }[] = []
  for (const track of tracks) {
    if (!track.enabled || track.muted) continue
    const clip = clipAtTimeOnTrack(clips, track.id, t)
    if (clip) out.push({ clip, track })
  }
  return out
}

/** trackId 위에서 [start,end) 와 겹치는 클립(ignoreId 제외). */
export function overlapsOnTrack(
  clips: TimelineClip[],
  trackId: string,
  start: number,
  end: number,
  ignoreId?: string
): TimelineClip[] {
  return clips.filter((c) => {
    if (c.trackId !== trackId || c.id === ignoreId) return false
    return c.startSec < end - EPS && clipEnd(c) > start + EPS
  })
}

/** desired 이상에서 dur 길이가 겹치지 않게 들어갈 첫 빈 위치(향후 'bump' 정책용). */
export function firstFreeSlot(
  clips: TimelineClip[],
  trackId: string,
  desired: number,
  dur: number
): number {
  const onTrack = clipsOnTrack(clips, trackId)
  let pos = Math.max(0, desired)
  for (const c of onTrack) {
    if (clipEnd(c) <= pos + EPS) continue
    if (c.startSec >= pos + dur - EPS) break
    pos = clipEnd(c)
  }
  return pos
}

/** t 를 포함하는 트랙 위 빈 구간 {startSec,endSec}, 없으면 null. */
export function gapAt(
  clips: TimelineClip[],
  trackId: string,
  t: number
): { startSec: number; endSec: number } | null {
  const onTrack = clipsOnTrack(clips, trackId)
  if (clipAtTimeOnTrack(clips, trackId, t)) return null
  let start = 0
  for (const c of onTrack) {
    if (clipEnd(c) <= t + EPS) start = clipEnd(c)
    else if (c.startSec > t - EPS) return { startSec: start, endSec: c.startSec }
  }
  return null // t 가 마지막 클립 뒤(끝없는 공백)면 닫을 게 없음
}

/** 스냅 후보 시각들: 0, 모든 클립의 start/end(전 트랙), 추가값(플레이헤드 등). */
export function snapCandidates(clips: TimelineClip[], extra: number[] = []): number[] {
  const set = new Set<number>([0, ...extra])
  for (const c of clips) {
    set.add(c.startSec)
    set.add(clipEnd(c))
  }
  return [...set].sort((a, b) => a - b)
}

/** thresholdSec 내 가장 가까운 후보로 스냅, 없으면 원값. */
export function snap(
  value: number,
  candidates: number[],
  thresholdSec: number
): { sec: number; snappedTo: number | null } {
  let best: number | null = null
  let bestD = thresholdSec
  for (const c of candidates) {
    const d = Math.abs(c - value)
    if (d <= bestD) {
      bestD = d
      best = c
    }
  }
  return best === null ? { sec: value, snappedTo: null } : { sec: best, snappedTo: best }
}

/** 눈금 간격을 보기 좋은 값으로. */
export function niceStep(rough: number): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  for (const s of steps) if (rough <= s) return s
  return 900
}

/** 초 → m:ss (고배율이면 m:ss.ff 프레임 표기). */
export function fmtClock(sec: number, fps?: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const base = `${m}:${s.toString().padStart(2, '0')}`
  if (fps && fps > 0) {
    const ff = Math.round((sec - Math.floor(sec)) * fps)
    return `${base}.${ff.toString().padStart(2, '0')}`
  }
  return base
}

// ── 익스포트 평탄화 ──
export interface FlatSegment {
  startSec: number
  endSec: number
  /** null = 검은 공백 */
  clip: TimelineClip | null
}

/**
 * 멀티트랙을 상위-비디오-우선으로 단일 세그먼트 열로 평탄화(공백 = null).
 * 경계를 fps 그리드로 양자화하고 반프레임 미만 조각은 합쳐(드롭) — 익스포트 프레임/오디오 정렬용.
 */
export function flattenTimeline(clips: TimelineClip[], tracks: Track[], fps = 60): FlatSegment[] {
  const end = qf(totalDuration(clips), fps)
  if (end <= EPS) return []
  const half = 0.5 / fps
  const bounds = snapCandidates(clips, [end])
    .map((b) => qf(Math.max(0, Math.min(b, end)), fps))
    .filter((b) => b >= -EPS && b <= end + EPS)
  const uniq = [...new Set(bounds)].sort((a, b) => a - b)
  const segs: FlatSegment[] = []
  for (let i = 0; i < uniq.length - 1; i++) {
    const a = uniq[i]
    const b = uniq[i + 1]
    if (b - a < half) continue // 반프레임 미만 슬리버 무시
    const hit = activeVideoClipAt(clips, tracks, (a + b) / 2)
    segs.push({ startSec: a, endSec: b, clip: hit ? hit.clip : null })
  }
  return segs
}
