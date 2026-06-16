// EDL(TimelineClip[]) → 단일 1080p mp4 내보내기 (스펙 §6 마지막).
// 2-패스: ① 각 구간을 동일 규격(1920x1080/60fps/H264+AAC)으로 정규화 →
//         ② concat demuxer 로 무손실 이어붙이기. 전환효과 없음(단순 컷).
// 원본은 읽기 전용. 임시 파일만 생성 후 정리.

import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { runFfmpeg } from './ffmpeg'
import type { Project, SourceClip, TimelineClip } from '@shared/types'

export interface ExportProgress {
  stage: 'segment' | 'concat' | 'done'
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

/** 한 타임라인 클립 → 정규화된 중간 mp4 한 개 생성. */
async function renderSegment(
  clip: TimelineClip,
  src: SourceClip,
  outPath: string
): Promise<void> {
  // 소스에서 잘라낼 길이(trimDur)와 속도 적용 후 출력 길이(outDur)를 구분.
  const trimDur = Math.max(0.05, clip.outSec - clip.inSec)
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1.0
  const outDur = trimDur / speed
  const hasAudio = src.audioStreams > 0

  // 비디오 필터: 정규화 + (속도 변경 시 setpts) + cfr 60fps
  let vf = VF_NORMALIZE
  if (speed !== 1.0) vf += `,setpts=${(1 / speed).toFixed(6)}*PTS`
  vf += ',fps=60'

  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    // 입력 시킹 + 입력 길이 제한(소스 기준 trimDur) 후 재인코딩
    '-ss',
    clip.inSec.toFixed(3),
    '-t',
    trimDur.toFixed(3),
    '-i',
    src.path
  ]

  if (!hasAudio) {
    // 오디오 없는 소스 → 출력 길이(outDur)만큼 무음 트랙 생성(concat 규격 통일)
    args.push(
      '-f',
      'lavfi',
      '-t',
      outDur.toFixed(3),
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000'
    )
  }

  args.push('-vf', vf, '-map', '0:v:0')

  if (hasAudio) {
    args.push('-map', '0:a:0?')
    if (speed !== 1.0) {
      args.push('-af', atempoChain(speed).join(','))
    }
  } else {
    args.push('-map', '1:a:0')
  }

  // 비디오/오디오 길이 정렬
  args.push('-shortest')

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '60',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    outPath
  )

  await runFfmpeg(args)
}

/**
 * 프로젝트의 타임라인을 단일 mp4 로 렌더.
 * @returns 최종 출력 경로(= outPath)
 */
export async function exportMontage(
  project: Project,
  outPath: string,
  onProgress?: (p: ExportProgress) => void
): Promise<string> {
  const clips = [...project.timeline.clips].sort((a, b) => a.order - b.order)
  if (clips.length === 0) throw new Error('내보낼 클립이 없습니다.')

  const sourceById = new Map(project.sources.map((s) => [s.id, s]))
  const tmpDir = join(app.getPath('temp'), `clipreel-render-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })

  try {
    const segPaths: string[] = []
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      const src = sourceById.get(clip.sourceId)
      if (!src) throw new Error(`소스를 찾을 수 없음: ${clip.sourceId}`)
      const segPath = join(tmpDir, `seg_${String(i).padStart(4, '0')}.mp4`)
      onProgress?.({
        stage: 'segment',
        current: i + 1,
        total: clips.length,
        message: `컷 ${i + 1}/${clips.length} 렌더링: ${src.name}`
      })
      await renderSegment(clip, src, segPath)
      segPaths.push(segPath)
    }

    // concat demuxer 목록 파일.
    // Windows 역슬래시는 concat 파서에서 이스케이프 문자로 오인되므로 forward slash 로 정규화.
    const listPath = join(tmpDir, 'concat.txt')
    const listBody = segPaths
      .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n')
    await writeFile(listPath, listBody, 'utf-8')

    onProgress?.({
      stage: 'concat',
      current: clips.length,
      total: clips.length,
      message: '컷들을 이어붙이는 중…'
    })

    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      outPath
    ])

    onProgress?.({
      stage: 'done',
      current: clips.length,
      total: clips.length,
      message: '완료'
    })
    return outPath
  } finally {
    // 임시 파일 정리(실패해도 무시)
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
