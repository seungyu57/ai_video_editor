// 몽타주 타임라인 레이아웃 헬퍼 (순수). 시퀀스 트랙/재생 위치 계산에 사용.
// 몽타주 상의 클립 길이 = (out-in)/speed (배속 반영).

import type { TimelineClip } from './types'

export interface LayoutItem {
  clip: TimelineClip
  /** 몽타주 시작 시각(초) */
  start: number
  /** 몽타주 상 길이(초) */
  dur: number
}

export function clipMontageDur(c: TimelineClip): number {
  const speed = c.speed && c.speed > 0 ? c.speed : 1
  return Math.max(0.01, (c.outSec - c.inSec) / speed)
}

/** order 순으로 누적 배치한 레이아웃 + 총 길이. */
export function buildLayout(clips: TimelineClip[]): { items: LayoutItem[]; total: number } {
  const ordered = [...clips].sort((a, b) => a.order - b.order)
  let t = 0
  const items: LayoutItem[] = ordered.map((clip) => {
    const dur = clipMontageDur(clip)
    const item = { clip, start: t, dur }
    t += dur
    return item
  })
  return { items, total: t }
}

/** 몽타주 시각 → 해당 클립 인덱스 + 원본 시각. */
export function locate(
  items: LayoutItem[],
  montageT: number
): { index: number; sourceTime: number } {
  if (items.length === 0) return { index: -1, sourceTime: 0 }
  let i = items.findIndex((it) => montageT < it.start + it.dur)
  if (i < 0) i = items.length - 1
  const it = items[i]
  const speed = it.clip.speed && it.clip.speed > 0 ? it.clip.speed : 1
  const sourceTime = it.clip.inSec + Math.max(0, montageT - it.start) * speed
  return { index: i, sourceTime }
}

/** 눈금 간격을 보기 좋은 값으로(1,2,5,10,15,30,60...). */
export function niceStep(roughStep: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  for (const s of steps) if (roughStep <= s) return s
  return 900
}

/** 초 → m:ss */
export function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
