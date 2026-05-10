/** 主进程 onProgress 负载；IPC 会再附加 segmentIndex */
export interface JimengProgressPayload {
  percent: number
  label: string
  detail?: string
  /** 本段豆包 TTS 测得的口播时长（秒） */
  voiceDurationSec?: number
  /**
   * 本应用为即梦文生视频选择的成片档位（秒），与口播对齐；非服务端「可生成上限」。
   * 公开文档中未见单独「可查询当前账号可生成秒数」的接口，故以本端档位为准展示。
   */
  targetGenDurationSec?: number
  /** 查询结果中的任务状态（若接口返回，如 processing / done） */
  serverStatusLabel?: string
}

/** 主进程 → 渲染进程：即梦视频生成进度 */
export interface JimengVideoProgress extends JimengProgressPayload {
  /** 对应分段 `SegmentRow.id`，便于多段并行时过滤 */
  segmentIndex: number
}
