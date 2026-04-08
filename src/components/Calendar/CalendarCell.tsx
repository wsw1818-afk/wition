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
        p-1 transition-all duration-150 text-sm select-none overflow-hidden
        border-b border-r border-gray-200 dark:border-white/5
        ${!isCurrentMonth ? 'bg-gray-50/50 dark:bg-white/[0.02]' : 'bg-white dark:bg-white/[0.03]'}
        ${isSelected ? 'bg-accent-50 dark:bg-accent-500/15 dark:border-accent-500/30 dark:shadow-[0_0_12px_rgba(139,92,246,0.15)]' : ''}
        ${isFiltered === false ? 'opacity-25' : ''}
        ${isFiltered === true ? 'ring-2 ring-inset ring-accent-400' : ''}
        hover:bg-gray-50 dark:hover:bg-white/[0.06]
      `}
      style={{ minHeight: 'auto' }}
    >
      {/* 날짜 숫자 - 좌상단 */}
      <div className="flex items-center gap-1 mb-0.5">
        <span className={`
          text-sm leading-none font-semibold
          ${isToday
            ? 'bg-accent-500 text-white w-6 h-6 rounded-full flex items-center justify-center'
            : dayNumberColor}
        `}>
          {day}
        </span>
        {hasAlarm && (
          <span className="text-[10px] leading-none text-orange-400">🔔</span>
        )}
      </div>

      {/* 공휴일 이름 */}
      {shortHoliday && (
        <span className="text-[10px] leading-tight text-red-400 dark:text-red-400 truncate max-w-full">
          {shortHoliday}
        </span>
      )}

      {/* 감정 이모지 */}
      {mood && (
        <span className="text-xs leading-none mt-0.5">{mood}</span>
      )}

      {/* 메모 요약 - 각 메모를 줄별로 표시 (PC: 5줄) */}
      {count > 0 && summary && (
        <div className="flex flex-col gap-[2px] w-full mt-0.5 min-w-0 overflow-hidden flex-1">
          {summary.split('\n').slice(0, 5).map((line, i) => (
            <div key={i} className={`
              w-full rounded-sm px-1 py-[1px] text-[11px] leading-snug truncate
              ${i === 0
                ? (isSelected
                    ? 'bg-accent-500 text-white font-medium'
                    : 'bg-accent-500/15 dark:bg-accent-500/20 text-accent-600 dark:text-accent-300 font-medium')
                : (isSelected
                    ? 'bg-accent-400/40 text-white/80'
                    : 'bg-gray-100 dark:bg-white/[0.06] text-gray-500 dark:text-gray-400')}
            `}>
              {line}
            </div>
          ))}
          {summary.split('\n').length > 5 && (
            <div className={`
              text-[9px] leading-tight px-1
              ${isSelected ? 'text-white/60' : 'text-gray-400 dark:text-gray-500'}
            `}>
              +{summary.split('\n').length - 5}개 더
            </div>
          )}
        </div>
      )}
      {count > 0 && !summary && (
        <div className="flex items-center gap-1 mt-0.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white/70' : 'bg-accent-400'}`} />
          <span className={`text-[11px] leading-none ${isSelected ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'}`}>
            {count}
          </span>
        </div>
      )}
    </button>
  )
})
