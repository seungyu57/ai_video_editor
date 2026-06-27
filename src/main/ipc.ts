// 렌더러 ↔ 메인 IPC 핸들러 등록.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { scanFolder, probeFiles } from './media'
import { saveProject, loadProject } from './project'
import { ffmpegPath, ffprobePath, checkFfmpeg } from './ffmpeg'
import { allowPaths, isAllowed } from './mediaAccess'
import { exportMontage } from './export'
import {
  analyzeTrim,
  analyzeHighlights,
  analyzeHighlightsVision,
  chatEdit,
  detectWhisper,
  getInstructions,
  saveInstructions,
  resetInstructions,
  generateInstructions
} from './ai'
import type { EnvStatus, Project, SourceClip } from '@shared/types'
import type {
  AiProvider,
  ChatEditRequest,
  ChatEditResult,
  HighlightRequest,
  HighlightSegment,
  TrimAnalyzeItem,
  TrimSuggestion,
  VisionHighlightRequest
} from '@shared/ai-edit'

const execFileAsync = promisify(execFile)

/** 지정 CLI 가 PATH 에 있는지. */
async function detectCmd(name: string): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    await execFileAsync(cmd, [name], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

export function registerIpc(): void {
  // 환경 점검
  ipcMain.handle('env:check', async (): Promise<EnvStatus> => {
    const ffmpegOk = await checkFfmpeg()
    const [codexFound, agyFound, geminiLegacy, claudeFound, whisperCmd] = await Promise.all([
      detectCmd('codex'),
      detectCmd('agy'), // Antigravity CLI (Gemini CLI 후속)
      detectCmd('gemini'),
      detectCmd('claude'),
      detectWhisper()
    ])
    // 구글 provider 사용 가능 = Antigravity(agy) 설치됨. 레거시 gemini CLI 는 2026-06 종료라
    // 설치돼 있어도 '사용 가능'으로 치지 않는다(있으면 런타임 폴백으로만 시도).
    void geminiLegacy
    const geminiFound = agyFound
    return {
      ffmpegPath: ffmpegPath(),
      ffprobePath: ffprobePath(),
      ffmpegOk,
      codexFound,
      geminiFound,
      claudeFound,
      // 음성 분석은 내장(Transformers.js, 의존성 동봉)으로 항상 가능. CLI(whisperCmd)는 폴백.
      whisperFound: true,
      whisperCmd
    }
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

  // AI 트림: 선택 클립들의 앞/뒤 무음 절삭량 분석(ffmpeg, 오프라인)
  // 보안: 앱이 실제로 불러온 원본(allowlist)만 분석 — 임의 로컬 파일 읽기 차단.
  ipcMain.handle(
    'ai:analyzeTrim',
    async (_e, items: TrimAnalyzeItem[], padSec: number): Promise<TrimSuggestion[]> => {
      const safe = items.filter((it) => isAllowed(it.sourcePath))
      return analyzeTrim(safe, padSec)
    }
  )

  // AI 자동 하이라이트: 소스의 소리 피크 구간 검출(ffmpeg, 오프라인) — 레거시
  ipcMain.handle(
    'ai:autoHighlight',
    async (_e, req: HighlightRequest): Promise<HighlightSegment[]> => {
      if (!isAllowed(req.sourcePath)) throw new Error('허용되지 않은 경로입니다')
      return analyzeHighlights(req)
    }
  )

  // AI 비전 하이라이트: codex 가 프레임을 직접 보고 하이라이트 선별(진행 이벤트 전송)
  ipcMain.handle(
    'ai:visionHighlights',
    async (e, req: VisionHighlightRequest): Promise<{ segments: HighlightSegment[]; error?: string }> => {
      if (!isAllowed(req.sourcePath)) throw new Error('허용되지 않은 경로입니다')
      // 보안: 렌더러가 보낸 whisperCmd 는 신뢰하지 않고, 메인에서 직접 재탐지한 값만 사용.
      const whisperCmd = req.useAudio ? await detectWhisper() : null
      const safeReq = { ...req, whisperCmd }
      const sender = e.sender
      return analyzeHighlightsVision(safeReq, (p) => {
        if (!sender.isDestroyed()) sender.send('ai:visionProgress', p)
      })
    }
  )

  // AI 자연어 편집: codex 로 EditOp[] 생성(미설치 시 안내 반환)
  ipcMain.handle('ai:chatEdit', async (_e, req: ChatEditRequest): Promise<ChatEditResult> => {
    return chatEdit(req)
  })

  // AI 지침(ai-agent.md) 조회/저장/복원
  ipcMain.handle('ai:getInstructions', async () => getInstructions())
  ipcMain.handle('ai:saveInstructions', async (_e, text: string) => {
    await saveInstructions(text)
  })
  ipcMain.handle('ai:resetInstructions', async (): Promise<string> => resetInstructions())
  ipcMain.handle(
    'ai:generateInstructions',
    async (_e, gameDescription: string, currentDoc: string, provider: AiProvider) =>
      generateInstructions(provider, gameDescription, currentDoc)
  )

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
