import type { ClipReelApi } from './index'

declare global {
  interface Window {
    clipreel: ClipReelApi
  }
}

export {}
