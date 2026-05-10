import { useState } from 'react'
import type { AuthUser } from '@/types/auth'

const DEFAULT_REGISTER_URL = 'https://aiganhuole.com/register'

type Props = {
  onLoggedIn: (user: AuthUser) => void
}

async function openRegisterInBrowser(): Promise<void> {
  if (typeof window.storyStock?.openAuthRegisterPage === 'function') {
    await window.storyStock.openAuthRegisterPage()
    return
  }
  window.open(DEFAULT_REGISTER_URL, '_blank', 'noopener,noreferrer')
}

export default function LoginScreen({ onLoggedIn }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (typeof window.storyStock?.authLogin !== 'function') {
      setError('请在桌面端（Electron）中运行本应用')
      return
    }
    setLoading(true)
    try {
      const user = await window.storyStock.authLogin({
        email: email.trim(),
        password,
      })
      onLoggedIn(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='auth-gate'>
      <div className='auth-shell'>
        <header className='auth-brand-block'>
          <p className='auth-product-name'>易剪</p>
          <h1 className='auth-headline'>登录</h1>
          <p className='auth-lead'>
            使用AI干活网账号登录后即可使用全部功能。
          </p>
        </header>

        <div className='auth-card'>
          <form className='auth-form' onSubmit={(e) => void handleSubmit(e)}>
            <div className='auth-field'>
              <label className='auth-label' htmlFor='auth-email'>
                邮箱
              </label>
              <input
                id='auth-email'
                className='auth-input'
                type='email'
                autoComplete='username'
                inputMode='email'
                placeholder='name@example.com'
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                required
              />
            </div>
            <div className='auth-field'>
              <label className='auth-label' htmlFor='auth-password'>
                密码
              </label>
              <input
                id='auth-password'
                className='auth-input'
                type='password'
                autoComplete='current-password'
                placeholder='请输入密码'
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                required
              />
            </div>

            {error && (
              <p className='auth-error' role='alert'>
                {error}
              </p>
            )}

            <button
              type='submit'
              className='auth-submit'
              disabled={loading}
            >
              {loading ? '登录中…' : '登录'}
            </button>
          </form>

          <div className='auth-footer-actions'>
            <p className='auth-divider'>
              <span>还没有账号？</span>
            </p>
            <button
              type='button'
              className='auth-register-btn'
              disabled={loading}
              onClick={() => void openRegisterInBrowser()}
            >
              前往AI干活网注册
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
