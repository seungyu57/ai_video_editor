// AI 편집 공유 타입 + 순수 적용기.
// 세 기능(AI 트림 / 자동 하이라이트 / 자연어 채팅)이 모두 EditOp[] 로 수렴 →
// applyOps 가 기존 timeline-ops 를 그대로 재사용해 결과 스냅샷을 계산. (미리보기→적용/취소)

import type { TimelineClip, Track } from './types'
import {
  moveClip,
  placeClip,
  remove,
  rippleDelete,
  setSpeed,
  splitAt,
  trimLeft,
  trimRight,
  type OpResult,
  type OpState
} from './timeline-ops'

/** codex/내부가 내놓는 단일 편집 명령. strict 스키마 호환 위해 평면+nullable. */
export type EditOpKind =
  | 'trimLeft'
  | 'trimRight'
  | 'remove'
  | 'rippleDelete'
  | 'move'
  | 'split'
  | 'setSpeed'
  | 'placeRange'

export interface EditOp {
  op: EditOpKind
  clipId?: string | null
  sourceId?: string | null
  trackId?: string | null
  /** 주 시간 인자(트림 목표 위치 / 분할·이동 위치 / placeRange 시작). 타임라인 절대초. */
  valueSec?: number | null
  /** placeRange 전용 원본 in/out(초). */
  inSec?: number | null
  outSec?: number | null
  speed?: number | null
}

export interface ApplyResult {
  tracks: Track[]
  clips: TimelineClip[]
  changed: string[]
  applied: number
  rejected: { op: EditOp; reason: string }[]
}

const num = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const str = (v: string | null | undefined): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null

/** EditOp[] 를 순차 적용해 최종 스냅샷을 계산(불변). 실패 op 는 건너뛰고 사유를 모은다. */
export function applyOps(state: OpState, edits: EditOp[]): ApplyResult {
  let cur = state
  let applied = 0
  const changed = new Set<string>()
  const rejected: { op: EditOp; reason: string }[] = []

  for (const e of edits) {
    let res: OpResult | null = null
    const clipId = str(e.clipId)
    const trackId = str(e.trackId)
    const v = num(e.valueSec)

    switch (e.op) {
      case 'trimLeft':
        if (!clipId || v === null) { rejected.push({ op: e, reason: 'clipId/valueSec 필요' }); continue }
        res = trimLeft(cur, clipId, v)
        break
      case 'trimRight':
        if (!clipId || v === null) { rejected.push({ op: e, reason: 'clipId/valueSec 필요' }); continue }
        res = trimRight(cur, clipId, v)
        break
      case 'remove':
        if (!clipId) { rejected.push({ op: e, reason: 'clipId 필요' }); continue }
        res = remove(cur, clipId)
        break
      case 'rippleDelete':
        if (!clipId) { rejected.push({ op: e, reason: 'clipId 필요' }); continue }
        res = rippleDelete(cur, clipId)
        break
      case 'setSpeed': {
        const sp = num(e.speed)
        if (!clipId || sp === null) { rejected.push({ op: e, reason: 'clipId/speed 필요' }); continue }
        res = setSpeed(cur, clipId, sp)
        break
      }
      case 'split':
        if (!clipId || v === null) { rejected.push({ op: e, reason: 'clipId/valueSec 필요' }); continue }
        res = splitAt(cur, clipId, v)
        break
      case 'move': {
        if (!clipId || v === null) { rejected.push({ op: e, reason: 'clipId/valueSec 필요' }); continue }
        const clip = cur.clips.find((c) => c.id === clipId)
        if (!clip) { rejected.push({ op: e, reason: '클립 없음' }); continue }
        res = moveClip(cur, clipId, trackId ?? clip.trackId, v, true)
        break
      }
      case 'placeRange': {
        const sourceId = str(e.sourceId)
        const i = num(e.inSec)
        const o = num(e.outSec)
        if (!sourceId || !trackId || v === null || i === null || o === null) {
          rejected.push({ op: e, reason: 'sourceId/trackId/valueSec/inSec/outSec 필요' })
          continue
        }
        res = placeClip(cur, sourceId, trackId, v, i, o, 'ai', ['AI 하이라이트'])
        break
      }
      default:
        rejected.push({ op: e, reason: `알 수 없는 op: ${String((e as EditOp).op)}` })
        continue
    }

    if (res.rejected) {
      rejected.push({ op: e, reason: res.rejected })
    } else {
      cur = { ...cur, tracks: res.tracks, clips: res.clips }
      res.changed.forEach((id) => changed.add(id))
      applied += 1
    }
  }

  return { tracks: cur.tracks, clips: cur.clips, changed: [...changed], applied, rejected }
}

// ── 미리보기 제안 ──
export type ProposalKind = 'trim' | 'highlight' | 'chat'

export interface Proposal {
  id: string
  kind: ProposalKind
  title: string
  summary: string
  preview: { tracks: Track[]; clips: TimelineClip[] }
  /** "원본" 비교 시 보여줄 스냅샷(미지정이면 적용 직전 타임라인). 하이라이트는 전체 원본 영상. */
  before?: { tracks: Track[]; clips: TimelineClip[] }
  changedIds: string[]
  explanation?: string
}

// ── main ↔ renderer 요청/응답(오디오 분석은 메인에서 ffmpeg 로) ──

/** AI 트림 분석 요청 항목(클립 1개). */
export interface TrimAnalyzeItem {
  clipId: string
  sourcePath: string
  /** 원본 기준 in/out(초)과 배속. */
  inSec: number
  outSec: number
  speed: number
}

/** 트림 제안(타임라인 초 단위 절삭량). */
export interface TrimSuggestion {
  clipId: string
  /** 앞에서 잘라낼 무음 길이(타임라인 초). */
  leadCutSec: number
  /** 뒤에서 잘라낼 무음 길이(타임라인 초). */
  tailCutSec: number
  /** 사실상 통째로 무음 → 제거 권장. */
  fullSilent: boolean
}

/** 자동 하이라이트 분석 요청. */
export interface HighlightRequest {
  sourcePath: string
  /** 후보 최대 개수. */
  maxClips: number
  /** 각 하이라이트 앞/뒤 여유(초). */
  preRollSec: number
  postRollSec: number
}

/** 하이라이트 구간(원본 in/out 초). */
export interface HighlightSegment {
  inSec: number
  outSec: number
  /** 0..1 정규화 강도. */
  score: number
  /** AI(비전)가 고른 이유(선택). */
  reason?: string
}

/** 사용할 AI 백엔드. codex=ChatGPT로그인, gemini=구글, claude=Anthropic. */
export type AiProvider = 'codex' | 'gemini' | 'claude'

/** AI 자동 하이라이트 요청(비전 + 선택적 음성 전사 융합). */
export interface VisionHighlightRequest {
  sourcePath: string
  durationSec: number
  /** 분석에 쓸 AI. */
  provider: AiProvider
  /** fast=듬성듬성(빠름·저쿼터), precise=촘촘(정확·고쿼터). */
  mode: 'fast' | 'precise'
  /** 음성 전사(Whisper)도 분석에 포함할지. whisper 미설치면 무시(화면만). */
  useAudio: boolean
  /** env:check 가 알려준 whisper 실행 명령(없으면 null). */
  whisperCmd: string | null
  maxClips: number
  preRollSec: number
  postRollSec: number
}

/** 분석 진행 상황(렌더러 표시용). */
export interface VisionProgress {
  stage: 'transcribe' | 'extract' | 'analyze' | 'fuse' | 'done'
  current: number
  total: number
  message: string
}

/** 자연어 편집 요청. */
export interface ChatClipInfo {
  id: string
  track: string
  startSec: number
  durSec: number
  peakScore: number | null
}
export interface ChatEditRequest {
  instruction: string
  clips: ChatClipInfo[]
  /** 사용할 AI(기본 codex). */
  provider?: AiProvider
}
export interface ChatEditResult {
  ops: EditOp[]
  explanation: string
  /** codex 미설치/실패 시 사용자 안내. */
  error?: string
}
