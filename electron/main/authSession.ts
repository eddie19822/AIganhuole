/**
 * 账号登录（外部服务端）：令牌持久化 + 会话校验。
 * BASE：AUTH_API_BASE，默认 https://aiganhuole.com
 */

import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import type { AuthLoginResponse, AuthUser } from '../../src/types/auth'
import { mainFetch } from './mainFetch'

export function authApiBase(): string {
  const b = process.env.AUTH_API_BASE?.trim()
  return b && /^https?:\/\//i.test(b) ? b.replace(/\/+$/, '') : 'https://aiganhuole.com'
}

interface PersistFile {
  v: 1
  tokenB64: string
  encrypted: boolean
  expiresAtMs: number
  user: AuthUser
}

const FILE = 'app-auth-session.json'

function storePath(): string {
  return path.join(app.getPath('userData'), FILE)
}

function readPersist(): PersistFile | null {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const j = JSON.parse(raw) as PersistFile
    if (j?.v !== 1 || !j.tokenB64) return null
    return j
  } catch {
    return null
  }
}

function decryptToken(p: PersistFile): string | null {
  try {
    const buf = Buffer.from(p.tokenB64, 'base64')
    if (p.encrypted && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf)
    }
    return buf.toString('utf8')
  } catch {
    return null
  }
}

export function loadPersistedAccessToken(): string | null {
  const p = readPersist()
  if (!p) return null
  if (p.expiresAtMs <= Date.now()) {
    clearPersistedAuth()
    return null
  }
  return decryptToken(p)
}

export function readPersistedUser(): AuthUser | null {
  return readPersist()?.user ?? null
}

export function clearPersistedAuth(): void {
  try {
    fs.unlinkSync(storePath())
  } catch {
    /* ignore */
  }
}

function persistToken(accessToken: string, expiresInSec: number, user: AuthUser): void {
  const expiresAtMs = Date.now() + Math.max(60, expiresInSec) * 1000
  let tokenB64: string
  let encrypted = false
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(accessToken)
    tokenB64 = Buffer.from(enc).toString('base64')
    encrypted = true
  } else {
    tokenB64 = Buffer.from(accessToken, 'utf8').toString('base64')
  }
  const body: PersistFile = {
    v: 1,
    tokenB64,
    encrypted,
    expiresAtMs,
    user,
  }
  fs.mkdirSync(path.dirname(storePath()), { recursive: true })
  fs.writeFileSync(storePath(), `${JSON.stringify(body)}\n`, 'utf8')
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const t = await res.text()
  try {
    return JSON.parse(t) as unknown
  } catch {
    return null
  }
}

export async function loginWithPassword(
  email: string,
  password: string,
): Promise<AuthUser> {
  const trimmed = email.trim()
  if (!trimmed || !password) {
    throw new Error('请输入邮箱和密码')
  }
  const url = `${authApiBase()}/api/v1/auth/login`
  const res = await mainFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: trimmed, password }),
  })
  const json = (await parseJsonSafe(res)) as
    | AuthLoginResponse
    | { error?: string }
    | null
  if (!res.ok) {
    const msg =
      (json && typeof json === 'object' && 'error' in json && typeof (json as { error?: string }).error === 'string'
        ? (json as { error: string }).error
        : null) ?? `登录失败（HTTP ${res.status}）`
    throw new Error(msg)
  }
  const body = json as AuthLoginResponse
  if (!body?.accessToken || !body?.user) {
    throw new Error('登录响应无效')
  }
  persistToken(body.accessToken, body.expiresIn ?? 2592000, body.user)
  return body.user
}

/** GET /api/v1/auth/session — 远程校验令牌是否仍有效 */
export async function validateSessionRemote(accessToken: string): Promise<{
  ok: boolean
  user?: AuthUser
}> {
  const url = `${authApiBase()}/api/v1/auth/session`
  const res = await mainFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 401) return { ok: false }
  if (!res.ok) return { ok: false }
  const json = await parseJsonSafe(res)
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  const user =
    obj?.user && typeof obj.user === 'object'
      ? (obj.user as AuthUser)
      : undefined
  return { ok: true, user }
}

export async function getAuthStatePublic(): Promise<{
  loggedIn: boolean
  user?: AuthUser
}> {
  const token = loadPersistedAccessToken()
  if (!token) return { loggedIn: false }

  const localUser = readPersistedUser()
  const remote = await validateSessionRemote(token)
  if (!remote.ok) {
    clearPersistedAuth()
    return { loggedIn: false }
  }
  const user = remote.user ?? localUser ?? undefined
  return { loggedIn: true, user }
}

export function assertAppUserLoggedIn(): void {
  const token = loadPersistedAccessToken()
  if (!token) {
    throw new Error('请先登录账号后再使用本软件')
  }
}

export function logout(): void {
  clearPersistedAuth()
}
