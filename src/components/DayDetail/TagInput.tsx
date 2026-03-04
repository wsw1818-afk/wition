import { useState, useRef, KeyboardEvent } from 'react'

interface Props {
  tags: string[]
  onChange: (tags: string[]) => void
}

export function TagInput({ tags, onChange }: Props) {
  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function startEditing() {
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function stopEditing() {
    setEditing(false)
    setInputValue('')
  }

  function addTag(tag: string) {
    const trimmed = tag.trim().replace(/^#/, '') // # 접두사 제거
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed])
    }
    setInputValue('')
  }

  function removeTag(tagToRemove: string) {
    onChange(tags.filter((t) => t !== tagToRemove))
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === ',') {
      e.preventDefault()
      if (inputValue.trim()) {
        addTag(inputValue)
      }
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      // 입력값 없이 Backspace 시 마지막 태그 제거
      removeTag(tags[tags.length - 1])
    } else if (e.key === 'Escape') {
      stopEditing()
    }
  }

  function handleBlur() {
    if (inputValue.trim()) {
      addTag(inputValue)
    }
    stopEditing()
  }

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1.5">
      {/* 기존 태그 표시 */}
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded
                     bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400
                     group/tag"
        >
          #{tag}
          <button
            onClick={() => removeTag(tag)}
            className="opacity-0 group-hover/tag:opacity-100 hover:text-red-400 transition-opacity"
          >
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}

      {/* 태그 추가 버튼 / 입력 필드 */}
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder="태그 입력..."
          className="text-[10px] bg-transparent outline-none text-gray-600 dark:text-gray-300
                     placeholder-gray-400 w-16"
        />
      ) : (
        <button
          onClick={startEditing}
          className="text-[10px] text-gray-400 hover:text-accent-500 transition-colors"
        >
          + 태그
        </button>
      )}
    </div>
  )
}
