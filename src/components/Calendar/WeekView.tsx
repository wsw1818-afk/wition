import { useMemo } from 'react'
import dayjs from 'dayjs'
import { useCalendarStore } from '../../stores/calendarStore'
import { getHolidayMap } from '../../utils/holidays'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

export function WeekView() {
  const { selectedDate, currentMonth, dayMap, alarmDays, selectDate } = useCalendarStore()

  const today = dayjs().format('YYYY-MM-DD')

  // 기준 날짜: selectedDate 또는 현재 월의 오늘 또는 1일
  const baseDate = useMemo(() => {
    if (selectedDate) return dayjs(selectedDate)
    const todayObj = dayjs()
    if (todayObj.format('YYYY-MM') === currentMonth) return todayObj
    return dayjs(currentMonth + '-01')
  }, [selectedDate, currentMonth])

  // 해당 주의 일요일부터 토요일까지 7일
  const weekDays = useMemo(() => {
    const startOfWeek = baseDate.startOf('week') // dayjs locale ko → 일요일 시작
    return Array.from({ length: 7 }, (_, i) => {
      const d = startOfWeek.add(i, 'day')
      return {
        dateStr: d.format('YYYY-MM-DD'),
        day: d.date(),
        month: d.month(),
        dow: i,
      }
    })
  }, [baseDate])

  const holidayMap = useMemo(() => getHolidayMap(currentMonth), [currentMonth])

  const goToPrevWeek = () => {
    const prev = baseDate.subtract(7, 'day')
    // 월이 바뀌면 loadMonth 호출
    const prevMonth = prev.format('YYYY-MM')
    if (prevMonth !== currentMonth) {
      useCalendarStore.getState().loadMonth(prevMonth)
    }
    selectDate(prev.format('YYYY-MM-DD'))
  }

  const goToNextWeek = () => {
    const next = baseDate.add(7, 'day')
    const nextMonth = next.format('YYYY-MM')
    if (nextMonth !== currentMonth) {
      useCalendarStore.getState().loadMonth(nextMonth)
    }
    selectDate(next.format('YYYY-MM-DD'))
  }

  const weekLabel = (() => {
    const start = weekDays[0]
    const end = weekDays[6]
    const sd = dayjs(start.dateStr)
    const ed = dayjs(end.dateStr)
    if (sd.month() === ed.month()) {
      return `${sd.format('YYYY년 M월')} ${sd.date()}일 ~ ${ed.date()}일`
    }
    return `${sd.format('M월 D일')} ~ ${ed.format('M월 D일')}`
  })()

  return (
    <div className="flex flex-col h-full">
      {/* 주간 네비게이터 */}
      <div className="flex items-center justify-between px-5 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={goToPrevWeek}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="이전 주"
          >
            <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 min-w-[180px] text-center select-none">
            {weekLabel}
          </h2>
          <button
            onClick={goToNextWeek}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="다음 주"
          >
            <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
        </div>
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 px-3 pb-1 select-none">
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={`text-center text-[11px] font-medium py-1
              ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-400 dark:text-gray-500'}`}
          >
            {w}
          </div>
        ))}
      </div>

      {/* 주간 그리드 */}
      <div className="grid grid-cols-7 gap-1 px-3 flex-1">
        {weekDays.map((wd) => {
          const noteDay = dayMap[wd.dateStr]
          const isToday = wd.dateStr === today
          const isSelected = wd.dateStr === selectedDate
          const holiday = holidayMap[wd.dateStr]
          const hasAlarm = alarmDays.has(wd.dateStr)

          return (
            <div
              key={wd.dateStr}
              onClick={() => selectDate(wd.dateStr)}
              className={`flex flex-col rounded-lg p-1.5 cursor-pointer transition-colors min-h-[80px]
                ${isSelected ? 'bg-accent-50 dark:bg-accent-500/10 ring-1 ring-accent-400' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}
              `}
            >
              {/* 날짜 */}
              <div className="flex items-center gap-1 mb-1">
                <span className={`text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full
                  ${isToday ? 'bg-accent-500 text-white' : ''}
                  ${wd.dow === 0 || holiday ? 'text-red-400' : wd.dow === 6 ? 'text-blue-400' : 'text-gray-700 dark:text-gray-300'}
                `}>
                  {wd.day}
                </span>
                {hasAlarm && <span className="text-[9px]">🔔</span>}
                {noteDay?.mood && <span className="text-[10px]">{noteDay.mood}</span>}
              </div>

              {/* 메모 요약 (최대 3개) */}
              {noteDay && noteDay.note_count > 0 && (
                <div className="flex-1 space-y-0.5 overflow-hidden">
                  {noteDay.summary && (
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-tight truncate">
                      {noteDay.summary}
                    </p>
                  )}
                  {noteDay.note_count > 1 && (
                    <p className="text-[9px] text-gray-400 dark:text-gray-500">
                      +{noteDay.note_count - 1}개 더
                    </p>
                  )}
                </div>
              )}

              {/* 공휴일 */}
              {holiday && (
                <p className="text-[9px] text-red-400 truncate mt-auto">{holiday}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
