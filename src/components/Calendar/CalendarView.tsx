import { useEffect } from 'react'
import dayjs from 'dayjs'
import { useCalendarStore } from '../../stores/calendarStore'
import { MonthNavigator } from './MonthNavigator'
import { CalendarCell } from './CalendarCell'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

export function CalendarView() {
  const { currentMonth, selectedDate, dayMap, loadMonth, selectDate } = useCalendarStore()

  // 초기 로드 + 월 변경 시 로드
  useEffect(() => { loadMonth(currentMonth) }, [currentMonth])

  const today = dayjs().format('YYYY-MM-DD')
  const firstOfMonth = dayjs(currentMonth + '-01')
  const daysInMonth = firstOfMonth.daysInMonth()
  const startDow = firstOfMonth.day() // 0(일)~6(토)

  // 이전 달 빈 칸 + 이번 달 날짜
  const cells: Array<{ day: number; dateStr: string; isCurrentMonth: boolean }> = []

  // 이전 달 패딩
  const prevMonth = firstOfMonth.subtract(1, 'month')
  const prevDays = prevMonth.daysInMonth()
  for (let i = startDow - 1; i >= 0; i--) {
    const d = prevDays - i
    cells.push({ day: d, dateStr: prevMonth.date(d).format('YYYY-MM-DD'), isCurrentMonth: false })
  }

  // 이번 달
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, dateStr: firstOfMonth.date(d).format('YYYY-MM-DD'), isCurrentMonth: true })
  }

  // 다음 달 패딩 (6주=42칸 맞추기)
  const remaining = 42 - cells.length
  const nextMonth = firstOfMonth.add(1, 'month')
  for (let d = 1; d <= remaining; d++) {
    cells.push({ day: d, dateStr: nextMonth.date(d).format('YYYY-MM-DD'), isCurrentMonth: false })
  }

  return (
    <div className="flex flex-col h-full">
      <MonthNavigator />

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 px-5 pb-1 select-none">
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

      {/* 달력 그리드 */}
      <div className="grid grid-cols-7 gap-1 px-4 flex-1">
        {cells.map((c) => (
          <CalendarCell
            key={c.dateStr}
            day={c.day}
            dateStr={c.dateStr}
            noteDay={dayMap[c.dateStr]}
            isToday={c.dateStr === today}
            isSelected={c.dateStr === selectedDate}
            isCurrentMonth={c.isCurrentMonth}
            onClick={() => selectDate(c.dateStr)}
          />
        ))}
      </div>
    </div>
  )
}
