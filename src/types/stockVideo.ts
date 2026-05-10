/** 统一展示：Pexels、Pixabay、Mixkit（网页抓取）视频条目 */

export interface UnifiedStockVideo {
  /** 即梦视频生成（与素材站条目结构一致，便于导出合成） */
  source: 'pexels' | 'pixabay' | 'mixkit' | 'jimeng'
  /** 列表 key，如 pexels-123、pixabay-456 */
  key: string
  pageUrl: string
  duration: number
  authorName: string
  /** 列表缩略图（Pixabay 为各尺寸配套 .jpg） */
  thumbnailUrl: string
  /** 预览/下载用最高可用清晰度 MP4 */
  previewVideoUrl: string
  /** 标题/标签/slug 等拼接，供大模型与口播句对齐做二次排序 */
  rerankText?: string
}

export interface StockSearchResponse {
  videos: UnifiedStockVideo[]
  /** 某一站请求失败时记录，不阻断另一站结果 */
  warnings: string[]
}
