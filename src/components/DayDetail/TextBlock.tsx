import { useState, useRef, useEffect } from 'react'
import type { NoteItem } from '../../types'
import { parseTags } from '../../types'
import { TagInput } from './TagInput'

interface Props {
  item: NoteItem
  onUpdate: (content: string) => void
  onTagsChange: (tags: string[]) => void
  onDelete: () => void
  onTogglePin: () => void
}

export function TextBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin }: Props) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.content)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setText(item.content) }, [item.content])

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(text.length, text.length)
      autoResize(ref.current)
    }
  }, [editing])

  function save() {
    setEditing(false)
    const trimmed = text.trim()
    if (trimmed && trimmed !== item.content) onUpdate(trimmed)
    else setText(item.content) // 변경 없으면 복원
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  return (
    <div
      className={`group relative rounded-lg px-3 py-2 transition-colors
        hover:bg-gray-50 dark:hover:bg-gray-800/50
        ${item.pinned ? 'border-l-2 border-accent-400' : ''}`}
    >
      {/* 본문 */}
      {editing ? (
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => { setText(e.target.value); autoResize(e.target) }}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Escape') save() }}
          className="w-full bg-transparent text-sm text-gray-800 dark:text-gray-200 resize-none
                     outline-none leading-relaxed"
          rows={1}
        />
      ) : (
        <p
          onClick={() => setEditing(true)}
          className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed
                     cursor-text min-h-[20px]"
        >
          {item.content}
        </p>
      )}

      {/* 태그 */}
      <TagInput tags={parseTags(item.tags)} onChange={onTagsChange} />

      {/* 액션 버튼 (hover 시 표시) */}
      <div className="absolute right-1 top-1 hidden group-hover:flex gap-0.5">
        <ActionBtn
          onClick={onTogglePin}
          title={item.pinned ? '고정 해제' : '고정'}
          icon={item.pinned ? 'pin-filled' : 'pin'}
        />
        <ActionBtn onClick={onDelete} title="삭제" icon="trash" />
      </div>
    </div>
  )
}

function ActionBtn({ onClick, title, icon }: { onClick: () => void; title: string; icon: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400
                 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
    >
      {icon === 'pin' && (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path d="M12 2v10m0 0l-3-3m3 3l3-3M5 21h14" />
        </svg>
      )}
      {icon === 'pin-filled' && (
        <svg className="w-3.5 h-3.5 text-accent-500" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 2v10m0 0l-3-3m3 3l3-3M5 21h14" />
        </svg>
      )}
      {icon === 'trash' && (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      )}
    </button>
  )
}
