import { useState } from 'react'
import dayjs from 'dayjs'
import type { NoteItem } from '../../types'

interface Props {
  item: NoteItem
  open: boolean
  onClose: () => void
  onDone: () => void
}

export function CopyMoveDialog({ item, open, onClose, onDone }: Props) {
  const [targetDate, setTargetDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [mode, setMode] = useState<'copy' | 'move'>('copy')
  const [loading, setLoading] = useState(false)

  if (!open) return null

  async function handleConfirm() {
    if (!targetDate) return
    setLoading(true)
    try {
      if (mode === 'copy') {
        const newItem: NoteItem = {
          ...item,
          id: crypto.randomUUID(),
          day_id: targetDate,
          order_index: 999, // 서버가 재정렬
          created_at: Date.now(),
          updated_at: Date.now(),
        }
        await window.api.upsertNoteItem(newItem)
      } else {
        // move: 기존 삭제 + 새 날짜에 추가
        const newItem: NoteItem = {
          ...item,
          day_id: targetDate,
          updated_at: Date.now(),
        }
        await window.api.deleteNoteItem(item.id, item.day_id)
        await window.api.upsertNoteItem(newItem)
      }
      onDone()
      onClose()
    } catch (err) {
      console.error('CopyMoveDialog:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-5 max-w-xs w-full mx-4 border border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100 mb-3">
          블록 {mode === 'copy' ? '복사' : '이동'}
        </h3>

        {/* 모드 선택 */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setMode('copy')}
            className={`flex-1 py-1.5 text-xs rounded-md transition-colors ${
              mode === 'copy'
                ? 'bg-accent-500 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
            }`}
          >
            복사
          </button>
          <button
            onClick={() => setMode('move')}
            className={`flex-1 py-1.5 text-xs rounded-md transition-colors ${
              mode === 'move'
                ? 'bg-accent-500 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
            }`}
          >
            이동
          </button>
        </div>

        {/* 날짜 선택 */}
        <label className="block mb-4">
          <span className="text-xs text-gray-500 dark:text-gray-400">대상 날짜</span>
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-600
                       bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 outline-none
                       focus:border-accent-400"
          />
        </label>

        {/* 미리보기 */}
        <div className="mb-4 px-3 py-2 rounded-md bg-gray-50 dark:bg-gray-700/50 text-xs text-gray-600 dark:text-gray-300 truncate">
          {item.content.slice(0, 60)}
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300
                       hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            취소
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading || !targetDate}
            className="px-3 py-1.5 text-xs rounded-md bg-accent-500 text-white
                       hover:bg-accent-600 disabled:opacity-30 transition-colors"
          >
            {loading ? '처리 중...' : mode === 'copy' ? '복사' : '이동'}
          </button>
        </div>
      </div>
    </div>
  )
}
