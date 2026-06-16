// media:// 프로토콜이 아무 로컬 파일이나 읽지 못하도록, 앱이 실제로
// 스캔/열기 한 원본 경로만 허용하는 allowlist (임의 로컬 파일 읽기 차단).

import { normalize } from 'path'

function key(p: string): string {
  // Windows 는 대소문자 구분 안 함 → 정규화 + 소문자.
  const n = normalize(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

const allowed = new Set<string>()

export function allowPath(p: string): void {
  allowed.add(key(p))
}

export function allowPaths(paths: string[]): void {
  for (const p of paths) allowPath(p)
}

export function isAllowed(p: string): boolean {
  return allowed.has(key(p))
}
