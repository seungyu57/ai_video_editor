import { useEffect, useRef, useState } from 'react'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

export function ChatPanel({
  messages,
  busy,
  codexAvailable,
  hasPending,
  onSend,
  onApply,
  onCancel,
  onExport,
  canExport
}: {
  messages: ChatMessage[]
  busy: boolean
  codexAvailable: boolean
  hasPending: boolean
  onSend: (text: string) => void
  onApply: () => void
  onCancel: () => void
  onExport: () => void
  canExport: boolean
}): JSX.Element {
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, hasPending])

  function submit(): void {
    const t = input.trim()
    if (!t || busy || hasPending) return
    onSend(t)
    setInput('')
  }

  return (
    <div className="chat">
      <div className="chat-head">💬 Codex 편집</div>

      {!codexAvailable && (
        <div className="chat-locked">
          Codex CLI 가 없어 대화형 편집이 잠겨 있습니다.
          <br />
          <code>npm install -g @openai/codex</code> 후 <code>codex login</code> 하세요.
        </div>
      )}

      <div className="chat-log">
        {messages.length === 0 && codexAvailable && (
          <div className="chat-hint">
            예: “3번 컷 빼줘”, “1번 앞에 2초 더 붙여”, “가장 짧은 컷 삭제”, “현재 설정으로 다시
            만들어”
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">{m.text}</div>
          </div>
        ))}
        {busy && <div className="chat-msg assistant"><div className="chat-bubble">…</div></div>}
        <div ref={endRef} />
      </div>

      {hasPending && (
        <div className="pending-bar">
          <span>이 변경을 적용할까요?</span>
          <div className="pending-actions">
            <button className="primary" onClick={onApply} disabled={busy}>
              적용
            </button>
            <button onClick={onCancel} disabled={busy}>
              되돌리기
            </button>
          </div>
        </div>
      )}

      <div className="chat-input">
        <textarea
          value={input}
          placeholder={
            hasPending
              ? '먼저 적용/되돌리기를 선택하세요'
              : codexAvailable
                ? '편집 지시를 입력…'
                : 'Codex 미설치'
          }
          disabled={!codexAvailable || busy || hasPending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          className="primary"
          onClick={submit}
          disabled={!codexAvailable || busy || hasPending || !input.trim()}
        >
          보내기
        </button>
      </div>

      <button className="export-btn" onClick={onExport} disabled={!canExport || busy || hasPending}>
        ⬇ 몽타주 내보내기
      </button>
    </div>
  )
}
