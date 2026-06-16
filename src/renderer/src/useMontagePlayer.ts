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
  const loadTokenRef = useRef(0)
  const pendingMetaRef = useRef<(() => void) | null>(null)
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

  // 필요한 경우에만 src 교체 후 시킹.
  const loadAndSeek = useCallback(
    (sourceId: string, sourceTime: number, autoplay: boolean) => {
      const v = videoRef.current
      if (!v) return
      const url = urlOf(sourceId)
      if (!url) return
      // 로드 토큰: 메타 도착 전에 새 로드가 시작되면 옛 콜백을 무시(코드리뷰 반영).
      const token = ++loadTokenRef.current
      const apply = (): void => {
        if (token !== loadTokenRef.current) return
        try {
          v.currentTime = sourceTime
        } catch {
          /* 메타 미로드 시 무시 */
        }
        if (autoplay) void v.play().catch(() => {})
      }
      if (loadedSourceRef.current !== sourceId) {
        loadedSourceRef.current = sourceId
        // 이전에 대기 중이던 metadata 리스너 제거(스테일 방지).
        if (pendingMetaRef.current) {
          v.removeEventListener('loadedmetadata', pendingMetaRef.current)
          pendingMetaRef.current = null
        }
        v.src = url
        const onMeta = (): void => {
          v.removeEventListener('loadedmetadata', onMeta)
          pendingMetaRef.current = null
          apply()
        }
        pendingMetaRef.current = onMeta
        v.addEventListener('loadedmetadata', onMeta)
        v.load()
      } else {
        apply()
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
      loadAndSeek(it.clip.sourceId, sourceTime, autoplay ?? false)
    },
    [loadAndSeek]
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
