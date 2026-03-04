import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import type { NoteItem, ChecklistEntry } from '../../types'
import { parseChecklist, parseTags } from '../../types'
import { TagInput } from './TagInput'

interface Props {
  item: NoteItem
  onUpdate: (content: string) => void
  onTagsChange: (tags: string[]) => void
  onDelete: () => void
  onTogglePin: () => void
}

export function ChecklistBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin }: Props) {
  const entries = parseChecklist(item.content)

  function toggle(entryId: string) {
    const next = entries.map(e =>
      e.id === entryId ? { ...e, done: !e.done } : e
    )
    onUpdate(JSON.stringify(next))
  }

  function updateText(entryId: string, text: string) {
    const next = entries.map(e =>
      e.id === entryId ? { ...e, text } : e
    )
    onUpdate(JSON.stringify(next))
  }

  function addEntry() {
    const next: ChecklistEntry[] = [...entries, { id: uuid(), text: '', done: false }]
    onUpdate(JSON.stringify(next))
  }

  function removeEntry(entryId: string) {
    const next = entries.filter(e => e.id !== entryId)
    if (next.length === 0) {
      onDelete() // 항목이 전부 없어지면 블록 자체 삭제
    } else {
      onUpdate(JSON.stringify(next))
    }
  }

  const doneCount = entries.filter(e => e.done).length
  const total = entries.length

  return (
    <div
      className={`group relative rounded-lg px-3 py-2 transition-colors
        hover:bg-gray-50 dark:hover:bg-gray-800/50
        ${item.pinned ? 'border-l-2 border-accent-400' : ''}`}
    >
      {/* 진행률 표시 */}
      {total > 0 && (
        <div className="flex items-center gap-2 mb-1.5">
          <div className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-500 rounded-full transition-all duration-300"
              style={{ width: `${(doneCount / total) * 100}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-400">{doneCount}/{total}</span>
        </div>
      )}

      {/* 항목들 */}
      <div className="space-y-0.5">
        {entries.map((entry) => (
          <ChecklistRow
            key={entry.id}
            entry={entry}
            onToggle={() => toggle(entry.id)}
            onChangeText={(t) => updateText(entry.id, t)}
            onRemove={() => removeEntry(entry.id)}
          />
        ))}
      </div>

      {/* 항목 추가 */}
      <button
        onClick={addEntry}
        className="mt-1 text-xs text-gray-400 hover:text-accent-500 transition-colors"
      >
        + 항목 추가
      </button>

      {/* 태그 */}
      <TagInput tags={parseTags(item.tags)} onChange={onTagsChange} />

      {/* 액션 버튼 */}
      <div className="absolute right-1 top-1 hidden group-hover:flex gap-0.5">
        <SmallBtn
          onClick={onTogglePin}
          title={item.pinned ? '고정 해제' : '고정'}
        >
          <svg className={`w-3.5 h-3.5 ${item.pinned ? 'text-accent-500' : ''}`} fill={item.pinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path d="M12 2v10m0 0l-3-3m3 3l3-3M5 21h14" />
          </svg>
        </SmallBtn>
        <SmallBtn onClick={onDelete} title="삭제">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </SmallBtn>
      </div>
    </div>
  )
}

function ChecklistRow({
  entry, onToggle, onChangeText, onRemove
}: {
  entry: ChecklistEntry
  onToggle: () => void
  onChangeText: (text: string) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(!entry.text) // 빈 텍스트면 자동 편집 모드

  return (
    <div className="flex items-start gap-2 py-0.5 group/row">
      <button
        onClick={onToggle}
        className={`mt-0.5 w-4 h-4 rounded border-[1.5px] flex items-center justify-center flex-shrink-0 transition-colors
          ${entry.done
            ? 'bg-accent-500 border-accent-500'
            : 'border-gray-300 dark:border-gray-600 hover:border-accent-400'}`}
      >
        {entry.done && (
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </button>

      {editing ? (
        <input
          autoFocus
          value={entry.text}
          onChange={(e) => onChangeText(e.target.value)}
          onBlur={() => { if (entry.text.trim()) setEditing(false); else if (!entry.text) onRemove() }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); setEditing(false) }
            if (e.key === 'Escape') setEditing(false)
            if (e.key === 'Backspace' && !entry.text) onRemove()
          }}
          className="flex-1 text-sm bg-transparent outline-none text-gray-800 dark:text-gray-200"
          placeholder="항목 입력..."
        />
      ) : (
        <span
          onClick={() => setEditing(true)}
          className={`flex-1 text-sm cursor-text leading-relaxed
            ${entry.done ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-800 dark:text-gray-200'}`}
        >
          {entry.text || <span className="text-gray-300">항목 입력...</span>}
        </span>
      )}

      <button
        onClick={onRemove}
        className="opacity-0 group-hover/row:opacity-100 p-0.5 text-gray-300 hover:text-red-400 transition-all"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}

function SmallBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400
                 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
    >
      {children}
    </button>
  )
}
