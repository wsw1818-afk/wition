import type { NoteItem } from '../../types'

interface Props {
  item: NoteItem
  onDelete: () => void
  onTogglePin: () => void
  onEncrypt?: () => void
  encrypted?: boolean
  onCopyMove?: () => void
}

/** 블록 우상단 액션 버튼 (hover 시 표시) — 공통 컴포넌트 */
export function BlockActions({ item, onDelete, onTogglePin, onEncrypt, encrypted, onCopyMove }: Props) {
  return (
    <div className="absolute right-1 top-1 hidden group-hover:flex gap-0.5">
      {onCopyMove && (
        <ActionBtn onClick={onCopyMove} title="복사/이동">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        </ActionBtn>
      )}
      {onEncrypt && (
        <ActionBtn
          onClick={onEncrypt}
          title={encrypted ? '잠금 해제' : '잠금'}
        >
          <span className="text-[11px]">{encrypted ? '🔓' : '🔒'}</span>
        </ActionBtn>
      )}
      <ActionBtn
        onClick={onTogglePin}
        title={item.pinned ? '고정 해제' : '고정'}
      >
        <svg
          className={`w-3.5 h-3.5 ${item.pinned ? 'text-accent-500' : ''}`}
          fill={item.pinned ? 'currentColor' : 'none'}
          stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
        >
          <path d="M12 2v10m0 0l-3-3m3 3l3-3M5 21h14" />
        </svg>
      </ActionBtn>
      <ActionBtn onClick={onDelete} title="삭제">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </ActionBtn>
    </div>
  )
}

function ActionBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400
                 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
    >
      {children}
    </button>
  )
}
