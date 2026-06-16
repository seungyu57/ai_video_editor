// 신호 ② AI 화면 판단 (스펙 §6.4, §11 M3, §13).
// 오디오 피크 주변 프레임을 추출해 codex 비전에 넘겨 "하이라이트로 좋은지/피크 보정/코멘트"를 받는다.
// 이미지 입력 경로가 막히거나 실패하면 null 을 반환해 호출부가 ①(오디오)만으로 graceful 하게 진행.

import { spawn } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runFfmpeg } from './ffmpeg'

export interface VisionVerdict {
  /** 하이라이트로 쓸 만한 순간인가 */
  good: boolean
  /** 중심 프레임 기준 피크 보정량(초). [-1.5, 1.5] 권장 */
  offsetSec: number
  /** 짧은 이유 코멘트 (예: "더블킬", "클러치 디퓨즈") */
  comment: string
}

/** 비전 호출 1건 시간 상한(ms). 초과 시 kill 하고 null 반환(graceful). */
const VISION_TIMEOUT_MS = 90_000

function visionSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      good: { type: 'boolean' },
      offsetSec: { type: 'number' },
      comment: { type: 'string' }
    },
    required: ['good', 'offsetSec', 'comment']
  }
}

/** 피크 주변 3프레임(t-1, t, t+1)을 jpg 로 추출. */
async function extractFrames(
  src: string,
  centerSec: number,
  durationSec: number,
  dir: string
): Promise<string[]> {
  const offsets = [-1, 0, 1]
  const maxT = Math.max(0, durationSec - 0.05)
  const paths: string[] = []
  for (let i = 0; i < offsets.length; i++) {
    const t = Math.max(0, Math.min(centerSec + offsets[i], maxT))
    const out = join(dir, `f${i}.jpg`)
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      t.toFixed(3),
      '-i',
      src,
      '-frames:v',
      '1',
      '-q:v',
      '4',
      '-vf',
      'scale=640:-2', // 토큰 절약 위해 축소
      out
    ])
    paths.push(out)
  }
  return paths
}

function runCodexImages(
  frames: string[],
  prompt: string,
  schemaPath: string,
  outPath: string
): Promise<string> {
  const isWin = process.platform === 'win32'
  const imgArgs = frames.map((f) => (isWin ? `-i "${f}"` : f))
  const command = isWin
    ? `codex exec --skip-git-repo-check -s read-only --color never ${imgArgs.join(
        ' '
      )} --output-schema "${schemaPath}" -o "${outPath}" -`
    : 'codex'
  const args = isWin
    ? []
    : [
        'exec',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '--color',
        'never',
        ...frames.flatMap((f) => ['-i', f]),
        '--output-schema',
        schemaPath,
        '-o',
        outPath,
        '-'
      ]
  return new Promise((resolvePromise, reject) => {
    const proc = isWin
      ? spawn(command, { shell: true, windowsHide: true })
      : spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: (v: never) => void, val: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ;(fn as (v: unknown) => void)(val)
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* 무시 */
      }
      finish(reject as never, new Error('codex 비전 호출 시간 초과'))
    }, VISION_TIMEOUT_MS)

    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    proc.on('error', (err) => finish(reject as never, err))
    proc.on('close', (code) =>
      code === 0
        ? finish(resolvePromise as never, stdout)
        : finish(reject as never, new Error(stderr.slice(-800)))
    )
    // codex 가 일찍 종료하면 stdin 에서 EPIPE 가 날 수 있음 → 무시(close 에서 처리).
    proc.stdin.on('error', () => {})
    try {
      proc.stdin.write(prompt)
      proc.stdin.end()
    } catch {
      /* close/error 핸들러가 처리 */
    }
  })
}

function parseVerdict(text: string): VisionVerdict | null {
  const tryParse = (s: string): VisionVerdict | null => {
    try {
      const o = JSON.parse(s)
      if (o && typeof o.good === 'boolean') {
        return {
          good: o.good,
          offsetSec: typeof o.offsetSec === 'number' ? o.offsetSec : 0,
          comment: typeof o.comment === 'string' ? o.comment : ''
        }
      }
      return null
    } catch {
      return null
    }
  }
  let v = tryParse(text.trim())
  if (v) return v
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    v = tryParse(text.slice(first, last + 1))
    if (v) return v
  }
  return null
}

/**
 * 한 클립의 피크 주변을 비전 판단. 실패/미지원 시 null (graceful).
 */
export async function judgeClip(
  src: string,
  peakSec: number,
  durationSec: number
): Promise<VisionVerdict | null> {
  // mkdtemp 실패조차 throw 되지 않도록 전부 try 안에서 처리(graceful).
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'clipreel-vision-'))
    const frames = await extractFrames(src, peakSec, durationSec, dir)
    const schemaPath = join(dir, 'vision.schema.json')
    const outPath = join(dir, 'verdict.txt')
    await writeFile(schemaPath, JSON.stringify(visionSchema(), null, 2), 'utf-8')
    const prompt = `너는 게임 하이라이트 편집 보조다. 첨부한 3장의 프레임은 한 게임 클립에서
t-1초, t초, t+1초(가운데가 t) 시점의 화면이다. 이 순간이 하이라이트 몽타주에 쓸 만한지 판단하라.

JSON 하나만 출력(설명/코드펜스 금지):
- good: 하이라이트로 쓸 만하면 true
- offsetSec: 더 좋은 순간이 가운데 기준 몇 초 앞/뒤인지(-1.5~1.5, 모르면 0)
- comment: 한국어 한 줄 이유(예: "더블킬", "클러치", 화면 근거). 모르면 ""`
    const stdout = await runCodexImages(frames, prompt, schemaPath, outPath)
    const raw = (await readFile(outPath, 'utf-8').catch(() => '')) || stdout
    return parseVerdict(raw)
  } catch {
    return null
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
