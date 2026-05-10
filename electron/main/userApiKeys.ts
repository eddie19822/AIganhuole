/**
 * 解析「用户本机设置」与 `.env` 合并后的有效密钥（用户优先）。
 */

import type { UserApiSettingsPublic } from '../../src/types/userApiSettings'
import { readUserApiSettings } from './userApiSettings'

function maskSecret(s: string | undefined): string {
  if (!s?.trim()) return ''
  const t = s.trim()
  if (t.length <= 8) return '••••••••'
  return `${t.slice(0, 4)}•••••••${t.slice(-4)}`
}

export function effectiveDashscopeApiKey(): string {
  const u = readUserApiSettings()
  return (
    u.dashscopeApiKey?.trim() ||
    process.env.DASHSCOPE_API_KEY?.trim() ||
    ''
  )
}

export function effectiveVolcTtsApiKey(): string {
  const u = readUserApiSettings()
  return (
    u.volcTtsApiKey?.trim() ||
    process.env.VOLC_TTS_API_KEY?.trim() ||
    process.env.VOLC_TTS_ACCESS_TOKEN?.trim() ||
    ''
  )
}

/** 火山引擎 IAM（即梦视觉接口）；与控制台访问密钥一致 */
export function effectiveVolcIam(): { ak: string; sk: string } | null {
  const u = readUserApiSettings()
  const ak =
    u.volcAccessKeyId?.trim() ||
    process.env.VOLC_ACCESS_KEY_ID?.trim() ||
    process.env.VOLC_ACCESSKEY?.trim() ||
    ''
  const sk =
    u.volcSecretAccessKey?.trim() ||
    process.env.VOLC_SECRET_ACCESS_KEY?.trim() ||
    process.env.VOLC_SECRETKEY?.trim() ||
    ''
  if (ak && sk) return { ak, sk }
  return null
}

export function effectivePexelsApiKey(): string {
  const u = readUserApiSettings()
  return u.pexelsApiKey?.trim() || process.env.PEXELS_API_KEY?.trim() || ''
}

export function effectivePixabayApiKey(): string {
  const u = readUserApiSettings()
  return u.pixabayApiKey?.trim() || process.env.PIXABAY_API_KEY?.trim() || ''
}

/** 供渲染进程展示：合并应用内设置与其它生效来源后的掩码摘要 */
export function getUserApiSettingsPublic(): UserApiSettingsPublic {
  const u = readUserApiSettings()
  const dsEff = effectiveDashscopeApiKey()
  const volcTtsEff = effectiveVolcTtsApiKey()
  const volcIamEff = effectiveVolcIam()
  const pexEff = effectivePexelsApiKey()
  const pixEff = effectivePixabayApiKey()

  const dsSaved = !!u.dashscopeApiKey?.trim()
  const ttsSaved = !!u.volcTtsApiKey?.trim()
  const iamSaved =
    !!u.volcAccessKeyId?.trim() && !!u.volcSecretAccessKey?.trim()
  const pexSaved = !!u.pexelsApiKey?.trim()
  const pixSaved = !!u.pixabayApiKey?.trim()

  return {
    dashscopeConfigured: !!dsEff,
    dashscopeSavedInSettings: dsSaved,
    dashscopeApiKeyMasked: maskSecret(dsEff || undefined),
    dashscopeModel: u.dashscopeModel?.trim() || undefined,
    dashscopeModelChain: u.dashscopeModelChain?.trim() || undefined,
    dashscopeChatCompletionsUrl:
      u.dashscopeChatCompletionsUrl?.trim() || undefined,
    volcTtsConfigured: !!volcTtsEff,
    volcTtsSavedInSettings: ttsSaved,
    volcTtsApiKeyMasked: maskSecret(volcTtsEff || undefined),
    volcIamConfigured: !!volcIamEff,
    volcIamSavedInSettings: iamSaved,
    volcAccessKeyIdMasked: volcIamEff ? maskSecret(volcIamEff.ak) : '',
    volcSecretAccessKeyMasked: volcIamEff ? maskSecret(volcIamEff.sk) : '',
    pexelsConfigured: !!pexEff,
    pexelsSavedInSettings: pexSaved,
    pexelsApiKeyMasked: maskSecret(pexEff || undefined),
    pixabayConfigured: !!pixEff,
    pixabaySavedInSettings: pixSaved,
    pixabayApiKeyMasked: maskSecret(pixEff || undefined),
  }
}
