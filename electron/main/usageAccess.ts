/**
 * 软件可用天数：完全由服务端 GET /api/v1/software-license/status 判定；
 * 兑换：POST /api/v1/software-license/purchase-days（见 ai-match-hub docs/software-license-api.md）
 */

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { UsagePublicStatus, UsagePurchaseDaysResult } from '../../src/types/usage'
import { MAX_LICENSE_PURCHASE_DAYS_PER_REQUEST } from '../../src/types/usage'
import {
  assertAppUserLoggedIn,
  authApiBase,
  loadPersistedAccessToken,
  readPersistedUser,
} from './authSession'
import { mainFetch } from './mainFetch'

/** 用户首次在本机登录成功时，自动用积分兑换的可用天数（1 积分 = 1 天） */
const FIRST_LOGIN_AUTO_REDEEM_DAYS = 7
const FIRST_LOGIN_REDEEM_FILE = 'app-first-login-redeem.json'

interface FirstLoginRedeemStateV1 {
  v: 1
  /** 小写邮箱；已成功兑换，或已判定无需再尝试（积分不足 / 授权接口不可用） */
  processedEmails: string[]
}

function firstLoginRedeemPath(): string {
  return path.join(app.getPath('userData'), FIRST_LOGIN_REDEEM_FILE)
}

function readFirstLoginRedeemState(): FirstLoginRedeemStateV1 {
  try {
    const raw = fs.readFileSync(firstLoginRedeemPath(), 'utf8')
    const j = JSON.parse(raw) as FirstLoginRedeemStateV1
    if (j?.v !== 1 || !Array.isArray(j.processedEmails)) {
      return { v: 1, processedEmails: [] }
    }
    return j
  } catch {
    return { v: 1, processedEmails: [] }
  }
}

function writeFirstLoginRedeemState(s: FirstLoginRedeemStateV1): void {
  fs.mkdirSync(path.dirname(firstLoginRedeemPath()), { recursive: true })
  fs.writeFileSync(firstLoginRedeemPath(), `${JSON.stringify(s)}\n`, 'utf8')
}

function markFirstLoginRedeemProcessed(emailKey: string): void {
  const s = readFirstLoginRedeemState()
  if (!s.processedEmails.includes(emailKey)) {
    s.processedEmails.push(emailKey)
    writeFirstLoginRedeemState(s)
  }
}

/**
 * 登录成功后调用：每个邮箱在本机仅尝试一次——积分≥7 且授权接口可用时自动兑换 7 天；
 * 积分不足或授权不可用时记入本地，不再自动尝试；兑换请求失败（网络等）不记入，下次登录可重试。
 */
export async function maybeFirstLoginAutoRedeemSevenDays(): Promise<void> {
  try {
    const user = readPersistedUser()
    const raw = user?.email?.trim()
    if (!raw) return
    const emailKey = raw.toLowerCase()

    if (readFirstLoginRedeemState().processedEmails.includes(emailKey)) return

    if (!loadPersistedAccessToken()) return

    const status = await syncUsageAccess()
    if (!status.licenseApiOk) {
      markFirstLoginRedeemProcessed(emailKey)
      return
    }
    if (status.pointsBalance < FIRST_LOGIN_AUTO_REDEEM_DAYS) {
      markFirstLoginRedeemProcessed(emailKey)
      return
    }

    const result = await purchaseLicenseDays(FIRST_LOGIN_AUTO_REDEEM_DAYS)
    if (result.ok) {
      markFirstLoginRedeemProcessed(emailKey)
      console.log(
        `[usageAccess] 首次登录已自动兑换 ${FIRST_LOGIN_AUTO_REDEEM_DAYS} 天（${emailKey}）`,
      )
    }
  } catch (e) {
    console.warn('[usageAccess] first-login auto redeem:', e)
  }
}

export type { UsagePublicStatus }

function licenseSoftwareCode(): string {
  return (
    process.env.SOFTWARE_LICENSE_CODE?.trim() ||
    process.env.STORY_STOCK_SOFTWARE_CODE?.trim() ||
    'yijian'
  )
}

interface LicenseStatusJson {
  softwareCode?: string
  softwareName?: string
  remainingDays?: number
  deductionAnchorDate?: string
  pointsBalance?: number
  allowed?: boolean
  dailyDeductionNote?: string
}

/** 账号积分（与可用天数接口独立；license 失败时用于正确展示余额） */
async function fetchAccountPointsBalance(accessToken: string): Promise<number | null> {
  const url = `${authApiBase()}/api/v1/account/points`
  try {
    const res = await mainFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* ignore */
    }
    if (!res.ok) return null
    const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : null
    const bal = obj?.balance
    if (typeof bal === 'number' && Number.isFinite(bal)) return Math.floor(bal)
    return null
  } catch {
    return null
  }
}

async function fetchLicenseStatus(
  accessToken: string,
  softwareCode: string,
): Promise<
  | { ok: true; data: LicenseStatusJson }
  | { ok: false; httpStatus: number; message: string }
> {
  const url = `${authApiBase()}/api/v1/software-license/status?softwareCode=${encodeURIComponent(softwareCode)}`
  try {
    const res = await mainFetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Software-Code': softwareCode,
      },
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* ignore */
    }
    const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : null
    const err = obj?.error
    const errMsg = typeof err === 'string' ? err : `HTTP ${res.status}`

    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        message: errMsg,
      }
    }

    return { ok: true, data: (json || {}) as LicenseStatusJson }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, httpStatus: 0, message: msg }
  }
}

function buildPublicStatus(
  code: string,
  data: LicenseStatusJson | null,
  extra?: { syncWarning?: string; blockMessage?: string },
): UsagePublicStatus {
  const pointsBalance = Math.max(
    0,
    Math.floor(
      typeof data?.pointsBalance === 'number' && Number.isFinite(data.pointsBalance)
        ? data.pointsBalance
        : 0,
    ),
  )
  const remainingDays = Math.max(
    0,
    Math.floor(
      typeof data?.remainingDays === 'number' && Number.isFinite(data.remainingDays)
        ? data.remainingDays
        : 0,
    ),
  )
  const maxPurchasableDays = Math.min(pointsBalance, MAX_LICENSE_PURCHASE_DAYS_PER_REQUEST)
  const allowed =
    typeof data?.allowed === 'boolean' ? data.allowed : remainingDays > 0

  const canUseApp = allowed

  return {
    softwareCode: typeof data?.softwareCode === 'string' ? data.softwareCode : code,
    softwareName: typeof data?.softwareName === 'string' ? data.softwareName : undefined,
    remainingDays,
    pointsBalance,
    maxPurchasableDays,
    allowed,
    canUseApp,
    licenseApiOk: true,
    deductionAnchorDate:
      typeof data?.deductionAnchorDate === 'string' ? data.deductionAnchorDate : undefined,
    dailyDeductionNote:
      typeof data?.dailyDeductionNote === 'string' ? data.dailyDeductionNote : undefined,
    syncWarning: extra?.syncWarning,
    blockMessage: extra?.blockMessage,
  }
}

/**
 * 登录后调用：拉取服务端可用天数（含惰性自然日扣减）；`canUseApp` 仅当 remainingDays>0。
 */
export async function syncUsageAccess(): Promise<UsagePublicStatus> {
  const token = loadPersistedAccessToken()
  const code = licenseSoftwareCode()

  if (!token) {
    return {
      softwareCode: code,
      remainingDays: 0,
      pointsBalance: 0,
      maxPurchasableDays: 0,
      allowed: false,
      canUseApp: false,
      licenseApiOk: false,
      blockMessage: '请先登录账号',
    }
  }

  const st = await fetchLicenseStatus(token, code)
  if (!st.ok) {
    const fallbackPoints = await fetchAccountPointsBalance(token)
    const pointsBalance = fallbackPoints ?? 0
    const blockMessage =
      st.httpStatus === 404
        ? '暂无法在此兑换，请稍后再试或联系客服。'
        : '暂无法获取可用天数，请稍后再试。'

    return {
      softwareCode: code,
      remainingDays: 0,
      pointsBalance,
      maxPurchasableDays: 0,
      allowed: false,
      canUseApp: false,
      licenseApiOk: false,
      blockMessage,
    }
  }

  const base = buildPublicStatus(code, st.data)

  if (!base.canUseApp) {
    return {
      ...base,
      blockMessage:
        base.remainingDays <= 0
          ? '可用天数已用完。在下方输入要兑换的天数，点「用积分兑换可用天数」即可（1 积分 = 1 天）；积分不够请先点「前往购买积分」。'
          : base.blockMessage,
    }
  }

  return base
}

/**
 * 积分兑换可用天数（服务端扣积分并增加 remainingDays）。
 */
export async function purchaseLicenseDays(days: number): Promise<UsagePurchaseDaysResult> {
  assertAppUserLoggedIn()
  const token = loadPersistedAccessToken()
  const code = licenseSoftwareCode()
  if (!token) {
    return { ok: false, message: '请先登录账号' }
  }

  const n = Math.floor(Number(days))
  if (
    !Number.isFinite(n) ||
    n < 1 ||
    n > MAX_LICENSE_PURCHASE_DAYS_PER_REQUEST
  ) {
    return {
      ok: false,
      message: `兑换天数须为 1～${MAX_LICENSE_PURCHASE_DAYS_PER_REQUEST} 的整数`,
    }
  }

  const url = `${authApiBase()}/api/v1/software-license/purchase-days`

  try {
    const res = await mainFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ softwareCode: code, days: n }),
    })
    const text = await res.text()
    let json: Record<string, unknown> | null = null
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* ignore */
    }

    if (res.ok && json) {
      invalidateUsageAssertCache()
      const status = await syncUsageAccess()
      return { ok: true, status }
    }

    const rawErr = json?.error
    let errStr = ''
    if (typeof rawErr === 'string') errStr = rawErr
    else if (rawErr !== undefined)
      try {
        errStr = JSON.stringify(rawErr)
      } catch {
        errStr = ''
      }

    const msg =
      errStr ||
      (res.status === 400
        ? '积分不足或参数错误，请先充值后再试'
        : `兑换失败 HTTP ${res.status}`)

    const shouldOpenRecharge =
      res.status === 400 &&
      (msg.includes('积分') ||
        errStr.includes('积分') ||
        typeof json?.needPoints === 'number')

    invalidateUsageAssertCache()
    let status: UsagePublicStatus | undefined
    try {
      status = await syncUsageAccess()
    } catch {
      /* ignore */
    }

    return { ok: false, message: msg, shouldOpenRecharge, status }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, message: msg }
  }
}

let usageAssertCache: { at: number; ok: boolean } | null = null
const USAGE_ASSERT_CACHE_MS = 45_000

export function invalidateUsageAssertCache(): void {
  usageAssertCache = null
}

/** IPC / 导出前校验：已登录且服务端允许使用（有剩余可用天数） */
export async function assertActiveUsageOrThrow(): Promise<void> {
  assertAppUserLoggedIn()
  const t = Date.now()
  if (
    usageAssertCache &&
    t - usageAssertCache.at < USAGE_ASSERT_CACHE_MS &&
    usageAssertCache.ok
  ) {
    return
  }
  const s = await syncUsageAccess()
  usageAssertCache = { at: t, ok: s.canUseApp }
  if (!s.canUseApp) {
    throw new Error(s.blockMessage ?? '当前无可用天数，请兑换或充值后再试。')
  }
}
