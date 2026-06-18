// 폴더 스캔 + ffprobe 메타 추출 → SourceClip[].

import { readdir } from 'fs/promises'
import { join, basename, extname } from 'path'
import { ffprobeJson } from './ffmpeg'
import type { SourceClip } from '@shared/types'

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.m4v'])

let _seq = 0
function nextId(prefix: string): string {
  _seq += 1
  return `${prefix}_${_seq}`
}

/** 분수 문자열("60/1") 또는 숫자를 fps 로 파싱. */
function parseFps(rate: unknown): number {
  if (typeof rate === 'number') return rate
  if (typeof rate !== 'string') return 0
  if (rate.includes('/')) {
    const [a, b] = rate.split('/').map(Number)
    if (b) return Math.round((a / b) * 1000) / 1000
    return 0
  }
  const n = Number(rate)
  return Number.isFinite(n) ? n : 0
}

async function probeOne(filePath: string): Promise<SourceClip> {
  const base: SourceClip = {
    id: nextId('src'),
    path: filePath,
    name: basename(filePath),
    durationSec: 0,
    fps: 0,
    resolution: '',
    audioStreams: 0
  }
  try {
    const info = await ffprobeJson(filePath)
    const streams: any[] = Array.isArray(info.streams) ? info.streams : []
    const video = streams.find((s) => s.codec_type === 'video')
    const audio = streams.filter((s) => s.codec_type === 'audio')

    const duration =
      Number(info.format?.duration) ||
      Number(video?.duration) ||
      0

    base.durationSec = Math.round(duration * 1000) / 1000
    base.fps = video ? parseFps(video.avg_frame_rate || video.r_frame_rate) : 0
    base.resolution = video ? `${video.width}x${video.height}` : ''
    base.audioStreams = audio.length
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err)
  }
  return base
}

/**
 * 폴더 안의 영상 파일을 스캔해 메타까지 채운 SourceClip 배열 반환.
 * 파일명 정렬(녹화 순서 근사). 하위 폴더는 보지 않음(v1).
 */
export async function scanFolder(folderPath: string): Promise<SourceClip[]> {
  const entries = await readdir(folderPath, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && VIDEO_EXT.has(extname(e.name).toLowerCase()))
    .map((e) => join(folderPath, e.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return probeFiles(files)
}

/** 지정한 파일 경로들(영상만)을 probe 해 SourceClip[] 반환. */
export async function probeFiles(filePaths: string[]): Promise<SourceClip[]> {
  const files = filePaths.filter((f) => VIDEO_EXT.has(extname(f).toLowerCase()))
  const out: SourceClip[] = []
  for (const f of files) {
    out.push(await probeOne(f))
  }
  return out
}
