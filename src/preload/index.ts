// 렌더러에 노출되는 안전한 API (contextIsolation).

import { contextBridge, ipcRenderer } from 'electron'
import type { EnvStatus, Project, SourceClip } from '@shared/types'

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
  importFiles: (): Promise<SourceClip[]> => ipcRenderer.invoke('media:importFiles'),
  saveProject: (project: Project, forceDialog = false): Promise<Project | null> =>
    ipcRenderer.invoke('project:save', project, forceDialog),
  openProject: (): Promise<Project | null> => ipcRenderer.invoke('project:open'),
  exportRender: (project: Project): Promise<string | null> =>
    ipcRenderer.invoke('export:render', project),

  onExportProgress: (cb: (p: ExportProgressEvent) => void): (() => void) => {
    const listener = (_e: unknown, p: ExportProgressEvent): void => cb(p)
    ipcRenderer.on('export:progress', listener)
    return () => ipcRenderer.removeListener('export:progress', listener)
  },

  toMediaUrl
}

export type ClipReelApi = typeof api

contextBridge.exposeInMainWorld('clipreel', api)
