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

function formatUploadTime(epoch: number): string {
  const d = new Date(epoch)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `업로드: ${y}.${mo}.${da} ${h}:${mi}`
}

export function TextBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin }: Props) {
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // [file:...] 태그 감지 → 파일 첨부 블록 여부
  const fileTagMatch = item.content.match(/\[file:.+?\]/)
  const fileTag = fileTagMatch ? fileTagMatch[0] : null
  const isFileBlock = !!fileTag

  const [text, setText] = useState(isFileBlock ? '' : item.content)

  useEffect(() => {
    if (!isFileBlock) setText(item.content)
  }, [item.content])

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(text.length, text.length)
      autoResize(ref.current)
    }
  }, [editing])

  // 자동 저장: 1초 디바운스 (일반 텍스트 블록 전용)
  const autoSave = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (value !== item.content) onUpdate(value)
    }, 1000)
  }, [item.content, onUpdate])

  // 컴포넌트 언마운트 시 타이머 정리
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  function save() {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setEditing(false)
    if (text !== item.content) onUpdate(text)
    else setText(item.content)
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
      {isFileBlock ? (
        /* 파일 첨부 블록: 편집 불가, 업로드 시간 표시 */
        <div className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed">
          <InlineRenderer text={item.content} />
          <div className="mt-1 text-[11px] text-gray-400 dark:text-gray-500 select-none">
            {formatUploadTime(item.created_at)}
          </div>
        </div>
      ) : editing ? (
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

