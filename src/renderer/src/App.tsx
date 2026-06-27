import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnvStatus, Project, SourceClip, TimelineClip, Track } from '@shared/types'
import { createEmptyProject, migrateProject } from '@shared/types'
import { clipEnd, totalDuration } from '@shared/timeline'
import {
  applyOps,
  type AiProvider,
  type ChatClipInfo,
  type EditOp,
  type Proposal
} from '@shared/ai-edit'
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
  setSpeed,
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
import { AiPanel, type ChatMsg } from './components/AiPanel'
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
  const [leftWidth, setLeftWidth] = useState(280)
  const [rightWidth, setRightWidth] = useState(320)
  const [timelineH, setTimelineH] = useState(320)
  const splitRef = useRef<{ kind: 'v' | 'vr' | 'h'; startPos: number; startVal: number } | null>(null)
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [compareBefore, setCompareBefore] = useState(false) // 제안 미리보기 중 원본 보기 토글
  const [aiBusy, setAiBusy] = useState(false)
  const [chatLog, setChatLog] = useState<ChatMsg[]>([])
  const [visionMode, setVisionMode] = useState<'fast' | 'precise'>('fast')
  const [useAudio, setUseAudio] = useState(true)
  const [aiProvider, setAiProvider] = useState<AiProvider>('codex')
  const videoRef = useRef<HTMLVideoElement>(null)

  const { tracks: baseTracks, clips: baseClips } = project.timeline
  // 제안 미리보기 중이면 미리보기 스냅샷을 화면/플레이어에 반영(원본은 그대로, 적용 시 commit).
  // compareBefore=true 면 비교를 위해 원본을 보여줌.
  const showPreview = !!proposal && !compareBefore
  // 원본 비교: proposal.before 가 있으면 그것(예: 하이라이트는 전체 원본), 없으면 적용 직전 타임라인.
  const beforeSnap = proposal?.before ?? { tracks: baseTracks, clips: baseClips }
  const tracks = !proposal ? baseTracks : showPreview ? proposal.preview.tracks : beforeSnap.tracks
  const clips = !proposal ? baseClips : showPreview ? proposal.preview.clips : beforeSnap.clips
  // 편집본 볼 때만 바뀐 클립 강조.
  const highlightChangedIds = showPreview ? proposal!.changedIds : []
  const total = useMemo(() => totalDuration(clips), [clips])
  const sourceById = useMemo(() => new Map(project.sources.map((s) => [s.id, s])), [project.sources])
  const hasClips = baseClips.length > 0

  const player = useTimelinePlayer(videoRef, clips, tracks, sourceById, total)

  useEffect(() => {
    window.clipreel.checkEnv().then(setEnv).catch(() => setEnv(null))
    const offE = window.clipreel.onExportProgress((p) => setStatus(p.message))
    const offV = window.clipreel.onVisionProgress((p) => setStatus(p.message))
    return () => { offE(); offV() }
  }, [])

  // ── 상태/커밋 ──
  // 편집 연산은 항상 원본(base) 기준. 미리보기 중에는 편집을 막는다.
  function curState(): OpState {
    return { tracks: baseTracks, clips: baseClips, sources: project.sources, fps: project.fps }
  }
  function commit(next: Snapshot, label: string): void {
    setPast((p) => [...p, { tracks: baseTracks, clips: baseClips }].slice(-100))
    setFuture([])
    setProject((prev) => ({
      ...prev,
      timeline: { tracks: next.tracks, clips: next.clips },
      history: [...prev.history, { label, at: new Date().toISOString(), snapshot: next }].slice(-200)
    }))
  }
  function runOp(fn: (s: OpState) => OpResult, label: string): void {
    if (proposal || aiBusy) {
      setStatus('AI 작업이 끝난 뒤 편집하세요')
      return
    }
    const res = fn(curState())
    if (res.rejected) {
      setStatus(res.rejected)
      return
    }
    commit({ tracks: res.tracks, clips: res.clips }, label)
  }

  function undo(): void {
    if (proposal || aiBusy || past.length === 0) return
    const prev = past[past.length - 1]
    setPast((p) => p.slice(0, -1))
    setFuture((f) => [{ tracks: baseTracks, clips: baseClips }, ...f])
    setProject((p) => ({ ...p, timeline: { tracks: prev.tracks, clips: prev.clips } }))
    setSelectedClipIds(new Set())
  }
  function redo(): void {
    if (proposal || aiBusy || future.length === 0) return
    const next = future[0]
    setFuture((f) => f.slice(1))
    setPast((p) => [...p, { tracks: baseTracks, clips: baseClips }].slice(-100))
    setProject((p) => ({ ...p, timeline: { tracks: next.tracks, clips: next.clips } }))
    setSelectedClipIds(new Set())
  }

  // ── 파일 ──
  /** AI 미리보기/분석 중에는 파일·프로젝트 전환을 막아 상태 누수를 방지. */
  function aiBlocked(): boolean {
    if (proposal || aiBusy) {
      setStatus('AI 제안을 적용/취소한 뒤 진행하세요')
      return true
    }
    return false
  }
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

  /** 미디어 빈에서 소스 제거(참조만 삭제, 원본 파일은 안 건드림). 타임라인 사용 중이면 확인 후 클립도 정리. */
  function removeSource(id: string): void {
    if (proposal || aiBusy) {
      setStatus('AI 작업 중에는 미디어를 삭제할 수 없어요')
      return
    }
    const using = baseClips.filter((c) => c.sourceId === id)
    if (using.length > 0 && !window.confirm(`타임라인에서 ${using.length}개 클립이 이 미디어를 사용 중입니다.\n클립까지 함께 삭제할까요?`)) {
      return
    }
    setProject((p) => ({
      ...p,
      sources: p.sources.filter((s) => s.id !== id),
      timeline: { ...p.timeline, clips: p.timeline.clips.filter((c) => c.sourceId !== id) }
    }))
    setSelectedSourceId((cur) => (cur === id ? null : cur))
    setSelectedClipIds((prev) => {
      if (![...prev].some((cid) => using.some((c) => c.id === cid))) return prev
      const next = new Set(prev)
      using.forEach((c) => next.delete(c.id))
      return next
    })
  }

  async function importFolder(): Promise<void> {
    if (aiBlocked()) return
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
    if (aiBlocked()) return
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
    if (aiBlocked()) return
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
    if (aiBlocked()) return
    setError(null)
    try {
      const saved = await window.clipreel.saveProject(project, forceDialog)
      if (saved) setProject(saved)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  async function exportMontage(): Promise<void> {
    if (aiBlocked()) return
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
    if (proposal || aiBusy || selectedClipIds.size === 0) return
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
    if (proposal || aiBusy) return
    const res = splitAtPlayhead(curState(), player.playheadSec, baseTracks.map((t) => t.id))
    if (res.changed.length) commit({ tracks: res.tracks, clips: res.clips }, '분할')
  }
  function unlinkClip(clipId: string): void {
    const clip = baseClips.find((c) => c.id === clipId)
    if (!clip?.linkId) return
    const ids = baseClips.filter((c) => c.linkId === clip.linkId).map((c) => c.id)
    runOp((st) => linkClips(st, ids), '링크 해제')
  }

  // ── AI 편집(미리보기 제안) ──
  const firstVideoTrackId = useMemo(() => {
    const vids = baseTracks.filter((t) => t.kind === 'video').sort((a, b) => a.index - b.index)
    return vids[0]?.id ?? 'V1'
  }, [baseTracks])

  function makeProposal(
    kind: Proposal['kind'],
    title: string,
    ops: EditOp[],
    explanation?: string,
    before?: { tracks: Track[]; clips: TimelineClip[] }
  ): void {
    if (ops.length === 0) {
      setStatus('변경할 내용이 없습니다')
      return
    }
    const res = applyOps(curState(), ops)
    if (res.applied === 0) {
      setStatus(explanation || '적용할 수 있는 편집이 없습니다')
      return
    }
    const dropped = res.rejected.length ? ` · ${res.rejected.length}개 건너뜀` : ''
    setCompareBefore(false) // 새 제안은 편집본부터 보여줌
    setProposal({
      id: `prop_${Date.now().toString(36)}`,
      kind,
      title,
      summary: `${title}: ${res.applied}개 변경${dropped}`,
      preview: { tracks: res.tracks, clips: res.clips },
      before,
      changedIds: res.changed,
      explanation
    })
    player.pause()
  }

  // AI 비전 하이라이트: codex 가 화면을 직접 보고 하이라이트 선별 → 타임라인 끝에 배치(제안).
  async function runHighlight(): Promise<void> {
    if (proposal || aiBusy) return
    if (!hasClips) {
      setStatus('먼저 좌측 미디어를 타임라인으로 드래그하세요')
      return
    }
    // 분석 대상: 선택된 소스 우선, 없으면 타임라인 첫 클립의 소스.
    const srcId = (selectedSourceId && sourceById.get(selectedSourceId))
      ? selectedSourceId
      : baseClips[0]?.sourceId
    const src = srcId ? sourceById.get(srcId) : null
    if (!src) {
      setStatus('하이라이트할 영상을 찾지 못했습니다')
      return
    }
    const withAudio = useAudio && (env?.whisperFound ?? false)
    setAiBusy(true)
    setStatus(`${aiProvider} 분석 중(${visionMode === 'fast' ? '빠름' : '정밀'}${withAudio ? ' · 음성 포함' : ''})…`)
    try {
      const { segments, error } = await window.clipreel.visionHighlights({
        sourcePath: src.path,
        durationSec: src.durationSec,
        provider: aiProvider,
        mode: visionMode,
        useAudio: withAudio,
        whisperCmd: env?.whisperCmd ?? null,
        maxClips: 8,
        preRollSec: project.settings.preRollSec,
        postRollSec: project.settings.postRollSec
      })
      if (error) {
        setError(error)
        return
      }
      if (segments.length === 0) {
        setStatus('AI가 하이라이트를 찾지 못했습니다')
        return
      }
      // 빈 타임라인에 하이라이트 릴: 기존 클립 모두 제거 후 0초부터 순서대로 배치.
      const ops: EditOp[] = baseClips.map((c) => ({ op: 'remove', clipId: c.id }))
      let cursor = 0
      for (const s of segments) {
        ops.push({
          op: 'placeRange',
          sourceId: src.id,
          trackId: firstVideoTrackId,
          valueSec: cursor,
          inSec: s.inSec,
          outSec: s.outSec
        })
        cursor += s.outSec - s.inSec
      }
      // "원본" 비교용: 전체 원본 영상을 한 클립으로 배치한 스냅샷(타임라인에 안 올렸어도 비교 가능).
      const beforeOps: EditOp[] = [
        ...baseClips.map((c) => ({ op: 'remove', clipId: c.id }) as EditOp),
        { op: 'placeRange', sourceId: src.id, trackId: firstVideoTrackId, valueSec: 0, inSec: 0, outSec: src.durationSec }
      ]
      const beforeRes = applyOps(curState(), beforeOps)
      const before = { tracks: beforeRes.tracks, clips: beforeRes.clips }
      makeProposal(
        'highlight',
        'AI 하이라이트 릴',
        ops,
        `AI가 고른 ${segments.length}곳으로 새 하이라이트 릴 구성`,
        before
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAiBusy(false)
      setStatus(null)
    }
  }

  async function runChat(instruction: string): Promise<void> {
    if (proposal || aiBusy) return
    setChatLog((l) => [...l, { role: 'user', text: instruction }])
    const clipInfos: ChatClipInfo[] = baseClips.map((c) => ({
      id: c.id,
      track: c.trackId,
      startSec: c.startSec,
      durSec: clipEnd(c) - c.startSec,
      peakScore: c.peakScore ?? null
    }))
    setAiBusy(true)
    try {
      const res = await window.clipreel.chatEdit({ instruction, clips: clipInfos, provider: aiProvider })
      if (res.error) {
        setChatLog((l) => [...l, { role: 'ai', text: res.error! }])
        return
      }
      setChatLog((l) => [...l, { role: 'ai', text: res.explanation || '편집을 제안합니다.' }])
      makeProposal('chat', '자연어 편집', res.ops, res.explanation)
    } catch (e) {
      setChatLog((l) => [...l, { role: 'ai', text: e instanceof Error ? e.message : String(e) }])
    } finally {
      setAiBusy(false)
    }
  }

  function acceptProposal(): void {
    if (!proposal) return
    const p = proposal
    setProposal(null)
    setCompareBefore(false)
    commit(p.preview, p.title)
    setSelectedClipIds(new Set())
  }
  function cancelProposal(): void {
    setProposal(null)
    setCompareBefore(false)
  }

  const locked = busy || aiBusy || !!proposal

  // 패널 크기 조절 스플리터
  function splitDown(kind: 'v' | 'vr' | 'h', e: React.PointerEvent): void {
    e.preventDefault()
    splitRef.current = {
      kind,
      startPos: kind === 'h' ? e.clientY : e.clientX,
      startVal: kind === 'v' ? leftWidth : kind === 'vr' ? rightWidth : timelineH
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function splitMove(e: React.PointerEvent): void {
    const s = splitRef.current
    if (!s) return
    if (s.kind === 'v') {
      setLeftWidth(Math.max(160, Math.min(560, s.startVal + (e.clientX - s.startPos))))
    } else if (s.kind === 'vr') {
      // 오른쪽 패널: 왼쪽으로 끌수록 넓어짐.
      setRightWidth(Math.max(220, Math.min(560, s.startVal - (e.clientX - s.startPos))))
    } else {
      setTimelineH(Math.max(140, Math.min(window.innerHeight - 220, s.startVal - (e.clientY - s.startPos))))
    }
  }
  function splitUp(e: React.PointerEvent): void {
    if (splitRef.current) {
      splitRef.current = null
      ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    }
  }

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
      } else if (e.key === 'Escape') {
        if (proposal) cancelProposal()
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
        setPxPerSec((p) => Math.max(0.5, p * 0.8))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, tracks, clips, selectedClipIds, busy, total, player, proposal, aiBusy])

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
      {proposal && (
        <div className="banner proposal">
          <span>🤖 {proposal.summary} — {compareBefore ? '원본 보는 중' : '편집본 미리보기'}</span>
          <span className="banner-actions">
            <span className="compare-toggle" role="group" aria-label="원본/편집본 비교">
              <button
                className={compareBefore ? 'on' : ''}
                onClick={() => setCompareBefore(true)}
                title="원본 타임라인 보기"
              >
                원본
              </button>
              <button
                className={!compareBefore ? 'on' : ''}
                onClick={() => setCompareBefore(false)}
                title="AI 편집본 보기(바뀐 부분 강조)"
              >
                편집본
              </button>
            </span>
            <button className="primary" onClick={acceptProposal} disabled={aiBusy}>
              적용
            </button>
            <button onClick={cancelProposal} disabled={aiBusy}>
              취소
            </button>
          </span>
        </div>
      )}

      <div className="layout">
        <div className="upper">
          <div className="pane-left" style={{ width: leftWidth }}>
            <SourceBin
              sources={project.sources}
              busy={busy}
              selectedSourceId={selectedSourceId}
              onPick={pickSource}
              onRemoveSource={removeSource}
              onDragSource={setDraggingSourceId}
            />
          </div>

          <div
            className="vsplit"
            onPointerDown={(e) => splitDown('v', e)}
            onPointerMove={splitMove}
            onPointerUp={splitUp}
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

          <div
            className="vsplit"
            onPointerDown={(e) => splitDown('vr', e)}
            onPointerMove={splitMove}
            onPointerUp={splitUp}
          />

          <div className="pane-right" style={{ width: rightWidth }}>
            <AiPanel
              env={env}
              aiBusy={aiBusy}
              hasClips={hasClips}
              selectedSourceName={
                selectedSourceId ? sourceById.get(selectedSourceId)?.name ?? null : null
              }
              proposal={proposal}
              chatLog={chatLog}
              provider={aiProvider}
              onProviderChange={setAiProvider}
              providersAvailable={{
                codex: env?.codexFound ?? false,
                gemini: env?.geminiFound ?? false,
                claude: env?.claudeFound ?? false
              }}
              visionMode={visionMode}
              onVisionModeChange={setVisionMode}
              useAudio={useAudio}
              onUseAudioChange={setUseAudio}
              whisperFound={env?.whisperFound ?? false}
              onHighlight={runHighlight}
              onChat={runChat}
              onAccept={acceptProposal}
              onCancel={cancelProposal}
            />
          </div>
        </div>

        <div
          className="hsplit"
          onPointerDown={(e) => splitDown('h', e)}
          onPointerMove={splitMove}
          onPointerUp={splitUp}
        />

        <div className="pane-timeline" style={{ height: timelineH }}>
          <TimelinePanel
          tracks={tracks}
          clips={clips}
          sources={project.sources}
          fps={project.fps}
          pxPerSec={pxPerSec}
          setPxPerSec={setPxPerSec}
          snapEnabled={snapEnabled}
          selectedClipIds={selectedClipIds}
          changedClipIds={highlightChangedIds}
          playheadSec={player.playheadSec}
          draggingSourceId={draggingSourceId}
          onSelectClip={selectClip}
          onSplitPlayhead={splitPlayhead}
          onRemoveClip={(id) => runOp((st) => remove(st, id), '삭제')}
          onRippleDeleteClip={(id) => runOp((st) => rippleDelete(st, id), '리플 삭제')}
          onSetClipSpeed={(id, rate) => runOp((st) => setSpeed(st, id, rate), '속도 변경')}
          onUnlinkClip={unlinkClip}
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
    </div>
  )
}
