import { useState, useEffect } from 'react'
import type { AuthUser } from '../../types'

interface LoginScreenProps {
  onLogin: (user: AuthUser) => void
}

interface LocalAccount {
  id: string
  email: string
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [mode, setMode] = useState<'login' | 'signup' | 'offline'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [signupSuccess, setSignupSuccess] = useState(false)
  const [localAccounts, setLocalAccounts] = useState<LocalAccount[]>([])
  const [selectedAccount, setSelectedAccount] = useState<LocalAccount | null>(null)
  const [offlinePassword, setOfflinePassword] = useState('')

  // 저장된 로그인 정보 + 로컬 계정 목록 불러오기
  useEffect(() => {
    window.api.authGetCredentials().then(res => {
      if (res.ok && res.email && res.password) {
        setEmail(res.email)
        setPassword(res.password)
        setRememberMe(true)
      }
    })
    window.api.authGetLocalAccounts().then(accounts => {
      setLocalAccounts(accounts)
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

  async function handleOfflineLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!selectedAccount) {
      setError('계정을 선택해주세요.')
      return
    }
    if (!offlinePassword.trim()) {
      setError('비밀번호를 입력해주세요.')
      return
    }

    setLoading(true)
    try {
      const res = await window.api.authOfflineLogin(selectedAccount.id, offlinePassword)
      if (!res.ok) {
        setError(res.error || '오프라인 로그인 실패')
        return
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
      <div className="titlebar-drag h-8 flex-shrink-0 flex items-center justify-end px-2">
        <div className="titlebar-no-drag flex gap-1">
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

          {/* 오프라인 로그인 모드 */}
          {mode === 'offline' ? (
            <>
              <form onSubmit={handleOfflineLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">계정 선택</label>
                  <div className="space-y-2">
                    {localAccounts.map(account => (
                      <button
                        key={account.id}
                        type="button"
                        onClick={() => { setSelectedAccount(account); setError('') }}
                        className={`w-full px-3 py-2.5 text-sm text-left rounded-lg border transition-colors ${
                          selectedAccount?.id === account.id
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                            : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                      >
                        {account.email}
                      </button>
                    ))}
                  </div>
                </div>

                {selectedAccount && (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">비밀번호</label>
                    <input
                      type="password"
                      value={offlinePassword}
                      onChange={e => setOfflinePassword(e.target.value)}
                      placeholder="비밀번호 입력"
                      autoFocus
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg
                        bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200
                        placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || !selectedAccount}
                  className="w-full py-2.5 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600
                    disabled:bg-blue-300 rounded-lg transition-colors"
                >
                  {loading ? '처리 중...' : '오프라인 로그인'}
                </button>
              </form>

              <div className="mt-4 text-center">
                <button
                  onClick={() => { setMode('login'); setError(''); setSelectedAccount(null); setOfflinePassword('') }}
                  className="text-xs text-gray-400 hover:text-blue-500 transition-colors"
                >
                  온라인 로그인으로 돌아가기
                </button>
              </div>
            </>
          ) : (
            <>
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

              {/* 오프라인 로그인 (로컬 계정이 있을 때만 표시) */}
              {localAccounts.length > 0 && (
                <div className="mt-4">
                  <button
                    onClick={() => { setMode('offline'); setError('') }}
                    className="w-full py-2 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300
                      hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors"
                  >
                    오프라인 로그인 (서버 없이 로컬 데이터 사용)
                  </button>
                </div>
              )}
            </>
          )}

          {/* 안내 */}
          <div className="mt-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800">
            <p className="text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed text-center">
              {mode === 'offline'
                ? '이전에 온라인 로그인한 계정으로 오프라인 접속할 수 있습니다.\n서버 연결 시 자동으로 동기화됩니다.'
                : 'PC와 모바일에서 동시에 사용할 수 있습니다.\n데이터는 자동으로 동기화됩니다.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
