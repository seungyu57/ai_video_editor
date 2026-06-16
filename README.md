# ClipReel — 게임 하이라이트 자동 편집기

NVIDIA 하이라이트 클립 폴더를 불러오면, 오디오 피크를 기준으로 군더더기를 잘라
**타이트한 컷 몽타주(10분 내외)** 를 자동으로 만들어 주는 윈도우 데스크톱 앱입니다.
원본 파일은 절대 수정하지 않습니다(비파괴 편집).

## 진행 상황

- [x] **M0** — 뼈대 · 폴더 불러오기 · 메타 표시 · 미리보기 재생 · `.clipreel` 저장/열기
- [x] **M1** — 자동 하이라이트(오디오 피크) · 몽타주 조립 · 단일 mp4 내보내기
- [x] **M2** — Codex 대화형 편집(자연어→편집연산) · diff 미리보기 · 무제한 undo/redo · 히스토리
- [x] **M3** — AI 화면 판단(신호 ②, codex 비전, opt-in) · 오디오만으로 graceful fallback
- [x] **M4** — 설정 UI(pre/post-roll·목표 길이) · 단축키 · 로컬 컷 삭제 · 에러 안내

### 단축키
| 키 | 동작 |
|---|---|
| `Ctrl+Z` / `Ctrl+Shift+Z` (`Ctrl+Y`) | 실행 취소 / 다시 실행 |
| `Ctrl+S` / `Ctrl+O` | 저장 / 열기 |
| `Ctrl+E` | 몽타주 내보내기 |
| `Delete` / `Backspace` | 선택한 타임라인 컷 삭제 |
| `Esc` | 설정 닫기 / 제안 미리보기 취소 |

## 첫 실행 (윈도우)

```powershell
# 1) Node 22+ 확인
node -v

# 2) (M2부터 필요) Codex CLI 설치 + 로그인 — 지금 단계에선 없어도 됩니다
npm install -g @openai/codex
codex login

# 3) 의존성 설치 + 개발 실행
npm install
npm run dev
```

`npm run dev` 를 실행하면 ClipReel 창이 뜹니다.
**📂 폴더 불러오기** → 클립이 들어 있는 폴더를 고르면 목록과 메타데이터가 표시되고,
클립을 클릭하면 미리보기가 재생됩니다. **저장**으로 `.clipreel` 프로젝트 파일을 만들 수 있습니다.

> ffmpeg/ffprobe 는 `ffmpeg-static` / `ffprobe-static` 로 자동 번들됩니다(시스템 설치 불필요).

## 스크립트

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 모드 실행(핫리로드) |
| `npm run build` | 프로덕션 빌드 |
| `npm run typecheck` | 타입 체크(메인+렌더러) |

## 구조

```
src/
├─ main/      Electron 메인 — ffmpeg, 폴더 스캔, 프로젝트 저장, media:// 프로토콜
├─ preload/   contextBridge API (window.clipreel)
├─ renderer/  React UI (Vite)
└─ shared/    공유 타입 (데이터 모델)
```
