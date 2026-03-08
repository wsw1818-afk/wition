import { useState, useRef, useEffect, useCallback } from 'react'
import type { NoteItem } from '../../types'
import { parseTags } from '../../types'
import { TagInput } from './TagInput'
import { InlineRenderer } from './InlineRenderer'
import { BlockActions } from './BlockActions'

interface Props {
  item: NoteItem
  onUpdate: (content: string) => void
  onTagsChange: (tags: string[]) => void
  onDelete: () => void
  onTogglePin: () => void
}

export function TextBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin }: Props) {
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // [file:...] 태그를 분리하여 편집 영역에서 보호
  const fileTagMatch = item.content.match(/\[file:.+?\]/)
  const fileTag = fileTagMatch ? fileTagMatch[0] : null
  const editableContent = fileTag ? item.content.replace(fileTag, '').trim() : item.content
  const [text, setText] = useState(editableContent)

  useEffect(() => {
    const editable = fileTag ? item.content.replace(fileTag, '').trim() : item.content
    setText(editable)
  }, [item.content])

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(text.length, text.length)
      autoResize(ref.current)
    }
  }, [editing])

  // 전체 content 복원 (편집 텍스트 + file 태그)
  function buildContent(editText: string): string {
    if (!fileTag) return editText
    const trimmed = editText.trim()
    return trimmed ? `${trimmed}\n${fileTag}` : fileTag
  }

  // 자동 저장: 1초 디바운스
  const autoSave = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const full = buildContent(value)
      if (full !== item.content) onUpdate(full)
    }, 1000)
  }, [item.content, onUpdate, fileTag])

  // 컴포넌트 언마운트 시 타이머 정리
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  function save() {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setEditing(false)
    const full = buildContent(text)
    if (full !== item.content) onUpdate(full)
    else {
      const editable = fileTag ? item.content.replace(fileTag, '').trim() : item.content
      setText(editable)
    }
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
        <div>
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => { setText(e.target.value); autoResize(e.target); autoSave(e.target.value) }}
            onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Escape') save() }}
            className="w-full bg-transparent text-sm text-gray-800 dark:text-gray-200 resize-none
                       outline-none leading-relaxed"
            rows={1}
          />
          {fileTag && (
            <div className="mt-1 pointer-events-auto">
              <InlineRenderer text={fileTag} />
            </div>
          )}
        </div>
      ) : (
        <div
          onClick={() => setEditing(true)}
          className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed
                     cursor-text min-h-[20px]"
        >
          <InlineRenderer text={item.content} />
        </div>
      )}

      {/* 태그 */}
      <TagInput tags={parseTags(item.tags)} onChange={onTagsChange} />

      <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} />
    </div>
  )
}

