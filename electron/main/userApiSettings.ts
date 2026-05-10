/**
 * 用户在本机保存的 API 密钥（与项目 .env 分离，便于多人共用同一安装包）。
 * 文件位于 userData/user-api-settings.json，请勿提交到版本库。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import type { UserApiSettingsPatch } from '../../src/types/userApiSettings'

let cache: UserApiSettingsPatch | null = null
let resolvedPath: string | null = null

function settingsFilePath(): string {
  if (resolvedPath) return resolvedPath
  try {
    resolvedPath = path.join(app.getPath('userData'), 'user-api-settings.json')
  } catch {
    resolvedPath = path.join(os.tmpdir(), 'story-stock-user-api-settings.json')
  }
  return resolvedPath
}

export function readUserApiSettings(): UserApiSettingsPatch {
  if (cache) return cache
  const p = settingsFilePath()
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8')
      cache = JSON.parse(raw) as UserApiSettingsPatch
      return cache
    }
  } catch {
    /* ignore */
  }
  cache = {}
  return cache
}

/** 合并写入；字段为空字符串则从存储中删除该键（回退用 .env） */
export function writeUserApiSettings(
  patch: UserApiSettingsPatch,
): UserApiSettingsPatch {
  const cur = { ...readUserApiSettings() }
  for (const [k, v] of Object.entries(patch) as [
    keyof UserApiSettingsPatch,
    string | undefined,
  ][]) {
    if (v === undefined) continue
    const t = typeof v === 'string' ? v.trim() : ''
    if (t === '') delete cur[k]
    else (cur as Record<string, string>)[k as string] = t
  }
  cache = cur
  const p = settingsFilePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cur, null, 2), 'utf8')
  return cur
}
