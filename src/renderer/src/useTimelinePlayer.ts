// 멀티트랙 재생 엔진. rAF 월클록이 마스터, 단일 <video> 는 프레임 소스(슬레이브).
// 공백(active=null) 구간에선 video 를 멈추고 검은 화면을 보여주되 시계는 계속 흐른다.
// 미리보기는 "최상위 비디오 트랙"만 보여줌(오디오 레이어링은 익스포트에서 믹스).

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SourceClip, Track, TimelineClip } from '@shared/types'
import { activeVideoClipAt, sourceTimeAt } from '@shared/timeline'

const DRIFT = 0.3 // 초. 이보다 어긋나야 재시킹(코덱 재생 끊김 방지)

export interface TimelinePlayer {
  playing: boolean
  playheadSec: number
  /** 현재 위치가 공백(검은 화면)인가 */
  gap: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (t: number, autoplay?: boolean) => void
  showFrame: (sourceId: string, sourceTime: number) => void
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function useTimelinePlayer(
  videoRef: React.RefObject<HTMLVideoElement>,
  clips: TimelineClip[],
  tracks: Track[],
  sourceById: Map<string, SourceClip>,
  totalSec: number
): TimelinePlayer {
  const [playing, setPlaying] = useState(false)
  const [playheadSec, setPlayheadSec] = useState(0)
  const [gap, setGap] = useState(false)

  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const totalRef = useRef(totalSec)
  totalRef.current = totalSec

  const playingRef = useRef(false)
  const gapRef = useRef(false)
  const playheadRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const lastUiRef = useRef(0)

  // 단일 <video> 로드/시킹 — 항상 "최신" 목표를 적용(빠른 스크럽/경계 교차 대응).
  const loadedSourceRef = useRef<string | null>(null)
  const desiredTimeRef = useRef(0)
  const desiredPlayRef = useRef(false)
  const metaPendingRef = useRef(false)

  const urlOf = useCallback(
    (sourceId: string): string | null => {
      const s = sourceById.get(sourceId)
      return s ? window.clipreel.toMediaUrl(s.path) : null
    },
    [sourceById]
  )

  const loadAndSeek = useCallback(
    (sourceId: string, sourceTime: number, autoplay: boolean) => {
      const v = videoRef.current
      if (!v) return
      const url = urlOf(sourceId)
      if (!url) return
      try {
        v.preservesPitch = false
      } catch {
        /* 일부 환경 미지원 */
      }
      desiredTimeRef.current = sourceTime
      desiredPlayRef.current = autoplay
      const applyNow = (): void => {
        try {
          v.currentTime = desiredTimeRef.current
        } catch {
          /* 메타 미로드 — onReady 가 재적용 */
        }
        if (desiredPlayRef.current) void v.play().catch(() => {})
        else v.pause()
      }
      const ensurePending = (): void => {
        if (metaPendingRef.current) return
        metaPendingRef.current = true
        const onReady = (): void => {
          v.removeEventListener('loadedmetadata', onReady)
          metaPendingRef.current = false
          applyNow()
        }
        v.addEventListener('loadedmetadata', onReady)
      }
      if (loadedSourceRef.current !== sourceId) {
        loadedSourceRef.current = sourceId
        v.src = url
        ensurePending()
        v.load()
      } else if (v.readyState >= 1) {
        applyNow()
      } else {
        ensurePending()
      }
    },
    [videoRef, urlOf]
  )

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    lastTsRef.current = null
  }, [])

  const tick = useCallback(
    (ts: number) => {
      if (!playingRef.current) return
      const last = lastTsRef.current ?? ts
      lastTsRef.current = ts
      let t = playheadRef.current + (ts - last) / 1000

      if (t >= totalRef.current) {
        t = totalRef.current
        playheadRef.current = t
        setPlayheadSec(t)
        playingRef.current = false
        setPlaying(false)
        videoRef.current?.pause()
        stopRaf()
        return
      }
      playheadRef.current = t
      if (ts - lastUiRef.current > 33) {
        lastUiRef.current = ts
        setPlayheadSec(t)
      }

      const a = activeVideoClipAt(clipsRef.current, tracksRef.current, t)
      const v = videoRef.current
      if (!a) {
        if (!gapRef.current) {
          gapRef.current = true
          setGap(true)
        }
        v?.pause()
      } else {
        if (gapRef.current) {
          gapRef.current = false
          setGap(false)
        }
        if (v) {
          const sp = a.clip.speed > 0 ? a.clip.speed : 1
          const want = sourceTimeAt(a.clip, t)
          if (loadedSourceRef.current !== a.clip.sourceId) {
            loadAndSeek(a.clip.sourceId, want, true)
          } else {
            // 같은 소스: 로드 대기 중이면 최신 목표를 갱신(stale seek 방지).
            desiredTimeRef.current = want
            desiredPlayRef.current = true
            if (v.paused) {
              try {
                v.currentTime = want
              } catch {
                /* 무시 */
              }
              void v.play().catch(() => {})
            } else if (Math.abs(v.currentTime - want) > DRIFT) {
              try {
                v.currentTime = want
              } catch {
                /* 무시 */
              }
            }
          }
          // 프레임당 불필요한 속성 쓰기 방지.
          if (v.playbackRate !== sp) v.playbackRate = sp
          if (v.muted !== a.track.muted) v.muted = a.track.muted
          const vol = clamp(a.clip.gain ?? 1, 0, 1)
          if (v.volume !== vol) v.volume = vol
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [loadAndSeek, stopRaf, videoRef]
  )

  const play = useCallback(() => {
    if (clipsRef.current.length === 0) return
    let t = playheadRef.current
    if (t >= totalRef.current - 0.05) t = 0
    playheadRef.current = t
    setPlayheadSec(t)
    playingRef.current = true
    setPlaying(true)

    // 사용자 제스처와 같은 콜스택에서 동기적으로 재생을 시작(autoplay/activation 안전).
    // rAF tick 은 이후 시계만 전진시킨다.
    const a = activeVideoClipAt(clipsRef.current, tracksRef.current, t)
    const v = videoRef.current
    if (a && v) {
      gapRef.current = false
      setGap(false)
      const want = sourceTimeAt(a.clip, t)
      if (loadedSourceRef.current !== a.clip.sourceId) {
        loadAndSeek(a.clip.sourceId, want, true)
      } else {
        desiredTimeRef.current = want
        desiredPlayRef.current = true
        try {
          v.currentTime = want
        } catch {
          /* 무시 */
        }
        void v.play().catch(() => {})
      }
    } else if (!a) {
      gapRef.current = true
      setGap(true)
    }

    lastTsRef.current = null
    stopRaf()
    rafRef.current = requestAnimationFrame(tick)
  }, [loadAndSeek, stopRaf, tick, videoRef])

  const pause = useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    stopRaf()
    videoRef.current?.pause()
  }, [stopRaf, videoRef])

  const toggle = useCallback(() => {
    if (playingRef.current) pause()
    else play()
  }, [pause, play])

  const seek = useCallback(
    (t: number, autoplay?: boolean) => {
      const clamped = clamp(t, 0, totalRef.current)
      playheadRef.current = clamped
      setPlayheadSec(clamped)
      const keepPlaying = autoplay ?? playingRef.current
      if (!keepPlaying) {
        playingRef.current = false
        setPlaying(false)
        stopRaf()
      }
      const a = activeVideoClipAt(clipsRef.current, tracksRef.current, clamped)
      if (!a) {
        gapRef.current = true
        setGap(true)
        videoRef.current?.pause()
        return
      }
      gapRef.current = false
      setGap(false)
      loadAndSeek(a.clip.sourceId, sourceTimeAt(a.clip, clamped), keepPlaying)
      if (keepPlaying && playingRef.current) {
        lastTsRef.current = null
        stopRaf()
        rafRef.current = requestAnimationFrame(tick)
      }
    },
    [loadAndSeek, stopRaf, tick, videoRef]
  )

  // 소스 빈 프리뷰: 몽타주와 무관하게 프레임만 표시.
  const showFrame = useCallback(
    (sourceId: string, sourceTime: number) => {
      playingRef.current = false
      setPlaying(false)
      stopRaf()
      gapRef.current = false
      setGap(false)
      loadAndSeek(sourceId, sourceTime, false)
    },
    [loadAndSeek, stopRaf]
  )

  // total 이 줄어 playhead 가 넘치면 클램프.
  useEffect(() => {
    if (playheadRef.current > totalSec) {
      playheadRef.current = totalSec
      setPlayheadSec(totalSec)
    }
  }, [totalSec])

  // 언마운트 정리.
  useEffect(() => stopRaf, [stopRaf])

  return { playing, playheadSec, gap, play, pause, toggle, seek, showFrame }
}
