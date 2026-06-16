// 몽타주 재생 훅: 하나의 <video> 로 시퀀스를 통째로 재생.
// 컷 경계에서 다음 클립 소스로 자동 전환하고, montageTime(몽타주 상 현재 시각)을 노출.
// 트림 스크럽용 showFrame 은 몽타주 인덱스를 건드리지 않고 프레임만 표시.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SourceClip } from '@shared/types'
import type { LayoutItem } from '@shared/montage'

export interface MontagePlayer {
  playing: boolean
  montageTime: number
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (t: number, autoplay?: boolean) => void
  showFrame: (sourceId: string, sourceTime: number) => void
}

export function useMontagePlayer(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  items: LayoutItem[],
  total: number,
  sourceById: Map<string, SourceClip>
): MontagePlayer {
  const [playing, setPlaying] = useState(false)
  const [montageTime, setMontageTime] = useState(0)
  const idxRef = useRef(0)
  const loadedSourceRef = useRef<string | null>(null)
  // 메타데이터 도착 시 적용할 "최신" 목표(스크럽 중 빠른 연속 호출 대응).
  const desiredTimeRef = useRef(0)
  const desiredPlayRef = useRef(false)
  const metaPendingRef = useRef(false)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const totalRef = useRef(total)
  totalRef.current = total

  const urlOf = useCallback(
    (sourceId: string): string | null => {
      const s = sourceById.get(sourceId)
      return s ? window.clipreel.toMediaUrl(s.path) : null
    },
    [sourceById]
  )

  // 필요한 경우에만 src 교체 후 시킹. 항상 "최신" 목표시각/재생여부를 적용.
  const loadAndSeek = useCallback(
    (sourceId: string, sourceTime: number, autoplay: boolean) => {
      const v = videoRef.current
      if (!v) return
      const url = urlOf(sourceId)
      if (!url) return
      desiredTimeRef.current = sourceTime
      desiredPlayRef.current = autoplay

      const applyNow = (): void => {
        try {
          v.currentTime = desiredTimeRef.current
        } catch {
          /* 메타 미로드 — onReady 가 다시 적용 */
        }
        if (desiredPlayRef.current) void v.play().catch(() => {})
      }
      // 메타데이터 준비 시 최신 목표를 적용하는 1회 리스너(중복 등록 방지).
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
        // 같은 소스 + 메타 준비됨 → 즉시 시킹(스크럽 일반 경로).
        applyNow()
      } else {
        // 같은 소스지만 아직 로딩 중 → 준비되면 최신 목표 적용.
        ensurePending()
      }
    },
    [videoRef, urlOf]
  )

  const seek = useCallback(
    (t: number, autoplay?: boolean) => {
      const its = itemsRef.current
      if (its.length === 0) return
      const clamped = Math.max(0, Math.min(t, totalRef.current))
      let i = its.findIndex((it) => clamped < it.start + it.dur)
      if (i < 0) i = its.length - 1
      idxRef.current = i
      const it = its[i]
      const speed = it.clip.speed && it.clip.speed > 0 ? it.clip.speed : 1
      const sourceTime = it.clip.inSec + Math.max(0, clamped - it.start) * speed
      setMontageTime(clamped)
      if (!autoplay) {
        // 스크럽/클릭 탐색은 재생을 멈춘 상태로(재생 중이면 충돌 방지).
        setPlaying(false)
        videoRef.current?.pause()
      }
      loadAndSeek(it.clip.sourceId, sourceTime, autoplay ?? false)
    },
    [loadAndSeek, videoRef]
  )

  const play = useCallback(() => {
    const its = itemsRef.current
    if (its.length === 0) return
    setPlaying(true)
    let start = montageTime
    if (start >= totalRef.current - 0.05) start = 0
    seek(start, true)
  }, [montageTime, seek])

  const pause = useCallback(() => {
    setPlaying(false)
    videoRef.current?.pause()
  }, [videoRef])

  const toggle = useCallback(() => {
    if (playing) pause()
    else play()
  }, [playing, play, pause])

  // 트림 스크럽: 몽타주 인덱스 불변, 프레임만 표시(일시정지).
  const showFrame = useCallback(
    (sourceId: string, sourceTime: number) => {
      setPlaying(false)
      videoRef.current?.pause()
      loadAndSeek(sourceId, sourceTime, false)
    },
    [videoRef, loadAndSeek]
  )

  // timeupdate → montageTime 갱신 + 컷 경계에서 다음 컷으로 자동 전환.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = (): void => {
      if (!playing) return
      const its = itemsRef.current
      const it = its[idxRef.current]
      if (!it) return
      const speed = it.clip.speed && it.clip.speed > 0 ? it.clip.speed : 1
      if (v.currentTime >= it.clip.outSec - 0.03) {
        const next = idxRef.current + 1
        if (next < its.length) {
          idxRef.current = next
          setMontageTime(its[next].start)
          loadAndSeek(its[next].clip.sourceId, its[next].clip.inSec, true)
        } else {
          v.pause()
          setPlaying(false)
          setMontageTime(totalRef.current)
        }
      } else {
        const local = (v.currentTime - it.clip.inSec) / speed
        setMontageTime(it.start + Math.max(0, local))
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [playing, videoRef, loadAndSeek])

  // 클립 편집으로 total 이 줄면 montageTime 클램프.
  useEffect(() => {
    setMontageTime((mt) => (mt > total ? total : mt))
  }, [total])

  // 재생 중 클립이 삭제/재정렬되어 idx 가 범위를 벗어나면 멈춤 방지로 클램프.
  useEffect(() => {
    if (idxRef.current >= items.length) {
      idxRef.current = Math.max(0, items.length - 1)
    }
  }, [items])

  return { playing, montageTime, play, pause, toggle, seek, showFrame }
}
