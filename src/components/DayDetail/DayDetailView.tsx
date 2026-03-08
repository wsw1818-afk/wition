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

dayjs.locale('ko')

export function DayDetailView() {
  const { selectedDate, clearSelection, patchDay } = useCalendarStore()
  const { items, loading, load, addText, addChecklist, addBlock, update, remove, togglePin, reset, reorder } = useDayStore()
  const inputRef = useRef<InputBarHandle>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
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
        // 빈 날짜 → 바로 입력 포커스 (#12)
        setTimeout(() => inputRef.current?.focus(), 100)
      })
    } else {
      reset()
    }
  }, [selectedDate])

  if (!selectedDate) return null

  const dateLabel = dayjs(selectedDate).format('YYYY년 M월 D일 (ddd)')

  async function handleAddText(text: string) {
    const day = await addText(text)
    if (day) patchDay(day)
  }

  async function handleAddChecklist(text?: string) {
    const day = await addChecklist(text)
    if (day) patchDay(day)
  }

  async function handleAddBlock(type: import('../../types').BlockType, content?: string) {
    const day = await addBlock(type, content)
    if (day) patchDay(day)
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

  async function handleTagsChange(id: string, tags: string[]) {
    const day = await update(id, { tags: JSON.stringify(tags) })
    if (day) patchDay(day)
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
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{dateLabel}</h2>
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
              <div className="flex flex-col gap-1.5 py-1">
                {items.map((item) => (
                  <SortableBlock
                    key={item.id}
                    item={item}
                    onUpdate={(c: string) => handleUpdate(item.id, c)}
                    onTagsChange={(tags: string[]) => handleTagsChange(item.id, tags)}
                    onDelete={() => handleDeleteRequest(item.id)}
                    onTogglePin={() => handleTogglePin(item.id)}
                  />
                ))}
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
    </div>
  )
}
