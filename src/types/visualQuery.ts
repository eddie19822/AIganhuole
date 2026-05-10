/** 画面向英文检索：一句镜头概括 + 多条不同侧重点的检索 */

export interface VisualStockQueriesResult {
  /** 若原文偏抽象，先概括「这一镜在拍什么」 */
  shotDescriptionEn: string
  /** 2～3 条，侧重不同（如动作 / 环境 / 光线情绪） */
  queries: string[]
  /** 素材标签应尽量体现的英文锚词（检索预排与重排用） */
  mustIncludeEn: string[]
  /** 易与口播混淆、出现在画面中则应靠后的英文主体提示 */
  avoidSubjectsEn: string[]
}
