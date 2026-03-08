import { useState, useEffect } from 'react'
import type { AuthUser } from '../../types'

interface LoginScreenProps {
  onLogin: (user: AuthUser) => void
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [signupSuccess, setSignupSuccess] = useState(false)

  // 저장된 로그인 정보 불러오기
  useEffect(() => {
    window.api.authGetCredentials().then(res => {
      if (res.ok && res.email && res.password) {
        setEmail(res.email)
        setPassword(res.password)
        setRememberMe(true)
      }
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!email.trim() || !password.trim()) {
      setError('이메일과 비밀번호를 입력해주세요.')
      return
    }

    if (mode === 'signup') {
      if (password.length < 6) {
        setError('비밀번호는 6자 이상이어야 합니다.')
        return
      }
      if (password !== confirmPassword) {
        setError('비밀번호가 일치하지 않습니다.')
        return
      }
    }

    setLoading(true)
    try {
      if (mode === 'signup') {
        const res = await window.api.authSignup(email.trim(), password)
        if (!res.ok) {
          setError(res.error || '회원가입 실패')
          return
        }
        setSignupSuccess(true)
        setMode('login')
        setPassword('')
        setConfirmPassword('')
        return
      }

      // 로그인
      const res = await window.api.authLogin(email.trim(), password)
      if (!res.ok) {
        setError(res.error || '로그인 실패')
        return
      }

      // 로그인 정보 기억 처리
      if (rememberMe) {
        await window.api.authSaveCredentials(email.trim(), password)
      } else {
        await window.api.authClearCredentials()
      }

      if (res.user) onLogin(res.user)
    } catch (err) {
      setError(`오류: ${err}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-900">
      {/* 드래그 가능한 타이틀바 영역 */}
      <div className="h-8 flex-shrink-0 flex items-center justify-end px-2" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={() => window.api.minimize()} className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 rounded text-xs">─</button>
          <button onClick={() => window.api.close()} className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded text-xs">✕</button>
        </div>
      </div>

      {/* 로그인 폼 */}
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-sm">
          {/* 로고 */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100 mb-1">Wition</h1>
            <p className="text-sm text-gray-400 dark:text-gray-500">캘린더 기반 블록 노트</p>
          </div>

          {/* 성공 메시지 */}
          {signupSuccess && (
            <div className="mb-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
              <p className="text-sm text-green-700 dark:text-green-400">회원가입 완료! 이메일로 로그인해주세요.</p>
            </div>
          )}

          {/* 에러 메시지 */}
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">이메일</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="example@email.com"
                autoFocus
                className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg
                  bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200
                  placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">비밀번호</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="6자 이상"
                className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg
                  bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200
                  placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              />
            </div>

            {mode === 'login' && (
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={e => setRememberMe(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-blue-500 focus:ring-blue-500/50 cursor-pointer"
                />
                <span className="text-xs text-gray-500 dark:text-gray-400">로그인 정보 기억</span>
              </label>
            )}

            {mode === 'signup' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">비밀번호 확인</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="비밀번호 다시 입력"
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg
                    bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200
                    placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600
                disabled:bg-blue-300 rounded-lg transition-colors"
            >
              {loading ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}
            </button>
          </form>

          {/* 모드 전환 */}
          <div className="mt-6 text-center">
            <button
              onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setSignupSuccess(false) }}
              className="text-xs text-gray-400 hover:text-blue-500 transition-colors"
            >
              {mode === 'login' ? '계정이 없으신가요? 회원가입' : '이미 계정이 있으신가요? 로그인'}
            </button>
          </div>

          {/* 안내 */}
          <div className="mt-8 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800">
            <p className="text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed text-center">
              로그인하면 다른 기기의 세션은 자동으로 종료됩니다.<br/>
              한 번에 하나의 기기에서만 사용할 수 있습니다.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
