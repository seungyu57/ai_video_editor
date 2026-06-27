import { useEffect, useRef, useState } from 'react'
import type { AiProvider } from '@shared/ai-edit'

/** AI 작업지시(ai-agent.md) 편집 모달. 저장 시 다음 분석부터 즉시 반영. */
export function InstructionsModal({
  provider,
  onClose
}: {
  provider: AiProvider
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [isCustom, setIsCustom] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [game, setGame] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genErr, setGenErr] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    window.clipreel
      .getInstructions()
      .then((r) => {
        setText(r.text)
        setIsCustom(r.isCustom)
      })
      .finally(() => setLoading(false))
  }, [])

  async function save(): Promise<void> {
    await window.clipreel.saveInstructions(text)
    setIsCustom(true)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  async function reset(): Promise<void> {
    if (!window.confirm('기본 지침으로 되돌릴까요? 수정 내용이 사라집니다.')) return
    const def = await window.clipreel.resetInstructions()
    setText(def)
    setIsCustom(false)
  }
  async function generate(): Promise<void> {
    const g = game.trim()
    if (!g || generating) return
    setGenerating(true)
    setGenErr(null)
    try {
      const r = await window.clipreel.generateInstructions(g, text, provider)
      if (r.error) setGenErr(r.error)
      else if (r.text) setText(r.text) // 미리보기 — 확인 후 저장 버튼으로 적용
    } catch (e) {
      setGenErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>📋 AI 작업지시 {isCustom ? '· 사용자 수정됨' : '· 기본'}</span>
          <button className="modal-x" onClick={onClose} title="닫기">✕</button>
        </div>
        <p className="modal-desc">
          AI가 하이라이트·편집 전에 읽는 지침이에요. 직접 적어도 되고, 아래에 <b>게임만 알려주면 AI가
          그 게임에 맞게 지침을 고쳐</b>줍니다. (생성 결과는 미리보기 — 확인 후 저장)
        </p>
        <div className="modal-gen">
          <input
            className="modal-gen-input"
            placeholder="게임 설명 (예: 발로란트, 배그 1인칭, 리그오브레전드…)"
            value={game}
            disabled={generating}
            onChange={(e) => setGame(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void generate() }}
          />
          <button className="primary" onClick={generate} disabled={generating || !game.trim()}>
            {generating ? `생성 중(${provider})…` : '✨ AI로 지침 생성'}
          </button>
        </div>
        {genErr && <div className="modal-generr">{genErr}</div>}
        <textarea
          ref={taRef}
          className="modal-textarea"
          value={loading ? '불러오는 중…' : text}
          disabled={loading}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <div className="modal-actions">
          <button onClick={reset} disabled={loading} title="기본 지침으로 복원">기본값 복원</button>
          <span className="modal-spacer" />
          {saved && <span className="modal-saved">저장됨 ✓</span>}
          <button onClick={onClose}>닫기</button>
          <button className="primary" onClick={save} disabled={loading}>저장</button>
        </div>
      </div>
    </div>
  )
}
