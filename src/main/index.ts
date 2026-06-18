// Electron 메인 엔트리. 윈도우 생성 + media:// 프로토콜 등록 + IPC.

import { app, shell, BrowserWindow, protocol } from 'electron'
import { join, extname } from 'path'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { registerIpc } from './ipc'
import { isAllowed } from './mediaAccess'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm'
}

// media://<base64url(절대경로)> → 로컬 영상 스트리밍 (range 지원은 net.fetch 가 처리).
// 원본 파일은 읽기 전용으로만 접근.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

function decodeMediaUrl(url: string): string | null {
  try {
    // media://h/<b64url> 형태. host("h")는 더미이므로 pathname 에서만 추출.
    const u = new URL(url)
    const encoded = u.pathname.replace(/^\/+|\/+$/g, '')
    if (!encoded) return null
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
    return Buffer.from(b64 + pad, 'base64').toString('utf-8')
  } catch {
    return null
  }
}

function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    const filePath = decodeMediaUrl(request.url)
    if (!filePath) {
      return new Response('Bad media url', { status: 400 })
    }
    // 앱이 실제로 불러온 원본만 허용 (임의 로컬 파일 읽기 차단).
    if (!isAllowed(filePath)) {
      return new Response('Forbidden', { status: 403 })
    }
    // 명시적 Range 처리 → <video> 가 seekable 해짐(시킹/스크럽 정상).
    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const type = MIME[extname(filePath).toLowerCase()] ?? 'video/mp4'
    const range = request.headers.get('Range') || request.headers.get('range')

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1
      if (Number.isNaN(start)) start = 0
      if (Number.isNaN(end) || end >= size) end = size - 1
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const stream = createReadStream(filePath, { start, end })
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1)
        }
      })
    }

    const stream = createReadStream(filePath)
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size)
      }
    })
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#14161b',
    title: 'ClipReel',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 로컬 비디오 편집기 — 제스처 없이도 재생 허용(클립 경계 자동 전환 등).
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 개발: electron-vite dev 서버 / 프로덕션: 빌드된 html
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerMediaProtocol()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
