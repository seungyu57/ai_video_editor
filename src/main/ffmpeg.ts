// ffmpeg/ffprobe 경로 해석 + 실행 헬퍼.
// 우선순위: ffmpeg-static / ffprobe-static 번들 → 시스템 PATH.
// 외부 의존성은 자동 설치하지 않는다 (스펙 §0).

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'

const execFileAsync = promisify(execFile)

/**
 * asar 패키징 시 네이티브 바이너리 경로는 app.asar.unpacked 안에 있다.
 * ffmpeg-static / ffprobe-static 는 .exe 경로 문자열을 default export 한다.
 */
function unpacked(p: string | null | undefined): string | null {
  if (!p) return null
  // 패키징 환경에서 asar 내부 경로를 unpacked 로 치환
  const fixed = p.replace('app.asar', 'app.asar.unpacked')
  if (existsSync(fixed)) return fixed
  if (existsSync(p)) return p
  return null
}

function resolveFfmpeg(): string | null {
  try {
    // ffmpeg-static 는 경로 문자열을 default export
    const mod = require('ffmpeg-static') as string | { default?: string }
    const raw = typeof mod === 'string' ? mod : mod?.default
    const found = unpacked(raw)
    if (found) return found
  } catch {
    /* 모듈 없음 → PATH 탐지로 폴백 */
  }
  // 시스템 PATH 폴백 (존재 확인은 호출 시점에)
  return 'ffmpeg'
}

function resolveFfprobe(): string | null {
  try {
    const mod = require('ffprobe-static') as { path?: string } | string
    const raw = typeof mod === 'string' ? mod : mod?.path
    const found = unpacked(raw)
    if (found) return found
  } catch {
    /* 폴백 */
  }
  return 'ffprobe'
}

let _ffmpeg: string | null | undefined
let _ffprobe: string | null | undefined

export function ffmpegPath(): string | null {
  if (_ffmpeg === undefined) _ffmpeg = resolveFfmpeg()
  return _ffmpeg
}

export function ffprobePath(): string | null {
  if (_ffprobe === undefined) _ffprobe = resolveFfprobe()
  return _ffprobe
}

/** ffmpeg 실제 실행 가능 여부 확인 (버전 호출). */
export async function checkFfmpeg(): Promise<boolean> {
  const bin = ffmpegPath()
  if (!bin) return false
  try {
    await execFileAsync(bin, ['-version'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** ffprobe 로 JSON 메타 추출. */
export async function ffprobeJson(filePath: string): Promise<any> {
  const bin = ffprobePath()
  if (!bin) throw new Error('ffprobe 를 찾을 수 없습니다.')
  const { stdout } = await execFileAsync(
    bin,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 16 }
  )
  return JSON.parse(stdout)
}

/** ffmpeg stdout(바이너리)을 Buffer 로 캡처. 오디오 PCM 추출용. */
export async function ffmpegCapture(args: string[]): Promise<Buffer> {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg 를 찾을 수 없습니다.')
  const { spawn } = await import('child_process')
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(bin, args, { windowsHide: true })
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks))
      else reject(new Error(`ffmpeg 종료 코드 ${code}\n${stderr.slice(-2000)}`))
    })
  })
}

/** 임의 ffmpeg 인자 실행 (트림/concat/렌더 등에서 사용). */
export async function runFfmpeg(
  args: string[],
  onProgress?: (line: string) => void
): Promise<void> {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg 를 찾을 수 없습니다.')
  const { spawn } = await import('child_process')
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(bin, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr += s
      if (onProgress) onProgress(s)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`ffmpeg 종료 코드 ${code}\n${stderr.slice(-2000)}`))
    })
  })
}
