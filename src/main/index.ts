// Electron 메인 엔트리. 윈도우 생성 + media:// 프로토콜 등록 + IPC.

import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { registerIpc } from './ipc'
import { isAllowed } from './mediaAccess'

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
    // net.fetch 로 file:// 을 가져오면 Range 헤더(영상 탐색)를 그대로 지원.
    const fileUrl = pathToFileURL(filePath).toString()
    return net.fetch(fileUrl, {
      headers: request.headers,
      // range 요청 전달
      method: request.method
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
      nodeIntegration: false
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
