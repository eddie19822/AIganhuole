/** 阿里云口播分段返回（含可选的每段英文画面提示，用于素材检索） */

export interface SegmentVoiceOverResult {
  segments: string[]
  /** 与 segments 等长；空字符串表示无单独画面提示 */
  visualHintsEn: (string | null)[]
}
