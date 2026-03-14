import { useState, useRef, useEffect, useCallback } from 'react'
import type { NoteItem } from '../../types'
import { parseCallout } from '../../types'
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

const CALLOUT_EMOJIS = ['💡', '⚠️', '❗', '📌', '✅', '❓', '📝', '🔥']

export function CalloutBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin, onCopyMove }: Props) {
  const data = parseCallout(item.content)
  const [editing, setEditing] = useState(!data.text)
  const [text, setText] = useState(data.text)
  const [emoji, setEmoji] = useState(data.emoji)
  const [showEmojis, setShowEmojis] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const d = parseCallout(item.content)
    setText(d.text)
    setEmoji(d.emoji)
  }, [item.content])

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(text.length, text.length)
      autoResize(ref.current)
    }
  }, [editing])

  const doSave = useCallback((t: string, e: string) => {
    onUpdate(JSON.stringify({ emoji: e, text: t.trim() }))
  }, [onUpdate])

  const autoSave = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSave(value, emoji), 1000)
  }, [emoji, doSave])

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  function save() {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setEditing(false)
    doSave(text, emoji)
  }

  function changeEmoji(e: string) {
    setEmoji(e)
    setShowEmojis(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    doSave(text, e)
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  return (
    <div className={`group relative rounded-lg transition-colors
      ${item.pinned ? 'border-l-2 border-accent-400' : ''}`}
    >
      <div className="flex gap-2 rounded-lg bg-gray-50 dark:bg-gray-800/70 px-3 py-2.5">
        {/* 이모지 선택 */}
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setShowEmojis(!showEmojis)}
            className="text-lg hover:bg-gray-200 dark:hover:bg-gray-700 rounded p-0.5 transition-colors"
          >
            {emoji}
          </button>
          {showEmojis && (
            <div className="absolute top-8 left-0 z-20 bg-white dark:bg-gray-800 border border-gray-200
                            dark:border-gray-700 rounded-lg shadow-lg p-1.5 flex gap-1 flex-wrap w-36">
              {CALLOUT_EMOJIS.map(e => (
                <button key={e} onClick={() => changeEmoji(e)}
                  className="text-lg p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                >{e}</button>
              ))}
            </div>
          )}
        </div>

        {/* 텍스트 */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <textarea
              ref={ref}
              value={text}
              onChange={(e) => { setText(e.target.value); autoResize(e.target); autoSave(e.target.value) }}
              onBlur={save}
              onKeyDown={(e) => { if (e.key === 'Escape') save() }}
              className="w-full bg-transparent text-sm text-gray-800 dark:text-gray-200 resize-none
                         outline-none leading-relaxed"
              rows={1}
              placeholder="콜아웃 내용을 입력하세요..."
            />
          ) : (
            <div
              onClick={() => setEditing(true)}
              className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed
                         cursor-text min-h-[20px]"
            >
              {data.text || <span className="text-gray-400">콜아웃 내용을 입력하세요...</span>}
            </div>
          )}
        </div>
      </div>

      <TagInput tags={parseTags(item.tags)} onChange={onTagsChange} />
      <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
    </div>
  )
}
