import { memo } from 'react'
import type { NoteDay } from '../../types'

interface Props {
  day: number         // 1~31
  dateStr: string     // "YYYY-MM-DD"
  noteDay?: NoteDay
  isToday: boolean
  isSelected: boolean
  isCurrentMonth: boolean
  holiday?: string    // 공휴일 이름
  hasAlarm?: boolean  // 알람 존재 여부
  onClick: () => void
}

export const CalendarCell = memo(function CalendarCell({
  day, dateStr, noteDay, isToday, isSelected, isCurrentMonth, holiday, hasAlarm, onClick
}: Props) {
  const count = noteDay?.note_count ?? 0
  const mood = noteDay?.mood
  const dots = Math.min(count, 3)
  const summary = noteDay?.summary
  const dow = new Date(dateStr).getDay() // 0=일, 6=토
  const isHoliday = !!holiday
  const isSunday = dow === 0
  const isRedDay = isHoliday || isSunday

  // 호버 툴팁 (#8)
  const parts: string[] = []
  if (holiday) parts.push(holiday)
  if (count > 0) parts.push(`${count}개 메모${summary ? `\n${summary}` : ''}`)
  const tooltip = parts.length > 0 ? parts.join('\n') : undefined

  // 공휴일 축약 이름 (셀 안에 표시)
  const shortHoliday = holiday
    ? holiday.split(',')[0]
        .replace('대체공휴일(', '대체(')
        .replace(' 연휴', '')
    : null

  return (
    <button
      onClick={onClick}
      title={tooltip}
      className={`
        relative flex flex-col items-center justify-start gap-0.5
        pt-1.5 pb-1 rounded-xl transition-all duration-100 text-sm select-none
        ${!isCurrentMonth ? 'opacity-30 pointer-events-none' : ''}
        ${isSelected
          ? 'bg-accent-500 text-white shadow-sm'
          : isToday
            ? 'bg-accent-50 dark:bg-accent-500/10 text-accent-600 dark:text-accent-400 font-semibold'
            : isRedDay
              ? 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10'
              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}
      `}
      style={{ aspectRatio: '1' }}
    >
      <span className="text-xs leading-none">{day}</span>

      {/* 공휴일 이름 */}
      {shortHoliday && !mood && (
        <span className={`text-[8px] leading-tight text-center max-w-full px-0.5
          ${isSelected ? 'text-white/70' : 'text-red-400 dark:text-red-400'}`}>
          {shortHoliday}
        </span>
      )}

      {/* 감정 이모지 */}
      {mood && <span className="text-[10px] leading-none">{mood}</span>}

      {/* 메모 요약 텍스트 */}
      {summary && !mood && !shortHoliday && (
        <span className={`text-[9px] leading-tight text-center max-w-full px-0.5 truncate font-medium
          ${isSelected ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'}`}>
          {summary.slice(0, 8)}
        </span>
      )}

      {/* 메모 dot + 알람 아이콘 */}
      {(dots > 0 || hasAlarm) && (
        <div className="flex items-center gap-[3px]">
          {hasAlarm && (
            <span className={`text-[8px] leading-none ${isSelected ? 'text-white/80' : 'text-orange-400'}`}>🔔</span>
          )}
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
  prev.noteDay === next.noteDay &&
  prev.holiday === next.holiday &&
  prev.hasAlarm === next.hasAlarm
)
