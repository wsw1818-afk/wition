import { useEffect, useRef, useState } from 'react'
import type { InputBarHandle } from './InputBar'
import dayjs from 'dayjs'
import 'dayjs/locale/ko'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useDayStore } from '../../stores/dayStore'
import { useCalendarStore } from '../../stores/calendarStore'
import { InputBar } from './InputBar'
import { EmptyState } from '../common/EmptyState'
import { MoodPicker } from '../common/MoodPicker'
import { SortableBlock } from './SortableBlock'

dayjs.locale('ko')

export function DayDetailView() {
  const { selectedDate, dayMap, clearSelection, patchDay } = useCalendarStore()
  const { items, loading, load, addText, addChecklist, update, remove, togglePin, reset, reorder } = useDayStore()
  const inputRef = useRef<InputBarHandle>(null)
  const [currentMood, setCurrentMood] = useState<string | null>(null)

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
      load(selectedDate)
      const dayData = dayMap[selectedDate]
      setCurrentMood(dayData?.mood ?? null)
    } else {
      reset()
      setCurrentMood(null)
    }
  }, [selectedDate])

  if (!selectedDate) return null

  const dateLabel = dayjs(selectedDate).format('YYYY년 M월 D일 (ddd)')

  async function handleMoodChange(mood: string | null) {
    if (!selectedDate) return
    setCurrentMood(mood)
    await window.api.updateMood(selectedDate, mood)
    const updatedDay = await window.api.getNoteDay(selectedDate)
    if (updatedDay) patchDay(updatedDay)
  }

  async function handleAddText(text: string) {
    const day = await addText(text)
    if (day) patchDay(day)
  }

  async function handleAddChecklist(text?: string) {
    const day = await addChecklist(text)
    if (day) patchDay(day)
  }

  async function handleUpdate(id: string, content: string) {
    const day = await update(id, { content })
    if (day) patchDay(day)
  }

  async function handleDelete(id: string) {
    const day = await remove(id)
    if (day) patchDay(day)
  }

  async function handleTogglePin(id: string) {
    const day = await togglePin(id)
    if (day) patchDay(day)
  }

  async function handleTagsChange(id: string, tags: string[]) {
    const day = await update(id, { tags: JSON.stringify(tags) })
    if (day) patchDay(day)
  }

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
        <MoodPicker selected={currentMood} onChange={handleMoodChange} />
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">불러오는 중...</div>
        ) : items.length === 0 ? (
          <EmptyState onAdd={() => inputRef.current?.focus()} />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {items.map((item) => (
                  <SortableBlock
                    key={item.id}
                    item={item}
                    onUpdate={(c: string) => handleUpdate(item.id, c)}
                    onTagsChange={(tags: string[]) => handleTagsChange(item.id, tags)}
                    onDelete={() => handleDelete(item.id)}
                    onTogglePin={() => handleTogglePin(item.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <InputBar ref={inputRef} onAddText={handleAddText} onAddChecklist={handleAddChecklist} />
    </div>
  )
}
