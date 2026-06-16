import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditOp, EnvStatus, Project, SourceClip, TimelineClip } from '@shared/types'
import { createEmptyProject } from '@shared/types'
import { applyEditOps, diffTimeline, type ApplyResult, type TimelineDiff } from '@shared/editops'
import { buildLayout, fmtClock } from '@shared/montage'
import { SequenceTrack } from './components/SequenceTrack'
import { SourceTrimBar } from './components/SourceTrimBar'
import { ChatPanel, type ChatMessage } from './components/ChatPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { useMontagePlayer } from './useMontagePlayer'
import type { ProjectSettings } from '@shared/types'

function fmtDuration(sec: number): string {
  if (!sec || !Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function describeOp(op: EditOp): string {
  switch (op.op) {
    case 'cut':
      return '컷 삭제'
    case 'trim':
      return `트림(${op.inSec ?? '–'}~${op.outSec ?? '–'})`
    case 'pad':
      return `패딩(앞 ${op.preSec ?? 0}s/뒤 ${op.postSec ?? 0}s)`
    case 'reorder':
      return `순서 → ${op.toOrder + 1}`
    case 'speed':
      return `배속 ${op.rate}x`
    case 'addClip':
      return '컷 추가'
    case 'rebuild':
      return '자동 재생성'
    case 'addMarker':
      return `메모: ${op.note}`
    default:
      return '편집'
  }
}

interface Pending {
  result: ApplyResult
  diff: TimelineDiff
  label: string
}

export default function App(): JSX.Element {
  const [project, setProject] = useState<Project>(() => createEmptyProject())
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  const [past, setPast] = useState<TimelineClip[][]>([])
  const [future, setFuture] = useState<TimelineClip[][]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [analyzing, setAnalyzing] = useState<{ done: number; total: number } | null>(null)
  const analyzeIdsRef = useRef<string[]>([])
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    window.clipreel.checkEnv().then(setEnv).catch(() => setEnv(null))
    const offA = window.clipreel.onAnalyzeProgress((p) =>
      setAnalyzing({ done: p.done, total: p.total })
    )
    const offE = window.clipreel.onExportProgress((p) => setStatus(p.message))
    return () => {
      offA()
      offE()
    }
  }, [])

  const selectedSource = useMemo(
    () => project.sources.find((s) => s.id === selectedSourceId) ?? null,
    [project.sources, selectedSourceId]
  )

  // 미리보기에 보여줄 타임라인(제안 미리보기 중이면 그 결과) + 시간 비례 레이아웃.
  const displayClips = pending ? pending.result.clips : project.timeline.clips
  const sourceById = useMemo(
    () => new Map(project.sources.map((s) => [s.id, s])),
    [project.sources]
  )
  const { items, total } = useMemo(() => buildLayout(displayClips), [displayClips])
  const selectedClip = useMemo(
    () => displayClips.find((c) => c.id === selectedClipId) ?? null,
    [displayClips, selectedClipId]
  )
  const player = useMontagePlayer(videoRef, items, total, sourceById)

  // 타임라인이 비어있다가 채워지면 첫 프레임을 미리보기에 표시.
  const initedRef = useRef(false)
  useEffect(() => {
    if (items.length > 0 && !initedRef.current) {
      initedRef.current = true
      player.seek(0)
    }
    if (items.length === 0) initedRef.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  /** 새 타임라인을 커밋(undo 스택에 현재 상태 push, future 비움, history 기록). */
  function commit(newClips: TimelineClip[], label: string): void {
    setPast((p) => [...p, project.timeline.clips])
    setFuture([])
    setProject((p) => ({
      ...p,
      timeline: { clips: newClips },
      history: [...p.history, { label, at: new Date().toISOString(), clips: newClips }]
    }))
  }

  function undo(): void {
    if (past.length === 0) return
    const prev = past[past.length - 1]
    setPast((p) => p.slice(0, -1))
    setFuture((f) => [project.timeline.clips, ...f])
    setProject((p) => ({ ...p, timeline: { clips: prev } }))
    setPending(null)
  }

  function redo(): void {
    if (future.length === 0) return
    const next = future[0]
    setFuture((f) => f.slice(1))
    setPast((p) => [...p, project.timeline.clips])
    setProject((p) => ({ ...p, timeline: { clips: next } }))
    setPending(null)
  }

  async function loadFolder(): Promise<void> {
    setError(null)
    try {
      const folder = await window.clipreel.openFolder()
      if (!folder) return
      setBusy(true)
      setStatus('폴더 스캔 중…')
      const sources = await window.clipreel.scanFolder(folder)
      setProject((p) => ({
        ...p,
        name: folder.split(/[\\/]/).pop() || p.name,
        sources,
        timeline: { clips: [] },
        history: []
      }))
      setSelectedSourceId(sources[0]?.id ?? null)
      setSelectedClipId(null)
      setPast([])
      setFuture([])
      setPending(null)
      setMessages([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  async function autoEdit(): Promise<void> {
    setError(null)
    if (project.sources.length === 0) return
    try {
      setBusy(true)
      setPending(null)
      const existing = project.timeline.clips
      analyzeIdsRef.current =
        existing.length > 0 ? existing.map((c) => c.sourceId) : project.sources.map((s) => s.id)
      setAnalyzing({ done: 0, total: analyzeIdsRef.current.length })
      if (existing.length > 0) {
        // 타임라인에 있는 클립을 그대로 두고 각자 핵심 구간으로 다듬기.
        const trimmed = await window.clipreel.analyzeTrim(
          existing,
          project.sources,
          project.settings
        )
        commit(trimmed, `AI가 ${trimmed.length}컷 다듬음`)
      } else {
        // 비어 있으면 전체 소스에서 자동 생성.
        const clips = await window.clipreel.analyzeAuto(
          project.sources,
          project.settings,
          project.targetDurationSec
        )
        commit(clips, `AI가 ${clips.length}컷 생성`)
        setSelectedClipId(clips[0]?.id ?? null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setStatus(null)
      setAnalyzing(null)
    }
  }

  async function exportMontage(): Promise<void> {
    setError(null)
    if (project.timeline.clips.length === 0) return
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

  async function sendChat(text: string): Promise<void> {
    setError(null)
    setMessages((m) => [...m, { role: 'user', text }])
    try {
      setBusy(true)
      setStatus('Codex 생각 중… (한 번에 한 지시)')
      const res = await window.clipreel.requestEdits(project, text)
      if (res.error) {
        setMessages((m) => [...m, { role: 'assistant', text: `오류: ${res.error}` }])
        return
      }
      if (res.ops.length === 0) {
        setMessages((m) => [
          ...m,
          { role: 'assistant', text: '바꿀 내용을 찾지 못했어요. 더 구체적으로 말해 주세요.' }
        ])
        return
      }
      const result = applyEditOps(project.timeline.clips, res.ops, project.sources)
      // 적용 가능한 연산이 하나도 없으면(전부 거부 + rebuild 아님) pending 을 만들지 않는다.
      if (result.applied.length === 0 && !result.rebuildRequested) {
        const why = result.rejected.map((r) => r.reason).join('; ') || '적용할 변경이 없습니다.'
        setMessages((m) => [...m, { role: 'assistant', text: `적용하지 못했어요: ${why}` }])
        return
      }
      const diff = diffTimeline(project.timeline.clips, result.clips)
      const opsSummary = result.applied.map(describeOp).join(', ') || '전체 재생성'
      const rejectNote =
        result.rejected.length > 0
          ? `\n적용 못 한 연산 ${result.rejected.length}개: ${result.rejected
              .map((r) => r.reason)
              .join('; ')}`
          : ''
      const label = `Codex: ${opsSummary}`
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: `제안: ${opsSummary}\n(추가 +${diff.added.length} / 삭제 -${diff.removed.length} / 변경 ~${diff.changed.length})${rejectNote}\n아래에서 적용/되돌리기를 선택하세요.`
        }
      ])
      setPending({ result, diff, label })
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: 'assistant', text: `오류: ${e instanceof Error ? e.message : String(e)}` }
      ])
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  function applyPending(): void {
    if (!pending) return
    // rebuild 은 현재 소스로 전체 재생성 → pending 클립을 커밋하지 않고 autoEdit 로 일원화.
    // (커밋 후 autoEdit 를 부르면 stale 클로저로 undo 스택이 꼬인다.)
    if (pending.result.rebuildRequested) {
      setPending(null)
      setSelectedClipId(null)
      void autoEdit()
      return
    }
    commit(pending.result.clips, pending.label)
    setSelectedClipId(null)
    setPending(null)
  }

  function cancelPending(): void {
    setPending(null)
    setMessages((m) => [...m, { role: 'assistant', text: '변경을 되돌렸습니다.' }])
  }

  async function openProject(): Promise<void> {
    setError(null)
    try {
      const p = await window.clipreel.openProject()
      if (!p) return
      setProject(p)
      setSelectedSourceId(p.sources[0]?.id ?? null)
      setSelectedClipId(p.timeline.clips[0]?.id ?? null)
      setPast([])
      setFuture([])
      setPending(null)
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

  function selectTimelineClip(clip: TimelineClip): void {
    setSelectedClipId(clip.id)
    setSelectedSourceId(clip.sourceId)
    player.showFrame(clip.sourceId, clip.inSec)
  }

  /** 좌측 소스를 타임라인으로 드래그&드롭 → 클립 추가(원본 전체, 지정 위치). */
  function addSourceToTimeline(sourceId: string, toOrder: number): void {
    if (locked) return
    const src = sourceById.get(sourceId)
    if (!src) return
    const before = project.timeline.clips
    let r = applyEditOps(
      before,
      [{ op: 'addClip', sourceId, inSec: 0, outSec: src.durationSec || 1 }],
      project.sources
    )
    const added = r.clips.find((c) => !before.some((o) => o.id === c.id))
    if (added && toOrder < r.clips.length) {
      r = applyEditOps(r.clips, [{ op: 'reorder', clipId: added.id, toOrder }], project.sources)
    }
    commit(r.clips, `${src.name} 추가`)
    if (added) {
      setSelectedClipId(added.id)
      setSelectedSourceId(sourceId)
      player.showFrame(sourceId, 0)
    }
  }

  /** 시퀀스 블록 드래그 → 순서 변경. */
  function reorderClip(clipId: string, toOrder: number): void {
    if (locked) return
    const r = applyEditOps(project.timeline.clips, [{ op: 'reorder', clipId, toOrder }], project.sources)
    commit(r.clips, `순서 변경 → ${toOrder + 1}`)
  }

  /** 원본 트림 바에서 in/out 확정. */
  function commitTrim(clipId: string, inSec: number, outSec: number): void {
    if (locked) return
    const r = applyEditOps(
      project.timeline.clips,
      [{ op: 'trim', clipId, inSec, outSec }],
      project.sources
    )
    commit(r.clips, '트림 조절')
  }

  const hasClips = project.timeline.clips.length > 0
  const codexAvailable = !!env?.codexFound
  // 현재 분석 중인 소스(좌측 빈에서 스캔 효과 표시).
  const analyzingSourceId = analyzing ? (analyzeIdsRef.current[analyzing.done] ?? null) : null
  // pending 미리보기는 모달: 적용/되돌리기 전까지 다른 동작을 잠근다.
  const locked = busy || !!pending

  // 로컬(코덱스 없이) 컷 삭제 — 단축키/빠른 편집용.
  function deleteSelectedClip(): void {
    if (!selectedClipId || locked) return
    if (!project.timeline.clips.some((c) => c.id === selectedClipId)) return
    const r = applyEditOps(
      project.timeline.clips,
      [{ op: 'cut', clipId: selectedClipId }],
      project.sources
    )
    commit(r.clips, '컷 삭제')
    setSelectedClipId(null)
  }

  function saveSettings(next: ProjectSettings, targetDurationSec: number): void {
    setProject((p) => ({ ...p, settings: next, targetDurationSec }))
    setShowSettings(false)
  }

  // 키보드 단축키
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (showSettings) {
        if (e.key === 'Escape') setShowSettings(false)
        return
      }
      if (pending) {
        if (e.key === 'Escape') cancelPending()
        return
      }
      // 입력/텍스트영역에 포커스가 있으면 단축키를 가로채지 않음(네이티브 undo 등 보존).
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
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
        if (!busy && hasClips) void exportMontage()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelectedClip()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [past, future, project, selectedClipId, locked, busy, pending, showSettings])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-word">ClipReel</span>
        </div>
        <div className="actions">
          <button onClick={loadFolder} disabled={locked}>
            📂 폴더 불러오기
          </button>
          <button
            className="primary"
            onClick={autoEdit}
            disabled={locked || project.sources.length === 0}
          >
            ✨ 자동편집
          </button>
          <label
            className={`ai-toggle${codexAvailable ? '' : ' disabled'}`}
            title={
              codexAvailable
                ? 'AI 화면 판단(클립당 codex 호출, 쿼터 소모). 끄면 오디오만 사용.'
                : 'Codex CLI 가 있어야 사용 가능'
            }
          >
            <input
              type="checkbox"
              checked={!!project.settings.aiVision}
              disabled={!codexAvailable || locked}
              onChange={(e) =>
                setProject((p) => ({
                  ...p,
                  settings: { ...p.settings, aiVision: e.target.checked }
                }))
              }
            />
            AI 화면판단
          </label>
          <span className="sep" />
          <button onClick={undo} disabled={locked || past.length === 0} title="실행 취소">
            ↶ 취소
          </button>
          <button onClick={redo} disabled={locked || future.length === 0} title="다시 실행">
            ↷ 다시
          </button>
          <span className="sep" />
          <button onClick={openProject} disabled={locked}>
            열기
          </button>
          <button
            onClick={() => saveProject(false)}
            disabled={locked || project.sources.length === 0}
          >
            저장
          </button>
          <button onClick={() => setShowSettings(true)} disabled={locked} title="설정">
            ⚙
          </button>
        </div>
        <div className="proj-name">{project.name}</div>
      </header>

      {env && (!env.ffmpegOk || !env.codexFound) && (
        <div className="banner warn">
          {!env.ffmpegOk && (
            <span>⚠ ffmpeg 를 찾지 못했습니다. 분석/내보내기가 동작하지 않습니다. </span>
          )}
          {!env.codexFound && (
            <span>
              ℹ Codex CLI 미설치 — 대화형 편집 잠김. <code>npm install -g @openai/codex</code>
            </span>
          )}
        </div>
      )}
      {status && <div className="banner info">{status}</div>}
      {error && <div className="banner error">오류: {error}</div>}

      {analyzing && (
        <div className="analyze-bar" role="progressbar">
          <div
            className="analyze-fill"
            style={{ width: `${(analyzing.done / Math.max(1, analyzing.total)) * 100}%` }}
          />
          <div className="analyze-shimmer" />
          <span className="analyze-label">
            AI ANALYZING · {analyzing.done}/{analyzing.total}
          </span>
        </div>
      )}

      <div className="layout">
        <div className="col-left">
          <aside className="clip-list">
            <div className="list-head">
              소스 {project.sources.length}개{busy && <span className="spin"> · 작업 중…</span>}
            </div>
            {project.sources.length === 0 && !busy && (
              <div className="empty">
                <b>폴더 불러오기</b>로 클립 폴더를 선택하세요.
              </div>
            )}
            <ul>
              {project.sources.map((s) => (
                <ClipRow
                  key={s.id}
                  clip={s}
                  active={s.id === selectedSourceId}
                  analyzing={s.id === analyzingSourceId}
                  onClick={() => {
                    setSelectedSourceId(s.id)
                    setSelectedClipId(null)
                    player.showFrame(s.id, 0)
                  }}
                />
              ))}
            </ul>
          </aside>
          <HistoryPanel history={project.history} />
        </div>

        <div className="col-center">
          <section className="preview">
            <div className="player-wrap">
              <video ref={videoRef} className="player" playsInline />
              {!hasClips && !selectedSource && (
                <div className="preview-overlay">
                  폴더를 불러오고 <b>자동편집</b>을 누르면 여기에 몽타주가 재생됩니다.
                </div>
              )}
            </div>

            <div className="transport">
              <button
                className="play-btn"
                onClick={player.toggle}
                disabled={!hasClips && !selectedSource}
                title={player.playing ? '일시정지' : '재생'}
              >
                {player.playing ? '⏸' : '▶'}
              </button>
              <span className="tcode">
                {fmtClock(player.montageTime)} / {fmtClock(total)}
              </span>
              {selectedSource && <span className="tname">{selectedSource.name}</span>}
            </div>

            {selectedSource && (
              <div className="meta">
                <div className="meta-stats">
                  {selectedSource.resolution || '—'} · {fmtDuration(selectedSource.durationSec)} ·{' '}
                  {selectedSource.fps ? `${selectedSource.fps}fps` : '—'} · 오디오{' '}
                  {selectedSource.audioStreams}트랙
                  {selectedSource.error && ` · 메타 오류: ${selectedSource.error}`}
                </div>
              </div>
            )}
          </section>

          <div className="editor-bottom">
            {selectedClip && sourceById.get(selectedClip.sourceId) && (
              <SourceTrimBar
                clip={selectedClip}
                source={sourceById.get(selectedClip.sourceId)!}
                settings={project.settings}
                onScrub={(sid, t) => player.showFrame(sid, t)}
                onCommit={commitTrim}
              />
            )}
            <SequenceTrack
              clips={displayClips}
              sources={project.sources}
              selectedClipId={selectedClipId}
              montageTime={player.montageTime}
              diff={pending?.diff ?? null}
              onSelect={selectTimelineClip}
              onSeek={(t) => player.seek(t, false)}
              onReorder={reorderClip}
              onAddSource={addSourceToTimeline}
            />
          </div>
        </div>

        <div className="col-right">
          <ChatPanel
            messages={messages}
            busy={busy}
            codexAvailable={codexAvailable}
            hasPending={!!pending}
            onSend={sendChat}
            onApply={applyPending}
            onCancel={cancelPending}
            onExport={exportMontage}
            canExport={hasClips}
          />
        </div>
      </div>

      {showSettings && (
        <SettingsDialog
          settings={project.settings}
          targetDurationSec={project.targetDurationSec}
          onClose={() => setShowSettings(false)}
          onSave={saveSettings}
        />
      )}
    </div>
  )
}

function ClipRow({
  clip,
  active,
  analyzing,
  onClick
}: {
  clip: SourceClip
  active: boolean
  analyzing: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <li
      className={`clip-row${active ? ' active' : ''}${clip.error ? ' has-err' : ''}${
        analyzing ? ' analyzing' : ''
      }`}
      onClick={onClick}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('clipreel/source', clip.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title="타임라인으로 드래그해 추가"
    >
      <div className="cr-name">⠿ {clip.name}</div>
      <div className="cr-stats">
        {fmtDuration(clip.durationSec)} · {clip.resolution || '메타 없음'}
      </div>
    </li>
  )
}
