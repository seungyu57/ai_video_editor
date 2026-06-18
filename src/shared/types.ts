// ClipReel 공유 타입 — 메인/프리로드/렌더러 공용.
// 멀티트랙 NLE 모델: 클립은 트랙(trackId) 위의 절대 시각(startSec)에 배치되고, 사이에 공백 허용.

/** 원본 영상(읽기 전용 참조). 절대 수정/삭제하지 않는다. */
export interface SourceClip {
  id: string
  path: string
  /** 파일명만 (표시용) */
  name: string
  durationSec: number
  fps: number
  /** 예: "1920x1080" */
  resolution: string
  /** 오디오 트랙 수 (0이면 무음) */
  audioStreams: number
  /** ffprobe 실패 등으로 메타를 못 읽었을 때 */
  error?: string
}

export type TrackKind = 'video' | 'audio'

/** 트랙(레인). id 는 안정 식별자이자 clip.trackId 와 일치. */
export interface Track {
  id: string
  kind: TrackKind
  name: string
  /** 같은 kind 내 z-순서. 높을수록 위 레인 = 비디오는 위에 합성, 오디오는 합산. */
  index: number
  enabled: boolean
  locked: boolean
  muted: boolean
  /** 레인 높이(px) */
  height: number
}

/** 타임라인 클립 = 원본 참조 + 트랙 + 타임라인 위치 + in/out. */
export interface TimelineClip {
  id: string
  sourceId: string
  /** 어느 트랙(레인)에 있는지 */
  trackId: string
  /** 타임라인 절대 위치(초, 프레임 양자화). 공백 허용. */
  startSec: number
  inSec: number
  outSec: number
  /** >0, 기본 1. timelineDur = (outSec-inSec)/speed */
  speed: number
  /** 가져올 때 분리된 비디오↔오디오 클립을 묶는 id (선택). */
  linkId?: string
  origin: 'ai' | 'user'
  /** 0..1 클립별 오디오 게인(기본 1). 익스포트 믹스에 사용 */
  gain?: number
  reasons: string[]
  peakScore?: number
}

export interface ProjectSettings {
  preRollSec: number
  postRollSec: number
  /** 유지(현재 미사용, AI 기능 보류) */
  aiVision?: boolean
}

/** 편집 히스토리 항목(undo/redo 스냅샷). */
export interface HistoryEntry {
  label: string
  /** ISO 타임스탬프 */
  at: string
  /** 이 시점 직후의 타임라인 스냅샷 */
  snapshot: { tracks: Track[]; clips: TimelineClip[] }
}

export interface Project {
  version: 2
  name: string
  targetDurationSec: number
  /** 타임라인 프레임 그리드(기본 60) */
  fps: number
  width: number
  height: number
  sources: SourceClip[]
  timeline: { tracks: Track[]; clips: TimelineClip[] }
  history: HistoryEntry[]
  settings: ProjectSettings
  /** 디스크 저장 경로 (저장 전이면 undefined) */
  filePath?: string
}

/** 환경 점검 결과 (ffmpeg/codex 존재 여부). */
export interface EnvStatus {
  ffmpegPath: string | null
  ffprobePath: string | null
  ffmpegOk: boolean
  codexFound: boolean
}

export function defaultTracks(): Track[] {
  // 비디오 트랙마다 짝 오디오 트랙(V1↔A1, V2↔A2, V3↔A3). 영상 드롭 시 짝 트랙으로 분리.
  return [
    { id: 'V3', kind: 'video', name: 'V3', index: 2, enabled: true, locked: false, muted: false, height: 64 },
    { id: 'V2', kind: 'video', name: 'V2', index: 1, enabled: true, locked: false, muted: false, height: 64 },
    { id: 'V1', kind: 'video', name: 'V1', index: 0, enabled: true, locked: false, muted: false, height: 64 },
    { id: 'A1', kind: 'audio', name: 'A1', index: 0, enabled: true, locked: false, muted: false, height: 48 },
    { id: 'A2', kind: 'audio', name: 'A2', index: 1, enabled: true, locked: false, muted: false, height: 48 },
    { id: 'A3', kind: 'audio', name: 'A3', index: 2, enabled: true, locked: false, muted: false, height: 48 }
  ]
}

export function createEmptyProject(): Project {
  return {
    version: 2,
    name: '새 프로젝트',
    targetDurationSec: 600,
    fps: 60,
    width: 1920,
    height: 1080,
    sources: [],
    timeline: { tracks: defaultTracks(), clips: [] },
    history: [],
    settings: { preRollSec: 2.5, postRollSec: 1.5 }
  }
}

/** 순수 v1→v2 마이그레이션. 메인(project.ts load)과 렌더러(openProject) 양쪽에서 사용. */
export function migrateProject(p: unknown): Project {
  const any = (p ?? {}) as Record<string, unknown>
  if (any.version === 2) {
    // 손상/부분 v2 파일도 안전하게: 필수 필드를 명시적으로 보정.
    const tl = (any.timeline as { tracks?: unknown; clips?: unknown }) ?? {}
    return {
      version: 2,
      name: typeof any.name === 'string' ? any.name : '새 프로젝트',
      targetDurationSec: typeof any.targetDurationSec === 'number' ? any.targetDurationSec : 600,
      fps: Number(any.fps) > 0 ? Number(any.fps) : 60,
      width: Number(any.width) > 0 ? Number(any.width) : 1920,
      height: Number(any.height) > 0 ? Number(any.height) : 1080,
      sources: Array.isArray(any.sources) ? (any.sources as SourceClip[]) : [],
      timeline: {
        tracks: Array.isArray(tl.tracks) && tl.tracks.length ? (tl.tracks as Track[]) : defaultTracks(),
        clips: Array.isArray(tl.clips) ? (tl.clips as TimelineClip[]) : []
      },
      history: Array.isArray(any.history) ? (any.history as HistoryEntry[]) : [],
      settings: (any.settings as ProjectSettings) ?? { preRollSec: 2.5, postRollSec: 1.5 },
      filePath: typeof any.filePath === 'string' ? any.filePath : undefined
    }
  }

  const tracks = defaultTracks()
  const oldClips = Array.isArray((any.timeline as { clips?: unknown[] })?.clips)
    ? ([...((any.timeline as { clips: unknown[] }).clips)] as Record<string, unknown>[])
    : []
  oldClips.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))

  let cursor = 0
  const clips: TimelineClip[] = oldClips.map((c) => {
    const inSec = Number(c.inSec ?? 0)
    const outSec = Number(c.outSec ?? 0)
    const sp = Number(c.speed) > 0 ? Number(c.speed) : 1
    const dur = Math.max(0.01, (outSec - inSec) / sp)
    const clip: TimelineClip = {
      id: String(c.id ?? `clip_${cursor}`),
      sourceId: String(c.sourceId ?? ''),
      trackId: 'V1',
      startSec: cursor,
      inSec,
      outSec,
      speed: sp,
      origin: (c.origin as 'ai' | 'user') ?? 'user',
      reasons: Array.isArray(c.reasons) ? (c.reasons as string[]) : [],
      peakScore: typeof c.peakScore === 'number' ? c.peakScore : undefined
    }
    cursor += dur
    return clip
  })

  const settings = (any.settings as ProjectSettings) ?? { preRollSec: 2.5, postRollSec: 1.5 }
  return {
    version: 2,
    name: typeof any.name === 'string' ? any.name : '새 프로젝트',
    targetDurationSec: typeof any.targetDurationSec === 'number' ? any.targetDurationSec : 600,
    fps: 60,
    width: 1920,
    height: 1080,
    sources: Array.isArray(any.sources) ? (any.sources as SourceClip[]) : [],
    timeline: { tracks, clips },
    history: [],
    settings,
    filePath: typeof any.filePath === 'string' ? any.filePath : undefined
  }
}
