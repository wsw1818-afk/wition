import { useState, useRef, useEffect, useCallback } from 'react'
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setText(item.content) }, [item.content])

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(text.length, text.length)
      autoResize(ref.current)
    }
  }, [editing])

  // 자동 저장: 1초 디바운스
  const autoSave = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const trimmed = value.trim()
      if (trimmed && trimmed !== item.content) onUpdate(trimmed)
    }, 1000)
  }, [item.content, onUpdate])

  // 컴포넌트 언마운트 시 타이머 정리
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
          onChange={(e) => { setText(e.target.value); autoResize(e.target); autoSave(e.target.value) }}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Escape') save() }}
          className="w-full bg-transparent text-sm text-gray-800 dark:text-gray-200 resize-none
                     outline-none leading-relaxed"
          rows={1}
        />
      ) : (
        <div
          onClick={() => setEditing(true)}
          className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed
                     cursor-text min-h-[20px]"
        >
          <RenderContent content={item.content} />
        </div>
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

/** 텍스트 내 [file:xxx] 패턴을 클릭 가능한 첨부 링크로 렌더링 */
function RenderContent({ content }: { content: string }) {
  const filePattern = /\[file:(.+?)\]/g
  const parts: (string | { fileName: string })[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = filePattern.exec(content)) !== null) {
    if (match.index > lastIndex) parts.push(content.slice(lastIndex, match.index))
    parts.push({ fileName: match[1] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < content.length) parts.push(content.slice(lastIndex))

  if (parts.length <= 1 && typeof parts[0] === 'string') return <>{content}</>

  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <button
            key={i}
            onClick={(e) => { e.stopPropagation(); window.api.openAttachment(part.fileName) }}
            className="text-accent-500 hover:underline cursor-pointer"
            title="파일 열기"
          >
            열기
          </button>
        )
      )}
    </>
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
