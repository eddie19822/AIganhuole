/** 与服务端 POST /api/v1/auth/login 响应 user 字段对齐 */
export interface AuthUser {
  id: string
  email: string
  nickname: string | null
  role: string
}

export interface AuthLoginResponse {
  accessToken: string
  tokenType: string
  expiresIn: number
  user: AuthUser
}

/** 渲染进程可见的登录态（不含 token） */
export interface AuthStatePublic {
  loggedIn: boolean
  user?: AuthUser
}
