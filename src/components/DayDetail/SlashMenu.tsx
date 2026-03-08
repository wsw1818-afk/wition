import { useState, useEffect, useRef } from 'react'
import type { BlockType } from '../../types'
import { SLASH_MENU_ITEMS } from '../../types'

interface Props {
  filter: string
  position: { top: number; left: number }
  onSelect: (type: BlockType) => void
  onClose: () => void
}

export function SlashMenu({ filter, position, onSelect, onClose }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)

  const filtered = SLASH_MENU_ITEMS.filter(item =>
    item.label.includes(filter) || item.description.includes(filter) || item.type.includes(filter)
  )

  useEffect(() => { setSelectedIndex(0) }, [filter])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => (i + 1) % filtered.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => (i - 1 + filtered.length) % filtered.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filtered[selectedIndex]) onSelect(filtered[selectedIndex].type)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [filtered, selectedIndex, onSelect, onClose])

  // 선택된 항목이 보이도록 스크롤
  useEffect(() => {
    const el = menuRef.current?.children[selectedIndex] as HTMLElement
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (filtered.length === 0) return null

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                 rounded-lg shadow-xl py-1 max-h-[280px] w-64 overflow-y-auto"
      style={{ top: position.top, left: position.left }}
    >
      {filtered.map((item, i) => (
        <button
          key={item.type}
          onClick={() => onSelect(item.type)}
          onMouseEnter={() => setSelectedIndex(i)}
          className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors
            ${i === selectedIndex
              ? 'bg-accent-50 dark:bg-accent-500/10'
              : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
        >
          <span className="w-8 h-8 rounded-md bg-gray-100 dark:bg-gray-700 flex items-center justify-center
                          text-sm font-medium text-gray-600 dark:text-gray-300 flex-shrink-0">
            {item.icon}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{item.label}</div>
            <div className="text-xs text-gray-400 truncate">{item.description}</div>
          </div>
        </button>
      ))}
    </div>
  )
}
