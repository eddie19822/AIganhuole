export interface PexelsVideoFile {
  id: number
  quality: string
  file_type: string
  width: number
  height: number
  link: string
}

export interface PexelsUser {
  id: number
  name: string
  url: string
}

export interface PexelsVideo {
  id: number
  width: number
  height: number
  url: string
  image: string
  duration: number
  /** API 可能返回标签对象或字符串 */
  tags?: Array<{ title: string } | string>
  user: PexelsUser
  video_files: PexelsVideoFile[]
}

export interface PexelsVideoSearchResponse {
  page: number
  per_page: number
  total_results: number
  url: string
  videos: PexelsVideo[]
}
