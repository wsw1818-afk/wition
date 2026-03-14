import { useState, useRef, useEffect } from 'react'
import type { NoteItem } from '../../types'
import { BlockActions } from './BlockActions'

interface Props {
  item: NoteItem
  onUpdate: (content: string) => void
  onDelete: () => void
  onTogglePin: () => void
  onCopyMove?: () => void
}

export function HeadingBlock({ item, onUpdate, onDelete, onTogglePin, onCopyMove }: Props) {
  const [editing, setEditing] = useState(!item.content)
  const [text, setText] = useState(item.content)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { setText(item.content) }, [item.content])

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(text.length, text.length)
    }
  }, [editing])

  function save() {
    setEditing(false)
    const trimmed = text.trim()
    if (trimmed && trimmed !== item.content) onUpdate(trimmed)
    else setText(item.content)
  }

  const level = item.type === 'heading1' ? 1 : item.type === 'heading2' ? 2 : 3
  const sizeClass = level === 1
    ? 'text-2xl font-bold'
    : level === 2
      ? 'text-xl font-semibold'
      : 'text-lg font-medium'

  return (
    <div className={`group relative rounded-lg px-3 py-1.5 transition-colors
      hover:bg-gray-50 dark:hover:bg-gray-800/50
      ${item.pinned ? 'border-l-2 border-accent-400' : ''}`}
    >
      {editing ? (
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) save()
            if (e.key === 'Escape') save()
          }}
          className={`w-full bg-transparent outline-none text-gray-800 dark:text-gray-200 ${sizeClass}`}
          placeholder={`제목 ${level}`}
        />
      ) : (
        <div
          onClick={() => setEditing(true)}
          className={`cursor-text text-gray-800 dark:text-gray-200 ${sizeClass} min-h-[24px]`}
        >
          {item.content || <span className="text-gray-300 dark:text-gray-600">제목 {level}</span>}
        </div>
      )}
      <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
    </div>
  )
}
