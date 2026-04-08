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
  onCopyMove?: () => void
}

/** 글머리 기호 / 번호 목록 블록 */
export function ListBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin, onCopyMove }: Props) {
  const [editing, setEditing] = useState(!item.content)
  const [text, setText] = useState(item.content)
  const ref = useRef<HTMLTextAreaElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isBulleted = item.type === 'bulleted_list'

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

  // 각 줄을 리스트 아이템으로 렌더링
  const lines = (item.content || '').split('\n').filter(l => l.trim())

  return (
    <div className={`group relative rounded-lg px-3 py-1 transition-colors
      hover:bg-gray-50 dark:hover:bg-white/[0.04]
      ${item.pinned ? 'border-l-2 border-accent-400' : ''}`}
    >
      {editing ? (
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => { setText(e.target.value); autoResize(e.target); autoSave(e.target.value) }}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Escape') save() }}
          className="w-full bg-transparent text-base text-gray-800 dark:text-gray-200 resize-none
                     outline-none leading-relaxed pl-5"
          rows={1}
          placeholder={isBulleted ? '목록 항목 (줄바꿈으로 구분)' : '번호 목록 (줄바꿈으로 구분)'}
        />
      ) : (
        <div onClick={() => setEditing(true)} className="cursor-text min-h-[20px]">
          {lines.length > 0 ? (
            <ul className={`space-y-0.5 ${isBulleted ? 'list-disc' : 'list-decimal'} list-inside`}>
              {lines.map((line, i) => (
                <li key={i} className="text-base text-gray-800 dark:text-gray-200 leading-relaxed">{line}</li>
              ))}
            </ul>
          ) : (
            <span className="text-sm text-gray-300 dark:text-gray-600">
              {isBulleted ? '글머리 기호 목록...' : '번호 목록...'}
            </span>
          )}
        </div>
      )}

      <TagInput tags={parseTags(item.tags)} onChange={onTagsChange} />
      <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
    </div>
  )
}
