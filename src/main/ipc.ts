// 렌더러 ↔ 메인 IPC 핸들러 등록.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { scanFolder } from './media'
import { saveProject, loadProject } from './project'
import { ffmpegPath, ffprobePath, checkFfmpeg } from './ffmpeg'
import { detectCodex, requestEdits } from './codex'
import { allowPaths } from './mediaAccess'
import { autoHighlight, trimClips, suggestRegion } from './analyze'
import { exportMontage } from './export'
import type { EnvStatus, Project, ProjectSettings, SourceClip, TimelineClip } from '@shared/types'

export function registerIpc(): void {
  // 환경 점검 (ffmpeg / codex)
  ipcMain.handle('env:check', async (): Promise<EnvStatus> => {
    const ffmpegOk = await checkFfmpeg()
    const codexFound = await detectCodex()
    return {
      ffmpegPath: ffmpegPath(),
      ffprobePath: ffprobePath(),
      ffmpegOk,
      codexFound
    }
  })

  // 폴더 선택 다이얼로그
  ipcMain.handle('dialog:openFolder', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: '클립 폴더 선택',
      properties: ['openDirectory']
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // 폴더 스캔 → SourceClip[]
  ipcMain.handle('media:scanFolder', async (_e, folderPath: string) => {
    const sources = await scanFolder(folderPath)
    allowPaths(sources.map((s) => s.path))
    return sources
  })

  // 프로젝트 저장 (경로 미지정 시 다이얼로그)
  ipcMain.handle(
    'project:save',
    async (e, project: Project, forceDialog: boolean): Promise<Project | null> => {
      const win = BrowserWindow.fromWebContents(e.sender)
      let target = project.filePath
      if (!target || forceDialog) {
        const opts: Electron.SaveDialogOptions = {
          title: '프로젝트 저장',
          defaultPath: `${project.name || 'clipreel'}.clipreel`,
          filters: [{ name: 'ClipReel 프로젝트', extensions: ['clipreel'] }]
        }
        const res = win
          ? await dialog.showSaveDialog(win, opts)
          : await dialog.showSaveDialog(opts)
        if (res.canceled || !res.filePath) return null
        target = res.filePath
      }
      return saveProject(target, project)
    }
  )

  // 프로젝트 열기
  ipcMain.handle('project:open', async (e): Promise<Project | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: '프로젝트 열기',
      filters: [{ name: 'ClipReel 프로젝트', extensions: ['clipreel'] }],
      properties: ['openFile']
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const project = await loadProject(res.filePaths[0])
    allowPaths(project.sources.map((s) => s.path))
    return project
  })

  // 자동 하이라이트: 소스 분석 → 타임라인 클립(EDL) 생성
  ipcMain.handle(
    'analyze:auto',
    async (
      e,
      sources: SourceClip[],
      settings: ProjectSettings,
      targetDurationSec: number
    ) => {
      const sender = e.sender
      return autoHighlight(sources, settings, targetDurationSec, (done, total) => {
        if (!sender.isDestroyed()) sender.send('analyze:progress', { done, total })
      })
    }
  )

  // 기존 타임라인 클립을 재분석해 in/out 만 다듬기(드래그로 추가한 클립용)
  ipcMain.handle(
    'analyze:trim',
    async (e, clips: TimelineClip[], sources: SourceClip[], settings: ProjectSettings) => {
      const sender = e.sender
      return trimClips(clips, sources, settings, (done, total) => {
        if (!sender.isDestroyed()) sender.send('analyze:progress', { done, total })
      })
    }
  )

  // 단일 소스의 AI 추천 구간(원본 트림 바의 "AI 추천 적용"용)
  ipcMain.handle(
    'analyze:suggest',
    async (_e, source: SourceClip, settings: ProjectSettings) => {
      return suggestRegion(source, settings)
    }
  )

  // 내보내기: EDL → 단일 mp4 (저장 경로 다이얼로그 + 진행 이벤트)
  ipcMain.handle(
    'export:render',
    async (e, project: Project): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts: Electron.SaveDialogOptions = {
        title: '몽타주 내보내기',
        defaultPath: `${project.name || 'montage'}.mp4`,
        filters: [{ name: 'MP4 비디오', extensions: ['mp4'] }]
      }
      const res = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return null
      const sender = e.sender
      return exportMontage(project, res.filePath, (p) => {
        if (!sender.isDestroyed()) sender.send('export:progress', p)
      })
    }
  )

  // Codex 대화형 편집: 자연어 지시 → 편집연산 JSON(EditOp[])
  ipcMain.handle('codex:requestEdits', async (_e, project: Project, message: string) => {
    return requestEdits(project, message)
  })
}
