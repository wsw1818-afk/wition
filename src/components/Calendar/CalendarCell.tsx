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
  isFiltered?: boolean  // 태그 필터 매치 여부 (undefined = 필터 없음)
  onClick: () => void
  onContextMenu?: (dateStr: string, x: number, y: number) => void
}

export const CalendarCell = memo(function CalendarCell({
  day, dateStr, noteDay, isToday, isSelected, isCurrentMonth, holiday, hasAlarm, isFiltered, onClick, onContextMenu
}: Props) {
  const count = noteDay?.note_count ?? 0
  const mood = noteDay?.mood
  const summary = noteDay?.summary
  const dow = new Date(dateStr).getDay() // 0=일, 6=토
  const isHoliday = !!holiday
  const isSunday = dow === 0
  const isSaturday = dow === 6
  const isRedDay = isHoliday || isSunday

  // 호버 툴팁
  const parts: string[] = []
  if (holiday) parts.push(holiday)
  if (count > 0) parts.push(`${count}개 메모${summary ? `\n${summary}` : ''}`)
  const tooltip = parts.length > 0 ? parts.join('\n') : undefined

  // 공휴일 축약 이름
  const shortHoliday = holiday
    ? holiday.split(',')[0]
        .replace('대체공휴일(', '대체(')
        .replace(' 연휴', '')
    : null

  // 날짜 숫자 색상
  const dayNumberColor = !isCurrentMonth
    ? 'text-gray-300 dark:text-gray-600'
    : isRedDay
      ? 'text-red-500 dark:text-red-400'
      : isSaturday
        ? 'text-blue-500 dark:text-blue-400'
        : 'text-gray-700 dark:text-gray-200'

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(dateStr, e.clientX, e.clientY) } : undefined}
      title={tooltip}
      className={`
        relative flex flex-col items-start justify-start
        p-1 transition-colors duration-75 text-sm select-none overflow-hidden
        border-b border-r border-gray-200 dark:border-gray-700
        ${!isCurrentMonth ? 'bg-gray-50/50 dark:bg-gray-900/30' : 'bg-white dark:bg-gray-900'}
        ${isSelected ? 'bg-accent-50 dark:bg-accent-500/10' : ''}
        ${isFiltered === false ? 'opacity-25' : ''}
        ${isFiltered === true ? 'ring-2 ring-inset ring-accent-400' : ''}
        hover:bg-gray-50 dark:hover:bg-gray-800/50
      `}
      style={{ minHeight: 0 }}
    >
      {/* 날짜 숫자 - 좌상단 */}
      <div className="flex items-center gap-1 mb-0.5">
        <span className={`
          text-xs leading-none font-medium
          ${isToday
            ? 'bg-accent-500 text-white w-5 h-5 rounded-full flex items-center justify-center'
            : dayNumberColor}
        `}>
          {day}
        </span>
        {hasAlarm && (
          <span className="text-[8px] leading-none text-orange-400">🔔</span>
        )}
      </div>

      {/* 공휴일 이름 */}
      {shortHoliday && (
        <span className="text-[8px] leading-tight text-red-400 dark:text-red-400 truncate max-w-full">
          {shortHoliday}
        </span>
      )}

      {/* 감정 이모지 */}
      {mood && (
        <span className="text-[10px] leading-none mt-0.5">{mood}</span>
      )}

      {/* 메모 요약 - summary 있으면 컬러 바, 없으면 dot+개수 */}
      {count > 0 && summary && (
        <div className="flex flex-col gap-[2px] w-full mt-0.5">
          <div className={`
            w-full rounded-sm px-1 py-[1px] text-[9px] leading-tight font-medium truncate
            ${isSelected
              ? 'bg-accent-500 text-white'
              : 'bg-accent-100 dark:bg-accent-500/20 text-accent-700 dark:text-accent-300'}
          `}>
            {summary.slice(0, 20)}
          </div>
          {count > 1 && (
            <div className={`
              w-full rounded-sm px-1 py-[1px] text-[8px] leading-tight truncate
              ${isSelected
                ? 'bg-accent-400 text-white/80'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}
            `}>
              +{count - 1}개 더
            </div>
          )}
        </div>
      )}
      {count > 0 && !summary && (
        <div className="flex items-center gap-1 mt-0.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white/70' : 'bg-accent-400'}`} />
          <span className={`text-[9px] leading-none ${isSelected ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'}`}>
            {count}
          </span>
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
  prev.hasAlarm === next.hasAlarm &&
  prev.isFiltered === next.isFiltered &&
  prev.onContextMenu === next.onContextMenu
)
