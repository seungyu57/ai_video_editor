// 멀티트랙 타임라인 → 단일 1080p mp4.
// ① 비디오 트랙을 상위-우선 평탄화 → 영상-only 세그먼트 concat (gaps=검정)
// ② 오디오 트랙 클립들을 adelay(위치)+atempo(속도)+volume(게인) 후 amix 로 한 번에 믹스
// ③ 영상 + 믹스 오디오를 mux. (트랙 음소거/비활성 반영)

import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { runFfmpeg } from './ffmpeg'
import { flattenTimeline, sourceTimeAt, timelineDur } from '@shared/timeline'
import type { Project, SourceClip, TimelineClip } from '@shared/types'

export interface ExportProgress {
  stage: 'segment' | 'audio' | 'mux' | 'concat' | 'done'
  current: number
  total: number
  message: string
}

/** atempo 는 0.5~2.0 범위만 지원 → 범위 밖이면 체인으로 분해. */
function atempoChain(rate: number): string[] {
  const filters: string[] = []
  let r = rate
  while (r > 2.0) {
    filters.push('atempo=2.0')
    r /= 2.0
  }
  while (r < 0.5) {
    filters.push('atempo=0.5')
    r /= 0.5
  }
  filters.push(`atempo=${r.toFixed(4)}`)
  return filters
}

const VF_NORMALIZE =
  'scale=1920:1080:force_original_aspect_ratio=decrease,' +
  'pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1'

const ACODEC = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
const VCODEC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']

/** 소스 구간 → 정규화 영상-only 세그먼트(정수 프레임). */
async function renderVideoSegment(
  src: SourceClip,
  inSec: number,
  outSec: number,
  speed: number,
  fps: number,
  outPath: string
): Promise<void> {
  const trimDur = Math.max(0.02, outSec - inSec)
  const sp = speed > 0 ? speed : 1.0
  const outDur = Math.max(1, Math.round((trimDur / sp) * fps)) / fps
  let vf = VF_NORMALIZE
  if (sp !== 1.0) vf += `,setpts=${(1 / sp).toFixed(6)}*PTS`
  vf += `,fps=${fps}`
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', inSec.toFixed(4), '-t', (trimDur + 1 / fps).toFixed(4), '-i', src.path,
    '-an', '-vf', vf, '-map', '0:v:0', '-t', outDur.toFixed(4),
    ...VCODEC, '-r', String(fps), '-movflags', '+faststart', outPath
  ])
}

/** 검정 영상-only 세그먼트. */
async function renderBlackSegment(durSec: number, fps: number, outPath: string): Promise<void> {
  const outDur = Math.max(1, Math.round(durSec * fps)) / fps
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=1920x1080:r=${fps}`,
    '-an', '-t', outDur.toFixed(4),
    ...VCODEC, '-r', String(fps), '-movflags', '+faststart', outPath
  ])
}

/** 오디오 트랙 클립들을 위치/속도/게인 반영해 amix → 단일 오디오(총 길이). */
async function buildAudioMix(
  clips: TimelineClip[],
  sourceById: Map<string, SourceClip>,
  totalSec: number,
  outPath: string
): Promise<void> {
  const usable = clips.filter((c) => (sourceById.get(c.sourceId)?.audioStreams ?? 0) > 0)
  const inputs: string[] = []
  const filters: string[] = []
  const labels: string[] = []

  usable.forEach((c, i) => {
    const src = sourceById.get(c.sourceId)!
    const sp = c.speed > 0 ? c.speed : 1
    const trimDur = Math.max(0.02, c.outSec - c.inSec)
    inputs.push('-ss', c.inSec.toFixed(4), '-t', trimDur.toFixed(4), '-i', src.path)
    const chain: string[] = []
    if (sp !== 1) chain.push(...atempoChain(sp))
    const gain = c.gain ?? 1
    if (gain !== 1) chain.push(`volume=${gain.toFixed(3)}`)
    const delayMs = Math.max(0, Math.round(c.startSec * 1000))
    chain.push(`adelay=${delayMs}:all=1`)
    filters.push(`[${i}:a]${chain.join(',')}[a${i}]`)
    labels.push(`[a${i}]`)
  })

  let graph: string
  if (labels.length === 1) {
    graph = `${filters[0]};${labels[0]}apad,atrim=0:${totalSec.toFixed(4)}[aout]`
  } else {
    graph =
      filters.join(';') +
      `;${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[mx];` +
      `[mx]apad,atrim=0:${totalSec.toFixed(4)}[aout]`
  }

  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    '-filter_complex', graph,
    '-map', '[aout]', ...ACODEC, '-movflags', '+faststart', outPath
  ])
}

/** 타임라인을 단일 mp4 로 렌더. @returns 최종 출력 경로. */
export async function exportMontage(
  project: Project,
  outPath: string,
  onProgress?: (p: ExportProgress) => void
): Promise<string> {
  const fps = project.fps > 0 ? project.fps : 60
  const tracks = project.timeline.tracks
  const allClips = project.timeline.clips

  const videoTrackIds = new Set(tracks.filter((t) => t.kind === 'video').map((t) => t.id))
  const videoClips = allClips.filter((c) => videoTrackIds.has(c.trackId))
  const segs = flattenTimeline(videoClips, tracks, fps)
  if (segs.length === 0) throw new Error('내보낼 영상이 없습니다.')

  // 오디오: enabled & non-muted 오디오 트랙의 클립.
  const audioTrackIds = new Set(
    tracks.filter((t) => t.kind === 'audio' && t.enabled && !t.muted).map((t) => t.id)
  )
  const audioClips = allClips.filter((c) => audioTrackIds.has(c.trackId) && timelineDur(c) > 0)

  const sourceById = new Map(project.sources.map((s) => [s.id, s]))
  const tmpDir = join(app.getPath('temp'), `clipreel-render-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })

  try {
    // ① 영상-only 세그먼트
    const segPaths: string[] = []
    let total = 0
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const segPath = join(tmpDir, `seg_${String(i).padStart(4, '0')}.mp4`)
      const outDur = Math.max(1, Math.round((seg.endSec - seg.startSec) * fps)) / fps
      total += outDur
      onProgress?.({ stage: 'segment', current: i + 1, total: segs.length, message: `영상 세그 ${i + 1}/${segs.length}` })
      if (seg.clip) {
        const src = sourceById.get(seg.clip.sourceId)
        if (!src) throw new Error(`소스를 찾을 수 없음: ${seg.clip.sourceId}`)
        await renderVideoSegment(src, sourceTimeAt(seg.clip, seg.startSec), sourceTimeAt(seg.clip, seg.endSec), seg.clip.speed || 1, fps, segPath)
      } else {
        await renderBlackSegment(seg.endSec - seg.startSec, fps, segPath)
      }
      segPaths.push(segPath)
    }

    const listPath = join(tmpDir, 'concat.txt')
    await writeFile(
      listPath,
      segPaths.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf-8'
    )
    const videoOnly = join(tmpDir, 'video.mp4')
    onProgress?.({ stage: 'concat', current: segs.length, total: segs.length, message: '영상 이어붙이는 중…' })
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', videoOnly
    ])

    // ② 오디오 믹스 + ③ mux
    if (audioClips.length > 0) {
      const audioPath = join(tmpDir, 'audio.m4a')
      onProgress?.({ stage: 'audio', current: 0, total: 1, message: `오디오 ${audioClips.length}개 믹스 중…` })
      await buildAudioMix(audioClips, sourceById, total, audioPath)
      onProgress?.({ stage: 'mux', current: 0, total: 1, message: '영상+오디오 합치는 중…' })
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', videoOnly, '-i', audioPath,
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy',
        '-shortest', '-movflags', '+faststart', outPath
      ])
    } else {
      // 오디오 없음 → 무음 트랙 추가(호환성).
      onProgress?.({ stage: 'mux', current: 0, total: 1, message: '마무리 중…' })
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', videoOnly, '-f', 'lavfi', '-t', total.toFixed(4), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...ACODEC, '-shortest', '-movflags', '+faststart', outPath
      ])
    }

    onProgress?.({ stage: 'done', current: 1, total: 1, message: '완료' })
    return outPath
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
