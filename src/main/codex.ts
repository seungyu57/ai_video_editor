// Codex CLI 연동 (스펙 §7). 자연어 지시 → 편집연산 JSON(EditOp[]) 변환.
// LLM 은 영상을 직접 만지지 않는다. 정해진 연산만 출력하게 강제하고 앱이 검증/적용.

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EditOp, Project } from '@shared/types'

const execFileAsync = promisify(execFile)

/** codex CLI 가 PATH 에 있는지 확인. */
export async function detectCodex(): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    await execFileAsync(cmd, ['codex'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

// 편집연산 필드 목록 (op 외). null 정리에 재사용.
const OP_FIELDS = [
  'clipId',
  'sourceId',
  'inSec',
  'outSec',
  'preSec',
  'postSec',
  'toOrder',
  'rate',
  'note'
] as const

// EditOp[] 출력 강제용 JSON Schema. codex exec --output-schema 대상.
// OpenAI strict structured outputs 는 oneOf 를 불허하고 모든 property 를 required 로 요구하므로,
// "모든 필드를 가진 평면 op 객체(미사용 필드는 null)" 패턴을 쓴다. 파싱 시 null 을 제거해 EditOp 로 정규화.
function editOpsSchema(): object {
  const numOrNull = { type: ['number', 'null'] }
  const strOrNull = { type: ['string', 'null'] }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ops: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: {
              type: 'string',
              enum: ['cut', 'trim', 'pad', 'reorder', 'speed', 'addClip', 'rebuild', 'addMarker']
            },
            clipId: strOrNull,
            sourceId: strOrNull,
            inSec: numOrNull,
            outSec: numOrNull,
            preSec: numOrNull,
            postSec: numOrNull,
            toOrder: numOrNull,
            rate: numOrNull,
            note: strOrNull
          },
          required: ['op', ...OP_FIELDS]
        }
      }
    },
    required: ['ops']
  }
}

/** 타임라인 + 소스 상태를 프롬프트용 텍스트로 요약. */
function buildPrompt(project: Project, userMessage: string): string {
  const sourceName = new Map(project.sources.map((s) => [s.id, s.name]))
  const clipLines = [...project.timeline.clips]
    .sort((a, b) => a.order - b.order)
    .map((c) => {
      const len = (c.outSec - c.inSec).toFixed(1)
      const reasons = c.reasons.join(', ')
      return `  - id=${c.id} order=${c.order} source="${sourceName.get(c.sourceId) ?? c.sourceId}" in=${c.inSec.toFixed(2)} out=${c.outSec.toFixed(2)} len=${len}s speed=${c.speed} reasons=[${reasons}]`
    })
    .join('\n')
  const srcLines = project.sources
    .map((s) => `  - id=${s.id} name="${s.name}" duration=${s.durationSec.toFixed(1)}s`)
    .join('\n')

  return `너는 비디오 컷편집 어시스턴트다. 아래 타임라인 상태와 사용자 지시를 보고,
적용할 편집 연산 목록을 JSON 으로만 출력한다. 영상을 직접 만지지 말고 연산만 낸다.

[현재 타임라인 클립] (order 순)
${clipLines || '  (없음)'}

[원본 소스 목록] (addClip 에 사용)
${srcLines || '  (없음)'}

[사용 가능한 편집 연산]
- {"op":"cut","clipId":"..."}                                  컷 삭제
- {"op":"trim","clipId":"...","inSec":n,"outSec":n}            시작/끝 시점 조정(초)
- {"op":"pad","clipId":"...","preSec":n,"postSec":n}          앞/뒤 더 붙이기(초)
- {"op":"reorder","clipId":"...","toOrder":n}                  순서 이동(0부터)
- {"op":"speed","clipId":"...","rate":n}                       배속(1=기본)
- {"op":"addClip","sourceId":"...","inSec":n,"outSec":n}      소스에서 새 컷 추가
- {"op":"rebuild"}                                             현재 설정으로 자동 초안 재생성
- {"op":"addMarker","clipId":"...","note":"..."}             클립에 메모 태그

[사용자 지시]
${userMessage}

[출력 규칙]
- 반드시 {"ops":[ ... ]} 형태의 JSON 하나만 출력. 설명/코드펜스/추가 텍스트 금지.
- 지시와 무관한 연산은 만들지 말 것. 바꿀 게 없으면 {"ops":[]}.
- clipId / sourceId 는 위 목록의 실제 id 만 사용.
- 각 연산 객체는 op 외 사용하지 않는 필드는 null 로 둔다.`
}

export interface CodexEditResult {
  ops: EditOp[]
  raw: string
  error?: string
}

/** codex exec 를 헤드리스로 호출해 편집연산 JSON 을 얻는다. */
export async function requestEdits(
  project: Project,
  userMessage: string
): Promise<CodexEditResult> {
  const dir = await mkdtemp(join(tmpdir(), 'clipreel-codex-'))
  const schemaPath = join(dir, 'editops.schema.json')
  const outPath = join(dir, 'last-message.txt')
  const prompt = buildPrompt(project, userMessage)

  try {
    await writeFile(schemaPath, JSON.stringify(editOpsSchema(), null, 2), 'utf-8')

    const raw = await runCodexExec(prompt, schemaPath, outPath)
    const text = (await readFile(outPath, 'utf-8').catch(() => '')) || raw
    const ops = parseOps(text)
    return { ops, raw: text }
  } catch (e) {
    return { ops: [], raw: '', error: e instanceof Error ? e.message : String(e) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runCodexExec(prompt: string, schemaPath: string, outPath: string): Promise<string> {
  const isWin = process.platform === 'win32'
  // 프롬프트는 stdin 으로 전달(따옴표/길이 문제 회피). 경로 인자는 따옴표 처리.
  const command = isWin
    ? `codex exec --skip-git-repo-check -s read-only --color never --output-schema "${schemaPath}" -o "${outPath}" -`
    : 'codex'
  const args = isWin
    ? []
    : [
        'exec',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '--color',
        'never',
        '--output-schema',
        schemaPath,
        '-o',
        outPath,
        '-'
      ]

  return new Promise((resolvePromise, reject) => {
    const proc = isWin
      ? spawn(command, { shell: true, windowsHide: true })
      : spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 16000) stderr = stderr.slice(-16000)
    })
    proc.on('error', (err) =>
      reject(new Error(`codex 실행 실패: ${err.message}. codex 가 설치/로그인 됐는지 확인하세요.`))
    )
    proc.on('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else {
        const hint = /login|auth|unauthor/i.test(stderr)
          ? '\ncodex login 으로 ChatGPT 로그인이 필요할 수 있습니다.'
          : ''
        reject(new Error(`codex 종료 코드 ${code}\n${stderr.slice(-1500)}${hint}`))
      }
    })
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

/** 평면 op 객체(미사용 필드 null)를 깔끔한 EditOp 로 정규화. */
function cleanOp(raw: Record<string, unknown>): EditOp | null {
  if (!raw || typeof raw.op !== 'string') return null
  const o: Record<string, unknown> = { op: raw.op }
  for (const k of OP_FIELDS) {
    const v = raw[k]
    if (v !== null && v !== undefined) o[k] = v
  }
  return o as EditOp
}

/** 모델 출력에서 {ops:[...]} 추출. 코드펜스/잡텍스트가 섞여도 견고하게. */
function parseOps(text: string): EditOp[] {
  const tryParse = (s: string): Record<string, unknown>[] | null => {
    try {
      const obj = JSON.parse(s)
      if (obj && Array.isArray(obj.ops)) return obj.ops as Record<string, unknown>[]
      if (Array.isArray(obj)) return obj as Record<string, unknown>[]
      return null
    } catch {
      return null
    }
  }
  const normalize = (arr: Record<string, unknown>[]): EditOp[] =>
    arr.map(cleanOp).filter((o): o is EditOp => o !== null)

  // 1) 통째로 파싱
  let arr = tryParse(text.trim())
  if (arr) return normalize(arr)
  // 2) 코드펜스 제거 후
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    arr = tryParse(fenced[1].trim())
    if (arr) return normalize(arr)
  }
  // 3) 첫 '{' ~ 마지막 '}' 구간
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    arr = tryParse(text.slice(first, last + 1))
    if (arr) return normalize(arr)
  }
  throw new Error(`편집 연산 JSON 을 파싱할 수 없습니다:\n${text.slice(0, 500)}`)
}
