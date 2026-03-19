import { useEffect, useRef, useState, useCallback } from 'react'
import type { InputBarHandle } from './InputBar'
import dayjs from 'dayjs'
import 'dayjs/locale/ko'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useDayStore } from '../../stores/dayStore'
import { useCalendarStore } from '../../stores/calendarStore'
import { InputBar } from './InputBar'
import { EmptyState } from '../common/EmptyState'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SortableBlock } from './SortableBlock'
import { AlarmPanel } from './AlarmPanel'
import { TemplatePanel } from './TemplatePanel'
import { CopyMoveDialog } from './CopyMoveDialog'
import type { NoteItem } from '../../types'

dayjs.locale('ko')

export function DayDetailView() {
  const { selectedDate, clearSelection, patchDay } = useCalendarStore()
  const { items, loading, load, addText, addChecklist, addBlock, update, remove, togglePin, reset, reorder } = useDayStore()
  const inputRef = useRef<InputBarHandle>(null)
  const listEndRef = useRef<HTMLDivElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [showTemplate, setShowTemplate] = useState(false)
  const [copyMoveItem, setCopyMoveItem] = useState<NoteItem | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [focusedBlockIdx, setFocusedBlockIdx] = useState(-1)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  useEffect(() => {
    if (selectedDate) {
      load(selectedDate).then(() => {
        setTimeout(() => inputRef.current?.focus(), 100)
      })
    } else {
      reset()
    }
    // 선택 모드 해제
    setSelectMode(false)
    setSelectedIds(new Set())
    setFocusedBlockIdx(-1)
  }, [selectedDate])

  // Alt+Up/Down 블록 순서 이동 (1-4)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      if (focusedBlockIdx < 0 || items.length < 2) return
      e.preventDefault()

      const dir = e.key === 'ArrowUp' ? -1 : 1
      const newIdx = focusedBlockIdx + dir
      if (newIdx < 0 || newIdx >= items.length) return

      const newItems = [...items]
      const [moved] = newItems.splice(focusedBlockIdx, 1)
      newItems.splice(newIdx, 0, moved)
      const orderedIds = newItems.map(i => i.id)
      reorder(orderedIds)
      setFocusedBlockIdx(newIdx)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [focusedBlockIdx, items, reorder])

  if (!selectedDate) return null

  const dateLabel = dayjs(selectedDate).format('YYYY년 M월 D일 (ddd)')

  async function handleAddText(text: string) {
    const day = await addText(text)
    if (day) {
      patchDay(day)
      setTimeout(() => listEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
  }

  async function handleAddChecklist(text?: string) {
    const day = await addChecklist(text)
    if (day) {
      patchDay(day)
      setTimeout(() => listEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
  }

  async function handleAddBlock(type: import('../../types').BlockType, content?: string) {
    const day = await addBlock(type, content)
    if (day) {
      patchDay(day)
      setTimeout(() => listEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
  }

  async function handleUpdate(id: string, content: string) {
    const day = await update(id, { content })
    if (day) patchDay(day)
  }

  function handleDeleteRequest(id: string) {
    setDeleteTarget(id)
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return
    const day = await remove(deleteTarget)
    if (day) patchDay(day)
    setDeleteTarget(null)
  }

  async function handleTogglePin(id: string) {
    const day = await togglePin(id)
    if (day) patchDay(day)
  }

  const handleTagsChange = useCallback(async (id: string, tags: string[]) => {
    const day = await update(id, { tags: JSON.stringify(tags) })
    if (day) patchDay(day)
  }, [update, patchDay])

  // 선택 모드 토글
  function toggleSelectItem(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 선택된 아이템 일괄 삭제 (2-3)
  async function handleDeleteSelected() {
    for (const id of selectedIds) {
      const day = await remove(id)
      if (day) patchDay(day)
    }
    setSelectedIds(new Set())
    setSelectMode(false)
  }

  async function handleAttachFile() {
    const files = await window.api.attachFile()
    if (!files || files.length === 0) return
    // 첨부 파일 정보를 텍스트 블록으로 추가
    for (const f of files) {
      const sizeStr = f.size < 1024 ? `${f.size}B`
        : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)}KB`
        : `${(f.size / (1024 * 1024)).toFixed(1)}MB`
      const day = await addText(`📎 ${f.name} (${sizeStr})\n[file:${f.path}]`)
      if (day) patchDay(day)
    }
  }

  // 클립보드 이미지(스크린샷) 붙여넣기
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) continue

        const reader = new FileReader()
        reader.onload = async () => {
          const base64 = (reader.result as string).split(',')[1]
          const result = await window.api.saveClipboardImage(base64)
          if (result) {
            const sizeStr = result.size < 1024 ? `${result.size}B`
              : result.size < 1024 * 1024 ? `${(result.size / 1024).toFixed(1)}KB`
              : `${(result.size / (1024 * 1024)).toFixed(1)}MB`
            const day = await addText(`📷 ${result.name} (${sizeStr})\n[file:${result.path}]`)
            if (day) patchDay(day)
          }
        }
        reader.readAsDataURL(blob)
        return
      }
    }
  }, [addText, patchDay])

  useEffect(() => {
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [handlePaste])

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((item) => item.id === active.id)
      const newIndex = items.findIndex((item) => item.id === over.id)
      const newItems = [...items]
      const [movedItem] = newItems.splice(oldIndex, 1)
      newItems.splice(newIndex, 0, movedItem)
      const orderedIds = newItems.map((item) => item.id)
      await reorder(orderedIds)
    }
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-3">
          <button
            onClick={clearSelection}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="뒤로"
          >
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">{dateLabel}</h2>
        </div>
        <div className="flex items-center gap-1">
          {/* 선택 모드 토글 (2-3) */}
          <button
            onClick={() => {
              setSelectMode(!selectMode)
              setSelectedIds(new Set())
            }}
            className={`p-1.5 rounded-lg transition-colors text-xs
              ${selectMode
                ? 'bg-accent-100 dark:bg-accent-500/20 text-accent-600 dark:text-accent-400'
                : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
            title="선택 모드"
          >
            ☑
          </button>
          {/* 선택 삭제 */}
          {selectMode && selectedIds.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors text-xs text-red-500"
              title={`${selectedIds.size}개 삭제`}
            >
              🗑 {selectedIds.size}
            </button>
          )}
          {/* 템플릿 (3-2) */}
          <button
            onClick={() => setShowTemplate(true)}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title="템플릿"
          >
            📋
          </button>
          {/* 마크다운 내보내기 */}
          <button
            onClick={async () => {
              const path = await window.api.exportMarkdown(selectedDate!)
              if (path) alert(`내보내기 완료: ${path}`)
            }}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title="마크다운 내보내기"
          >
            MD
          </button>
        </div>
      </div>

      <AlarmPanel dayId={selectedDate} />

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">불러오는 중...</div>
        ) : items.length === 0 ? (
          <EmptyState onAdd={() => inputRef.current?.focus()} />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1 py-1">
                {items.map((item, idx) => (
                  <div key={item.id} className="flex items-start gap-1" onClick={() => setFocusedBlockIdx(idx)}>
                    {selectMode && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleSelectItem(item.id)}
                        className="mt-2.5 w-4 h-4 accent-accent-500 flex-shrink-0 cursor-pointer"
                      />
                    )}
                    <div className={`flex-1 min-w-0 ${focusedBlockIdx === idx ? 'ring-1 ring-accent-300 dark:ring-accent-600 rounded-md' : ''}`}>
                      <SortableBlock
                        item={item}
                        onUpdate={(c: string) => handleUpdate(item.id, c)}
                        onTagsChange={(tags: string[]) => handleTagsChange(item.id, tags)}
                        onDelete={() => handleDeleteRequest(item.id)}
                        onTogglePin={() => handleTogglePin(item.id)}
                        onCopyMove={() => setCopyMoveItem(item)}
                      />
                    </div>
                  </div>
                ))}
                <div ref={listEndRef} />
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <InputBar ref={inputRef} onAddText={handleAddText} onAddChecklist={handleAddChecklist} onAddBlock={handleAddBlock} onAttachFile={handleAttachFile} />

      <ConfirmDialog
        open={!!deleteTarget}
        title="메모 삭제"
        message="이 메모를 삭제하시겠습니까? 삭제된 메모는 복구할 수 없습니다."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 템플릿 패널 (3-2) */}
      {showTemplate && selectedDate && (
        <TemplatePanel
          dayId={selectedDate}
          items={items}
          onApplied={() => { load(selectedDate!); setShowTemplate(false) }}
          onClose={() => setShowTemplate(false)}
        />
      )}

      {/* 복사/이동 다이얼로그 (2-1) */}
      {copyMoveItem && (
        <CopyMoveDialog
          item={copyMoveItem}
          open={!!copyMoveItem}
          onClose={() => setCopyMoveItem(null)}
          onDone={() => {
            if (selectedDate) load(selectedDate)
            useCalendarStore.getState().loadMonth(useCalendarStore.getState().currentMonth)
          }}
        />
      )}
    </div>
  )
}
