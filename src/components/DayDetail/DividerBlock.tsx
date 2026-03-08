import type { NoteItem } from '../../types'
import { BlockActions } from './BlockActions'

interface Props {
  item: NoteItem
  onDelete: () => void
  onTogglePin: () => void
}

export function DividerBlock({ item, onDelete, onTogglePin }: Props) {
  return (
    <div className="group relative py-2 px-3">
      <hr className="border-gray-200 dark:border-gray-700" />
      <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} />
    </div>
  )
}
