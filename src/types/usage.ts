/** 与 ai-match-hub `docs/software-license-api.md` 对齐；主进程 usage-sync-status / usage-purchase-days */

/** 单次兑换天数上限（与服务端 MAX_PURCHASE_DAYS_PER_REQUEST 一致） */
export const MAX_LICENSE_PURCHASE_DAYS_PER_REQUEST = 366

export type UsagePublicStatus = {
  softwareCode: string
  softwareName?: string
  /** 该款软件剩余可用天数（服务端已按上海自然日结算扣减） */
  remainingDays: number
  /** 账号积分余额；兑换可用天数时 1 积分 = 1 天 */
  pointsBalance: number
  /** 当前积分一次最多可兑换天数（min(积分, 366)） */
  maxPurchasableDays: number
  /** 服务端字段：remainingDays > 0 */
  allowed: boolean
  canUseApp: boolean
  deductionAnchorDate?: string
  dailyDeductionNote?: string
  syncWarning?: string
  blockMessage?: string
  /**
   * GET /software-license/status 是否成功。
   * 为 false 时勿调用兑换接口（多为服务端未登记 softwareCode）；积分可能来自单独查询仅供参考。
   */
  licenseApiOk: boolean
}

export type UsagePurchaseDaysResult =
  | { ok: true; status: UsagePublicStatus }
  | {
      ok: false
      message: string
      /** 建议打开积分充值页 */
      shouldOpenRecharge?: boolean
      status?: UsagePublicStatus
    }
