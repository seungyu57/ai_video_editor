// EditOp[] 를 타임라인에 적용하는 순수 함수 + diff 계산 (스펙 §8, §9).
// 메인/렌더러 어디서든 쓰도록 node 의존성 없음. 검증 후 적용, 실패 연산은 사유와 함께 반환.

import type { EditOp, SourceClip, TimelineClip } from './types'

export interface ApplyResult {
  clips: TimelineClip[]
  applied: EditOp[]
  rejected: { op: EditOp; reason: string }[]
  /** rebuild 연산이 있었는지 — 렌더러가 자동편집 재실행 신호로 사용 */
  rebuildRequested: boolean
}

export interface TimelineDiff {
  added: string[] // clip id
  removed: string[]
  changed: string[]
}

let _seq = 0
function newClipId(): string {
  _seq += 1
  return `clip_user_${Date.now().toString(36)}_${_seq}`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** order 값을 0..n-1 로 정규화(현재 순서 유지). */
function renumber(clips: TimelineClip[]): void {
  clips
    .slice()
    .sort((a, b) => a.order - b.order)
    .forEach((c, i) => {
      c.order = i
    })
}

/**
 * ops 를 순차 적용. 원본 clips 는 변경하지 않고 새 배열 반환.
 * 각 연산은 검증 후 적용하며, 실패 시 rejected 에 사유 기록.
 */
export function applyEditOps(
  clips: TimelineClip[],
  ops: EditOp[],
  sources: SourceClip[]
): ApplyResult {
  // rebuild 은 "현재 설정으로 전체 재생성"이라 다른 연산과 섞이면 미리보기/적용이 어긋난다.
  // → rebuild 가 있으면 단독으로 처리하고 타임라인은 그대로 둔다(적용 시 호출부가 재생성).
  const rebuildOp = ops.find((o) => o.op === 'rebuild')
  if (rebuildOp) {
    return {
      clips: clips.map((c) => ({ ...c, reasons: [...c.reasons] })),
      applied: [rebuildOp],
      rejected: [],
      rebuildRequested: true
    }
  }

  // 깊은 복사(클립은 평면 객체 + reasons 배열)
  let work: TimelineClip[] = clips.map((c) => ({ ...c, reasons: [...c.reasons] }))
  const applied: EditOp[] = []
  const rejected: { op: EditOp; reason: string }[] = []
  const rebuildRequested = false

  const sourceById = new Map(sources.map((s) => [s.id, s]))
  const find = (id: string): TimelineClip | undefined => work.find((c) => c.id === id)

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'cut': {
          const c = find(op.clipId)
          if (!c) throw new Error(`존재하지 않는 clipId: ${op.clipId}`)
          work = work.filter((x) => x.id !== op.clipId)
          renumber(work)
          applied.push(op)
          break
        }
        case 'trim': {
          const c = find(op.clipId)
          if (!c) throw new Error(`존재하지 않는 clipId: ${op.clipId}`)
          const src = sourceById.get(c.sourceId)
          const dur = src?.durationSec ?? Math.max(c.outSec, op.outSec ?? 0)
          const nextIn = op.inSec !== undefined ? clamp(op.inSec, 0, dur) : c.inSec
          const nextOut = op.outSec !== undefined ? clamp(op.outSec, 0, dur) : c.outSec
          if (nextOut - nextIn < 0.1) throw new Error('트림 구간이 너무 짧음')
          c.inSec = Math.round(nextIn * 1000) / 1000
          c.outSec = Math.round(nextOut * 1000) / 1000
          applied.push(op)
          break
        }
        case 'pad': {
          const c = find(op.clipId)
          if (!c) throw new Error(`존재하지 않는 clipId: ${op.clipId}`)
          const src = sourceById.get(c.sourceId)
          const dur = src?.durationSec ?? c.outSec + (op.postSec ?? 0)
          c.inSec = Math.round(clamp(c.inSec - (op.preSec ?? 0), 0, dur) * 1000) / 1000
          c.outSec = Math.round(clamp(c.outSec + (op.postSec ?? 0), 0, dur) * 1000) / 1000
          applied.push(op)
          break
        }
        case 'reorder': {
          const idx = work.findIndex((c) => c.id === op.clipId)
          if (idx < 0) throw new Error(`존재하지 않는 clipId: ${op.clipId}`)
          const target = clamp(Math.round(op.toOrder), 0, work.length - 1)
          const ordered = work.slice().sort((a, b) => a.order - b.order)
          const [moved] = ordered.splice(
            ordered.findIndex((c) => c.id === op.clipId),
            1
          )
          ordered.splice(target, 0, moved)
          ordered.forEach((c, i) => (c.order = i))
          applied.push(op)
          break
        }
        case 'speed': {
          const c = find(op.clipId)
          if (!c) throw new Error(`존재하지 않는 clipId: ${op.clipId}`)
          if (!(op.rate > 0)) throw new Error('speed rate 는 0보다 커야 함')
          c.speed = op.rate
          applied.push(op)
          break
        }
        case 'addClip': {
          const src = sourceById.get(op.sourceId)
          if (!src) throw new Error(`존재하지 않는 sourceId: ${op.sourceId}`)
          const dur = src.durationSec || op.outSec
          const inSec = clamp(op.inSec, 0, dur)
          const outSec = clamp(op.outSec, 0, dur)
          if (outSec - inSec < 0.1) throw new Error('addClip 구간이 너무 짧음')
          work.push({
            id: newClipId(),
            sourceId: op.sourceId,
            inSec: Math.round(inSec * 1000) / 1000,
            outSec: Math.round(outSec * 1000) / 1000,
            order: work.length,
            speed: 1.0,
            origin: 'user',
            reasons: ['직접 추가']
          })
          renumber(work)
          applied.push(op)
          break
        }
        case 'rebuild': {
          // 위에서 단독 처리되므로 여기 도달하지 않음(방어적 무시).
          break
        }
        case 'addMarker': {
          const c = find(op.clipId)
          if (!c) throw new Error(`존재하지 않는 clipId: ${op.clipId}`)
          c.reasons.push(`📌 ${op.note}`)
          applied.push(op)
          break
        }
        default: {
          throw new Error(`알 수 없는 연산: ${(op as { op: string }).op}`)
        }
      }
    } catch (e) {
      rejected.push({ op, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  renumber(work)
  work.sort((a, b) => a.order - b.order)
  return { clips: work, applied, rejected, rebuildRequested }
}

/** before→after 타임라인 차이. UI 하이라이트(추가/삭제/변경)용. */
export function diffTimeline(
  before: TimelineClip[],
  after: TimelineClip[]
): TimelineDiff {
  const beforeById = new Map(before.map((c) => [c.id, c]))
  const afterById = new Map(after.map((c) => [c.id, c]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []

  for (const c of after) {
    const prev = beforeById.get(c.id)
    if (!prev) {
      added.push(c.id)
    } else if (
      prev.inSec !== c.inSec ||
      prev.outSec !== c.outSec ||
      prev.order !== c.order ||
      prev.speed !== c.speed ||
      prev.reasons.length !== c.reasons.length
    ) {
      changed.push(c.id)
    }
  }
  for (const c of before) {
    if (!afterById.has(c.id)) removed.push(c.id)
  }
  return { added, removed, changed }
}
