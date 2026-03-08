import { useState, useRef, useEffect, useCallback } from 'react'
import type { NoteItem } from '../../types'
import { BlockActions } from './BlockActions'
import { TagInput } from './TagInput'
import { parseTags } from '../../types'

interface Props {
  item: NoteItem
  onUpdate: (content: string) => void
  onTagsChange: (tags: string[]) => void
  onDelete: () => void
  onTogglePin: () => void
}

export function QuoteBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin }: Props) {
  const [editing, setEditing] = useState(!item.content)
  const [text, setText] = useState(item.content)
  const ref = useRef<HTMLTextAreaElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setText(item.content) }, [item.content])

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(text.length, text.length)
      autoResize(ref.current)
    }
  }, [editing])

  const autoSave = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (value.trim() !== item.content) onUpdate(value.trim())
    }, 1000)
  }, [item.content, onUpdate])

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  function save() {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setEditing(false)
    const trimmed = text.trim()
    if (trimmed && trimmed !== item.content) onUpdate(trimmed)
    else setText(item.content)
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  return (
    <div className={`group relative rounded-lg px-3 py-2 transition-colors
      hover:bg-gray-50 dark:hover:bg-gray-800/50
      ${item.pinned ? 'border-l-2 border-accent-400' : ''}`}
    >
      <div className="border-l-[3px] border-gray-300 dark:border-gray-600 pl-3">
        {editing ? (
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => { setText(e.target.value); autoResize(e.target); autoSave(e.target.value) }}
            onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Escape') save() }}
            className="w-full bg-transparent text-sm text-gray-600 dark:text-gray-400 italic resize-none
                       outline-none leading-relaxed"
            rows={1}
            placeholder="인용문을 입력하세요..."
          />
        ) : (
          <div
            onClick={() => setEditing(true)}
            className="text-sm text-gray-600 dark:text-gray-400 italic whitespace-pre-wrap leading-relaxed
                       cursor-text min-h-[20px]"
          >
            {item.content || <span className="text-gray-300 dark:text-gray-600 not-italic">인용문을 입력하세요...</span>}
          </div>
        )}
      </div>

      <TagInput tags={parseTags(item.tags)} onChange={onTagsChange} />
      <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} />
    </div>
  )
}
