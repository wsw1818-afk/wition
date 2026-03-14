import { useState } from 'react'

interface Props {
  mode: 'encrypt' | 'decrypt'
  onConfirm: (password: string) => void
  onCancel: () => void
}

export function EncryptDialog({ mode, onConfirm, onCancel }: Props) {
  const [password, setPassword] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [error, setError] = useState('')

  function handleSubmit() {
    if (!password) {
      setError('비밀번호를 입력하세요.')
      return
    }
    if (mode === 'encrypt' && password !== confirmPw) {
      setError('비밀번호가 일치하지 않습니다.')
      return
    }
    if (password.length < 4) {
      setError('비밀번호는 4자 이상이어야 합니다.')
      return
    }
    onConfirm(password)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-5 w-80 border border-gray-200 dark:border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center mb-4">
          <span className="text-3xl">{mode === 'encrypt' ? '🔒' : '🔓'}</span>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mt-2">
            {mode === 'encrypt' ? '메모 잠금' : '메모 잠금 해제'}
          </h3>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            {mode === 'encrypt' ? '이 메모를 암호화합니다.' : '비밀번호를 입력하세요.'}
          </p>
        </div>

        <div className="space-y-2">
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
            placeholder="비밀번호"
            autoFocus
            className="w-full text-sm bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700
                       rounded-lg px-3 py-2 outline-none focus:border-accent-400 text-gray-800 dark:text-gray-200"
          />
          {mode === 'encrypt' && (
            <input
              type="password"
              value={confirmPw}
              onChange={(e) => { setConfirmPw(e.target.value); setError('') }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
              placeholder="비밀번호 확인"
              className="w-full text-sm bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700
                         rounded-lg px-3 py-2 outline-none focus:border-accent-400 text-gray-800 dark:text-gray-200"
            />
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 text-sm py-1.5 rounded-lg border border-gray-200 dark:border-gray-700
                       text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            취소
          </button>
          <button
            onClick={handleSubmit}
            className="flex-1 text-sm py-1.5 rounded-lg bg-accent-500 text-white hover:bg-accent-600 transition-colors"
          >
            {mode === 'encrypt' ? '잠금' : '해제'}
          </button>
        </div>
      </div>
    </div>
  )
}
