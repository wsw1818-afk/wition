import { useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'

interface RecurringBlock {
  id: string
  type: string
  content: string
  repeat: string        // 'daily' | 'weekdays' | 'weekly'
  day_of_week: number   // 0-6 (weekly일 때만 사용)
  created_at: number
}

const REPEAT_OPTIONS = [
  { value: 'daily', label: '매일' },
  { value: 'weekdays', label: '평일 (월~금)' },
  { value: 'weekly', label: '매주' },
]

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토']

interface RecurringPanelProps {
  onClose?: () => void
}

export function RecurringPanel({ onClose }: RecurringPanelProps) {
  const [blocks, setBlocks] = useState<RecurringBlock[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [repeat, setRepeat] = useState('daily')
  const [dayOfWeek, setDayOfWeek] = useState(1) // 기본: 월요일

  useEffect(() => {
    loadBlocks()
  }, [])

  async function loadBlocks() {
    const data = await window.api.getRecurringBlocks()
    setBlocks(data)
  }

  function resetForm() {
    setContent('')
    setRepeat('daily')
    setDayOfWeek(1)
    setEditId(null)
    setShowForm(false)
  }

  async function handleSave() {
    if (!content.trim()) return

    const block: RecurringBlock = {
      id: editId || uuid(),
      type: 'text',
      content: content.trim(),
      repeat,
      day_of_week: repeat === 'weekly' ? dayOfWeek : 0,
      created_at: editId ? (blocks.find(b => b.id === editId)?.created_at ?? Date.now()) : Date.now(),
    }

    const ok = await window.api.upsertRecurringBlock(block)
    if (ok) {
      await loadBlocks()
      resetForm()
    }
  }

  async function handleDelete(id: string) {
    const ok = await window.api.deleteRecurringBlock(id)
    if (ok) await loadBlocks()
  }

  function handleEdit(block: RecurringBlock) {
    setEditId(block.id)
    setContent(block.content)
    setRepeat(block.repeat)
    setDayOfWeek(block.day_of_week)
    setShowForm(true)
  }

  function getRepeatLabel(block: RecurringBlock): string {
    if (block.repeat === 'daily') return '매일'
    if (block.repeat === 'weekdays') return '평일'
    if (block.repeat === 'weekly') return `매주 ${DOW_LABELS[block.day_of_week]}요일`
    return block.repeat
  }

  // 모달 모드(onClose 있을 때)와 인라인 모드
  const panelContent = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400">반복 메모</h3>
        <button
          onClick={() => { resetForm(); setShowForm(!showForm) }}
          className="text-[10px] px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700
                     text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          {showForm ? '취소' : '+ 추가'}
        </button>
      </div>

      {/* 추가/편집 폼 */}
      {showForm && (
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 space-y-2">
          <input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="반복할 메모 내용..."
            className="w-full text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                       rounded px-2 py-1.5 outline-none focus:border-accent-400 text-gray-800 dark:text-gray-200"
          />
          <div className="flex items-center gap-2">
            <select
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              className="text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                         rounded px-2 py-1 outline-none text-gray-700 dark:text-gray-300"
            >
              {REPEAT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {repeat === 'weekly' && (
              <select
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
                className="text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                           rounded px-2 py-1 outline-none text-gray-700 dark:text-gray-300"
              >
                {DOW_LABELS.map((label, i) => (
                  <option key={i} value={i}>{label}요일</option>
                ))}
              </select>
            )}
            <button
              onClick={handleSave}
              className="text-xs px-3 py-1 rounded bg-accent-500 text-white hover:bg-accent-600 transition-colors ml-auto"
            >
              {editId ? '수정' : '저장'}
            </button>
          </div>
        </div>
      )}

      {/* 목록 */}
      {blocks.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">설정된 반복 메모가 없습니다.</p>
      ) : (
        <div className="space-y-1">
          {blocks.map((block) => (
            <div
              key={block.id}
              className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800/30 rounded-lg px-3 py-2 group"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-700 dark:text-gray-300 truncate">{block.content}</p>
                <p className="text-[10px] text-gray-400 dark:text-gray-500">{getRepeatLabel(block)}</p>
              </div>
              <div className="hidden group-hover:flex gap-1">
                <button
                  onClick={() => handleEdit(block)}
                  className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 text-[10px]"
                  title="편집"
                >
                  ✏️
                </button>
                <button
                  onClick={() => handleDelete(block.id)}
                  className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-400 hover:text-red-500 text-[10px]"
                  title="삭제"
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  if (!onClose) return panelContent

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 max-w-md w-full mx-4 border border-gray-200 dark:border-gray-700 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-gray-800 dark:text-gray-100">반복 메모 설정</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {panelContent}
      </div>
    </div>
  )
}
