import dayjs from 'dayjs'
import { useCalendarStore } from '../../stores/calendarStore'

export function MonthNavigator() {
  const { currentMonth, goToPrevMonth, goToNextMonth, goToToday } = useCalendarStore()
  const label = dayjs(currentMonth + '-01').format('YYYY년 M월')

  return (
    <div className="flex items-center justify-between px-5 py-3">
      {/* 좌: 월 이동 */}
      <div className="flex items-center gap-2">
        <NavButton onClick={goToPrevMonth} label="이전 달" direction="left" />
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 min-w-[110px] text-center select-none">
          {label}
        </h2>
        <NavButton onClick={goToNextMonth} label="다음 달" direction="right" />
      </div>

      {/* 우: 오늘 버튼 */}
      <button
        onClick={goToToday}
        className="text-xs px-2.5 py-1 rounded-md border border-gray-200 dark:border-gray-700
                   text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800
                   transition-colors"
      >
        오늘
      </button>
    </div>
  )
}

function NavButton({ onClick, label, direction }: { onClick: () => void; label: string; direction: 'left' | 'right' }) {
  return (
    <button
      onClick={onClick}
      className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      aria-label={label}
    >
      <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {direction === 'left'
          ? <polyline points="15 18 9 12 15 6" />
          : <polyline points="9 6 15 12 9 18" />}
      </svg>
    </button>
  )
}
