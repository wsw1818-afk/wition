import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import dayjs from 'dayjs'
import { useCalendarStore } from '../../stores/calendarStore'
import { MonthNavigator } from './MonthNavigator'
import { CalendarCell } from './CalendarCell'
import { getHolidayMap } from '../../utils/holidays'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

export function CalendarView() {
  const { currentMonth, selectedDate, dayMap, alarmDays, loadMonth, selectDate, filterTag, filteredDays, setFilterTag } = useCalendarStore()
  const [tagInput, setTagInput] = useState('')

  // 초기 로드 + 월 변경 시 로드
  useEffect(() => { loadMonth(currentMonth) }, [currentMonth])

  const holidayMap = useMemo(() => getHolidayMap(currentMonth), [currentMonth])
  const today = dayjs().format('YYYY-MM-DD')
  const firstOfMonth = dayjs(currentMonth + '-01')
  const daysInMonth = firstOfMonth.daysInMonth()
  const startDow = firstOfMonth.day() // 0(일)~6(토)

  // 컨텍스트 메뉴 상태
  const [contextMenu, setContextMenu] = useState<{ dateStr: string; x: number; y: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
        setConfirming(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [contextMenu])

  const handleContextMenu = useCallback((dateStr: string, x: number, y: number) => {
    setContextMenu({ dateStr, x, y })
    setConfirming(false)
  }, [])

  const handleDeleteAll = async () => {
    if (!contextMenu) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    await window.api.deleteAllItemsByDay(contextMenu.dateStr)
    loadMonth(currentMonth)
    setContextMenu(null)
    setConfirming(false)
  }

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

  // 컨텍스트 메뉴 위치 보정 (화면 밖으로 나가지 않게)
  const menuStyle = contextMenu ? {
    left: Math.min(contextMenu.x, window.innerWidth - 180),
    top: Math.min(contextMenu.y, window.innerHeight - 100),
  } : {}

  const noteCount = contextMenu ? (dayMap[contextMenu.dateStr]?.note_count ?? 0) : 0

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#0f0a1a]">
      <MonthNavigator />

      {/* 태그 필터 */}
      <div className="px-4 pb-1.5">
        <div className="flex items-center gap-1.5">
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tagInput.trim()) {
                setFilterTag(tagInput.trim())
              }
              if (e.key === 'Escape') {
                setTagInput('')
                setFilterTag(null)
              }
            }}
            placeholder="태그 필터..."
            className="flex-1 text-[10px] px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700
                       bg-transparent text-gray-600 dark:text-gray-300 outline-none
                       focus:border-accent-400 placeholder-gray-400"
          />
          {filterTag && (
            <button
              onClick={() => { setTagInput(''); setFilterTag(null) }}
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-100 dark:bg-accent-500/20
                         text-accent-600 dark:text-accent-400 hover:bg-accent-200 transition-colors"
            >
              #{filterTag} ✕
            </button>
          )}
        </div>
      </div>

      {/* 요일 헤더 - 구글 캘린더 스타일 */}
      <div className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-700 select-none">
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={`text-center text-[11px] font-medium py-1.5
              border-r border-gray-200 dark:border-gray-700 last:border-r-0
              ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-500 dark:text-gray-400'}
              bg-gray-50/50 dark:bg-gray-900/50`}
          >
            {w}
          </div>
        ))}
      </div>

      {/* 달력 그리드 - 구글 캘린더 스타일 보더 그리드 */}
      <div className="grid grid-cols-7 grid-rows-6 flex-1 border-l border-gray-200 dark:border-gray-700 overflow-y-auto">
        {cells.map((c) => (
          <CalendarCell
            key={c.dateStr}
            day={c.day}
            dateStr={c.dateStr}
            noteDay={dayMap[c.dateStr]}
            isToday={c.dateStr === today}
            isSelected={c.dateStr === selectedDate}
            isCurrentMonth={c.isCurrentMonth}
            holiday={holidayMap[c.dateStr]}
            hasAlarm={alarmDays.has(c.dateStr)}
            isFiltered={filterTag ? filteredDays.has(c.dateStr) : undefined}
            onClick={() => selectDate(c.dateStr)}
            onContextMenu={handleContextMenu}
          />
        ))}
      </div>

      {/* 우클릭 컨텍스트 메뉴 */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 min-w-[160px]"
          style={menuStyle}
        >
          <div className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-700">
            {contextMenu.dateStr}
          </div>
          {noteCount === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
              메모가 없습니다
            </div>
          ) : (
            <button
              onClick={handleDeleteAll}
              className={`w-full text-left px-3 py-2 text-sm transition-colors
                ${confirming
                  ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 font-medium'
                  : 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                }`}
            >
              {confirming
                ? `정말 삭제할까요? (${noteCount}개)`
                : `메모 ${noteCount}개 전체 삭제`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
