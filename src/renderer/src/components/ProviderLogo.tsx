import type { AiProvider } from '@shared/ai-edit'

/** 각 AI 회사 브랜드 마크(인라인 SVG, 단순화). codex=OpenAI, gemini=Google, claude=Anthropic. */
export function ProviderLogo({ provider, size = 16 }: { provider: AiProvider; size?: number }): JSX.Element {
  if (provider === 'gemini') {
    // Antigravity(구글) — 상승 오빗 마크(블루→퍼플 그라데이션). 단순화 마크.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none">
        <defs>
          <linearGradient id="agy-g" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
            <stop stopColor="#4285F4" />
            <stop offset="1" stopColor="#9B72CB" />
          </linearGradient>
        </defs>
        <ellipse cx="12" cy="12" rx="9.5" ry="4.2" transform="rotate(-45 12 12)" stroke="url(#agy-g)" strokeWidth="1.8" />
        <path d="M12 4.5 L12 13 M12 4.5 L9.4 7.4 M12 4.5 L14.6 7.4" stroke="url(#agy-g)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="2.1" fill="url(#agy-g)" />
      </svg>
    )
  }
  if (provider === 'claude') {
    // Anthropic 버스트 마크(코랄)
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="#D97757">
        <g stroke="#D97757" strokeWidth="2.1" strokeLinecap="round">
          <line x1="12" y1="3" x2="12" y2="21" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
          <line x1="18.4" y1="5.6" x2="5.6" y2="18.4" />
        </g>
      </svg>
    )
  }
  // OpenAI(codex): 헥사고날 노트를 단순화한 마크
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3.2 19 7.1v9.8L12 20.8 5 16.9V7.1L12 3.2Z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  )
}
