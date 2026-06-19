// 타임라인 편집 연산 (순수·불변). 입력을 변형하지 않고 새 배열 반환.
// 모든 시각 입력은 qf 로 프레임 양자화. 트랙 lock/enabled 는 호출부(App.commit)가 1차로 막고,
// 각 op 도 방어적으로 rejected 를 반환한다. 오버랩 규칙은 resolveOverwrite 하나로 통일.

import type { SourceClip, TimelineClip, Track } from './types'
import { clipEnd, EPS, qf, sourceTimeAt, timelineDur } from './timeline'

export const MIN_DUR = 0.05

export interface OpState {
  tracks: Track[]
  clips: TimelineClip[]
  sources: SourceClip[]
  fps: number
}

export interface OpResult {
  clips: TimelineClip[]
  tracks: Track[]
  changed: string[]
  rejected?: string
}

let _seq = 0
function newClipId(): string {
  _seq += 1
  return `clip_${Date.now().toString(36)}_${_seq}`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function reject(state: OpState, reason: string): OpResult {
  return { clips: state.clips, tracks: state.tracks, changed: [], rejected: reason }
}

function speedOf(c: TimelineClip): number {
  return c.speed > 0 ? c.speed : 1
}

/**
 * incoming 클립과 같은 트랙에서 겹치는 기존 클립들을 OVERWRITE 규칙으로 처리하고
 * incoming 을 삽입한 새 배열을 반환. (Premiere/Resolve 편집 페이지 방식)
 */
function resolveOverwrite(clips: TimelineClip[], incoming: TimelineClip): TimelineClip[] {
  const IS = incoming.startSec
  const IE = clipEnd(incoming)
  const out: TimelineClip[] = []

  for (const E of clips) {
    if (E.id === incoming.id) continue
    if (E.trackId !== incoming.trackId) {
      out.push(E)
      continue
    }
    const ES = E.startSec
    const EE = clipEnd(E)
    const overlap = ES < IE - EPS && EE > IS + EPS
    if (!overlap) {
      out.push(E)
      continue
    }

    const fullyInside = ES >= IS - EPS && EE <= IE + EPS
    const strictlyContains = ES < IS - EPS && EE > IE + EPS

    if (fullyInside) {
      // 1) E 가 incoming 안에 완전히 포함 → 삭제
      continue
    } else if (strictlyContains) {
      // 4) incoming 이 E 내부에 들어옴 → E 를 좌/우로 분할
      const left: TimelineClip = { ...E, outSec: sourceTimeAt(E, IS) }
      const right: TimelineClip = {
        ...E,
        id: newClipId(),
        startSec: IE,
        inSec: sourceTimeAt(E, IE),
        outSec: E.outSec
      }
      if (timelineDur(left) >= MIN_DUR) out.push(left)
      if (timelineDur(right) >= MIN_DUR) out.push(right)
    } else if (ES >= IS - EPS) {
      // 2) E 의 머리쪽이 덮임 → 왼쪽을 IE 까지 트림
      const trimmed: TimelineClip = { ...E, startSec: IE, inSec: sourceTimeAt(E, IE) }
      if (timelineDur(trimmed) >= MIN_DUR) out.push(trimmed)
    } else {
      // 3) E 의 꼬리쪽이 덮임 → 오른쪽을 IS 까지 트림
      const trimmed: TimelineClip = { ...E, outSec: E.inSec + (IS - E.startSec) * speedOf(E) }
      if (timelineDur(trimmed) >= MIN_DUR) out.push(trimmed)
    }
  }

  out.push(incoming)
  return out
}

const findTrack = (s: OpState, id: string): Track | undefined => s.tracks.find((t) => t.id === id)
const findClip = (s: OpState, id: string): TimelineClip | undefined =>
  s.clips.find((c) => c.id === id)

/**
 * 소스의 [inSec,outSec) 구간을 trackId 위 startSec 에 새 클립으로 배치.
 * 오디오가 있으면 짝 오디오 트랙(A{n})에 분리 배치(없으면 생성). addClip/AI 하이라이트 공용.
 */
export function placeClip(
  state: OpState,
  sourceId: string,
  trackId: string,
  startSec: number,
  inSec: number,
  outSec: number,
  origin: 'ai' | 'user' = 'user',
  reasons: string[] = []
): OpResult {
  const track = findTrack(state, trackId)
  if (!track) return reject(state, '트랙 없음')
  if (track.locked) return reject(state, '잠긴 트랙')
  if (track.kind !== 'video') return reject(state, '영상은 비디오 트랙에만 추가')
  const src = state.sources.find((s) => s.id === sourceId)
  if (!src) return reject(state, '소스 없음')

  const srcDur = Math.max(MIN_DUR, src.durationSec || MIN_DUR)
  const i = clamp(qf(inSec, state.fps), 0, srcDur - MIN_DUR)
  const o = clamp(qf(outSec, state.fps), i + MIN_DUR, srcDur)
  const start = Math.max(0, qf(startSec, state.fps))
  const linkId = newClipId()
  const videoClip: TimelineClip = {
    id: newClipId(),
    sourceId,
    trackId,
    startSec: start,
    inSec: i,
    outSec: o,
    speed: 1,
    linkId,
    origin,
    reasons
  }
  let clips = resolveOverwrite(state.clips, videoClip)
  const changed = [videoClip.id]
  let outTracks = state.tracks

  // 소스에 오디오가 있으면, 이 비디오 트랙(V{n})의 짝 오디오 트랙(A{n})에 분리 배치.
  if (src.audioStreams > 0) {
    const m = /^V(\d+)$/.exec(track.id)
    let audioTrack: Track | undefined
    if (m) {
      const aid = `A${m[1]}`
      audioTrack = state.tracks.find((t) => t.id === aid && t.kind === 'audio')
      if (!audioTrack) {
        // 짝 오디오 트랙이 없으면 생성.
        const idx = state.tracks.filter((t) => t.kind === 'audio').reduce((mx, t) => Math.max(mx, t.index), -1) + 1
        audioTrack = { id: aid, kind: 'audio', name: aid, index: idx, enabled: true, locked: false, muted: false, height: 48 }
        outTracks = [...state.tracks, audioTrack]
      }
    }
    if (!audioTrack) audioTrack = state.tracks.find((t) => t.kind === 'audio' && !t.locked)
    if (audioTrack && !audioTrack.locked) {
      const audioClip: TimelineClip = {
        id: newClipId(),
        sourceId,
        trackId: audioTrack.id,
        startSec: start,
        inSec: i,
        outSec: o,
        speed: 1,
        linkId,
        origin,
        reasons
      }
      clips = resolveOverwrite(clips, audioClip)
      changed.push(audioClip.id)
    }
  }
  return { clips, tracks: outTracks, changed }
}

/**
 * 삽입 편집(Premiere 'insert'): atSec 에서 모든 트랙을 분할한 뒤, atSec 이후의 클립을
 * 삽입 길이만큼 오른쪽으로 밀고, 소스 [inSec,outSec) 를 trackId 위 atSec 에 배치(오디오 짝 포함).
 * 모든 트랙을 함께 미뤄 싱크를 유지한다.
 */
export function insertClip(
  state: OpState,
  sourceId: string,
  trackId: string,
  atSec: number,
  inSec: number,
  outSec: number
): OpResult {
  const track = findTrack(state, trackId)
  if (!track) return reject(state, '트랙 없음')
  if (track.locked) return reject(state, '잠긴 트랙')
  if (track.kind !== 'video') return reject(state, '영상은 비디오 트랙에만 추가')
  const src = state.sources.find((s) => s.id === sourceId)
  if (!src) return reject(state, '소스 없음')

  const at = Math.max(0, qf(atSec, state.fps))
  const dur = Math.max(MIN_DUR, qf(outSec, state.fps) - qf(inSec, state.fps))

  // 1) at 을 지나는 모든 트랙 클립을 분할(중간이 잘리지 않도록).
  let cur: OpState = state
  for (const t of state.tracks) {
    const straddling = cur.clips.find(
      (c) => c.trackId === t.id && c.startSec + EPS < at && at < clipEnd(c) - EPS
    )
    if (straddling) {
      const r = splitAt(cur, straddling.id, at)
      if (!r.rejected) cur = { ...cur, clips: r.clips, tracks: r.tracks }
    }
  }
  // 2) at 이상에서 시작하는 모든 클립을 dur 만큼 오른쪽으로.
  const shifted = cur.clips.map((c) =>
    c.startSec >= at - EPS ? { ...c, startSec: qf(c.startSec + dur, state.fps) } : c
  )
  // 3) 비워진 자리에 배치(오디오 짝 포함).
  return placeClip({ ...cur, clips: shifted }, sourceId, trackId, at, inSec, outSec, 'user', [])
}

/** 소스를 trackId 위 startSec 에 새 클립으로 추가(원본 전체). */
export function addClip(
  state: OpState,
  sourceId: string,
  trackId: string,
  startSec: number
): OpResult {
  const src = state.sources.find((s) => s.id === sourceId)
  if (!src) return reject(state, '소스 없음')
  // 원본 길이를 프레임 그리드로 내림 → clipEnd 가 그리드에 정렬.
  const srcDur = src.durationSec || MIN_DUR
  const outSec = Math.max(MIN_DUR, Math.floor(srcDur * state.fps) / state.fps)
  return placeClip(state, sourceId, trackId, startSec, 0, outSec, 'user', [])
}

/**
 * 클립을 다른 트랙/위치로 이동(같은 kind 만). 원래 자리엔 공백을 남김.
 * moveLinked 면 같은 linkId(분리된 영상/오디오 짝)도 같은 양만큼 함께 이동.
 */
export function moveClip(
  state: OpState,
  id: string,
  toTrackId: string,
  toStartSec: number,
  moveLinked = false
): OpResult {
  const clip = findClip(state, id)
  if (!clip) return reject(state, '클립 없음')
  const from = findTrack(state, clip.trackId)
  const to = findTrack(state, toTrackId)
  if (!from || !to) return reject(state, '트랙 없음')
  if (from.locked || to.locked) return reject(state, '잠긴 트랙')
  if (from.kind !== to.kind) return reject(state, '같은 종류 트랙으로만 이동')

  const newStart = Math.max(0, qf(toStartSec, state.fps))
  const delta = newStart - clip.startSec
  if (toTrackId === clip.trackId && Math.abs(delta) < EPS) {
    return { clips: state.clips, tracks: state.tracks, changed: [] }
  }
  // Ctrl 이동(moveLinked=false)이고 링크가 있으면 → 영구 분리(linkId 제거).
  const moved: TimelineClip = {
    ...clip,
    trackId: toTrackId,
    startSec: newStart,
    linkId: moveLinked ? clip.linkId : undefined
  }
  let clips = resolveOverwrite(state.clips, moved)
  const changed = [id]

  if (moveLinked && clip.linkId) {
    for (const partner of state.clips) {
      if (partner.id === id || partner.linkId !== clip.linkId) continue
      const pTrack = findTrack(state, partner.trackId)
      if (pTrack?.locked) continue
      const ps = Math.max(0, qf(partner.startSec + delta, state.fps))
      clips = resolveOverwrite(clips, { ...partner, startSec: ps })
      changed.push(partner.id)
    }
  }
  return { clips, tracks: state.tracks, changed }
}

/**
 * 여러 클립을 같은 시간 delta 로 동시 이동(각자 트랙 유지). 다중 선택 드래그용.
 * moveLinked 면 링크된 짝도 포함. 잠긴 트랙 클립은 제외.
 */
export function moveClips(
  state: OpState,
  ids: string[],
  startDelta: number,
  moveLinked = false
): OpResult {
  const moveSet = new Set(ids)
  if (moveLinked) {
    const linkIds = new Set(
      state.clips.filter((c) => moveSet.has(c.id) && c.linkId).map((c) => c.linkId)
    )
    for (const c of state.clips) if (c.linkId && linkIds.has(c.linkId)) moveSet.add(c.id)
  }
  const moving = state.clips.filter((c) => moveSet.has(c.id) && !findTrack(state, c.trackId)?.locked)
  if (moving.length === 0) return reject(state, '이동할 클립 없음')

  let delta = startDelta
  const minStart = Math.min(...moving.map((c) => c.startSec))
  if (minStart + delta < 0) delta = -minStart

  const movingIds = new Set(moving.map((c) => c.id))
  let clips = state.clips.filter((c) => !movingIds.has(c.id))
  for (const c of moving) {
    const moved: TimelineClip = { ...c, startSec: Math.max(0, qf(c.startSec + delta, state.fps)) }
    clips = resolveOverwrite(clips, moved)
  }
  return { clips, tracks: state.tracks, changed: [...movingIds] }
}

/** 왼쪽 가장자리 트림(오른쪽 끝 고정). 원본 머리에서 하드스톱. */
export function trimLeft(state: OpState, id: string, newStartSec: number): OpResult {
  const clip = findClip(state, id)
  if (!clip) return reject(state, '클립 없음')
  const track = findTrack(state, clip.trackId)
  if (!track || track.locked) return reject(state, '잠긴 트랙')

  const sp = speedOf(clip)
  const ns = qf(newStartSec, state.fps)
  const deltaSrc = (ns - clip.startSec) * sp
  const newIn = clamp(clip.inSec + deltaSrc, 0, clip.outSec - MIN_DUR * sp)
  const end = clipEnd(clip) // 고정
  const newDurTl = (clip.outSec - newIn) / sp
  const newStart = Math.max(0, end - newDurTl)
  const moved: TimelineClip = { ...clip, inSec: newIn, startSec: newStart }
  return { clips: resolveOverwrite(state.clips, moved), tracks: state.tracks, changed: [id] }
}

/** 오른쪽 가장자리 트림(왼쪽 시작 고정). 원본 끝에서 하드스톱. */
export function trimRight(state: OpState, id: string, newEndSec: number): OpResult {
  const clip = findClip(state, id)
  if (!clip) return reject(state, '클립 없음')
  const track = findTrack(state, clip.trackId)
  if (!track || track.locked) return reject(state, '잠긴 트랙')
  const src = state.sources.find((s) => s.id === clip.sourceId)
  const srcDur = src?.durationSec ?? clip.outSec

  const sp = speedOf(clip)
  const ne = qf(newEndSec, state.fps)
  const newOut = clamp(clip.inSec + (ne - clip.startSec) * sp, clip.inSec + MIN_DUR * sp, srcDur)
  const moved: TimelineClip = { ...clip, outSec: newOut }
  return { clips: resolveOverwrite(state.clips, moved), tracks: state.tracks, changed: [id] }
}

/** tlTime 에서 분할. 좌측은 id 유지, 우측은 새 id. 정확히 맞붙음(공백/겹침 없음). */
export function splitAt(state: OpState, id: string, tlTime: number): OpResult {
  const clip = findClip(state, id)
  if (!clip) return reject(state, '클립 없음')
  const track = findTrack(state, clip.trackId)
  if (!track || track.locked) return reject(state, '잠긴 트랙')

  const t = qf(tlTime, state.fps)
  if (!(clip.startSec + EPS < t && t < clipEnd(clip) - EPS)) return reject(state, '분할 위치 범위 밖')

  const srcSplit = sourceTimeAt(clip, t)
  const left: TimelineClip = { ...clip, outSec: srcSplit }
  const right: TimelineClip = {
    ...clip,
    id: newClipId(),
    startSec: t,
    inSec: srcSplit,
    outSec: clip.outSec
  }
  const clips = state.clips.map((c) => (c.id === id ? left : c))
  clips.push(right)
  return { clips, tracks: state.tracks, changed: [left.id, right.id] }
}

/** 지정 트랙들에서 tlTime 을 지나는 클립을 분할. */
export function splitAtPlayhead(
  state: OpState,
  tlTime: number,
  targetTrackIds: string[]
): OpResult {
  let cur = state
  const changed: string[] = []
  // 오른쪽 조각은 새 링크 그룹으로(원본 linkId 별로 매핑) → 좌/우가 따로 움직이게.
  const linkRemap = new Map<string, string>()
  for (const trackId of targetTrackIds) {
    const t = qf(tlTime, cur.fps)
    const clip = cur.clips.find(
      (c) => c.trackId === trackId && c.startSec + EPS < t && t < clipEnd(c) - EPS
    )
    if (!clip) continue
    const res = splitAt(cur, clip.id, t)
    if (!res.rejected) {
      let clips = res.clips
      const rightId = res.changed[1]
      // 왼쪽 조각은 원본 linkId 유지, 오른쪽 조각은 (원본 그룹별) 새 linkId 부여.
      if (clip.linkId && rightId) {
        let nl = linkRemap.get(clip.linkId)
        if (!nl) {
          nl = newClipId()
          linkRemap.set(clip.linkId, nl)
        }
        clips = clips.map((c) => (c.id === rightId ? { ...c, linkId: nl } : c))
      }
      cur = { ...cur, clips, tracks: res.tracks }
      changed.push(...res.changed)
    }
  }
  return { clips: cur.clips, tracks: cur.tracks, changed }
}

/** 클립 삭제(공백 남김). */
export function remove(state: OpState, id: string): OpResult {
  const clip = findClip(state, id)
  if (!clip) return reject(state, '클립 없음')
  const track = findTrack(state, clip.trackId)
  if (!track || track.locked) return reject(state, '잠긴 트랙')
  return {
    clips: state.clips.filter((c) => c.id !== id),
    tracks: state.tracks,
    changed: [id]
  }
}

/** 리플 삭제: 같은 트랙에서 뒤 클립들을 삭제 길이만큼 왼쪽으로 당김. */
export function rippleDelete(state: OpState, id: string): OpResult {
  const clip = findClip(state, id)
  if (!clip) return reject(state, '클립 없음')
  const track = findTrack(state, clip.trackId)
  if (!track || track.locked) return reject(state, '잠긴 트랙')
  const shift = timelineDur(clip)
  const clips = state.clips
    .filter((c) => c.id !== id)
    .map((c) =>
      c.trackId === clip.trackId && c.startSec >= clip.startSec - EPS
        ? { ...c, startSec: Math.max(0, qf(c.startSec - shift, state.fps)) }
        : c
    )
  return { clips, tracks: state.tracks, changed: [id] }
}

/** 지정한 공백 구간 [gapStart,gapEnd) 를 닫고 그 뒤 클립을 당김(UI 가 범위를 직접 전달 → 결정적). */
export function closeGap(state: OpState, trackId: string, gapStart: number, gapEnd: number): OpResult {
  const track = findTrack(state, trackId)
  if (!track || track.locked) return reject(state, '잠긴 트랙')
  const gap = { startSec: gapStart, endSec: gapEnd }
  const width = gap.endSec - gap.startSec
  if (!(width > EPS)) return reject(state, '공백 없음')
  // 이 트랙에서 당겨질 클립들의 linkId → 붙어있는(링크된) 짝도 같은 양만큼 함께 당김.
  const shiftedLinkIds = new Set(
    state.clips
      .filter((c) => c.trackId === trackId && c.startSec >= gap.endSec - EPS && c.linkId)
      .map((c) => c.linkId)
  )
  const changed: string[] = []
  const clips = state.clips.map((c) => {
    const onTrack = c.trackId === trackId && c.startSec >= gap.endSec - EPS
    const linked = c.trackId !== trackId && !!c.linkId && shiftedLinkIds.has(c.linkId)
    if (onTrack || linked) {
      changed.push(c.id)
      return { ...c, startSec: Math.max(0, qf(c.startSec - width, state.fps)) }
    }
    return c
  })
  return { clips, tracks: state.tracks, changed }
}

/** 배속 변경(in/out 유지, startSec 고정). 길어지면 하류를 overwrite. */
export function setSpeed(state: OpState, id: string, rate: number): OpResult {
  if (!(rate > 0)) return reject(state, '배속은 0보다 커야 함')
  const clip = findClip(state, id)
  if (!clip) return reject(state, '클립 없음')
  const track = findTrack(state, clip.trackId)
  if (!track || track.locked) return reject(state, '잠긴 트랙')
  const moved: TimelineClip = { ...clip, speed: rate }
  return { clips: resolveOverwrite(state.clips, moved), tracks: state.tracks, changed: [id] }
}

/** 같은 kind 의 최상단 위에 트랙 추가. */
export function addTrack(state: OpState, kind: 'video' | 'audio'): OpResult {
  const sameKind = state.tracks.filter((t) => t.kind === kind)
  const maxIndex = sameKind.reduce((m, t) => Math.max(m, t.index), -1)
  const n = sameKind.length + 1
  const id = `${kind === 'video' ? 'V' : 'A'}${n}`
  const track: Track = {
    id,
    kind,
    name: id,
    index: maxIndex + 1,
    enabled: true,
    locked: false,
    muted: false,
    height: kind === 'video' ? 64 : 48
  }
  return { clips: state.clips, tracks: [...state.tracks, track], changed: [id] }
}

/** 선택 클립들을 링크/해제 토글. 모두 같은 링크면 해제, 아니면 새 linkId 부여. */
export function linkClips(state: OpState, ids: string[]): OpResult {
  const set = new Set(ids)
  const sel = state.clips.filter((c) => set.has(c.id))
  if (sel.length < 2) return reject(state, '두 개 이상 선택')
  const allSame = sel.every((c) => c.linkId && c.linkId === sel[0].linkId)
  const newLink = allSame ? undefined : newClipId()
  const clips = state.clips.map((c) => (set.has(c.id) ? { ...c, linkId: newLink } : c))
  return { clips, tracks: state.tracks, changed: ids }
}

/** 트랙을 같은 kind 내에서 위/아래로 이동(index 교환 → 합성 z-순서 변경). */
export function moveTrack(state: OpState, trackId: string, dir: 'up' | 'down'): OpResult {
  const track = findTrack(state, trackId)
  if (!track) return reject(state, '트랙 없음')
  const sameKind = state.tracks.filter((t) => t.kind === track.kind).sort((a, b) => a.index - b.index)
  const pos = sameKind.findIndex((t) => t.id === trackId)
  // up = 화면상 위 = 더 높은 index
  const swapPos = dir === 'up' ? pos + 1 : pos - 1
  if (swapPos < 0 || swapPos >= sameKind.length) return reject(state, '더 이동할 수 없음')
  const other = sameKind[swapPos]
  const tracks = state.tracks.map((t) => {
    if (t.id === track.id) return { ...t, index: other.index }
    if (t.id === other.id) return { ...t, index: track.index }
    return t
  })
  return { clips: state.clips, tracks, changed: [track.id, other.id] }
}

/**
 * 트랙을 같은 kind 내 임의 위치로 이동(드래그앤드롭). beforeTrackId 바로 "위(위 레인)"에 놓는다.
 * beforeTrackId 가 null/미존재면 맨 아래로. 시각 순서(위=높은 index)에 맞춰 index 재부여.
 */
export function reorderTrack(state: OpState, trackId: string, beforeTrackId: string | null): OpResult {
  const track = findTrack(state, trackId)
  if (!track) return reject(state, '트랙 없음')
  if (beforeTrackId === trackId) return { clips: state.clips, tracks: state.tracks, changed: [] }
  // 시각 순서(위→아래) = index 내림차순
  const visual = state.tracks
    .filter((t) => t.kind === track.kind)
    .sort((a, b) => b.index - a.index)
  const arr = visual.filter((t) => t.id !== trackId)
  const bPos = beforeTrackId ? arr.findIndex((t) => t.id === beforeTrackId) : -1
  const insertAt = bPos < 0 ? arr.length : bPos
  arr.splice(insertAt, 0, track)
  const n = arr.length
  const idxById = new Map(arr.map((t, i) => [t.id, n - 1 - i]))
  const tracks = state.tracks.map((t) =>
    idxById.has(t.id) ? { ...t, index: idxById.get(t.id)! } : t
  )
  return { clips: state.clips, tracks, changed: arr.map((t) => t.id) }
}

/** 트랙 삭제(그 트랙의 클립도 함께). 같은 kind 재인덱싱. 마지막 비디오 트랙은 보호. */
export function removeTrack(state: OpState, trackId: string): OpResult {
  const track = findTrack(state, trackId)
  if (!track) return reject(state, '트랙 없음')
  if (track.kind === 'video' && state.tracks.filter((t) => t.kind === 'video').length <= 1) {
    return reject(state, '마지막 비디오 트랙은 삭제할 수 없음')
  }
  const remaining = state.tracks.filter((t) => t.id !== trackId)
  const sameKind = remaining.filter((t) => t.kind === track.kind).sort((a, b) => a.index - b.index)
  const reindex = new Map(sameKind.map((t, i) => [t.id, i]))
  const tracks = remaining.map((t) => (reindex.has(t.id) ? { ...t, index: reindex.get(t.id)! } : t))
  const clips = state.clips.filter((c) => c.trackId !== trackId)
  return { clips, tracks, changed: [trackId] }
}

/** 트랙 플래그 토글(enabled/locked/muted). */
export function setTrackFlag(
  state: OpState,
  trackId: string,
  flags: Partial<Pick<Track, 'enabled' | 'locked' | 'muted'>>
): OpResult {
  let found = false
  const tracks = state.tracks.map((t) => {
    if (t.id !== trackId) return t
    found = true
    return { ...t, ...flags }
  })
  if (!found) return reject(state, '트랙 없음')
  return { clips: state.clips, tracks, changed: [trackId] }
}
