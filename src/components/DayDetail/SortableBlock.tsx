import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { NoteItem } from '../../types'
import { EncryptDialog } from './EncryptDialog'
import { BlockActions } from './BlockActions'
import { TextBlock } from './TextBlock'
import { ChecklistBlock } from './ChecklistBlock'
import { HeadingBlock } from './HeadingBlock'
import { ListBlock } from './ListBlock'
import { QuoteBlock } from './QuoteBlock'
import { DividerBlock } from './DividerBlock'
import { CalloutBlock } from './CalloutBlock'
import { CodeBlock } from './CodeBlock'
import { ToggleBlock } from './ToggleBlock'
import { ImageBlock } from './ImageBlock'

interface Props {
  item: NoteItem
  onUpdate: (content: string) => void
  onTagsChange: (tags: string[]) => void
  onDelete: () => void
  onTogglePin: () => void
  onCopyMove?: () => void
}

export function SortableBlock({ item, onUpdate, onTagsChange, onDelete, onTogglePin, onCopyMove }: Props) {
  const [encryptDialog, setEncryptDialog] = useState<'encrypt' | 'decrypt' | null>(null)
  const [decryptedContent, setDecryptedContent] = useState<string | null>(null)

  const isEncrypted = !!(item as any).encrypted

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

  async function handleEncryptAction() {
    if (isEncrypted) {
      setEncryptDialog('decrypt')
    } else {
      setEncryptDialog('encrypt')
    }
  }

  async function handleEncryptConfirm(password: string) {
    if (encryptDialog === 'encrypt') {
      const ok = await window.api.encryptBlock(item.id, password)
      if (ok) {
        // 블록을 다시 로드하기 위해 페이지 리프레시
        window.dispatchEvent(new Event('sync-refresh'))
      }
    } else if (encryptDialog === 'decrypt') {
      const content = await window.api.decryptBlock(item.id, password)
      if (content !== null) {
        setDecryptedContent(content)
      } else {
        // 비밀번호 틀림 — 다이얼로그 유지하지 않고 간단히 알림
        alert('비밀번호가 올바르지 않습니다.')
      }
    }
    setEncryptDialog(null)
  }

  function renderBlock() {
    switch (item.type) {
      case 'heading1':
      case 'heading2':
      case 'heading3':
        return <HeadingBlock item={item} onUpdate={onUpdate} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
      case 'bulleted_list':
      case 'numbered_list':
        return <ListBlock item={item} onUpdate={onUpdate} onTagsChange={onTagsChange} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
      case 'quote':
        return <QuoteBlock item={item} onUpdate={onUpdate} onTagsChange={onTagsChange} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
      case 'divider':
        return <DividerBlock item={item} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
      case 'callout':
        return <CalloutBlock item={item} onUpdate={onUpdate} onTagsChange={onTagsChange} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
      case 'code':
        return <CodeBlock item={item} onUpdate={onUpdate} onTagsChange={onTagsChange} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
      case 'toggle':
        return <ToggleBlock item={item} onUpdate={onUpdate} onTagsChange={onTagsChange} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
      case 'checklist':
        return <ChecklistBlock item={item} onUpdate={onUpdate} onTagsChange={onTagsChange} onDelete={onDelete} onTogglePin={onTogglePin} />
      case 'image':
        return <ImageBlock item={item} onUpdate={onUpdate} onTagsChange={onTagsChange} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
      case 'text':
      default:
        return <TextBlock item={item} onUpdate={onUpdate} onTagsChange={onTagsChange} onDelete={onDelete} onTogglePin={onTogglePin} onCopyMove={onCopyMove} />
    }
  }

  function formatTime(epoch: number): string {
    const d = new Date(epoch)
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }

  const createdStr = formatTime(item.created_at)
  const updatedStr = item.updated_at !== item.created_at ? formatTime(item.updated_at) : null

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative group/drag rounded-xl border border-gray-100 dark:border-gray-800
                 bg-gray-50/60 dark:bg-gray-800/40 hover:border-gray-200 dark:hover:border-gray-700
                 transition-colors"
    >
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
        {isEncrypted && !decryptedContent ? (
          <div
            className="group relative rounded-lg px-3 py-4 cursor-pointer text-center"
            onClick={handleEncryptAction}
          >
            <span className="text-2xl">🔒</span>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">잠긴 메모입니다. 클릭하여 해제</p>
            <BlockActions item={item} onDelete={onDelete} onTogglePin={onTogglePin} onEncrypt={handleEncryptAction} encrypted={true} />
          </div>
        ) : renderBlock()}
      </div>

      {/* 암호 다이얼로그 */}
      {encryptDialog && (
        <EncryptDialog
          mode={encryptDialog}
          onConfirm={handleEncryptConfirm}
          onCancel={() => setEncryptDialog(null)}
        />
      )}

      {/* 저장 시간 */}
      <div className="absolute right-2 bottom-0.5
                      text-[10px] text-gray-400 dark:text-gray-500 select-none pointer-events-none">
        {createdStr}{updatedStr ? ` (수정 ${updatedStr})` : ''}
      </div>
    </div>
  )
}
