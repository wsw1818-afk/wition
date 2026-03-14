import { useState, useRef, useEffect } from 'react'

interface Props {
  onUnlock: () => void
}

export function PinLock({ onUnlock }: Props) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function handleSubmit() {
    if (pin.length < 4) return
    const result = await window.api.verifyPin(pin)
    if (result.ok) {
      onUnlock()
    } else {
      setError(true)
      setPin('')
      inputRef.current?.focus()
      setTimeout(() => setError(false), 1500)
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-white dark:bg-gray-900">
      <div className="text-center p-8 max-w-xs w-full">
        <div className="text-4xl mb-4">🔒</div>
        <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-1">PIN 입력</h2>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-6">앱을 사용하려면 PIN을 입력하세요</p>

        <input
          ref={inputRef}
          type="password"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit()
          }}
          placeholder="4~6자리 숫자"
          className={`w-full text-center text-2xl tracking-[0.5em] py-3 rounded-lg border-2 bg-transparent outline-none transition-colors
            ${error
              ? 'border-red-400 text-red-500 animate-shake'
              : 'border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100 focus:border-accent-400'}`}
        />

        {error && (
          <p className="mt-2 text-xs text-red-500">PIN이 올바르지 않습니다</p>
        )}

        <button
          onClick={handleSubmit}
          disabled={pin.length < 4}
          className="mt-4 w-full py-2.5 rounded-lg bg-accent-500 text-white font-medium text-sm
                     disabled:opacity-30 hover:bg-accent-600 transition-colors"
        >
          잠금 해제
        </button>
      </div>
    </div>
  )
}
