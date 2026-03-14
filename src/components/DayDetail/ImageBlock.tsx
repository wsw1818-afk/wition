import { useState } from 'react'
import type { NoteItem } from '../../types'
import { parseImageData } from '../../types'
import { BlockActions } from './BlockActions'

interface Props {
  item: NoteItem
  onUpdate: (content: string) => void
  onTagsChange: (tags: string[]) => void
  onDelete: () => void
  onTogglePin: () => void
  onCopyMove?: () => void
}

export function ImageBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin, onCopyMove }: Props) {
  const data = parseImageData(item.content)
  const [caption, setCaption] = useState(data.caption)
  const [editingCaption, setEditingCaption] = useState(false)

  const hasSrc = !!data.src

  async function handleSelectImage() {
    const files = await window.api.attachFile()
    if (!files || files.length === 0) return
    const f = files[0]
    const updated = { ...data, src: f.path }
    onUpdate(JSON.stringify(updated))
  }

  function saveCaption() {
    setEditingCaption(false)
    if (caption !== data.caption) {
      const updated = { ...data, caption }
      onUpdate(JSON.stringify(updated))
    }
  }

  // 이미지 경로 결정: http URL이면 그대로, file: 접두사 또는 일반 파일명이면 로컬 참조
  const imgSrc = hasSrc
    ? data.src.startsWith('http')
      ? data.src
      : `wition-file://${data.src}`
    : ''

  return (
    <div
      className={`group relative rounded-lg px-3 py-2 transition-colors
        hover:bg-gray-50 dark:hover:bg-gray-800/50
        ${item.pinned ? 'border-l-2 border-accent-400' : ''}`}
    >
      {hasSrc ? (
        <div>
          <div className="rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800">
            <img
              src={imgSrc}
              alt={data.caption || '이미지'}
              className="max-w-full max-h-[400px] object-contain mx-auto"
              onError={(e) => {
                // 로드 실패 시 파일명 표시
                (e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          </div>
          {/* 캡션 */}
          {editingCaption ? (
            <input
              autoFocus
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onBlur={saveCaption}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') saveCaption() }}
              placeholder="캡션 입력..."
              className="mt-1.5 w-full text-xs text-gray-500 dark:text-gray-400 bg-transparent outline-none
                         border-b border-gray-200 dark:border-gray-700 pb-0.5"
            />
          ) : (
            <p
              onClick={() => setEditingCaption(true)}
              className="mt-1.5 text-xs text-gray-400 dark:text-gray-500 cursor-text min-h-[16px]"
            >
              {data.caption || '캡션을 입력하세요...'}
            </p>
          )}
        </div>
      ) : (
        <button
          onClick={handleSelectImage}
          className="w-full py-8 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700
                     text-gray-400 dark:text-gray-500 hover:border-accent-400 hover:text-accent-500
                     transition-colors flex flex-col items-center gap-2"
        >
          <span className="text-2xl">🖼</span>
          <span className="text-xs">이미지 선택</span>
        </button>
      )}

      <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
    </div>
  )
}
