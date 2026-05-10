/**
 * Pixabay Video API
 * https://pixabay.com/api/docs/#api_search_videos
 */

import { mainFetch } from './mainFetch'

export interface PixabayVideoRendition {
  url: string
  width: number
  height: number
  size: number
  thumbnail?: string
}

export interface PixabayVideoHit {
  id: number
  pageURL: string
  /** 部分响应可能含标题，用于素材语义排序 */
  title?: string
  duration: number
  user: string
  /** 逗号分隔关键词 */
  tags?: string
  videos: {
    large?: PixabayVideoRendition
    medium?: PixabayVideoRendition
    small?: PixabayVideoRendition
    tiny?: PixabayVideoRendition
  }
}

export interface PixabayVideoSearchResponse {
  total: number
  totalHits: number
  hits: PixabayVideoHit[]
}

export async function searchPixabayVideos(
  apiKey: string,
  query: string,
  perPage = 6,
  page = 1,
): Promise<PixabayVideoSearchResponse> {
  const url = new URL('https://pixabay.com/api/videos/')
  url.searchParams.set('key', apiKey)
  url.searchParams.set('q', query)
  url.searchParams.set('per_page', String(perPage))
  url.searchParams.set('page', String(Math.max(1, page)))
  url.searchParams.set('safesearch', 'true')

  const res = await mainFetch(url.toString())
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Pixabay HTTP ${res.status}: ${text.slice(0, 400)}`)
  }
  return JSON.parse(text) as PixabayVideoSearchResponse
}
