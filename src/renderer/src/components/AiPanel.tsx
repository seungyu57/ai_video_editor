import { useRef, useState } from 'react'
import type { EnvStatus } from '@shared/types'
import type { AiProvider, Proposal } from '@shared/ai-edit'
import { ProviderLogo } from './ProviderLogo'

export type ChatMsg = { role: 'user' | 'ai'; text: string }

interface AiPanelProps {
  env: EnvStatus | null
  aiBusy: boolean
  hasClips: boolean
  selectedSourceName: string | null
  proposal: Proposal | null
  chatLog: ChatMsg[]
  provider: AiProvider
  onProviderChange: (p: AiProvider) => void
  providersAvailable: Record<AiProvider, boolean>
  visionMode: 'fast' | 'precise'
  onVisionModeChange: (m: 'fast' | 'precise') => void
  useAudio: boolean
  onUseAudioChange: (v: boolean) => void
  whisperFound: boolean
  onHighlight: () => void
  onChat: (text: string) => void
  onAccept: () => void
  onCancel: () => void
}

export function AiPanel(props: AiPanelProps): JSX.Element {
  const {
    env,
    aiBusy,
    hasClips,
    selectedSourceName,
    proposal,
    chatLog,
    provider,
    onProviderChange,
    providersAvailable,
    visionMode,
    onVisionModeChange,
    useAudio,
    onUseAudioChange,
    whisperFound,
    onHighlight,
    onChat,
    onAccept,
    onCancel
  } = props
  const [text, setText] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const ffmpegOk = env?.ffmpegOk ?? false
  const providerOk = providersAvailable[provider] ?? false
  const anyProvider = providersAvailable.codex || providersAvailable.gemini || providersAvailable.claude
  const disabled = aiBusy || !!proposal
  const PROVIDER_LABEL: Record<AiProvider, string> = {
    codex: 'codex',
    gemini: 'Antigravity',
    claude: 'claude'
  }

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

      {(!ffmpegOk || !anyProvider) && (
        <div className="ai-warn">
          {!ffmpegOk
            ? 'ffmpeg 가 없어 프레임을 추출할 수 없습니다.'
            : '사용 가능한 AI CLI 가 없습니다 (codex/gemini/claude 중 하나 설치·로그인).'}
        </div>
      )}

      <div className="ai-actions">
        <div className="ai-mode ai-providers">
          <span className="ai-mode-label">AI</span>
          <div className="ai-seg ai-prov-seg">
            {(['codex', 'gemini', 'claude'] as AiProvider[]).map((p) => (
              <button
                key={p}
                className={provider === p ? 'on' : ''}
                disabled={disabled || !providersAvailable[p]}
                title={providersAvailable[p] ? PROVIDER_LABEL[p] : `${PROVIDER_LABEL[p]} — 미설치`}
                onClick={() => onProviderChange(p)}
              >
                <ProviderLogo provider={p} size={15} />
                <span>{PROVIDER_LABEL[p]}</span>
              </button>
            ))}
          </div>
        </div>
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
        <label
          className={`ai-audio${whisperFound ? '' : ' off'}`}
          title="음성을 전사해 대사·리액션도 하이라이트 근거로 사용(내장)"
        >
          <input
            type="checkbox"
            checked={useAudio && whisperFound}
            disabled={disabled || !whisperFound}
            onChange={(e) => onUseAudioChange(e.target.checked)}
          />
          🎙 음성(대사)도 분석
        </label>
        <button
          onClick={onHighlight}
          disabled={disabled || !ffmpegOk || !providerOk || !hasClips}
          title="타임라인의 영상을 AI가 화면(+음성)으로 분석해 하이라이트를 골라 배치"
        >
          🎯 AI 하이라이트
        </button>
      </div>
      <div className="ai-hint">
        {!hasClips
          ? '좌측 미디어를 아래 타임라인으로 드래그한 뒤 분석할 수 있어요.'
          : `대상: 타임라인 영상 · ${visionMode === 'fast' ? '빠름' : '정밀'}${useAudio && whisperFound ? ' · 🎙음성' : ''}`}
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
          placeholder={providerOk ? '편집 지시 입력…' : 'AI CLI 설치 시 사용 가능'}
          rows={2}
          disabled={disabled || !providerOk}
        />
        <button onClick={send} disabled={disabled || !providerOk || !text.trim()}>
          보내기
        </button>
      </div>
      {!anyProvider && (
        <div className="ai-hint dim">
          AI 편집은 codex/gemini/claude 중 하나 필요. 예: <code>npm i -g @openai/codex</code> → <code>codex login</code>
        </div>
      )}
    </div>
  )
}
