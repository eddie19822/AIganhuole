/**
 * 豆包语音合成大模型 — V3 HTTP SSE（新版控制台仅需 API Key）
 * https://www.volcengine.com/docs/6561/1598757
 *
 * 请求路径：`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse`
 * Headers: `X-Api-Key`、`X-Api-Resource-Id`（如 seed-tts-2.0）
 */

import { randomUUID } from 'node:crypto'
import { mainFetch } from './mainFetch'

const TTS_SSE_URL =
  'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse'

export interface DoubaoTtsV3Options {
  apiKey: string
  /** 与计费/音色版本绑定，如 seed-tts-2.0、seed-tts-1.0 */
  resourceId: string
  text: string
  /** 音色 ID，须与 resourceId 对应版本的音色列表一致 */
  speaker: string
  sampleRate?: number
}

/** 解析 SSE：拼接含音频 payload 的 data 行（常见 event 352）为完整 MP3 */
function concatMp3FromSseBody(sseBody: string): Buffer {
  const chunks: Buffer[] = []
  let lastErr = ''
  let eventId = ''

  for (const line of sseBody.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventId = line.slice(6).trim()
      continue
    }
    if (!line.startsWith('data:')) continue

    const raw = line.slice(5).trim()
    if (!raw) continue

    try {
      const obj = JSON.parse(raw) as {
        code?: number
        message?: string
        data?: string | null
      }

      if (eventId === '153') {
        lastErr = obj.message ?? 'SessionFailed'
      }

      const c = obj.code
      if (
        typeof c === 'number' &&
        c !== 0 &&
        c !== 20000000 &&
        (c >= 40000000 ||
          c === 40402003 ||
          c === 45000000 ||
          c === 55000000)
      ) {
        lastErr = obj.message ?? `code ${c}`
      }

      if (typeof obj.data === 'string' && obj.data.length > 0) {
        chunks.push(Buffer.from(obj.data, 'base64'))
      }
    } catch {
      /* 忽略非 JSON 行 */
    }
  }

  if (chunks.length === 0) {
    throw new Error(
      lastErr ||
        '豆包 TTS 未返回音频：请检查 API Key、VOLC_TTS_RESOURCE_ID 与 VOLC_TTS_SPEAKER 是否与控制台音色版本一致',
    )
  }

  return Buffer.concat(chunks)
}

/** 返回 MP3 的 base64（不含 data: 前缀） */
export async function synthesizeDoubaoTtsMp3Base64(
  options: DoubaoTtsV3Options,
): Promise<string> {
  const {
    apiKey,
    resourceId,
    text,
    speaker,
    sampleRate = 24000,
  } = options

  const clean = text.trim()
  if (!clean) throw new Error('合成文本为空')

  const body = {
    user: {
      uid: 'story-stock-desktop',
    },
    req_params: {
      text: clean.slice(0, 1024),
      speaker,
      audio_params: {
        format: 'mp3',
        sample_rate: sampleRate,
      },
    },
  }

  const res = await mainFetch(TTS_SSE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify(body),
  })

  const sseText = await res.text()
  if (!res.ok) {
    throw new Error(
      `豆包 TTS HTTP ${res.status}: ${sseText.slice(0, 600)}`,
    )
  }

  const buf = concatMp3FromSseBody(sseText)
  return buf.toString('base64')
}
