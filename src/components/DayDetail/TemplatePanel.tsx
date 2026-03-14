import { useEffect, useState } from 'react'
import type { Template, NoteItem } from '../../types'

interface Props {
  dayId: string
  items: NoteItem[]
  onApplied: () => void
  onClose: () => void
}

export function TemplatePanel({ dayId, items, onApplied, onClose }: Props) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [newName, setNewName] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    window.api.getTemplates().then(setTemplates)
  }, [])

  /** 현재 블록들을 새 템플릿으로 저장 */
  async function handleSave() {
    const name = newName.trim()
    if (!name || items.length === 0) return

    const blocks = items.map(item => ({
      type: item.type,
      content: item.content,
    }))

    const template: Template = {
      id: crypto.randomUUID(),
      name,
      blocks: JSON.stringify(blocks),
      created_at: Date.now(),
    }

    const ok = await window.api.upsertTemplate(template)
    if (ok) {
      setTemplates(prev => [template, ...prev])
      setNewName('')
    }
  }

  /** 템플릿을 현재 날짜에 적용 */
  async function handleApply(templateId: string) {
    setLoading(true)
    try {
      const result = await window.api.applyTemplate(templateId, dayId)
      if (result.ok) {
        onApplied()
      }
    } finally {
      setLoading(false)
    }
  }

  /** 템플릿 삭제 */
  async function handleDelete(id: string) {
    const ok = await window.api.deleteTemplate(id)
    if (ok) {
      setTemplates(prev => prev.filter(t => t.id !== id))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-5 max-w-sm w-full mx-4 border border-gray-200 dark:border-gray-700 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-gray-800 dark:text-gray-100">템플릿</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 현재 블록으로 저장 */}
        {items.length > 0 && (
          <div className="flex gap-2 mb-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
              placeholder="템플릿 이름"
              className="flex-1 text-xs px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-600
                         bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 outline-none
                         focus:border-accent-400"
            />
            <button
              onClick={handleSave}
              disabled={!newName.trim()}
              className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-white
                         hover:bg-accent-600 disabled:opacity-30 transition-colors"
            >
              저장
            </button>
          </div>
        )}

        {/* 템플릿 목록 */}
        <div className="flex-1 overflow-y-auto space-y-1.5">
          {templates.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">
              저장된 템플릿이 없습니다
            </p>
          ) : (
            templates.map(tpl => {
              let blockCount = 0
              try { blockCount = JSON.parse(tpl.blocks).length } catch {}
              return (
                <div
                  key={tpl.id}
                  className="flex items-center justify-between px-3 py-2 rounded-md
                             bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate">{tpl.name}</p>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500">{blockCount}개 블록</p>
                  </div>
                  <div className="flex gap-1.5 ml-2">
                    <button
                      onClick={() => handleApply(tpl.id)}
                      disabled={loading}
                      className="text-[10px] px-2 py-1 rounded bg-accent-500 text-white hover:bg-accent-600
                                 disabled:opacity-30 transition-colors"
                    >
                      적용
                    </button>
                    <button
                      onClick={() => handleDelete(tpl.id)}
                      className="text-[10px] px-2 py-1 rounded bg-red-100 dark:bg-red-900/20 text-red-500
                                 hover:bg-red-200 dark:hover:bg-red-900/30 transition-colors"
                    >
                      삭제
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
