// .clipreel 프로젝트 파일 저장/불러오기 (사람이 읽는 JSON).

import { readFile, writeFile } from 'fs/promises'
import { createEmptyProject, type Project } from '@shared/types'

/** Project 를 디스크에 저장. filePath 는 호출자가 결정. */
export async function saveProject(filePath: string, project: Project): Promise<Project> {
  const toSave: Project = { ...project, filePath }
  // filePath 는 디스크에 직렬화하지 않음 (이동 시 깨지지 않도록)
  const serializable = { ...toSave }
  delete (serializable as Partial<Project>).filePath
  await writeFile(filePath, JSON.stringify(serializable, null, 2), 'utf-8')
  return toSave
}

/** .clipreel 불러오기 + 기본값 병합(구버전/부분 파일도 안전하게). */
export async function loadProject(filePath: string): Promise<Project> {
  const raw = await readFile(filePath, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<Project>
  if (parsed.version !== 1) {
    throw new Error(`지원하지 않는 프로젝트 버전: ${parsed.version}`)
  }
  // 누락 필드는 기본값으로 채워 이후 로직(settings.preRollSec 등)이 깨지지 않게 한다.
  const base = createEmptyProject()
  return {
    ...base,
    ...parsed,
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    timeline: { clips: Array.isArray(parsed.timeline?.clips) ? parsed.timeline!.clips : [] },
    history: Array.isArray(parsed.history) ? parsed.history : [],
    settings: { ...base.settings, ...(parsed.settings ?? {}) },
    filePath
  }
}
