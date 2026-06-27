// AI 편집 백엔드(메인).
// ① 오디오 엔벨로프 분석(ffmpeg PCM) → 트림 포인트 / 하이라이트 피크 검출 (LLM 불필요·오프라인)
// ② 자연어 편집은 codex CLI 로 EditOp[] 생성 (--output-schema strict, 평면+nullable)
// 외부 의존성(codex)은 자동 설치하지 않는다. 없으면 사용자 안내만 반환.

import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { app } from 'electron'
import { ffmpegCapture, runFfmpeg, ffmpegPath } from './ffmpeg'
// AI 운영 지침 기본값(편집 전 읽는 작업지시). 빌드 시 인라인. 사용자가 앱에서 수정하면 오버라이드.
import AGENT_DOC_DEFAULT from '@shared/ai-agent.md?raw'

// ── AI 지침(사용자 편집 가능) — 앱 데이터 폴더에 저장, 없으면 기본값 ──
function agentDocPath(): string {
  return join(app.getPath('userData'), 'ai-agent.md')
}
let _agentDoc: string | null = null
/** 분석/편집 프롬프트에 쓸 현재 지침(사용자 저장본 우선, 캐시). */
async function getAgentDoc(): Promise<string> {
  if (_agentDoc != null) return _agentDoc
  try {
    _agentDoc = await readFile(agentDocPath(), 'utf8')
  } catch {
    _agentDoc = AGENT_DOC_DEFAULT
  }
  return _agentDoc
}
/** UI 표시용: 현재 지침 + 사용자 커스텀 여부 + 기본값. */
export async function getInstructions(): Promise<{ text: string; isCustom: boolean; defaultText: string }> {
  try {
    const t = await readFile(agentDocPath(), 'utf8')
    return { text: t, isCustom: true, defaultText: AGENT_DOC_DEFAULT }
  } catch {
    return { text: AGENT_DOC_DEFAULT, isCustom: false, defaultText: AGENT_DOC_DEFAULT }
  }
}
/** 지침 저장(다음 분석부터 즉시 반영). */
export async function saveInstructions(text: string): Promise<void> {
  await writeFile(agentDocPath(), text, 'utf8')
  _agentDoc = text
}
/** 기본값으로 복원(사용자 파일 삭제). */
export async function resetInstructions(): Promise<string> {
  await rm(agentDocPath(), { force: true }).catch(() => {})
  _agentDoc = AGENT_DOC_DEFAULT
  return AGENT_DOC_DEFAULT
}

const execFileAsync = promisify(execFile)
import type {
  AiProvider,
  ChatEditRequest,
  ChatEditResult,
  EditOp,
  HighlightRequest,
  HighlightSegment,
  TrimAnalyzeItem,
  TrimSuggestion,
  VisionHighlightRequest,
  VisionProgress
} from '@shared/ai-edit'

const SR = 8000 // 분석용 샘플레이트(모노)
const WIN_SEC = 0.025 // 25ms 창
const MIN_KEEP = 0.1 // 트림 후 최소 잔여(타임라인 초)

/** 소스 [ss, ss+dur] 구간을 모노 s16le PCM 으로 추출. dur<=0 이면 전체. */
async function extractPcm(sourcePath: string, ss: number, dur: number): Promise<Int16Array> {
  const args = ['-hide_banner', '-loglevel', 'error']
  if (ss > 0) args.push('-ss', ss.toFixed(4))
  if (dur > 0) args.push('-t', dur.toFixed(4))
  args.push('-i', sourcePath, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-')
  const buf = await ffmpegCapture(args)
  // Buffer → Int16Array (LE). 홀수 바이트 방지로 짝수 길이만.
  const len = buf.length - (buf.length % 2)
  return new Int16Array(buf.buffer, buf.byteOffset, len / 2)
}

/** PCM → 창별 RMS 엔벨로프(0..1 정규화). */
function rmsEnvelope(pcm: Int16Array): Float32Array {
  const win = Math.max(1, Math.round(SR * WIN_SEC))
  const n = Math.floor(pcm.length / win)
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    const base = i * win
    for (let j = 0; j < win; j++) {
      const v = pcm[base + j] / 32768
      sum += v * v
    }
    env[i] = Math.sqrt(sum / win)
  }
  return env
}

const mean = (a: Float32Array): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
function std(a: Float32Array, m: number): number {
  if (!a.length) return 0
  let s = 0
  for (const v of a) s += (v - m) * (v - m)
  return Math.sqrt(s / a.length)
}
function maxOf(a: Float32Array): number {
  let m = 0
  for (const v of a) if (v > m) m = v
  return m
}

// ── ① AI 트림: 앞/뒤 무음 절삭량 ──
export async function analyzeTrim(
  items: TrimAnalyzeItem[],
  padSec = 0.15
): Promise<TrimSuggestion[]> {
  const out: TrimSuggestion[] = []
  for (const it of items) {
    const sp = it.speed > 0 ? it.speed : 1
    const srcDur = Math.max(0, it.outSec - it.inSec)
    try {
      const pcm = await extractPcm(it.sourcePath, it.inSec, srcDur)
      const env = rmsEnvelope(pcm)
      if (env.length === 0) {
        out.push({ clipId: it.clipId, leadCutSec: 0, tailCutSec: 0, fullSilent: false })
        continue
      }
      const peak = maxOf(env)
      // 통무음 판정은 '절대 바닥'으로만(조용하지만 유효한 오디오를 삭제 제안하지 않도록).
      const SILENCE_FLOOR = 0.012
      if (peak < SILENCE_FLOOR) {
        out.push({ clipId: it.clipId, leadCutSec: 0, tailCutSec: 0, fullSilent: true })
        continue
      }
      // 경계 검출은 peak 상대 임계값.
      const thr = Math.max(0.015, peak * 0.15)
      let first = -1
      let last = -1
      for (let i = 0; i < env.length; i++) {
        if (env[i] > thr) {
          if (first < 0) first = i
          last = i
        }
      }
      if (first < 0) {
        // peak 가 바닥 이상인데 임계 초과 창이 없음(매우 평탄) → 변경 없음(삭제 아님).
        out.push({ clipId: it.clipId, leadCutSec: 0, tailCutSec: 0, fullSilent: false })
        continue
      }
      // 원본 도메인 무음 → padSec 여유 → 타임라인 도메인(/speed)
      const leadSrc = Math.max(0, first * WIN_SEC - padSec)
      const tailSrc = Math.max(0, (env.length - 1 - last) * WIN_SEC - padSec)
      let leadCut = leadSrc / sp
      let tailCut = tailSrc / sp
      const durTl = srcDur / sp
      // 잔여가 MIN_KEEP 이상이도록 절삭 총량 제한.
      if (durTl - leadCut - tailCut < MIN_KEEP) {
        const room = Math.max(0, durTl - MIN_KEEP)
        const total = leadCut + tailCut
        if (total > room && total > 0) {
          const k = room / total
          leadCut *= k
          tailCut *= k
        }
      }
      out.push({
        clipId: it.clipId,
        leadCutSec: Math.max(0, leadCut),
        tailCutSec: Math.max(0, tailCut),
        fullSilent: false
      })
    } catch {
      // 분석 실패한 클립은 변경 없음으로.
      out.push({ clipId: it.clipId, leadCutSec: 0, tailCutSec: 0, fullSilent: false })
    }
  }
  return out
}

// ── ② 자동 하이라이트: 소리 피크 구간 ──
export async function analyzeHighlights(req: HighlightRequest): Promise<HighlightSegment[]> {
  const pre = Math.max(0, req.preRollSec)
  const post = Math.max(0, req.postRollSec)
  const maxClips = Math.max(1, Math.min(50, req.maxClips))
  const pcm = await extractPcm(req.sourcePath, 0, 0)
  const env = rmsEnvelope(pcm)
  if (env.length === 0) return []

  // 살짝 평활화(3창 이동평균)로 단발 노이즈 억제.
  const sm = new Float32Array(env.length)
  for (let i = 0; i < env.length; i++) {
    const a = env[Math.max(0, i - 1)]
    const b = env[i]
    const c = env[Math.min(env.length - 1, i + 1)]
    sm[i] = (a + b + c) / 3
  }
  const m = mean(sm)
  const sd = std(sm, m)
  const peak = maxOf(sm)
  const thr = Math.max(m + 1.4 * sd, peak * 0.5)

  // thr 초과 구간을 병합(작은 골은 이어붙임).
  const mergeWin = Math.ceil((pre + post + 0.4) / WIN_SEC)
  type Seg = { s: number; e: number; score: number }
  const segs: Seg[] = []
  let i = 0
  while (i < sm.length) {
    if (sm[i] > thr) {
      let j = i
      let sc = sm[i]
      let gap = 0
      let k = i + 1
      while (k < sm.length && gap <= mergeWin) {
        if (sm[k] > thr) {
          j = k
          gap = 0
          if (sm[k] > sc) sc = sm[k]
        } else {
          gap++
        }
        k++
      }
      segs.push({ s: i, e: j, score: sc })
      i = j + 1
    } else {
      i++
    }
  }
  if (segs.length === 0) return []

  // 강도순 상위 maxClips → 시간순 정렬.
  segs.sort((a, b) => b.score - a.score)
  const top = segs.slice(0, maxClips).sort((a, b) => a.s - b.s)
  const totalSec = env.length * WIN_SEC
  const result: HighlightSegment[] = []
  for (const sgt of top) {
    const inSec = Math.max(0, sgt.s * WIN_SEC - pre)
    const outSec = Math.min(totalSec, (sgt.e + 1) * WIN_SEC + post)
    if (outSec - inSec < 0.2) continue
    // 직전 구간과 겹치면 병합.
    const prev = result[result.length - 1]
    if (prev && inSec <= prev.outSec) {
      prev.outSec = Math.max(prev.outSec, outSec)
      prev.score = Math.max(prev.score, sgt.score / peak)
    } else {
      result.push({ inSec, outSec, score: peak > 0 ? sgt.score / peak : 0 })
    }
  }
  return result
}

// ── 비전 자동 하이라이트(codex 가 프레임을 직접 분석) ──

const VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['highlights'],
  properties: {
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['startSec', 'endSec', 'score', 'reason'],
        properties: {
          startSec: { type: 'number' },
          endSec: { type: 'number' },
          score: { type: 'number' },
          reason: { type: 'string' }
        }
      }
    }
  }
} as const

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const numOr = (v: unknown, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d)

// ── 음성 전사(Whisper) ──

/** 설치된 whisper 계열 CLI 명령을 감지(없으면 null). 자동 설치는 하지 않는다. */
export async function detectWhisper(): Promise<string | null> {
  const which = process.platform === 'win32' ? 'where' : 'which'
  for (const cmd of ['whisper', 'whisper-cli', 'whisperx', 'faster-whisper']) {
    try {
      await execFileAsync(which, [cmd], { windowsHide: true })
      return cmd
    } catch {
      /* 다음 후보 */
    }
  }
  return null
}

/** Whisper(openai) JSON → {start,end,text} 세그먼트. 견고 파싱(순수, 테스트 대상). */
export function parseWhisperJson(raw: string): { start: number; end: number; text: string }[] {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return []
  }
  const segs = (obj as { segments?: unknown })?.segments
  if (!Array.isArray(segs)) return []
  const out: { start: number; end: number; text: string }[] = []
  for (const s of segs) {
    const seg = s as { start?: unknown; end?: unknown; text?: unknown }
    const start = Number(seg.start)
    const end = Number(seg.end)
    const text = typeof seg.text === 'string' ? seg.text.trim() : ''
    if (Number.isFinite(start) && Number.isFinite(end) && text) out.push({ start, end, text })
  }
  return out
}

type Seg = { start: number; end: number; text: string }

// ── 내장 전사(Transformers.js, 번들 — Python/CLI 불필요) ──
interface AsrPipe {
  (audio: Float32Array, opts?: Record<string, unknown>): Promise<{
    text?: string
    chunks?: { timestamp: [number, number | null]; text: string }[]
  }>
}
// 진행 중인 로드 promise 를 캐싱 → 동시 호출이 같은 싱글톤을 공유(동시성 안전).
let _asrPromise: Promise<AsrPipe | null> | null = null

/** ASR 파이프라인 lazy 로드(최초 1회 모델 다운로드·캐시). 실패 시 null. */
function getAsr(onProgress?: (msg: string) => void): Promise<AsrPipe | null> {
  if (_asrPromise) return _asrPromise
  _asrPromise = (async () => {
    try {
      const tf = (await import('@huggingface/transformers')) as unknown as {
        pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<AsrPipe>
      }
      onProgress?.('음성 모델 준비 중(최초 1회 다운로드)…')
      return await tf.pipeline('automatic-speech-recognition', 'Xenova/whisper-base')
    } catch {
      return null
    }
  })()
  return _asrPromise
}

/** 메모리 보호: 내장 전사는 최대 이 길이(초)까지만(긴 영상 OOM 방지). */
const MAX_TRANSCRIBE_SEC = 3600

/** ffmpeg(번들)로 16kHz 모노 Float32 PCM 추출(최대 MAX_TRANSCRIBE_SEC). */
async function pcm16kFloat(sourcePath: string): Promise<Float32Array> {
  const buf = await ffmpegCapture([
    '-hide_banner', '-loglevel', 'error',
    '-t', String(MAX_TRANSCRIBE_SEC),
    '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'
  ])
  const n = Math.floor(buf.length / 4)
  if (n === 0) return new Float32Array(0)
  // 4바이트 정렬이면 복사 없이 뷰(메모리 절약). Buffer.concat 결과는 보통 정렬됨.
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, n)
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4)
  return new Float32Array(ab)
}

/** 내장 모델로 전사. 사용 불가/실패 시 빈 배열. */
async function transcribeBuiltin(
  sourcePath: string,
  durationSec: number,
  onProgress?: (msg: string) => void
): Promise<Seg[]> {
  const asr = await getAsr(onProgress)
  if (!asr) return []
  let audio: Float32Array
  try {
    audio = await pcm16kFloat(sourcePath)
  } catch {
    return []
  }
  if (audio.length === 0) return []
  try {
    const out = await asr(audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 })
    const chunks = Array.isArray(out.chunks) ? out.chunks : []
    const segs: Seg[] = []
    for (const c of chunks) {
      const start = Number(c.timestamp?.[0])
      const endRaw = c.timestamp?.[1]
      const end = endRaw == null ? (durationSec > 0 ? durationSec : start + 2) : Number(endRaw)
      const text = typeof c.text === 'string' ? c.text.trim() : ''
      if (Number.isFinite(start) && text) segs.push({ start, end: Number.isFinite(end) ? end : start + 2, text })
    }
    return segs
  } catch {
    return []
  }
}

/** 전사: 내장(Transformers.js) 우선, 실패 시 설치된 whisper CLI 로 폴백. */
async function transcribe(
  sourcePath: string,
  whisperCmd: string | null,
  durationSec: number,
  dir: string,
  onProgress?: (msg: string) => void
): Promise<Seg[]> {
  const builtin = await transcribeBuiltin(sourcePath, durationSec, onProgress)
  if (builtin.length > 0) return builtin
  if (whisperCmd) return transcribeCli(sourcePath, whisperCmd, dir)
  return []
}

/** ffmpeg 로 16kHz 모노 wav 추출 → 설치된 whisper CLI 로 전사 → 세그먼트. 실패 시 빈 배열. */
async function transcribeCli(
  sourcePath: string,
  whisperCmd: string,
  dir: string
): Promise<Seg[]> {
  await mkdir(dir, { recursive: true })
  const wav = join(dir, 'audio.wav')
  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', wav
    ])
  } catch {
    return [] // 오디오 추출 실패 → 화면 분석으로 graceful fallback
  }
  // whisper 는 오디오 디코딩에 'ffmpeg'(시스템 PATH)를 호출한다. 번들 ffmpeg 폴더를
  // 자식 PATH 앞에 추가해 시스템 ffmpeg 미설치 환경에서도 동작하게 한다.
  const ff = ffmpegPath()
  const env = { ...process.env }
  // ff 가 실제 경로(구분자 포함)면 그 폴더를 PATH 앞에 추가. 'ffmpeg' 바레 이름이면 시스템 PATH 사용.
  if (ff && (ff.includes('\\') || ff.includes('/'))) {
    const sep = process.platform === 'win32' ? ';' : ':'
    env.PATH = `${dirname(ff)}${sep}${env.PATH ?? ''}`
  }
  // openai-whisper CLI: JSON 세그먼트 출력. (whisper.cpp 등 다른 포맷은 graceful 빈 배열)
  try {
    await execFileAsync(
      whisperCmd,
      [wav, '--model', 'small', '--output_format', 'json', '--output_dir', dir, '--fp16', 'False'],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 64, env }
    )
  } catch {
    return []
  }
  // 산출물: <dir>/audio.json
  for (const f of await readdir(dir)) {
    if (f.endsWith('.json') && f.startsWith('audio')) {
      try {
        return parseWhisperJson(await readFile(join(dir, f), 'utf-8'))
      } catch {
        return []
      }
    }
  }
  return []
}

/** 전사 세그먼트를 AI(텍스트)로 보내 하이라이트 구간을 고른다(AI가 시작~끝 직접 판단). */
async function analyzeTranscriptHighlights(
  provider: AiProvider,
  segments: { start: number; end: number; text: string }[],
  durationSec: number,
  dir: string,
  agentDoc: string
): Promise<{ ok: boolean; spawnError: boolean; hits: VisionHit[] }> {
  if (segments.length === 0) return { ok: true, spawnError: false, hits: [] }
  const lines = segments
    .map((s) => `[${s.start.toFixed(1)}~${s.end.toFixed(1)}초] ${s.text}`)
    .join('\n')
  const prompt = [
    agentDoc,
    '',
    '---',
    '',
    '아래는 영상의 음성을 전사한 대사/해설이다([시작~끝초] 텍스트).',
    lines,
    '',
    '위 지침의 "하이라이트 선별 기준"(음성)에 따라 하이라이트로 쓸 만한 구간만 골라,',
    'highlights 배열에 {startSec, endSec, score(0~1), reason(한국어 짧게)} 로 반환한다.',
    'startSec/endSec 는 그 하이라이트의 실제 시작~끝 시각(초). 짧으면 짧게, 길면 길게. 없으면 빈 배열.'
  ].join('\n')
  const res = await callProvider(provider, prompt, [], VISION_SCHEMA, dir, 't')
  if (res.spawnError) return { ok: false, spawnError: true, hits: [] }
  const arr = res.obj && Array.isArray((res.obj as { highlights?: unknown }).highlights)
    ? (res.obj as { highlights: RangeRaw[] }).highlights
    : []
  const dur = durationSec > 0 ? durationSec : Infinity
  const hits: VisionHit[] = []
  for (const h of arr) {
    const s = Math.max(0, Math.min(dur, numOr(h.startSec, NaN)))
    const e = Math.max(0, Math.min(dur, numOr(h.endSec, NaN)))
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      hits.push({ startSec: s, endSec: e, score: clamp01(numOr(h.score, 0.5)), reason: String(h.reason || '') })
    }
  }
  return { ok: true, spawnError: false, hits }
}

interface RangeRaw { startSec: number; endSec: number; score: number; reason: string }

/**
 * 화면(vision) + 음성(audio) 히트를 융합해 하이라이트 구간을 만든다(순수, 테스트 대상).
 * - 길이는 AI가 준 [startSec,endSec]를 사용(고정 여유 없음). 작은 패딩·최소 길이만 보정.
 * - 겹치는 구간은 병합. 화면·음성이 시간상 겹치면 점수 부스트(+0.25).
 */
const FUSE_PAD = 0.3 // 잘림 방지용 최소 패딩(초)
const FUSE_MIN_DUR = 1.2 // 너무 짧은 클립 방지 최소 길이(초)

export function fuseHits(
  visionHits: VisionHit[],
  audioHits: VisionHit[],
  opts: { durationSec: number; maxClips: number }
): HighlightSegment[] {
  const dur = opts.durationSec > 0 ? opts.durationSec : 0
  const cap = (v: number): number => (dur > 0 ? Math.min(dur, Math.max(0, v)) : Math.max(0, v))
  type Tagged = { inSec: number; outSec: number; score: number; reason: string; src: 'v' | 'a' }
  const all: Tagged[] = [
    ...visionHits.map((h) => ({ ...h, src: 'v' as const })),
    ...audioHits.map((h) => ({ ...h, src: 'a' as const }))
  ]
    .map((h) => {
      let inSec = cap(h.startSec - FUSE_PAD)
      let outSec = cap(h.endSec + FUSE_PAD)
      if (outSec - inSec < FUSE_MIN_DUR) {
        const c = (inSec + outSec) / 2
        inSec = cap(c - FUSE_MIN_DUR / 2)
        outSec = cap(inSec + FUSE_MIN_DUR)
      }
      return { inSec, outSec, score: h.score, reason: h.reason, src: h.src }
    })
    .sort((a, b) => a.inSec - b.inSec)
  if (all.length === 0) return []

  // 겹치는 구간 병합(기여 히트의 시각·소스 보관).
  type Build = { inSec: number; outSec: number; hits: Tagged[] }
  const merged: Build[] = []
  for (const h of all) {
    const prev = merged[merged.length - 1]
    if (prev && h.inSec <= prev.outSec) {
      prev.outSec = Math.max(prev.outSec, h.outSec)
      prev.hits.push(h)
    } else {
      merged.push({ inSec: h.inSec, outSec: h.outSec, hits: [h] })
    }
  }

  const segs: HighlightSegment[] = merged.map((m) => {
    const baseScore = Math.max(...m.hits.map((h) => h.score))
    const hasV = m.hits.some((h) => h.src === 'v')
    const hasA = m.hits.some((h) => h.src === 'a')
    // 화면·음성 히트가 시간상 겹치면(같은 순간 동의) 부스트.
    let agree = false
    if (hasV && hasA) {
      const vs = m.hits.filter((h) => h.src === 'v')
      const as = m.hits.filter((h) => h.src === 'a')
      agree = vs.some((v) => as.some((a) => v.inSec < a.outSec && a.inSec < v.outSec))
    }
    const reasons: string[] = []
    for (const h of m.hits) if (h.reason && !reasons.includes(h.reason)) reasons.push(h.reason)
    const tag = agree ? '🎬+🎙 ' : hasA && !hasV ? '🎙 ' : hasV && !hasA ? '🎬 ' : '🎬🎙 '
    return {
      inSec: m.inSec,
      outSec: m.outSec,
      score: agree ? clamp01(baseScore + 0.25) : baseScore,
      reason: tag + reasons.join(' · ')
    }
  })
  // maxClips<=0 이면 무제한(AI가 고른 만큼 전부). >0 이면 강도순 상위 N개.
  const ranked = segs.sort((a, b) => b.score - a.score)
  const picked = opts.maxClips > 0 ? ranked.slice(0, opts.maxClips) : ranked
  return picked.sort((a, b) => a.inSec - b.inSec)
}

/** 한 번의 ffmpeg 패스로 intervalSec 간격 프레임을 축소 추출. */
async function extractFrames(
  sourcePath: string,
  intervalSec: number,
  maxFrames: number,
  outDir: string
): Promise<{ path: string; timeSec: number }[]> {
  await mkdir(outDir, { recursive: true })
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourcePath,
    '-vf', `fps=1/${intervalSec},scale=512:-2`,
    '-frames:v', String(maxFrames),
    '-q:v', '5',
    join(outDir, 'f_%05d.jpg')
  ])
  const files = (await readdir(outDir))
    .filter((f) => f.startsWith('f_') && f.endsWith('.jpg'))
    .sort()
  // fps 필터의 i번째 프레임 ≈ i*interval (+반간격 보정).
  return files.map((f, i) => ({ path: join(outDir, f), timeSec: i * intervalSec + intervalSec / 2 }))
}

// 하이라이트 히트 = AI가 직접 판단한 구간[startSec, endSec].
interface VisionHit { startSec: number; endSec: number; score: number; reason: string }

/** 비전 호출(이미지 배치 → highlights). provider 별 어댑터 사용. */
async function visionBatch(
  provider: AiProvider,
  images: { path: string; timeSec: number }[],
  prompt: string,
  dir: string,
  tag: string
): Promise<{ ok: boolean; spawnError: boolean; error?: string; highlights: RangeRaw[] }> {
  const res = await callProvider(provider, prompt, images.map((im) => im.path), VISION_SCHEMA, dir, `v${tag}`)
  if (res.spawnError) return { ok: false, spawnError: true, highlights: [] }
  if (res.error) return { ok: false, spawnError: false, error: res.error, highlights: [] }
  const arr = res.obj && Array.isArray((res.obj as { highlights?: unknown }).highlights)
    ? ((res.obj as { highlights: RangeRaw[] }).highlights)
    : []
  return { ok: true, spawnError: false, highlights: arr }
}

/** AI 자동 하이라이트: (음성 전사 + 화면 비전) 융합 → 구간. */
export async function analyzeHighlightsVision(
  req: VisionHighlightRequest,
  onProgress?: (p: VisionProgress) => void
): Promise<{ segments: HighlightSegment[]; error?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'clipreel-vis-'))
  try {
    const dur = req.durationSec > 0 ? req.durationSec : 0
    const agentDoc = await getAgentDoc()

    // ① 음성 전사(선택) → 전사 하이라이트. 내장(Transformers.js) 우선, 없으면 whisper CLI.
    const audioHits: VisionHit[] = []
    if (req.useAudio) {
      onProgress?.({ stage: 'transcribe', current: 0, total: 1, message: '음성 전사 중…' })
      const segments = await transcribe(
        req.sourcePath,
        req.whisperCmd,
        dur,
        join(dir, 'stt'),
        (msg) => onProgress?.({ stage: 'transcribe', current: 0, total: 1, message: msg })
      )
      if (segments.length > 0) {
        onProgress?.({ stage: 'analyze', current: 0, total: 1, message: '대사 분석 중…' })
        const tr = await analyzeTranscriptHighlights(req.provider, segments, dur, dir, agentDoc)
        if (!tr.spawnError) audioHits.push(...tr.hits)
      }
    }

    // ② 화면 비전 — 샘플링 촘촘하게(긴 영상도 1~2초 간격), 배치를 키워 호출 수 억제.
    const cap = req.mode === 'fast' ? 120 : 320
    const baseInterval = req.mode === 'fast' ? 2 : 1
    // 영상이 길면 간격을 늘려 cap 안에서 전체를 고르게 커버.
    const interval = dur > 0 ? Math.max(baseInterval, dur / cap) : baseInterval

    onProgress?.({ stage: 'extract', current: 0, total: 1, message: '프레임 추출 중…' })
    const frames = await extractFrames(req.sourcePath, interval, cap, join(dir, 'frames'))
    if (frames.length === 0 && audioHits.length === 0) {
      return { segments: [], error: '프레임을 추출하지 못했습니다.' }
    }

    const BATCH = 16
    const batches = Math.ceil(frames.length / BATCH)
    const visionHits: VisionHit[] = []
    for (let b = 0; b < batches; b++) {
      const batch = frames.slice(b * BATCH, (b + 1) * BATCH)
      onProgress?.({ stage: 'analyze', current: b + 1, total: batches, message: `화면 분석 ${b + 1}/${batches}` })
      const tsList = batch.map((f) => `${f.timeSec.toFixed(1)}초`).join(', ')
      const winStart = Math.max(0, batch[0].timeSec - interval)
      const winEnd = (dur > 0 ? Math.min(dur, batch[batch.length - 1].timeSec + interval) : batch[batch.length - 1].timeSec + interval)
      const prompt = [
        agentDoc,
        '',
        '---',
        '',
        '아래 이미지들은 한 게임 영상에서 시간 순서로 추출한 프레임이다.',
        `각 프레임의 시각(초): ${tsList}`,
        '위 지침의 "하이라이트 선별 기준"에 따라 하이라이트 구간을 골라,',
        'highlights 배열에 {startSec, endSec, score(0~1), reason(한국어로 짧게)} 로 반환한다.',
        'startSec/endSec 는 그 하이라이트의 실제 시작~끝 시각(초)이다. 짧은 순간은 짧게, 긴 교전은',
        `길게 잡되 이 묶음의 시간 범위(${winStart.toFixed(1)}~${winEnd.toFixed(1)}초) 안에서. 평범/정적 구간은 제외. 없으면 빈 배열.`
      ].join('\n')
      const res = await visionBatch(req.provider, batch, prompt, dir, String(b))
      if (res.spawnError) {
        return { segments: [], error: `${req.provider} CLI 를 실행하지 못했습니다(설치/로그인 확인).` }
      }
      if (res.error) {
        return { segments: [], error: res.error }
      }
      for (const h of res.highlights) {
        // AI 가 준 구간을 이 묶음 시간 범위로 클램프(환각 방지).
        const s = Math.max(winStart, Math.min(winEnd, numOr(h.startSec, NaN)))
        const e = Math.max(winStart, Math.min(winEnd, numOr(h.endSec, NaN)))
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
          visionHits.push({ startSec: s, endSec: e, score: clamp01(numOr(h.score, 0.5)), reason: String(h.reason || '') })
        }
      }
    }

    // ③ 융합
    onProgress?.({ stage: 'fuse', current: 1, total: 1, message: '결과 합치는 중…' })
    const top = fuseHits(visionHits, audioHits, {
      durationSec: dur,
      maxClips: req.maxClips
    })
    onProgress?.({ stage: 'done', current: 1, total: 1, message: `하이라이트 ${top.length}곳` })
    return { segments: top }
  } catch (e) {
    return { segments: [], error: e instanceof Error ? e.message : String(e) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── ③ 자연어 편집(codex) ──

const CHAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['explanation', 'ops'],
  properties: {
    explanation: { type: 'string' },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'clipId', 'trackId', 'valueSec', 'speed'],
        properties: {
          op: {
            type: 'string',
            enum: ['trimLeft', 'trimRight', 'remove', 'rippleDelete', 'move', 'split', 'setSpeed']
          },
          clipId: { type: ['string', 'null'] },
          trackId: { type: ['string', 'null'] },
          valueSec: { type: ['number', 'null'] },
          speed: { type: ['number', 'null'] }
        }
      }
    }
  }
} as const

function buildPrompt(req: ChatEditRequest, agentDoc: string): string {
  const rows = req.clips
    .map(
      (c) =>
        `- id=${c.id} track=${c.track} start=${c.startSec.toFixed(2)}s dur=${c.durSec.toFixed(
          2
        )}s end=${(c.startSec + c.durSec).toFixed(2)}s peak=${
          c.peakScore == null ? 'n/a' : c.peakScore.toFixed(2)
        }`
    )
    .join('\n')
  return [
    agentDoc,
    '',
    '---',
    '',
    '현재 타임라인 클립 목록(시간은 타임라인 절대초):',
    rows || '(클립 없음)',
    '',
    `사용자 지시: ${req.instruction}`
  ].join('\n')
}

/** AI(provider)로 자연어 → EditOp[]. 미설치/실패 시 error 채워 반환. */
export async function chatEdit(req: ChatEditRequest): Promise<ChatEditResult> {
  const provider = req.provider ?? 'codex'
  const dir = await mkdtemp(join(tmpdir(), 'clipreel-ai-'))
  try {
    const prompt = buildPrompt(req, await getAgentDoc())
    const res = await callProvider(provider, prompt, [], CHAT_SCHEMA, dir, 'chat')
    if (res.spawnError) {
      return { ops: [], explanation: '', error: `${provider} CLI 를 실행하지 못했습니다(설치/로그인 확인).` }
    }
    if (res.error) {
      return { ops: [], explanation: '', error: res.error }
    }
    if (!res.obj) {
      return { ops: [], explanation: '', error: 'AI 응답을 해석하지 못했습니다.' }
    }
    const ops = Array.isArray(res.obj.ops) ? (res.obj.ops as EditOp[]) : []
    const explanation = typeof res.obj.explanation === 'string' ? res.obj.explanation : ''
    return { ops, explanation }
  } catch (e) {
    return { ops: [], explanation: '', error: e instanceof Error ? e.message : String(e) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

interface CodexRun {
  stdout: string
  stderr: string
  code: number | null
  spawnError: boolean
}

// CLI 존재 여부 캐시(where/which).
const _cmdCache = new Map<string, boolean>()
async function cmdExists(name: string): Promise<boolean> {
  const cached = _cmdCache.get(name)
  if (cached !== undefined) return cached
  const which = process.platform === 'win32' ? 'where' : 'which'
  let ok = false
  try {
    await execFileAsync(which, [name], { windowsHide: true })
    ok = true
  } catch {
    ok = false
  }
  _cmdCache.set(name, ok)
  return ok
}
/**
 * CLI 실행(범용). npm 글로벌(.cmd: codex/gemini)은 Windows 에서 cmd.exe 를 거쳐야 하고,
 * claude(.exe)는 직접 실행된다. shell 문자열을 조립하지 않고 인자 배열(shell:false)로 넘겨
 * 따옴표/메타문자 주입을 막는다. 프롬프트는 stdin 으로 전달.
 */
function runCli(cmdName: string, args: string[], cwd: string, promptStdin: string): Promise<CodexRun> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const isWin = process.platform === 'win32'
    // Windows 에선 .cmd/.exe 구분 없이 cmd.exe 를 거쳐 PATHEXT 로 해석(npm shim 도 안전).
    const file = isWin ? process.env.ComSpec || 'cmd.exe' : cmdName
    const spawnArgs = isWin ? ['/d', '/s', '/c', cmdName, ...args] : args
    let proc
    try {
      proc = spawn(file, spawnArgs, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve({ stdout: '', stderr: '', code: null, spawnError: true })
      return
    }
    const timer = setTimeout(() => {
      proc.kill()
    }, 240000)
    proc.on('error', () => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: null, spawnError: true })
    })
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, spawnError: false })
    })
    try {
      proc.stdin?.write(promptStdin)
      proc.stdin?.end()
    } catch {
      /* stdin 쓰기 실패는 close 에서 처리 */
    }
  })
}

/** codex 전용 래퍼(기존 호출부 호환). */
function runCodex(args: string[], cwd: string, promptStdin: string): Promise<CodexRun> {
  return runCli('codex', args, cwd, promptStdin)
}

/** claude -p --output-format json 의 결과(.result)에서 모델 텍스트를 꺼낸다. */
function claudeResultText(stdout: string): string {
  try {
    const env = JSON.parse(stdout) as { result?: unknown }
    if (typeof env.result === 'string') return env.result
  } catch {
    /* 엔벨로프 파싱 실패 → 원문 사용 */
  }
  return stdout
}

/** gemini -o json 의 결과(.response)에서 모델 텍스트를 꺼낸다. */
function geminiResultText(stdout: string): string {
  try {
    const env = JSON.parse(stdout) as { response?: unknown }
    if (typeof env.response === 'string') return env.response
  } catch {
    /* 실패 → 원문 사용 */
  }
  return stdout
}

interface ProviderJson { ok: boolean; spawnError: boolean; obj: Record<string, unknown> | null; error?: string }

/**
 * 이미지(선택)+프롬프트를 provider 에 보내 JSON 오브젝트를 받는다.
 * - codex: -i 이미지 + --output-schema(strict)
 * - claude: 프롬프트에 이미지 경로 명시 → Read 로 읽음, --output-format json
 * - gemini: 프롬프트에 @경로 → 멀티모달, -o json
 */
async function callProvider(
  provider: AiProvider,
  prompt: string,
  imagePaths: string[],
  schema: object,
  dir: string,
  tag: string
): Promise<ProviderJson> {
  if (provider === 'claude') {
    const refs = imagePaths.length
      ? '\n\n다음 이미지 파일들을 읽어서 분석하라(인덱스=경로):\n' +
        imagePaths.map((p, i) => `${i}=${p}`).join('\n')
      : ''
    const full = `${prompt}${refs}\n\n반드시 JSON 객체 하나만 출력하라. 다른 설명 금지.`
    const { stdout, stderr, code, spawnError } = await runCli(
      'claude',
      ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'],
      dir,
      full
    )
    if (spawnError) return { ok: false, spawnError: true, obj: null }
    if (code !== 0) return { ok: false, spawnError: false, obj: null, error: cliError('claude', code, stderr) }
    const obj = extractJson(claudeResultText(stdout)) as Record<string, unknown> | null
    return { ok: true, spawnError: false, obj }
  }
  if (provider === 'gemini') {
    const refs = imagePaths.map((p) => `@${p}`).join(' ')
    const full = `${refs}\n${prompt}\n\n반드시 JSON 객체 하나만 출력하라. 다른 설명 금지.`
    // Gemini CLI 는 2026-06 종료 → Antigravity CLI(agy)로 대체. agy 있으면 우선 사용.
    const useAgy = await cmdExists('agy')
    if (useAgy) {
      // agy 비대화형: --prompt(문서화된 플래그). 자동화는 승인 프리셋 필요. 이미지/JSON 헤드리스는
      // 미문서라 프롬프트에 경로를 넣고 출력에서 JSON 을 느슨하게 추출(best-effort, 미검증).
      const { stdout, stderr, code, spawnError } = await runCli(
        'agy',
        ['--prompt', full, '--permission', 'always-proceed'],
        dir,
        ''
      )
      if (spawnError) return { ok: false, spawnError: true, obj: null }
      if (code !== 0) return { ok: false, spawnError: false, obj: null, error: cliError('agy', code, stderr) }
      const obj = extractJson(stdout) as Record<string, unknown> | null
      return { ok: true, spawnError: false, obj }
    }
    // 레거시 gemini CLI 폴백. -p 는 값 1개(nargs:1) → 짧은 지시를 -p 값, 본문은 stdin.
    const { stdout, stderr, code, spawnError } = await runCli(
      'gemini',
      ['-p', '위 입력을 분석해 JSON 객체 하나만 출력하라.', '-o', 'json', '--skip-trust'],
      dir,
      full
    )
    if (spawnError) return { ok: false, spawnError: true, obj: null }
    if (code !== 0) return { ok: false, spawnError: false, obj: null, error: cliError('gemini', code, stderr) }
    const obj = extractJson(geminiResultText(stdout)) as Record<string, unknown> | null
    return { ok: true, spawnError: false, obj }
  }
  // codex
  const schemaPath = join(dir, `sch_${tag}.json`)
  const lastPath = join(dir, `last_${tag}.txt`)
  await writeFile(schemaPath, JSON.stringify(schema), 'utf-8')
  const imgArgs: string[] = []
  for (const p of imagePaths) imgArgs.push('-i', p)
  const args = ['exec', '--skip-git-repo-check', ...imgArgs, '--output-schema', schemaPath, '--output-last-message', lastPath, '-']
  const { stdout, stderr, code, spawnError } = await runCodex(args, dir, prompt)
  if (spawnError) return { ok: false, spawnError: true, obj: null }
  if (code !== 0) return { ok: false, spawnError: false, obj: null, error: cliError('codex', code, stderr) }
  let raw = ''
  try { raw = await readFile(lastPath, 'utf-8') } catch { raw = stdout }
  const obj = (extractJson(raw) ?? extractJson(stdout)) as Record<string, unknown> | null
  return { ok: true, spawnError: false, obj }
}

/** 실행은 됐으나 비정상 종료한 CLI 의 사용자용 에러 메시지(인증/쿼터/플래그 등). */
function cliError(name: string, code: number | null, stderr: string): string {
  const tail = (stderr || '').trim().split('\n').slice(-3).join(' ').slice(-300)
  return `${name} 실행 실패(code ${code ?? '?'}): ${tail || '로그인/쿼터/권한을 확인하세요.'}`
}

/** provider 에 프롬프트를 보내 자유 텍스트(마크다운 등) 응답을 받는다. */
async function callProviderText(
  provider: AiProvider,
  prompt: string,
  dir: string
): Promise<{ text: string; spawnError: boolean; error?: string }> {
  if (provider === 'claude') {
    const { stdout, stderr, code, spawnError } = await runCli(
      'claude', ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'], dir, prompt
    )
    if (spawnError) return { text: '', spawnError: true }
    if (code !== 0) return { text: '', spawnError: false, error: cliError('claude', code, stderr) }
    return { text: claudeResultText(stdout), spawnError: false }
  }
  if (provider === 'gemini') {
    const useAgy = await cmdExists('agy')
    if (useAgy) {
      const { stdout, stderr, code, spawnError } = await runCli('agy', ['--prompt', prompt, '--permission', 'always-proceed'], dir, '')
      if (spawnError) return { text: '', spawnError: true }
      if (code !== 0) return { text: '', spawnError: false, error: cliError('agy', code, stderr) }
      return { text: stdout, spawnError: false }
    }
    const { stdout, stderr, code, spawnError } = await runCli('gemini', ['-p', '아래 입력을 처리하라.', '-o', 'json', '--skip-trust'], dir, prompt)
    if (spawnError) return { text: '', spawnError: true }
    if (code !== 0) return { text: '', spawnError: false, error: cliError('gemini', code, stderr) }
    return { text: geminiResultText(stdout), spawnError: false }
  }
  // codex — 스키마 없이 마지막 메시지 텍스트.
  const lastPath = join(dir, 'gen_last.txt')
  const { stdout, stderr, code, spawnError } = await runCodex(
    ['exec', '--skip-git-repo-check', '--output-last-message', lastPath, '-'], dir, prompt
  )
  if (spawnError) return { text: '', spawnError: true }
  if (code !== 0) return { text: '', spawnError: false, error: cliError('codex', code, stderr) }
  let raw = ''
  try { raw = await readFile(lastPath, 'utf8') } catch { raw = stdout }
  return { text: raw, spawnError: false }
}

/** 코드펜스(```...```)로 감싸진 경우 안쪽만 추출. */
function stripFence(s: string): string {
  const m = s.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/)
  return (m ? m[1] : s).trim()
}

/** 게임 설명을 받아 현재 지침을 그 게임에 맞게 AI가 다시 작성. (UI 미리보기 후 저장) */
export async function generateInstructions(
  provider: AiProvider,
  gameDescription: string,
  currentDoc: string
): Promise<{ text: string; error?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'clipreel-instr-'))
  try {
    const prompt = [
      '너는 게임 영상 편집기의 설정 도우미다. 아래 "현재 작업지시 문서"의 전체 구조·규칙·말투는 그대로 유지하되,',
      '사용자가 알려준 게임에 맞게 특히 "하이라이트 선별 기준" 섹션을 그 게임의 특성에 맞춰 구체적으로 보강·수정하라.',
      '- 그 게임에서 무엇이 하이라이트인지(고유 이벤트/용어/UI 신호), 화면·음성에서 어떻게 알아보는지 구체적으로.',
      '- "절대 제외"에 그 게임의 비하이라이트(로비/상점/리스폰 등)를 반영.',
      '- 비파괴/실제 ID/JSON 출력/startSec·endSec 구간 반환 등 기존 규칙은 절대 바꾸지 말 것.',
      '출력은 수정된 마크다운 문서 "전문"만. 설명·코드펜스 없이 문서 자체만 출력한다.',
      '',
      `대상 게임: ${gameDescription}`,
      '',
      '현재 작업지시 문서:',
      currentDoc
    ].join('\n')
    const r = await callProviderText(provider, prompt, dir)
    if (r.spawnError) return { text: '', error: `${provider} CLI 를 실행하지 못했습니다(설치/로그인 확인).` }
    if (r.error) return { text: '', error: r.error }
    const text = stripFence(r.text)
    if (!text || text.length < 40) return { text: '', error: 'AI 응답이 비었습니다. 다시 시도해 주세요.' }
    return { text }
  } catch (e) {
    return { text: '', error: e instanceof Error ? e.message : String(e) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 문자열에서 마지막 최상위 JSON 오브젝트를 추출. */
function extractJson(s: string): { ops?: unknown; explanation?: unknown } | null {
  if (!s) return null
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  for (let i = start; i < s.length; i++) {
    if (s[i] !== '{') continue
    try {
      return JSON.parse(s.slice(i, end + 1))
    } catch {
      /* 다음 후보 */
    }
  }
  return null
}
