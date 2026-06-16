// 자동 하이라이트 파이프라인 (스펙 §6).
// 신호 ① 오디오 피크: 클립별 라우드니스 곡선 → 핵심 피크 → 트림 구간 → 몽타주 조립.
// 신호 ② AI 화면 판단(vision.ts)은 settings.aiVision 일 때만 보조로 사용하며,
// 실패/미설치 시 ①만으로 graceful 하게 완결된다.

import { ffmpegCapture } from './ffmpeg'
import { detectCodex } from './codex'
import { judgeClip } from './vision'
import type { ProjectSettings, SourceClip, TimelineClip } from '@shared/types'

const SAMPLE_RATE = 8000 // Hz, 라우드니스 엔벨로프 추출용 (충분히 낮춰 데이터량 절감)
const WINDOW_SEC = 0.2 // 라우드니스 곡선 윈도우
const MAX_ANALYZE_SEC = 900 // 분석 상한(메모리 안전). 하이라이트 클립은 보통 수십초.
const MAX_VISION_CLIPS = 40 // 비전(②) 호출 상한(쿼터/시간 보호). 초과분은 오디오만.

interface PeakResult {
  /** 핵심 피크 시각(초) */
  peakSec: number
  /** 기준선 대비 dB 상승폭 */
  deltaDb: number
  /** 0~1 정규화 점수 */
  score: number
  /** 오디오 트랙이 없어 피크를 못 구함 */
  noAudio: boolean
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 모노 8kHz s16le PCM 을 ffmpeg 로 추출 → 윈도우별 라우드니스(dB) 곡선. */
async function loudnessCurve(filePath: string): Promise<number[]> {
  const pcm = await ffmpegCapture([
    '-hide_banner',
    '-loglevel',
    'error',
    '-t',
    String(MAX_ANALYZE_SEC),
    '-i',
    filePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    's16le',
    '-'
  ])
  // s16le 를 readInt16LE 로 읽어 Buffer 정렬/엔디안 가정을 피한다.
  const sampleCount = Math.floor(pcm.length / 2)
  const perWindow = Math.max(1, Math.round(SAMPLE_RATE * WINDOW_SEC))
  const curve: number[] = []
  for (let i = 0; i < sampleCount; i += perWindow) {
    let sumSq = 0
    let n = 0
    for (let j = i; j < i + perWindow && j < sampleCount; j++) {
      const v = pcm.readInt16LE(j * 2) / 32768
      sumSq += v * v
      n++
    }
    const rms = n > 0 ? Math.sqrt(sumSq / n) : 0
    curve.push(20 * Math.log10(rms + 1e-9))
  }
  return curve
}

/** 이동평균 평활. */
function smooth(curve: number[], radius = 1): number[] {
  if (radius <= 0) return curve
  const out = new Array<number>(curve.length)
  for (let i = 0; i < curve.length; i++) {
    let sum = 0
    let n = 0
    for (let j = i - radius; j <= i + radius; j++) {
      if (j >= 0 && j < curve.length) {
        sum += curve[j]
        n++
      }
    }
    out[i] = sum / n
  }
  return out
}

/** 라우드니스 곡선에서 핵심 피크 검출. */
function detectPeak(curve: number[]): PeakResult {
  if (curve.length === 0) {
    return { peakSec: 0, deltaDb: 0, score: 0, noAudio: true }
  }
  const sm = smooth(curve, 1)
  const baseline = median(sm)
  let peakIdx = 0
  let peakVal = -Infinity
  for (let i = 0; i < sm.length; i++) {
    if (sm[i] > peakVal) {
      peakVal = sm[i]
      peakIdx = i
    }
  }
  const deltaDb = peakVal - baseline
  // 18dB 이상 상승이면 만점. 0~1 정규화.
  const score = Math.max(0, Math.min(1, deltaDb / 18))
  const peakSec = peakIdx * WINDOW_SEC + WINDOW_SEC / 2
  return { peakSec, deltaDb, score, noAudio: false }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

let _clipSeq = 0
function nextClipId(): string {
  _clipSeq += 1
  return `clip_${Date.now().toString(36)}_${_clipSeq}`
}

interface ClipPeak {
  peakSec: number
  reasons: string[]
  score: number
}

/**
 * 한 소스의 핵심 피크 + 이유 태그 산출(오디오 ① + 선택적 비전 ②).
 * 오디오가 없거나 분석 실패 시 클립 중앙을 피크로 가정(graceful).
 */
async function detectClipPeak(
  src: SourceClip,
  useVision: boolean
): Promise<ClipPeak> {
  let peak: PeakResult
  try {
    if (src.audioStreams > 0 && src.durationSec > 0) {
      const curve = await loudnessCurve(src.path)
      peak = detectPeak(curve)
    } else {
      peak = { peakSec: src.durationSec / 2, deltaDb: 0, score: 0, noAudio: true }
    }
  } catch {
    peak = { peakSec: src.durationSec / 2, deltaDb: 0, score: 0, noAudio: true }
  }

  const dur = src.durationSec || 0
  const reasons: string[] = []
  if (peak.noAudio) reasons.push('오디오 없음')
  else reasons.push(`오디오 +${Math.round(peak.deltaDb)}dB`)

  let peakSec = peak.peakSec
  if (useVision && dur > 0) {
    // judgeClip 은 실패 시 null 을 반환하지만, 만약을 위해 한 번 더 감싼다(graceful 보장).
    let verdict = null
    try {
      verdict = await judgeClip(src.path, peak.peakSec, dur)
    } catch {
      verdict = null
    }
    if (verdict) {
      if (verdict.good) peakSec = clamp(peak.peakSec + clamp(verdict.offsetSec, -1.5, 1.5), 0, dur)
      if (verdict.comment) reasons.push(`AI: ${verdict.comment}`)
    }
  }

  return { peakSec, reasons, score: Math.round(peak.score * 100) / 100 }
}

/** 피크 기준 pre/post-roll 로 트림 구간 산출(소스 길이로 클램프). */
function trimAround(
  peakSec: number,
  dur: number,
  settings: ProjectSettings
): { inSec: number; outSec: number } {
  let inSec = clamp(peakSec - settings.preRollSec, 0, Math.max(0, dur))
  let outSec = clamp(peakSec + settings.postRollSec, 0, dur || peakSec + settings.postRollSec)
  if (outSec - inSec < 0.5) {
    inSec = 0
    outSec = dur || peakSec + settings.postRollSec
  }
  return {
    inSec: Math.round(inSec * 1000) / 1000,
    outSec: Math.round(outSec * 1000) / 1000
  }
}

/** 한 소스의 AI 추천 트림 구간(오디오 피크 기준, 빠르게 — 비전 미사용). */
export async function suggestRegion(
  src: SourceClip,
  settings: ProjectSettings
): Promise<{ inSec: number; outSec: number }> {
  const peak = await detectClipPeak(src, false)
  return trimAround(peak.peakSec, src.durationSec || 0, settings)
}

/** 한 소스 → 트림된 새 TimelineClip 1개. */
async function analyzeOne(
  src: SourceClip,
  settings: ProjectSettings,
  useVision: boolean
): Promise<TimelineClip> {
  const peak = await detectClipPeak(src, useVision)
  const { inSec, outSec } = trimAround(peak.peakSec, src.durationSec || 0, settings)
  return {
    id: nextClipId(),
    sourceId: src.id,
    inSec,
    outSec,
    order: 0,
    speed: 1.0,
    origin: 'ai',
    peakScore: peak.score,
    reasons: peak.reasons
  }
}

/**
 * 모든 소스를 분석해 몽타주 EDL(TimelineClip[]) 생성.
 * - 녹화 순서(파일명 정렬 = 스캔 순서)대로 정렬
 * - 총 길이가 목표를 넘으면 peakScore 낮은 순으로 덜어냄
 */
export async function autoHighlight(
  sources: SourceClip[],
  settings: ProjectSettings,
  targetDurationSec: number,
  onProgress?: (done: number, total: number) => void
): Promise<TimelineClip[]> {
  // 비전(②) 사용 가능 여부를 1회만 확인. codex 없으면 자동으로 오디오만(graceful).
  const useVision = !!settings.aiVision && (await detectCodex())
  let visionBudget = useVision ? MAX_VISION_CLIPS : 0

  const clips: TimelineClip[] = []
  // 소스 스캔 순서를 녹화 순서로 간주 → sourceOrder 보존
  for (let i = 0; i < sources.length; i++) {
    const perClipVision = visionBudget > 0
    clips.push(await analyzeOne(sources[i], settings, perClipVision))
    if (perClipVision) visionBudget--
    onProgress?.(i + 1, sources.length)
  }

  // 소스 순서(=clips 생성 순서)가 곧 시간순.
  const sourceOrderOf = new Map(sources.map((s, idx) => [s.id, idx]))

  // 목표 길이 초과 시 점수 낮은 것부터 제거
  let kept = [...clips]
  const totalDur = (cs: TimelineClip[]): number =>
    cs.reduce((sum, c) => sum + (c.outSec - c.inSec), 0)
  while (kept.length > 1 && totalDur(kept) > targetDurationSec) {
    // 가장 점수 낮은 클립 인덱스
    let worst = 0
    for (let i = 1; i < kept.length; i++) {
      if ((kept[i].peakScore ?? 0) < (kept[worst].peakScore ?? 0)) worst = i
    }
    kept.splice(worst, 1)
  }

  // 시간순 정렬 + order 재부여
  kept.sort(
    (a, b) => (sourceOrderOf.get(a.sourceId) ?? 0) - (sourceOrderOf.get(b.sourceId) ?? 0)
  )
  kept.forEach((c, idx) => {
    c.order = idx
  })
  return kept
}

/**
 * 이미 타임라인에 있는 클립들을 "그대로 두고" 각 클립의 소스를 재분석해
 * 핵심 구간으로 in/out 을 다듬는다(id/order/sourceId/origin/speed 보존).
 * 프리미어식 워크플로: 사용자가 드래그로 추가한 클립을 AI가 잘라줌.
 */
export async function trimClips(
  clips: TimelineClip[],
  sources: SourceClip[],
  settings: ProjectSettings,
  onProgress?: (done: number, total: number) => void
): Promise<TimelineClip[]> {
  const useVision = !!settings.aiVision && (await detectCodex())
  let visionBudget = useVision ? MAX_VISION_CLIPS : 0
  const sourceById = new Map(sources.map((s) => [s.id, s]))

  const out: TimelineClip[] = []
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    const src = sourceById.get(clip.sourceId)
    if (!src) {
      out.push(clip)
      onProgress?.(i + 1, clips.length)
      continue
    }
    const perClipVision = visionBudget > 0
    const peak = await detectClipPeak(src, perClipVision)
    if (perClipVision) visionBudget--
    const { inSec, outSec } = trimAround(peak.peakSec, src.durationSec || 0, settings)
    out.push({
      ...clip,
      inSec,
      outSec,
      peakScore: peak.score,
      reasons: peak.reasons
    })
    onProgress?.(i + 1, clips.length)
  }
  return out
}
