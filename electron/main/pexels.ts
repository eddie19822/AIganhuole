import type { PexelsVideoSearchResponse } from '../../src/types/pexels'
import { mainFetch } from './mainFetch'

export async function searchPexelsVideos(
  apiKey: string,
  query: string,
  perPage = 12,
  page = 1,
): Promise<PexelsVideoSearchResponse> {
  const url = new URL('https://api.pexels.com/videos/search')
  url.searchParams.set('query', query)
  url.searchParams.set('per_page', String(perPage))
  url.searchParams.set('page', String(Math.max(1, page)))

  const res = await mainFetch(url.toString(), {
    headers: { Authorization: apiKey },
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Pexels HTTP ${res.status}: ${text.slice(0, 400)}`)
  }

  return JSON.parse(text) as PexelsVideoSearchResponse
}
