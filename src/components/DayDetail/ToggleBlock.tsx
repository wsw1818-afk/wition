import { useState, useRef, useEffect, useCallback } from 'react'
import type { NoteItem } from '../../types'
import { parseToggle } from '../../types'
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

export function ToggleBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin, onCopyMove }: Props) {
  const data = parseToggle(item.content)
  const [open, setOpen] = useState(false)

  // DB에서 토글 상태 로드 (초기 1회)
  useEffect(() => {
    window.api.getToggleStates().then((states) => {
      if (states[item.id]) setOpen(true)
    })
  }, [item.id])

  // 토글 시 DB에 상태 저장
  const handleToggle = useCallback(() => {
    const next = !open
    setOpen(next)
    window.api.setToggleState(item.id, next)
  }, [open, item.id])
  const [editingTitle, setEditingTitle] = useState(!data.title)
  const [editingBody, setEditingBody] = useState(false)
  const [title, setTitle] = useState(data.title)
  const [children, setChildren] = useState(data.children)
  const titleRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const d = parseToggle(item.content)
    setTitle(d.title)
    setChildren(d.children)
  }, [item.content])

  useEffect(() => {
    if (editingTitle && titleRef.current) {
      titleRef.current.focus()
      titleRef.current.setSelectionRange(title.length, title.length)
    }
  }, [editingTitle])

  useEffect(() => {
    if (editingBody && bodyRef.current) {
      bodyRef.current.focus()
      autoResize(bodyRef.current)
    }
  }, [editingBody])

  const doSave = useCallback((t: string, c: string) => {
    onUpdate(JSON.stringify({ title: t.trim(), children: c.trim() }))
  }, [onUpdate])

  const autoSave = useCallback((t: string, c: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSave(t, c), 1000)
  }, [doSave])

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  function saveTitle() {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setEditingTitle(false)
    doSave(title, children)
  }

  function saveBody() {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setEditingBody(false)
    doSave(title, children)
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
      {/* 토글 헤더 */}
      <div className="flex items-start gap-1.5">
        <button
          onClick={handleToggle}
          className="mt-0.5 flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => { setTitle(e.target.value); autoSave(e.target.value, children) }}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) { saveTitle(); setOpen(true) }
                if (e.key === 'Escape') saveTitle()
              }}
              className="w-full bg-transparent text-sm font-medium text-gray-800 dark:text-gray-200 outline-none"
              placeholder="토글 제목..."
            />
          ) : (
            <div
              onClick={() => setEditingTitle(true)}
              className="text-sm font-medium text-gray-800 dark:text-gray-200 cursor-text min-h-[20px]"
            >
              {data.title || <span className="text-gray-300 dark:text-gray-600">토글 제목...</span>}
            </div>
          )}
        </div>
      </div>

      {/* 토글 본문 (열린 상태) */}
      {open && (
        <div className="ml-5.5 mt-1 pl-2 border-l border-gray-200 dark:border-gray-700">
          {editingBody ? (
            <textarea
              ref={bodyRef}
              value={children}
              onChange={(e) => { setChildren(e.target.value); autoResize(e.target); autoSave(title, e.target.value) }}
              onBlur={saveBody}
              onKeyDown={(e) => { if (e.key === 'Escape') saveBody() }}
              className="w-full bg-transparent text-sm text-gray-700 dark:text-gray-300 resize-none
                         outline-none leading-relaxed"
              rows={1}
              placeholder="토글 내용..."
            />
          ) : (
            <div
              onClick={() => setEditingBody(true)}
              className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed
                         cursor-text min-h-[20px]"
            >
              {data.children || <span className="text-gray-300 dark:text-gray-600">토글 내용을 입력하세요...</span>}
            </div>
          )}
        </div>
      )}

      <TagInput tags={parseTags(item.tags)} onChange={onTagsChange} />
      <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
    </div>
  )
}
