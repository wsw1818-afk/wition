import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { NoteItem } from '../../types'
import { TextBlock } from './TextBlock'
import { ChecklistBlock } from './ChecklistBlock'

interface Props {
  item: NoteItem
  onUpdate: (content: string) => void
  onTagsChange: (tags: string[]) => void
  onDelete: () => void
  onTogglePin: () => void
}

export function SortableBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="relative group/drag">
      {/* 드래그 핸들 */}
      <div
        {...attributes}
        {...listeners}
        className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1 pl-1
                   opacity-0 group-hover/drag:opacity-100 cursor-grab active:cursor-grabbing
                   text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400
                   transition-opacity z-10"
        title="드래그하여 이동"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <circle cx="9" cy="6" r="1.5" />
          <circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" />
          <circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" />
          <circle cx="15" cy="18" r="1.5" />
        </svg>
      </div>

      {/* 블록 컨텐츠 */}
      <div className="pl-4">
        {item.type === 'text' ? (
          <TextBlock
            item={item}
            onUpdate={onUpdate}
            onTagsChange={onTagsChange}
            onDelete={onDelete}
            onTogglePin={onTogglePin}
          />
        ) : (
          <ChecklistBlock
            item={item}
            onUpdate={onUpdate}
            onTagsChange={onTagsChange}
            onDelete={onDelete}
            onTogglePin={onTogglePin}
          />
        )}
      </div>
    </div>
  )
}
