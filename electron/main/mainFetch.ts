import { net } from 'electron'

/** 把 undici/net 的「fetch failed」展开成更可读的原因（如证书、ECONNRESET） */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const parts: string[] = [err.message]
  const c = (err as Error & { cause?: unknown }).cause
  if (c instanceof Error) {
    parts.push(c.message)
  } else if (c != null && typeof c === 'object' && 'code' in c) {
    parts.push(String((c as { code?: string }).code))
  }
  return parts.filter(Boolean).join(' · ')
}

/**
 * Chromium 偶发 net::ERR_HTTP2_PROTOCOL_ERROR（CDN/代理/长连接）；同一 URL 用 Node undici 有时可成功。
 */
const TRANSIENT_NET_ERR =
  /ERR_HTTP2|HTTP2_PROTOCOL|PROTOCOL_ERROR|ECONNRESET|ETIMEDOUT|CONNECTION_CLOSED|ERR_NETWORK|ERR_CONNECTION|CONNECTION_REFUSED|net::/i

/** 导出给素材下载：读 body 阶段也可能出现 Chromium HTTP/2 协议错误 */
export function isLikelyTransientNetworkError(err: unknown): boolean {
  return TRANSIENT_NET_ERR.test(describeFetchError(err))
}

function isLikelyTransientFetchFailure(err: unknown): boolean {
  return isLikelyTransientNetworkError(err)
}

/**
 * 主进程出站 HTTPS：
 * 1. 优先 `net.fetch`（Chromium，可走系统代理），对瞬时错误最多重试 3 次；
 * 2. 仍失败则回退 `globalThis.fetch`（undici），协商栈不同，可规避部分 HTTP/2 问题。
 */
export async function mainFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = String(input)
  let lastErr: unknown

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 250 * attempt))
      }
      return await net.fetch(url, init)
    } catch (e) {
      lastErr = e
      const transient = isLikelyTransientFetchFailure(e)
      if (transient && attempt < 2) continue
      break
    }
  }

  try {
    return await globalThis.fetch(url, init)
  } catch (e2) {
    const a = lastErr != null ? describeFetchError(lastErr) : ''
    const b = describeFetchError(e2)
    const msg =
      a && a !== b
        ? `${a}（回退 Node fetch：${b}）`
        : b || a || 'fetch failed'
    throw new Error(msg)
  }
}
