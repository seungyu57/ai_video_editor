// 렌더러에 노출되는 안전한 API (contextIsolation).

import { contextBridge, ipcRenderer } from 'electron'
import type {
  EditOp,
  EnvStatus,
  Project,
  ProjectSettings,
  SourceClip,
  TimelineClip
} from '@shared/types'

export interface CodexEditResult {
  ops: EditOp[]
  raw: string
  error?: string
}

export interface AnalyzeProgress {
  done: number
  total: number
}

export interface ExportProgressEvent {
  stage: 'segment' | 'concat' | 'done'
  current: number
  total: number
  message: string
}

/** 절대경로 → media:// URL (영상 태그 src 용). */
function toMediaUrl(filePath: string): string {
  const b64 = Buffer.from(filePath, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `media://h/${b64}`
}

const api = {
  checkEnv: (): Promise<EnvStatus> => ipcRenderer.invoke('env:check'),
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  scanFolder: (folderPath: string): Promise<SourceClip[]> =>
    ipcRenderer.invoke('media:scanFolder', folderPath),
  saveProject: (project: Project, forceDialog = false): Promise<Project | null> =>
    ipcRenderer.invoke('project:save', project, forceDialog),
  openProject: (): Promise<Project | null> => ipcRenderer.invoke('project:open'),

  // 자동 하이라이트 / 내보내기
  analyzeAuto: (
    sources: SourceClip[],
    settings: ProjectSettings,
    targetDurationSec: number
  ): Promise<TimelineClip[]> =>
    ipcRenderer.invoke('analyze:auto', sources, settings, targetDurationSec),
  analyzeTrim: (
    clips: TimelineClip[],
    sources: SourceClip[],
    settings: ProjectSettings
  ): Promise<TimelineClip[]> => ipcRenderer.invoke('analyze:trim', clips, sources, settings),
  analyzeSuggest: (
    source: SourceClip,
    settings: ProjectSettings
  ): Promise<{ inSec: number; outSec: number }> =>
    ipcRenderer.invoke('analyze:suggest', source, settings),
  exportRender: (project: Project): Promise<string | null> =>
    ipcRenderer.invoke('export:render', project),

  // Codex 대화형 편집
  requestEdits: (project: Project, message: string): Promise<CodexEditResult> =>
    ipcRenderer.invoke('codex:requestEdits', project, message),

  // 진행 이벤트 구독 (해제 함수 반환)
  onAnalyzeProgress: (cb: (p: AnalyzeProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: AnalyzeProgress): void => cb(p)
    ipcRenderer.on('analyze:progress', listener)
    return () => ipcRenderer.removeListener('analyze:progress', listener)
  },
  onExportProgress: (cb: (p: ExportProgressEvent) => void): (() => void) => {
    const listener = (_e: unknown, p: ExportProgressEvent): void => cb(p)
    ipcRenderer.on('export:progress', listener)
    return () => ipcRenderer.removeListener('export:progress', listener)
  },

  toMediaUrl
}

export type ClipReelApi = typeof api

contextBridge.exposeInMainWorld('clipreel', api)
