import { useRef, KeyboardEvent, memo, useCallback } from 'react'

interface Props {
  tags: string[]
  onChange: (tags: string[]) => void
}

export const TagInput = memo(function TagInput({ tags, onChange }: Props) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const tagsRef = useRef(tags)
  tagsRef.current = tags

  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const editingRef = useRef(false)

  const showInput = useCallback(() => {
    editingRef.current = true
    const inp = inputRef.current
    const btn = wrapperRef.current?.querySelector('[data-tag-btn]') as HTMLElement | null
    if (inp) { inp.classList.remove('hidden') }
    if (btn) btn.classList.add('hidden')
    // 이벤트 루프 완료 후 포커스 — 부모 리렌더/이벤트 처리 완료 대기
    requestAnimationFrame(() => {
      if (inp && editingRef.current) inp.focus()
    })
  }, [])

  const hideInput = useCallback(() => {
    editingRef.current = false
    const inp = inputRef.current
    const btn = wrapperRef.current?.querySelector('[data-tag-btn]') as HTMLElement | null
    if (inp) { inp.classList.add('hidden'); inp.value = '' }
    if (btn) btn.classList.remove('hidden')
  }, [])

  function commitAndClose() {
    const val = inputRef.current?.value?.trim().replace(/^#/, '') || ''
    if (val && !tagsRef.current.includes(val)) {
      onChangeRef.current([...tagsRef.current, val])
    }
    hideInput()
  }

  function addTagFromInput() {
    const val = inputRef.current?.value?.trim().replace(/^#/, '') || ''
    if (val && !tagsRef.current.includes(val)) {
      onChangeRef.current([...tagsRef.current, val])
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  function removeTag(tagToRemove: string) {
    onChangeRef.current(tagsRef.current.filter((t) => t !== tagToRemove))
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTagFromInput()
    } else if (e.key === 'Backspace' && !inputRef.current?.value && tagsRef.current.length > 0) {
      removeTag(tagsRef.current[tagsRef.current.length - 1])
    } else if (e.key === 'Escape') {
      commitAndClose()
    }
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    if (!editingRef.current) return
    if (wrapperRef.current && e.relatedTarget && wrapperRef.current.contains(e.relatedTarget as Node)) {
      return
    }
    // relatedTarget null = DOM 리플로우 blur → 포커스 복구
    if (!e.relatedTarget) {
      setTimeout(() => {
        if (editingRef.current && inputRef.current && document.activeElement !== inputRef.current) {
          inputRef.current.focus()
        }
      }, 0)
      return
    }
    commitAndClose()
  }

  function handleWrapperClick(e: React.MouseEvent) {
    e.stopPropagation()
  }

  function handleWrapperMouseDown(e: React.MouseEvent) {
    // 부모 블록의 onClick/onMouseDown에서 setFocusedBlockIdx 호출 방지
    e.stopPropagation()
  }

  return (
    <div ref={wrapperRef} className="flex flex-wrap items-center gap-1 mt-1.5" onClick={handleWrapperClick} onMouseDown={handleWrapperMouseDown}>
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

      <input
        ref={inputRef}
        type="text"
        defaultValue=""
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder="태그 입력..."
        className="hidden text-[10px] bg-transparent outline-none text-gray-600 dark:text-gray-300
                   placeholder-gray-400 w-16"
      />
      <button
        data-tag-btn
        onClick={showInput}
        className="text-[10px] text-gray-400 hover:text-accent-500 transition-colors"
      >
        + 태그
      </button>
    </div>
  )
}, (prev, next) => {
  if (prev.tags.length !== next.tags.length) return false
  return prev.tags.every((t, i) => t === next.tags[i])
})
