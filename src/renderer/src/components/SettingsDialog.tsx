import { useState } from 'react'
import type { ProjectSettings } from '@shared/types'

export function SettingsDialog({
  settings,
  targetDurationSec,
  onClose,
  onSave
}: {
  settings: ProjectSettings
  targetDurationSec: number
  onClose: () => void
  onSave: (settings: ProjectSettings, targetDurationSec: number) => void
}): JSX.Element {
  const [pre, setPre] = useState(settings.preRollSec)
  const [post, setPost] = useState(settings.postRollSec)
  const [targetMin, setTargetMin] = useState(Math.round((targetDurationSec / 60) * 10) / 10)

  function save(): void {
    // 비유한수(NaN 등)는 기존값으로 폴백 → 설정에 NaN 이 새지 않게 한다.
    const safePre = Number.isFinite(pre) ? Math.max(0, pre) : settings.preRollSec
    const safePost = Number.isFinite(post) ? Math.max(0, post) : settings.postRollSec
    const safeTarget = Number.isFinite(targetMin)
      ? Math.max(10, Math.round(targetMin * 60))
      : targetDurationSec
    onSave({ ...settings, preRollSec: safePre, postRollSec: safePost }, safeTarget)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">설정</div>
        <div className="modal-body">
          <label className="field">
            <span>핵심 순간 앞 여유 (pre-roll, 초)</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={pre}
              onChange={(e) => setPre(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>핵심 순간 뒤 여유 (post-roll, 초)</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={post}
              onChange={(e) => setPost(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>목표 몽타주 길이 (분)</span>
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={targetMin}
              onChange={(e) => setTargetMin(Number(e.target.value))}
            />
          </label>
          <p className="field-note">
            설정 변경 후 <b>자동편집</b>을 다시 누르면 새 값으로 컷이 생성됩니다. 목표 길이를 넘으면
            오디오 점수가 낮은 컷부터 제외됩니다.
          </p>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={save}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
