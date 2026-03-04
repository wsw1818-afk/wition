import { memo } from 'react'
import type { NoteDay } from '../../types'

interface Props {
  day: number         // 1~31
  dateStr: string     // "YYYY-MM-DD"
  noteDay?: NoteDay
  isToday: boolean
  isSelected: boolean
  isCurrentMonth: boolean
  onClick: () => void
}

export const CalendarCell = memo(function CalendarCell({
  day, noteDay, isToday, isSelected, isCurrentMonth, onClick
}: Props) {
  const count = noteDay?.note_count ?? 0
  const mood = noteDay?.mood
  const dots = Math.min(count, 3)

  return (
    <button
      onClick={onClick}
      className={`
        relative flex flex-col items-center justify-start gap-0.5
        pt-1.5 pb-1 rounded-xl transition-all duration-100 text-sm select-none
        ${!isCurrentMonth ? 'opacity-30 pointer-events-none' : ''}
        ${isSelected
          ? 'bg-accent-500 text-white shadow-sm'
          : isToday
            ? 'bg-accent-50 dark:bg-accent-500/10 text-accent-600 dark:text-accent-400 font-semibold'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}
      `}
      style={{ aspectRatio: '1' }}
    >
      <span className="text-xs leading-none">{day}</span>

      {/* 감정 이모지 */}
      {mood && <span className="text-[10px] leading-none">{mood}</span>}

      {/* 메모 dot */}
      {dots > 0 && (
        <div className="flex items-center gap-[3px]">
          {Array.from({ length: dots }, (_, i) => (
            <span
              key={i}
              className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white/70' : 'bg-accent-400'}`}
            />
          ))}
          {count > 3 && (
            <span className={`text-[7px] leading-none ${isSelected ? 'text-white/60' : 'text-gray-400'}`}>+</span>
          )}
        </div>
      )}
    </button>
  )
}, (prev, next) =>
  prev.day === next.day &&
  prev.isToday === next.isToday &&
  prev.isSelected === next.isSelected &&
  prev.isCurrentMonth === next.isCurrentMonth &&
  prev.noteDay === next.noteDay
)
