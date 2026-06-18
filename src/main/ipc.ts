// 렌더러 ↔ 메인 IPC 핸들러 등록.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { scanFolder, probeFiles } from './media'
import { saveProject, loadProject } from './project'
import { ffmpegPath, ffprobePath, checkFfmpeg } from './ffmpeg'
import { allowPaths } from './mediaAccess'
import { exportMontage } from './export'
import type { EnvStatus, Project, SourceClip } from '@shared/types'

const execFileAsync = promisify(execFile)

/** codex CLI 존재 여부(향후 AI 기능용, 현재 UI 미사용). */
async function detectCodex(): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    await execFileAsync(cmd, ['codex'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

export function registerIpc(): void {
  // 환경 점검
  ipcMain.handle('env:check', async (): Promise<EnvStatus> => {
    const ffmpegOk = await checkFfmpeg()
    const codexFound = await detectCodex()
    return { ffmpegPath: ffmpegPath(), ffprobePath: ffprobePath(), ffmpegOk, codexFound }
  })

  // 폴더 선택 다이얼로그
  ipcMain.handle('dialog:openFolder', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = { title: '클립 폴더 선택', properties: ['openDirectory'] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // 폴더 스캔 → SourceClip[]
  ipcMain.handle('media:scanFolder', async (_e, folderPath: string) => {
    const sources = await scanFolder(folderPath)
    allowPaths(sources.map((s) => s.path))
    return sources
  })

  // 영상 파일 가져오기(여러 개 가능) → SourceClip[]
  ipcMain.handle('media:importFiles', async (e): Promise<SourceClip[]> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: '영상 가져오기',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '영상', extensions: ['mp4', 'mov', 'mkv', 'm4v'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return []
    const sources = await probeFiles(res.filePaths)
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
        const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
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
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const project = await loadProject(res.filePaths[0])
    allowPaths(project.sources.map((s) => s.path))
    return project
  })

  // 내보내기: 타임라인 → 단일 mp4 (저장 경로 다이얼로그 + 진행 이벤트)
  ipcMain.handle('export:render', async (e, project: Project): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.SaveDialogOptions = {
      title: '내보내기',
      defaultPath: `${project.name || 'montage'}.mp4`,
      filters: [{ name: 'MP4 비디오', extensions: ['mp4'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    const sender = e.sender
    return exportMontage(project, res.filePath, (p) => {
      if (!sender.isDestroyed()) sender.send('export:progress', p)
    })
  })
}
