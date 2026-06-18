import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnvStatus, Project, SourceClip, TimelineClip, Track } from '@shared/types'
import { createEmptyProject, migrateProject } from '@shared/types'
import { totalDuration } from '@shared/timeline'
import {
  addClip,
  addTrack,
  closeGap,
  linkClips,
  moveClip,
  moveClips,
  moveTrack,
  removeTrack,
  reorderTrack,
  remove,
  rippleDelete,
  setTrackFlag,
  splitAtPlayhead,
  trimLeft,
  trimRight,
  type OpResult,
  type OpState
} from '@shared/timeline-ops'
import { SourceBin } from './components/SourceBin'
import { ProgramMonitor } from './components/ProgramMonitor'
import { TimelinePanel } from './components/TimelinePanel'
import { useTimelinePlayer } from './useTimelinePlayer'

type Snapshot = { tracks: Track[]; clips: TimelineClip[] }

export default function App(): JSX.Element {
  const [project, setProject] = useState<Project>(() => createEmptyProject())
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(() => new Set())
  const [pxPerSec, setPxPerSec] = useState(100)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [draggingSourceId, setDraggingSourceId] = useState<string | null>(null)
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const videoRef = useRef<HTMLVideoElement>(null)

  const { tracks, clips } = project.timeline
  const total = useMemo(() => totalDuration(clips), [clips])
  const sourceById = useMemo(() => new Map(project.sources.map((s) => [s.id, s])), [project.sources])
  const hasClips = clips.length > 0

  const player = useTimelinePlayer(videoRef, clips, tracks, sourceById, total)

  useEffect(() => {
    window.clipreel.checkEnv().then(setEnv).catch(() => setEnv(null))
    const offE = window.clipreel.onExportProgress((p) => setStatus(p.message))
    return () => offE()
  }, [])

  // ── 상태/커밋 ──
  function curState(): OpState {
    return { tracks, clips, sources: project.sources, fps: project.fps }
  }
  function commit(next: Snapshot, label: string): void {
    setPast((p) => [...p, { tracks, clips }].slice(-100))
    setFuture([])
    setProject((prev) => ({
      ...prev,
      timeline: { tracks: next.tracks, clips: next.clips },
      history: [...prev.history, { label, at: new Date().toISOString(), snapshot: next }].slice(-200)
    }))
  }
  function runOp(fn: (s: OpState) => OpResult, label: string): void {
    const res = fn(curState())
    if (res.rejected) {
      setStatus(res.rejected)
      return
    }
    commit({ tracks: res.tracks, clips: res.clips }, label)
  }

  function undo(): void {
    if (past.length === 0) return
    const prev = past[past.length - 1]
    setPast((p) => p.slice(0, -1))
    setFuture((f) => [{ tracks, clips }, ...f])
    setProject((p) => ({ ...p, timeline: { tracks: prev.tracks, clips: prev.clips } }))
    setSelectedClipIds(new Set())
  }
  function redo(): void {
    if (future.length === 0) return
    const next = future[0]
    setFuture((f) => f.slice(1))
    setPast((p) => [...p, { tracks, clips }].slice(-100))
    setProject((p) => ({ ...p, timeline: { tracks: next.tracks, clips: next.clips } }))
    setSelectedClipIds(new Set())
  }

  // ── 파일 ──
  /** 가져온 소스를 미디어 빈에 병합(경로 중복 제거, 타임라인 유지). */
  function addSources(incoming: SourceClip[], folderName?: string): void {
    if (incoming.length === 0) return
    setProject((p) => {
      const existing = new Set(p.sources.map((s) => s.path))
      const merged = [...p.sources, ...incoming.filter((s) => !existing.has(s.path))]
      const name = p.sources.length === 0 && folderName ? folderName : p.name
      return { ...p, sources: merged, name }
    })
    setSelectedSourceId((cur) => cur ?? incoming[0]?.id ?? null)
  }

  async function importFolder(): Promise<void> {
    setError(null)
    try {
      const folder = await window.clipreel.openFolder()
      if (!folder) return
      setBusy(true)
      setStatus('폴더 스캔 중…')
      const sources = await window.clipreel.scanFolder(folder)
      addSources(sources, folder.split(/[\\/]/).pop())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  async function importFiles(): Promise<void> {
    setError(null)
    try {
      setBusy(true)
      setStatus('가져오는 중…')
      const sources = await window.clipreel.importFiles()
      addSources(sources)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }
  async function openProject(): Promise<void> {
    setError(null)
    try {
      const p = await window.clipreel.openProject()
      if (!p) return
      const migrated = migrateProject(p)
      setProject(migrated)
      setSelectedSourceId(migrated.sources[0]?.id ?? null)
      setSelectedClipIds(new Set())
      setPast([])
      setFuture([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  async function saveProject(forceDialog = false): Promise<void> {
    setError(null)
    try {
      const saved = await window.clipreel.saveProject(project, forceDialog)
      if (saved) setProject(saved)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  async function exportMontage(): Promise<void> {
    setError(null)
    if (total <= 0) return
    try {
      setBusy(true)
      setStatus('내보내기 시작…')
      const out = await window.clipreel.exportRender(project)
      setStatus(out ? `내보내기 완료: ${out}` : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // ── 편집 동작 ──
  function pickSource(s: SourceClip): void {
    setSelectedSourceId(s.id)
    player.showFrame(s.id, 0)
  }
  function selectClip(id: string | null, additive?: boolean): void {
    if (id === null) {
      setSelectedClipIds(new Set())
      return
    }
    setSelectedClipIds((prev) => {
      if (!additive) return new Set([id])
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function deleteSelected(ripple: boolean): void {
    if (selectedClipIds.size === 0) return
    let state = curState()
    let changed = false
    for (const id of selectedClipIds) {
      const res = (ripple ? rippleDelete : remove)(state, id)
      if (!res.rejected) {
        state = { ...state, tracks: res.tracks, clips: res.clips }
        changed = true
      }
    }
    if (changed) {
      commit({ tracks: state.tracks, clips: state.clips }, ripple ? '리플 삭제' : '삭제')
      setSelectedClipIds(new Set())
    }
  }
  function splitPlayhead(): void {
    const res = splitAtPlayhead(curState(), player.playheadSec, tracks.map((t) => t.id))
    if (res.changed.length) commit({ tracks: res.tracks, clips: res.clips }, '분할')
  }

  const locked = busy

  // ── 키보드 ──
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      const frame = 1 / (project.fps || 60)
      if (ctrl && k === 'z') {
        e.preventDefault()
        if (!busy) (e.shiftKey ? redo : undo)()
      } else if (ctrl && k === 'y') {
        e.preventDefault()
        if (!busy) redo()
      } else if (ctrl && k === 's') {
        e.preventDefault()
        if (!busy) void saveProject(false)
      } else if (ctrl && k === 'o') {
        e.preventDefault()
        if (!busy) void openProject()
      } else if (ctrl && k === 'e') {
        e.preventDefault()
        if (!busy && total > 0) void exportMontage()
      } else if (ctrl && (k === 'k' || k === 'c')) {
        e.preventDefault()
        if (!busy) splitPlayhead()
      } else if (e.key === ' ') {
        e.preventDefault()
        player.toggle()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        player.seek(player.playheadSec - frame * (e.shiftKey ? 10 : 1), false)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        player.seek(player.playheadSec + frame * (e.shiftKey ? 10 : 1), false)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        if (!busy) deleteSelected(e.shiftKey)
      } else if (!ctrl && k === 's') {
        setSnapEnabled((v) => !v)
      } else if (!ctrl && k === 'c') {
        if (!busy) splitPlayhead()
      } else if (!ctrl && (e.key === '+' || e.key === '=')) {
        setPxPerSec((p) => Math.min(500, p * 1.25))
      } else if (!ctrl && (e.key === '-' || e.key === '_')) {
        setPxPerSec((p) => Math.max(5, p * 0.8))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, tracks, clips, selectedClipIds, busy, total, player])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-word">ClipReel</span>
        </div>
        <div className="actions">
          <button onClick={importFolder} disabled={locked} title="폴더 안의 영상 전부 가져오기">
            📂 폴더
          </button>
          <button onClick={importFiles} disabled={locked} title="영상 파일 선택해서 가져오기(여러 개 가능)">
            🎬 파일
          </button>
          <button onClick={openProject} disabled={locked}>
            열기
          </button>
          <button onClick={() => saveProject(false)} disabled={locked || project.sources.length === 0}>
            저장
          </button>
          <span className="sep" />
          <button onClick={undo} disabled={locked || past.length === 0} title="실행 취소 (Ctrl+Z)">
            ↶
          </button>
          <button onClick={redo} disabled={locked || future.length === 0} title="다시 실행 (Ctrl+Y)">
            ↷
          </button>
          <span className="sep" />
          <button className="primary" onClick={exportMontage} disabled={locked || total <= 0}>
            ⬇ 내보내기
          </button>
        </div>
        <div className="proj-name">{project.name}</div>
      </header>

      {env && !env.ffmpegOk && (
        <div className="banner warn">⚠ ffmpeg 를 찾지 못했습니다. 미리보기/내보내기가 제한됩니다.</div>
      )}
      {status && <div className="banner info">{status}</div>}
      {error && <div className="banner error">오류: {error}</div>}

      <div className="layout">
        <SourceBin
          sources={project.sources}
          busy={busy}
          selectedSourceId={selectedSourceId}
          onPick={pickSource}
          onDragSource={setDraggingSourceId}
        />

        <ProgramMonitor
          videoRef={videoRef}
          playing={player.playing}
          playheadSec={player.playheadSec}
          gap={player.gap}
          total={total}
          fps={project.fps}
          hasClips={hasClips}
          onToggle={player.toggle}
        />

        <TimelinePanel
          tracks={tracks}
          clips={clips}
          sources={project.sources}
          fps={project.fps}
          pxPerSec={pxPerSec}
          setPxPerSec={setPxPerSec}
          snapEnabled={snapEnabled}
          selectedClipIds={selectedClipIds}
          playheadSec={player.playheadSec}
          draggingSourceId={draggingSourceId}
          onSelectClip={selectClip}
          onSplitPlayhead={splitPlayhead}
          onLinkSelected={() => runOp((st) => linkClips(st, [...selectedClipIds]), '링크')}
          onSeek={player.seek}
          onShowFrame={player.showFrame}
          onMoveClip={(id, t, s, linked) => runOp((st) => moveClip(st, id, t, s, linked), '이동')}
          onMoveClips={(ids, delta, linked) => runOp((st) => moveClips(st, ids, delta, linked), '동시 이동')}
          onCloseGap={(tid, s, e) => runOp((st) => closeGap(st, tid, s, e), '여백 제거')}
          onTrimLeft={(id, s) => runOp((st) => trimLeft(st, id, s), '트림')}
          onTrimRight={(id, s) => runOp((st) => trimRight(st, id, s), '트림')}
          onAddSource={(sid, tid, s) => runOp((st) => addClip(st, sid, tid, s), '클립 추가')}
          onToggleSnap={() => setSnapEnabled((v) => !v)}
          onAddTrack={(kind) => runOp((st) => addTrack(st, kind), '트랙 추가')}
          onMoveTrack={(tid, dir) => runOp((st) => moveTrack(st, tid, dir), '트랙 순서')}
          onRemoveTrack={(tid) => runOp((st) => removeTrack(st, tid), '트랙 삭제')}
          onReorderTrack={(tid, beforeId) => runOp((st) => reorderTrack(st, tid, beforeId), '트랙 순서')}
          onSetTrackFlag={(tid, flags) => runOp((st) => setTrackFlag(st, tid, flags), '트랙 설정')}
        />
      </div>
    </div>
  )
}
