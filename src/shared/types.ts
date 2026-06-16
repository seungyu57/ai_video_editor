// ClipReel 공유 타입 — 메인/프리로드/렌더러 모두 사용.
// 데이터 모델은 스펙 §8 기준.

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

/** 타임라인 클립 = 원본 참조 + in/out 시점. */
export interface TimelineClip {
  id: string
  sourceId: string
  inSec: number
  outSec: number
  order: number
  speed: number
  /** "ai" = 자동 생성, "user" = 사용자 생성/수정 */
  origin: 'ai' | 'user'
  /** 0~1, 오디오 피크 점수 (없으면 undefined) */
  peakScore?: number
  /** 잘린 이유 태그. 예: ["오디오 +9dB", "AI: 더블킬"] */
  reasons: string[]
}

export interface ProjectSettings {
  preRollSec: number
  postRollSec: number
  /** 신호 ② AI 화면 판단 사용 여부(기본 false). 켜면 클립당 codex 비전 호출. */
  aiVision?: boolean
}

/** 적용된 편집 연산 로그 (undo/redo용). */
export interface HistoryEntry {
  /** 사람이 읽는 요약. 예: "AI가 12컷 생성" */
  label: string
  /** ISO 타임스탬프 */
  at: string
  /** 이 시점 직후의 타임라인 스냅샷 (간단한 undo 구현용) */
  clips: TimelineClip[]
}

export interface Project {
  version: 1
  name: string
  targetDurationSec: number
  sources: SourceClip[]
  timeline: {
    clips: TimelineClip[]
  }
  history: HistoryEntry[]
  settings: ProjectSettings
  /** 디스크에 저장된 경로 (저장 전이면 undefined) */
  filePath?: string
}

/** 편집 연산 스키마 — Codex 응답 = EditOp[] (스펙 §8). M2에서 사용. */
export type EditOp =
  | { op: 'cut'; clipId: string }
  | { op: 'trim'; clipId: string; inSec?: number; outSec?: number }
  | { op: 'pad'; clipId: string; preSec?: number; postSec?: number }
  | { op: 'reorder'; clipId: string; toOrder: number }
  | { op: 'speed'; clipId: string; rate: number }
  | { op: 'addClip'; sourceId: string; inSec: number; outSec: number }
  | { op: 'rebuild'; note?: string }
  | { op: 'addMarker'; clipId: string; note: string }

/** 환경 점검 결과 (ffmpeg/codex 존재 여부). */
export interface EnvStatus {
  ffmpegPath: string | null
  ffprobePath: string | null
  ffmpegOk: boolean
  codexFound: boolean
}

export function createEmptyProject(): Project {
  return {
    version: 1,
    name: '새 프로젝트',
    targetDurationSec: 600,
    sources: [],
    timeline: { clips: [] },
    history: [],
    settings: { preRollSec: 2.5, postRollSec: 1.5 }
  }
}
