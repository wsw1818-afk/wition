import { useEffect, useState, useCallback } from 'react'

export interface ToastMessage {
  id: string
  text: string
  type: 'info' | 'success' | 'warning' | 'error'
}

let addToastFn: ((msg: Omit<ToastMessage, 'id'>) => void) | null = null

/** 외부에서 토스트 표시 (컴포넌트 외부에서도 호출 가능) */
export function showToast(text: string, type: ToastMessage['type'] = 'info') {
  addToastFn?.({ text, type })
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const addToast = useCallback((msg: Omit<ToastMessage, 'id'>) => {
    const id = crypto.randomUUID?.() || String(Date.now())
    setToasts(prev => [...prev, { ...msg, id }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 4000)
  }, [])

  useEffect(() => {
    addToastFn = addToast
    return () => { addToastFn = null }
  }, [addToast])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-in slide-in-from-right
            ${t.type === 'error' ? 'bg-red-500 text-white' :
              t.type === 'warning' ? 'bg-amber-500 text-white' :
              t.type === 'success' ? 'bg-green-500 text-white' :
              'bg-gray-800 text-white dark:bg-gray-700'}`}
          onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
