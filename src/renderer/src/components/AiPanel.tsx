import { useRef, useState } from 'react'
import type { EnvStatus } from '@shared/types'
import type { Proposal } from '@shared/ai-edit'

export type ChatMsg = { role: 'user' | 'ai'; text: string }

interface AiPanelProps {
  env: EnvStatus | null
  aiBusy: boolean
  selectedSourceName: string | null
  proposal: Proposal | null
  chatLog: ChatMsg[]
  visionMode: 'fast' | 'precise'
  onVisionModeChange: (m: 'fast' | 'precise') => void
  onHighlight: () => void
  onChat: (text: string) => void
  onAccept: () => void
  onCancel: () => void
}

export function AiPanel(props: AiPanelProps): JSX.Element {
  const {
    env,
    aiBusy,
    selectedSourceName,
    proposal,
    chatLog,
    visionMode,
    onVisionModeChange,
    onHighlight,
    onChat,
    onAccept,
    onCancel
  } = props
  const [text, setText] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const ffmpegOk = env?.ffmpegOk ?? false
  const codexOk = env?.codexFound ?? false
  const disabled = aiBusy || !!proposal

  function send(): void {
    const t = text.trim()
    if (!t || disabled) return
    setText('')
    onChat(t)
  }

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <span className="ai-title">🤖 AI 편집</span>
        {aiBusy && <span className="ai-spin">분석 중…</span>}
      </div>

      {(!ffmpegOk || !codexOk) && (
        <div className="ai-warn">
          {!ffmpegOk
            ? 'ffmpeg 가 없어 프레임을 추출할 수 없습니다.'
            : 'codex 가 없어 AI 분석을 쓸 수 없습니다 (npm i -g @openai/codex → codex login).'}
        </div>
      )}

      <div className="ai-actions">
        <div className="ai-mode">
          <span className="ai-mode-label">분석 속도</span>
          <div className="ai-seg">
            <button className={visionMode === 'fast' ? 'on' : ''} onClick={() => onVisionModeChange('fast')} disabled={disabled} title="듬성듬성 — 빠르고 쿼터 적게">
              빠름
            </button>
            <button className={visionMode === 'precise' ? 'on' : ''} onClick={() => onVisionModeChange('precise')} disabled={disabled} title="촘촘 — 정확하지만 느리고 쿼터 많이">
              정밀
            </button>
          </div>
        </div>
        <button
          onClick={onHighlight}
          disabled={disabled || !ffmpegOk || !codexOk || !selectedSourceName}
          title="선택한 영상을 AI(비전)가 직접 보고 하이라이트를 골라 타임라인에 배치"
        >
          🎯 AI 하이라이트
        </button>
      </div>
      <div className="ai-hint">
        {selectedSourceName
          ? `대상: ${selectedSourceName} · ${visionMode === 'fast' ? '빠름(듬성)' : '정밀(촘촘)'}`
          : '미디어 빈에서 영상을 선택하면 그 영상에서 하이라이트를 뽑아요.'}
      </div>

      {proposal && (
        <div className="ai-proposal">
          <div className="ai-proposal-sum">{proposal.summary}</div>
          {proposal.explanation && <div className="ai-proposal-exp">{proposal.explanation}</div>}
          <div className="ai-proposal-btns">
            <button className="primary" onClick={onAccept} disabled={aiBusy}>
              적용
            </button>
            <button onClick={onCancel} disabled={aiBusy}>
              취소
            </button>
          </div>
        </div>
      )}

      <div className="ai-chat-log" ref={logRef}>
        {chatLog.length === 0 && (
          <div className="ai-empty">
            자연어로 편집을 지시하세요.
            <br />
            예: “3초보다 짧은 클립 다 지워”, “각 클립 앞부분 0.5초 당겨”
          </div>
        )}
        {chatLog.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
      </div>

      <div className="ai-chat-input">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={codexOk ? '편집 지시 입력…' : 'codex 설치 시 사용 가능'}
          rows={2}
          disabled={disabled}
        />
        <button onClick={send} disabled={disabled || !text.trim()}>
          보내기
        </button>
      </div>
      {!codexOk && (
        <div className="ai-hint dim">
          자연어 편집은 codex 필요: <code>npm i -g @openai/codex</code> → <code>codex login</code>
        </div>
      )}
    </div>
  )
}
