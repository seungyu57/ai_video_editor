// AI 편집 백엔드(메인).
// ① 오디오 엔벨로프 분석(ffmpeg PCM) → 트림 포인트 / 하이라이트 피크 검출 (LLM 불필요·오프라인)
// ② 자연어 편집은 codex CLI 로 EditOp[] 생성 (--output-schema strict, 평면+nullable)
// 외부 의존성(codex)은 자동 설치하지 않는다. 없으면 사용자 안내만 반환.

import { spawn } from 'child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ffmpegCapture, runFfmpeg } from './ffmpeg'
import type {
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
        required: ['index', 'score', 'reason'],
        properties: {
          index: { type: 'integer' },
          score: { type: 'number' },
          reason: { type: 'string' }
        }
      }
    }
  }
} as const

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

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

interface VisionHit { timeSec: number; score: number; reason: string }

/** codex 비전 호출(이미지 배치 → highlights). */
async function codexVisionBatch(
  images: { path: string; timeSec: number }[],
  prompt: string,
  dir: string,
  tag: string
): Promise<{ ok: boolean; spawnError: boolean; highlights: { index: number; score: number; reason: string }[] }> {
  const schemaPath = join(dir, `vschema.json`)
  const lastPath = join(dir, `vlast_${tag}.txt`)
  await writeFile(schemaPath, JSON.stringify(VISION_SCHEMA), 'utf-8')
  const imgArgs: string[] = []
  for (const im of images) imgArgs.push('-i', im.path)
  const args = [
    'exec', '--skip-git-repo-check',
    ...imgArgs,
    '--output-schema', schemaPath,
    '--output-last-message', lastPath,
    '-'
  ]
  const { stdout, spawnError } = await runCodex(args, dir, prompt)
  if (spawnError) return { ok: false, spawnError: true, highlights: [] }
  let raw = ''
  try { raw = await readFile(lastPath, 'utf-8') } catch { raw = stdout }
  const parsed = extractJson(raw) ?? extractJson(stdout)
  const highlights = parsed && Array.isArray((parsed as { highlights?: unknown }).highlights)
    ? ((parsed as { highlights: { index: number; score: number; reason: string }[] }).highlights)
    : []
  return { ok: true, spawnError: false, highlights }
}

/** 비전 자동 하이라이트: 프레임 추출 → codex 분석 → 구간 병합. */
export async function analyzeHighlightsVision(
  req: VisionHighlightRequest,
  onProgress?: (p: VisionProgress) => void
): Promise<{ segments: HighlightSegment[]; error?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'clipreel-vis-'))
  try {
    const dur = req.durationSec > 0 ? req.durationSec : 0
    const cap = req.mode === 'fast' ? 80 : 200
    const baseInterval = req.mode === 'fast' ? 3 : 1
    // 영상이 길면 간격을 늘려 cap 안에서 전체를 고르게 커버.
    const interval = dur > 0 ? Math.max(baseInterval, dur / cap) : baseInterval

    onProgress?.({ stage: 'extract', current: 0, total: 1, message: '프레임 추출 중…' })
    const frames = await extractFrames(req.sourcePath, interval, cap, join(dir, 'frames'))
    if (frames.length === 0) return { segments: [], error: '프레임을 추출하지 못했습니다.' }

    const BATCH = 12
    const batches = Math.ceil(frames.length / BATCH)
    const hits: VisionHit[] = []
    for (let b = 0; b < batches; b++) {
      const batch = frames.slice(b * BATCH, (b + 1) * BATCH)
      onProgress?.({ stage: 'analyze', current: b + 1, total: batches, message: `AI 분석 ${b + 1}/${batches}` })
      const tsList = batch.map((f, i) => `${i}=${f.timeSec.toFixed(1)}초`).join(', ')
      const prompt = [
        '너는 게임 영상의 하이라이트 편집자다. 아래 이미지들은 한 게임 영상에서 시간 순서로 추출한 프레임이다.',
        `프레임 인덱스=시간: ${tsList}`,
        '킬, 교전, 클러치, 처치/승리 장면, 큰 리액션 등 "하이라이트"에 해당하는 프레임만 고른다.',
        '평범하거나 정적인(로비/대기/이동만) 프레임은 제외한다.',
        '각 하이라이트를 highlights 배열에 {index(프레임 번호), score(0~1 중요도), reason(한국어 짧게)} 로 반환.',
        '해당 없으면 빈 배열.'
      ].join('\n')
      const res = await codexVisionBatch(batch, prompt, dir, String(b))
      if (res.spawnError) {
        return {
          segments: [],
          error: 'codex CLI 를 찾지 못했습니다. 설치: npm i -g @openai/codex 후 codex login.'
        }
      }
      for (const h of res.highlights) {
        const f = batch[h.index]
        if (f) hits.push({ timeSec: f.timeSec, score: clamp01(Number(h.score) || 0.5), reason: String(h.reason || '') })
      }
    }

    if (hits.length === 0) return { segments: [] }

    // 히트 → 구간[ t-pre, t+post ], 시간순 정렬 후 겹치면 병합.
    hits.sort((a, b) => a.timeSec - b.timeSec)
    const pre = Math.max(0, req.preRollSec)
    const post = Math.max(0, req.postRollSec)
    const merged: HighlightSegment[] = []
    for (const h of hits) {
      const inSec = Math.max(0, h.timeSec - pre)
      const outSec = (dur > 0 ? Math.min(dur, h.timeSec + post) : h.timeSec + post)
      const prev = merged[merged.length - 1]
      if (prev && inSec <= prev.outSec) {
        prev.outSec = Math.max(prev.outSec, outSec)
        prev.score = Math.max(prev.score, h.score)
        if (h.reason && !prev.reason?.includes(h.reason)) prev.reason = prev.reason ? `${prev.reason} · ${h.reason}` : h.reason
      } else {
        merged.push({ inSec, outSec, score: h.score, reason: h.reason })
      }
    }
    // 강도순 상위 maxClips → 시간순.
    const top = merged.sort((a, b) => b.score - a.score).slice(0, Math.max(1, req.maxClips)).sort((a, b) => a.inSec - b.inSec)
    onProgress?.({ stage: 'done', current: batches, total: batches, message: `하이라이트 ${top.length}곳` })
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

function buildPrompt(req: ChatEditRequest): string {
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
    '너는 영상 편집기 ClipReel 의 편집 어시스턴트다. 사용자의 한국어 지시를 타임라인 편집 연산(EditOp) 목록으로 변환한다.',
    '',
    '현재 타임라인 클립 목록(시간은 타임라인 절대초):',
    rows || '(클립 없음)',
    '',
    '사용 가능한 op:',
    '- trimLeft: 클립 왼쪽 가장자리를 valueSec(타임라인 절대초)으로 트림(앞부분 자르기). clipId, valueSec 필요.',
    '- trimRight: 클립 오른쪽 가장자리를 valueSec 로 트림(뒷부분 자르기). clipId, valueSec 필요.',
    '- remove: 클립 삭제(공백 남김). clipId 필요.',
    '- rippleDelete: 클립 삭제 후 뒤 클립 당김. clipId 필요.',
    '- move: 클립을 valueSec(새 시작 위치)로 이동. clipId, valueSec, (선택)trackId.',
    '- split: 클립을 valueSec 위치에서 분할. clipId, valueSec 필요.',
    '- setSpeed: 배속 변경(예 2.0). clipId, speed 필요.',
    '',
    '규칙:',
    '- 반드시 위 목록의 실제 id 만 사용한다. 없는 id 를 지어내지 않는다.',
    '- 사용하지 않는 필드는 null 로 둔다.',
    '- 짧은 클립/조용한 클립 제거 같은 지시는 위 dur/peak 수치를 근거로 판단한다.',
    '- explanation 에는 무엇을 왜 바꿨는지 한국어 한두 문장.',
    '',
    `사용자 지시: ${req.instruction}`
  ].join('\n')
}

/** codex 로 자연어 → EditOp[]. codex 미설치/실패 시 error 채워 반환. */
export async function chatEdit(req: ChatEditRequest): Promise<ChatEditResult> {
  const dir = await mkdtemp(join(tmpdir(), 'clipreel-ai-'))
  const schemaPath = join(dir, 'schema.json')
  const lastPath = join(dir, 'last.txt')
  try {
    await writeFile(schemaPath, JSON.stringify(CHAT_SCHEMA), 'utf-8')
    const prompt = buildPrompt(req)
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      lastPath,
      '-'
    ]
    const { stdout, code, spawnError } = await runCodex(args, dir, prompt)
    if (spawnError) {
      return {
        ops: [],
        explanation: '',
        error:
          'codex CLI 를 찾지 못했습니다. 설치: npm i -g @openai/codex 후 codex login (자연어 편집에만 필요).'
      }
    }
    let raw = ''
    try {
      raw = await readFile(lastPath, 'utf-8')
    } catch {
      raw = stdout
    }
    const parsed = extractJson(raw) ?? extractJson(stdout)
    if (!parsed) {
      return { ops: [], explanation: '', error: `AI 응답을 해석하지 못했습니다(code ${code}).` }
    }
    const ops = Array.isArray(parsed.ops) ? (parsed.ops as EditOp[]) : []
    const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : ''
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
/**
 * codex CLI 실행. Windows 네이티브 spawn 은 확장자 없는 'codex'(.cmd 필요)를 실행하지 못하므로
 * shell 을 거쳐 해석한다. 경로 인자는 따옴표로 감싸고, 프롬프트는 stdin 으로 전달해
 * (개행/유니코드 escape 문제 회피) args 끝에는 '-'(stdin 에서 프롬프트 읽기)를 둔다.
 */
function runCodex(args: string[], cwd: string, promptStdin: string): Promise<CodexRun> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const quoted = args.map((a) => (a.startsWith('-') ? a : `"${a}"`)).join(' ')
    const command = `codex ${quoted}`
    let proc
    try {
      proc = spawn(command, { cwd, windowsHide: true, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve({ stdout: '', stderr: '', code: null, spawnError: true })
      return
    }
    const timer = setTimeout(() => {
      proc.kill()
    }, 180000)
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
    // 프롬프트를 stdin 으로 전달 후 종료.
    try {
      proc.stdin?.write(promptStdin)
      proc.stdin?.end()
    } catch {
      /* stdin 쓰기 실패는 close 에서 처리 */
    }
  })
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
