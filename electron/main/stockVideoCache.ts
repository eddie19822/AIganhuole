import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { UnifiedStockVideo } from '../../src/types/stockVideo'
import { resolveStockDownloadUrl } from './stockVideoUrls'
import { isLikelyTransientNetworkError, mainFetch } from './mainFetch'
import { mapPool } from '../../src/lib/mapPool'

/** 主进程：后台预取成片缓存时的最大并发（1～32，默认 16），可用环境变量覆盖 */
export function stockCachePrefetchConcurrencyCap(): number {
  const raw = process.env.STOCK_CACHE_MAX_CONCURRENCY?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 1 && n <= 32) return n
  return 16
}

export function clampStockCachePrefetchConcurrency(requested: number): number {
  const cap = stockCachePrefetchConcurrencyCap()
  return Math.max(1, Math.min(cap, Math.floor(requested)))
}

/** 非选中素材仅缓存文件头前缀的字节数（默认约 2.5MB，便于前几秒播放） */
export function stockPreviewCacheMaxBytes(): number {
  const raw = process.env.STOCK_PREVIEW_CACHE_BYTES?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 200_000 && n <= 20_000_000) return n
  return 2_500_000
}

/** 导出阶段单次素材下载超时（毫秒），默认 15 分钟；可按网络调大 */
export function exportMaterializeDownloadTimeoutMs(): number {
  const raw = process.env.EXPORT_MATERIALIZE_TIMEOUT_MS?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 30_000 && n <= 3_600_000) return n
  return 900_000
}

export function stockVideoCacheDir(): string {
  return path.join(app.getPath('userData'), 'stock-video-cache')
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
}

export function cachedFilePathForDownloadUrl(url: string): string {
  return path.join(stockVideoCacheDir(), `${hashUrl(url)}.mp4`)
}

/** 仅前缀预览缓存（选中项完整缓存时不使用） */
export function previewFilePathForDownloadUrl(url: string): string {
  return path.join(stockVideoCacheDir(), `${hashUrl(url)}.preview.mp4`)
}

/** 供渲染进程拼 `<video src>`：指向 stock-cache 协议的本地文件 */
export function stockCacheProtocolUrlForAbsolutePath(absPath: string): string {
  const t = Buffer.from(absPath, 'utf8').toString('base64url')
  return `stock-cache://local/?t=${encodeURIComponent(t)}`
}

export function isPathUnderStockVideoCache(absPath: string): boolean {
  const root = path.normalize(stockVideoCacheDir())
  const norm = path.normalize(absPath)
  if (process.platform === 'win32') {
    const rel = path.relative(root.toLowerCase(), norm.toLowerCase())
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  const rel = path.relative(root, norm)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 解析可为本地 stock-cache、预览或远程 https */
export function resolveStockVideoPlayUrl(v: UnifiedStockVideo): {
  url: string
  kind: 'full' | 'preview' | 'remote'
} {
  const rawPrev = v.previewVideoUrl?.trim() ?? ''
  const dl = resolveStockDownloadUrl(v).trim()
  if (
    rawPrev.startsWith('jimeng-local:') ||
    rawPrev.startsWith('file:') ||
    rawPrev.startsWith('story-video:')
  ) {
    return { url: rawPrev || dl || '', kind: 'remote' }
  }
  if (!dl || !/^https?:\/\//i.test(dl)) {
    return { url: rawPrev || dl, kind: 'remote' }
  }
  const fullPath = cachedFilePathForDownloadUrl(dl)
  try {
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0) {
      return {
        url: stockCacheProtocolUrlForAbsolutePath(fullPath),
        kind: 'full',
      }
    }
  } catch {
    /* 走远程 */
  }
  const prevPath = previewFilePathForDownloadUrl(dl)
  try {
    if (fs.existsSync(prevPath) && fs.statSync(prevPath).size > 0) {
      return {
        url: stockCacheProtocolUrlForAbsolutePath(prevPath),
        kind: 'preview',
      }
    }
  } catch {
    /* 走远程 */
  }
  return { url: rawPrev || dl, kind: 'remote' }
}

const STOCK_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

/** 读 body 时 Chromium 仍可能抛 ERR_HTTP2_PROTOCOL_ERROR；换 Node undici 再拉一次 */
async function arrayBufferWithNodeFallback(
  url: string,
  init: RequestInit,
): Promise<ArrayBuffer> {
  const res = await mainFetch(url, init)
  if (!res.ok) {
    throw new Error(`下载预览视频失败 HTTP ${res.status}`)
  }
  return arrayBufferFromResponseWithFallback(res, url, init)
}

/** Response 已拿到，仅读 body 失败时（常见于 net::ERR_HTTP2_PROTOCOL_ERROR）换 undici */
async function arrayBufferFromResponseWithFallback(
  res: Response,
  url: string,
  init: RequestInit,
): Promise<ArrayBuffer> {
  try {
    return await res.arrayBuffer()
  } catch (bodyErr) {
    if (!isLikelyTransientNetworkError(bodyErr)) throw bodyErr
    const res2 = await globalThis.fetch(url, init)
    if (!res2.ok) {
      throw new Error(`下载预览视频失败 HTTP ${res2.status}`)
    }
    return await res2.arrayBuffer()
  }
}

async function fetchUrlToFile(
  url: string,
  dest: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  if (timeoutMs != null && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs)
  }
  try {
    const nodeFirst =
      process.env.STOCK_MATERIAL_FETCH_NODE_FIRST?.trim() === '1'
    const init: RequestInit = {
      headers: { 'User-Agent': STOCK_UA },
      signal: controller.signal,
    }
    let buf: Buffer
    if (nodeFirst) {
      try {
        const res0 = await globalThis.fetch(url, init)
        if (res0.ok) {
          buf = Buffer.from(await res0.arrayBuffer())
        } else {
          buf = Buffer.from(await arrayBufferWithNodeFallback(url, init))
        }
      } catch {
        buf = Buffer.from(await arrayBufferWithNodeFallback(url, init))
      }
    } else {
      buf = Buffer.from(await arrayBufferWithNodeFallback(url, init))
    }
    const tmp = `${dest}.part`
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, dest)
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    const msg = e instanceof Error ? e.message : String(e)
    if (name === 'AbortError' || /abort/i.test(msg)) {
      throw new Error(
        `下载素材超时（约 ${timeoutMs != null ? Math.round(timeoutMs / 1000) : '?'}s）。请检查网络或增大环境变量 EXPORT_MATERIALIZE_TIMEOUT_MS`,
      )
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 仅拉取前 maxBytes 字节（Range；若服务端返回 200 则读流截断） */
async function fetchPrefixToFile(
  url: string,
  dest: string,
  maxBytes: number,
): Promise<boolean> {
  const end = maxBytes - 1
  const init: RequestInit = {
    headers: {
      'User-Agent': STOCK_UA,
      Range: `bytes=0-${end}`,
    },
  }

  const writeBuf = (buf: Buffer): boolean => {
    if (buf.length === 0) return false
    const tmp = `${dest}.part`
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, dest)
    return true
  }

  const read200PrefixFromResponse = async (
    r: Response,
  ): Promise<Buffer | null> => {
    const reader = r.body?.getReader()
    if (!reader) return null
    const chunks: Buffer[] = []
    let total = 0
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.length > 0) {
        const need = maxBytes - total
        const slice =
          value.length > need
            ? Buffer.from(value.subarray(0, need))
            : Buffer.from(value)
        chunks.push(slice)
        total += slice.length
      }
    }
    if (total === 0) return null
    return Buffer.concat(chunks)
  }

  let res = await mainFetch(url, init)

  if (res.status === 206) {
    try {
      const buf = Buffer.from(
        await arrayBufferFromResponseWithFallback(res, url, init),
      )
      return writeBuf(buf)
    } catch {
      return false
    }
  }

  if (res.ok && res.status === 200) {
    try {
      const buf = await read200PrefixFromResponse(res)
      if (buf) return writeBuf(buf)
    } catch (e) {
      if (!isLikelyTransientNetworkError(e)) return false
      try {
        const res2 = await globalThis.fetch(url, init)
        if (!res2.ok || res2.status !== 200) return false
        const buf = await read200PrefixFromResponse(res2)
        if (buf) return writeBuf(buf)
      } catch {
        return false
      }
    }
    return false
  }

  return false
}

/**
 * 若解析为 https 地址且缓存未命中，则完整下载到 userData/stock-video-cache。
 * 用于搜索返回后后台预取，导出时可零下载命中缓存。
 */
export async function ensureStockVideoCached(
  v: UnifiedStockVideo,
): Promise<void> {
  const url = resolveStockDownloadUrl(v)
  if (!url || !/^https?:\/\//i.test(url)) return
  const dest = cachedFilePathForDownloadUrl(url)
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return
  } catch {
    /* 重新拉取 */
  }
  await fetchUrlToFile(url, dest)
  try {
    const prevPath = previewFilePathForDownloadUrl(url)
    if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath)
  } catch {
    /* ignore */
  }
}

/** 仅写入前缀预览文件（已有完整缓存则跳过） */
export async function ensureStockVideoPreviewCached(
  v: UnifiedStockVideo,
): Promise<void> {
  const url = resolveStockDownloadUrl(v)
  if (!url || !/^https?:\/\//i.test(url)) return
  const fullPath = cachedFilePathForDownloadUrl(url)
  try {
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0) return
  } catch {
    /* continue */
  }
  const previewPath = previewFilePathForDownloadUrl(url)
  try {
    if (fs.existsSync(previewPath) && fs.statSync(previewPath).size > 0) return
  } catch {
    /* continue */
  }
  const ok = await fetchPrefixToFile(url, previewPath, stockPreviewCacheMaxBytes())
  if (!ok) {
    console.warn('[stock-cache] preview prefix failed', v.key)
  }
}

export async function prefetchStockVideosToCache(
  videos: readonly UnifiedStockVideo[],
  concurrency: number,
): Promise<void> {
  if (videos.length === 0) return
  const c = clampStockCachePrefetchConcurrency(concurrency)
  await mapPool(videos, c, async (v) => {
    try {
      await ensureStockVideoCached(v)
    } catch (e) {
      console.warn(
        '[stock-cache] prefetch failed',
        v.key,
        e instanceof Error ? e.message : e,
      )
    }
  })
}

/** 选中素材完整缓存 + 其余仅前缀预览 */
export async function prefetchStockVideosTiered(options: {
  fullVideos: readonly UnifiedStockVideo[]
  previewVideos: readonly UnifiedStockVideo[]
  concurrencyFull?: number
  concurrencyPreview?: number
}): Promise<void> {
  const cf =
    typeof options.concurrencyFull === 'number' &&
    Number.isFinite(options.concurrencyFull)
      ? Math.max(1, Math.floor(options.concurrencyFull))
      : 3
  const cp =
    typeof options.concurrencyPreview === 'number' &&
    Number.isFinite(options.concurrencyPreview)
      ? Math.max(1, Math.floor(options.concurrencyPreview))
      : Math.min(8, stockCachePrefetchConcurrencyCap())

  await Promise.all([
    mapPool(options.fullVideos, cf, async (v) => {
      try {
        await ensureStockVideoCached(v)
      } catch (e) {
        console.warn(
          '[stock-cache] full prefetch failed',
          v.key,
          e instanceof Error ? e.message : e,
        )
      }
    }),
    mapPool(options.previewVideos, cp, async (v) => {
      try {
        await ensureStockVideoPreviewCached(v)
      } catch (e) {
        console.warn(
          '[stock-cache] preview prefetch failed',
          v.key,
          e instanceof Error ? e.message : e,
        )
      }
    }),
  ])
}

/** 用户点击播放后：拉完整缓存并删除前缀文件 */
export async function ensureStockVideoFullThenInvalidatePreview(
  v: UnifiedStockVideo,
): Promise<{ ok: boolean }> {
  const url = resolveStockDownloadUrl(v)
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false }
  const fullPath = cachedFilePathForDownloadUrl(url)
  try {
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0) {
      return { ok: true }
    }
  } catch {
    /* download */
  }
  try {
    await fetchUrlToFile(url, fullPath)
    const prevPath = previewFilePathForDownloadUrl(url)
    try {
      if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath)
    } catch {
      /* ignore */
    }
    return { ok: true }
  } catch (e) {
    console.warn(
      '[stock-cache] ensure full failed',
      v.key,
      e instanceof Error ? e.message : e,
    )
    return { ok: false }
  }
}

/**
 * 将成片素材落到导出临时路径：优先从缓存复制，否则下载并写入缓存。
 */
export async function materializeStockVideoForSegment(
  v: UnifiedStockVideo,
  destPath: string,
): Promise<void> {
  const url = resolveStockDownloadUrl(v)
  if (!url) throw new Error('缺少预览视频地址')
  const isHttp = /^https?:\/\//i.test(url)
  if (isHttp) {
    const cache = cachedFilePathForDownloadUrl(url)
    try {
      if (fs.existsSync(cache) && fs.statSync(cache).size > 0) {
        fs.copyFileSync(cache, destPath)
        return
      }
    } catch {
      /* 走下载 */
    }
  }
  await fetchUrlToFile(url, destPath, {
    timeoutMs: exportMaterializeDownloadTimeoutMs(),
  })
  if (isHttp) {
    try {
      const cache = cachedFilePathForDownloadUrl(url)
      fs.mkdirSync(path.dirname(cache), { recursive: true })
      fs.copyFileSync(destPath, cache)
      const prevPath = previewFilePathForDownloadUrl(url)
      try {
        if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath)
      } catch {
        /* ignore */
      }
    } catch {
      /* 缓存失败不阻断导出 */
    }
  }
}
