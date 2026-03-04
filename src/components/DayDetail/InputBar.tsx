import { useState, useRef, forwardRef, useImperativeHandle } from 'react'
import type { BlockType } from '../../types'

interface Props {
  onAddText: (text: string) => void
  onAddChecklist: (text?: string) => void
}

export interface InputBarHandle {
  focus: () => void
}

export const InputBar = forwardRef<InputBarHandle, Props>(function InputBar({ onAddText, onAddChecklist }, ref) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<BlockType>('text')
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus()
  }))

  function submit() {
    const trimmed = text.trim()
    if (!trimmed) return

    if (mode === 'text') onAddText(trimmed)
    else onAddChecklist(trimmed)

    setText('')
    inputRef.current?.focus()
  }

  return (
    <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100 dark:border-gray-800
                    bg-white dark:bg-gray-900">
      {/* 블록 타입 전환 버튼 */}
      <button
        onClick={() => setMode(mode === 'text' ? 'checklist' : 'text')}
        className={`flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center
                    transition-colors text-xs font-bold
                    ${mode === 'checklist'
                      ? 'bg-accent-100 dark:bg-accent-500/20 text-accent-600 dark:text-accent-400'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}
        title={mode === 'text' ? '체크리스트로 전환' : '텍스트로 전환'}
      >
        {mode === 'text' ? 'T' : '✓'}
      </button>

      {/* 입력 필드 */}
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
        placeholder={mode === 'text' ? '메모를 입력하세요...' : '체크리스트 항목을 입력하세요...'}
        className="flex-1 text-sm bg-transparent outline-none text-gray-800 dark:text-gray-200
                   placeholder-gray-400"
      />

      {/* 전송 버튼 */}
      <button
        onClick={submit}
        disabled={!text.trim()}
        className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center
                   bg-accent-500 text-white disabled:opacity-30 hover:bg-accent-600
                   transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-5 5m5-5l5 5" />
        </svg>
      </button>
    </div>
  )
})
