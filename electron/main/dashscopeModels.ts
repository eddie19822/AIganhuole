/**
 * DashScope 兼容 Chat Completions：多模型降级链。
 * 参考阿里云百炼错误说明（额度/限流/模型无权访问等）：遇到「换模型可能有用」的错误时依次尝试下一模型。
 * https://help.aliyun.com/zh/model-studio/developer-reference/status-codes
 */

import { readUserApiSettings } from './userApiSettings'
import { mainFetch } from './mainFetch'

/** 北京地域默认；新加坡等国际密钥需改环境变量；可在应用设置中覆盖 URL */
export function dashscopeChatCompletionsUrl(): string {
  const u = readUserApiSettings()
  const fromUser = u.dashscopeChatCompletionsUrl?.trim()
  const fromEnv = process.env.DASHSCOPE_CHAT_COMPLETIONS_URL?.trim()
  if (fromUser) return fromUser
  if (fromEnv) return fromEnv
  return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
}

/**
 * 解析 Chat Completions 模型顺序：从左到右优先尝试（左侧视为更强/更优先）。
 * - `DASHSCOPE_MODEL_CHAIN`：逗号分隔，例如 `qwen-plus,qwen-turbo,qwen-flash`
 * - 未配置时：仅使用 `DASHSCOPE_MODEL`（默认 qwen-turbo）
 */
export function getDashscopeChatModelChain(explicitSingle?: string | null): string[] {
  if (explicitSingle?.trim()) return [explicitSingle.trim()]

  const u = readUserApiSettings()
  const chainRaw =
    u.dashscopeModelChain?.trim() || process.env.DASHSCOPE_MODEL_CHAIN?.trim()
  if (chainRaw) {
    const parts = chainRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    const seen = new Set<string>()
    const out: string[] = []
    for (const p of parts) {
      const k = p.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(p)
    }
    if (out.length > 0) return out
  }

  const single =
    u.dashscopeModel?.trim() ||
    process.env.DASHSCOPE_MODEL?.trim() ||
    'qwen-turbo'
  return [single]
}

function dashscopeErrorMessage(json: unknown): string {
  const j = json as { error?: { message?: string; code?: string } }
  return (
    j?.error?.message ??
    (typeof j?.error?.code === 'string' ? j.error.code : '') ??
    ''
  )
}

/**
 * 当前响应是否适合「换下一个模型」重试（额度、模型无权、限流等与模型/计费相关的失败）。
 * 同一 API Key 下欠费类错误换模型通常无效，但免费额度按模型区分时切换仍可能有效。
 */
export function shouldRetryDashscopeChatWithNextModel(
  httpStatus: number,
  rawBody: string,
): boolean {
  const lower = rawBody.toLowerCase()

  if (httpStatus === 401 || httpStatus === 404) return false

  // Key 无效 / 认证失败 — 换模型无效
  if (
    /invalid.*api[_-]?key|incorrect.*api[_-]?key|invalid_api_key|authentication|鉴权|无效的\s*api/i.test(
      lower,
    )
  )
    return false

  // 文档常见：429 限流与额度、403 模型无权 / 免费额度、400-Throttling.AllocationQuota 等
  if (httpStatus === 429) return true
  if (httpStatus === 403) return true
  if (httpStatus === 402) return true

  if (httpStatus === 400) {
    if (
      /throttling|allocationquota|allocation_quota|commoditynotpurchased/i.test(
        lower,
      )
    )
      return true
    return false
  }

  if (
    /insufficient_quota|allocationquota|allocation_quota|free allocated quota|free tier only|额度|欠费|余额不足|无权访问此模型|model\.access|accessdenied|access_denied|app\.accessdenied|workspace\.accessdenied|prepaidbilloverdue|postpaidbilloverdue/i.test(
      lower,
    )
  ) {
    return httpStatus >= 400 && httpStatus !== 401
  }

  return false
}

export type DashscopeChatJsonSuccess = {
  json: unknown
  raw: string
  modelUsed: string
}

/**
 * 对 Chat Completions 发起请求；失败且命中「可换模型」时在链上依次重试，直至成功或用尽模型。
 */
export async function fetchDashscopeChatCompletionJsonWithModelFallback(
  apiKey: string,
  buildBody: (model: string) => Record<string, unknown>,
  explicitSingleModel?: string | null,
): Promise<DashscopeChatJsonSuccess> {
  const models = getDashscopeChatModelChain(explicitSingleModel)
  const failures: string[] = []

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!
    const res = await mainFetch(dashscopeChatCompletionsUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBody(model)),
    })
    const raw = await res.text()

    let json: unknown
    try {
      json = JSON.parse(raw) as unknown
    } catch {
      const hint = `DashScope 非 JSON 响应 (${res.status})`
      failures.push(`${model}: ${hint}`)
      if (
        i < models.length - 1 &&
        shouldRetryDashscopeChatWithNextModel(res.status, raw)
      ) {
        console.warn(
          `[dashscope] model "${model}" ${hint.slice(0, 80)} → try "${models[i + 1]}"`,
        )
        continue
      }
      throw new Error(`${hint}: ${raw.slice(0, 400)}`)
    }

    if (!res.ok) {
      const msg =
        dashscopeErrorMessage(json) || `DashScope HTTP ${res.status}`
      failures.push(`${model}: ${msg}`)
      if (
        i < models.length - 1 &&
        shouldRetryDashscopeChatWithNextModel(res.status, raw)
      ) {
        console.warn(
          `[dashscope] model "${model}" failed (${res.status}): ${msg.slice(0, 140)} → try "${models[i + 1]}"`,
        )
        continue
      }
      throw new Error(msg)
    }

    if (i > 0) {
      console.info(
        `[dashscope] chat completions OK with fallback model "${model}" (${i + 1}/${models.length})`,
      )
    }
    return { json, raw, modelUsed: model }
  }

  throw new Error(
    failures.length > 0
      ? failures.join(' · ')
      : 'DashScope：没有可用的 Chat 模型配置',
  )
}
