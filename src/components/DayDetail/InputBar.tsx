import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from 'react'
import type { BlockType } from '../../types'
import { SlashMenu } from './SlashMenu'

interface Props {
  onAddText: (text: string) => void
  onAddChecklist: (text?: string) => void
  onAddBlock: (type: BlockType, content?: string) => void
  onAttachFile?: () => void
}

export interface InputBarHandle {
  focus: () => void
}

/** 마크다운 자동 변환 패턴 */
const MARKDOWN_PATTERNS: { regex: RegExp; type: BlockType; transform?: (m: RegExpMatchArray) => string }[] = [
  { regex: /^# (.+)$/,      type: 'heading1',      transform: m => m[1] },
  { regex: /^## (.+)$/,     type: 'heading2',      transform: m => m[1] },
  { regex: /^### (.+)$/,    type: 'heading3',      transform: m => m[1] },
  { regex: /^[-*] (.+)$/,   type: 'bulleted_list', transform: m => m[1] },
  { regex: /^\d+\. (.+)$/,  type: 'numbered_list', transform: m => m[1] },
  { regex: /^> (.+)$/,      type: 'quote',         transform: m => m[1] },
  { regex: /^---$/,         type: 'divider' },
  { regex: /^\[\] (.+)$/,   type: 'checklist',     transform: m => m[1] },
]

export const InputBar = forwardRef<InputBarHandle, Props>(function InputBar(
  { onAddText, onAddChecklist, onAddBlock, onAttachFile },
  ref
) {
  const [text, setText] = useState('')
  const [showSlash, setShowSlash] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashPos, setSlashPos] = useState({ top: 0, left: 0 })
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus()
  }))

  // 슬래시 커맨드 감지
  useEffect(() => {
    if (text.startsWith('/')) {
      setSlashFilter(text.slice(1))
      if (!showSlash) {
        const rect = inputRef.current?.getBoundingClientRect()
        if (rect) {
          setSlashPos({ top: rect.top - 290, left: rect.left })
        }
        setShowSlash(true)
      }
    } else if (showSlash && text === '') {
      // handleSlashSelect에서 setText('')이 호출된 경우에만 닫기
      // 사용자가 직접 /를 지운 경우도 여기에 해당
      setShowSlash(false)
    } else if (!text.startsWith('/')) {
      setShowSlash(false)
    }
  }, [text])

  function handleSlashSelect(type: BlockType) {
    setShowSlash(false)
    setText('')
    if (type === 'text') {
      inputRef.current?.focus()
      return
    }
    if (type === 'checklist') {
      onAddChecklist()
    } else {
      onAddBlock(type)
    }
  }

  function submit() {
    const trimmed = text.trim()
    if (!trimmed) return

    // 마크다운 자동 변환 체크
    for (const pattern of MARKDOWN_PATTERNS) {
      const match = trimmed.match(pattern.regex)
      if (match) {
        const content = pattern.transform ? pattern.transform(match) : undefined
        if (pattern.type === 'checklist') {
          onAddChecklist(content)
        } else {
          onAddBlock(pattern.type, content)
        }
        setText('')
        inputRef.current?.focus()
        return
      }
    }

    // 기본: 텍스트 블록
    onAddText(trimmed)
    setText('')
    inputRef.current?.focus()
  }

  return (
    <div className="relative">
      {showSlash && (
        <SlashMenu
          filter={slashFilter}
          position={slashPos}
          onSelect={handleSlashSelect}
          onClose={() => { setShowSlash(false); setText('') }}
        />
      )}

      <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100 dark:border-gray-800
                      bg-white dark:bg-gray-900">
        {/* 블록 타입 메뉴 (+ 버튼) */}
        <button
          onClick={() => {
            if (showSlash) {
              setShowSlash(false)
              setText('')
            } else {
              setText('/')
              inputRef.current?.focus()
            }
          }}
          className={`flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center
                      transition-colors text-xs font-bold
                      ${showSlash
                        ? 'bg-accent-100 dark:bg-accent-500/20 text-accent-600 dark:text-accent-400'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}
          title="블록 타입 선택 (/ 입력)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>

        {/* 입력 필드 */}
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !showSlash) submit()
            if (e.key === 'Escape' && showSlash) {
              setShowSlash(false)
              setText('')
            }
          }}
          placeholder="메모 입력... (/ 로 블록 타입 선택, # 제목, - 목록, > 인용)"
          className="flex-1 text-sm bg-transparent outline-none text-gray-800 dark:text-gray-200
                     placeholder-gray-400"
        />

        {/* 파일 첨부 버튼 */}
        {onAttachFile && (
          <button
            onClick={onAttachFile}
            className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center
                       bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400
                       hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            title="파일 첨부"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </button>
        )}

        {/* 전송 버튼 */}
        <button
          onClick={submit}
          disabled={!text.trim() || showSlash}
          className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center
                     bg-accent-500 text-white disabled:opacity-30 hover:bg-accent-600
                     transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-5 5m5-5l5 5" />
          </svg>
        </button>
      </div>
    </div>
  )
})
