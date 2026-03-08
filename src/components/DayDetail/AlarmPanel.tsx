import { useState, useEffect, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import dayjs from 'dayjs'
import { useDayStore } from '../../stores/dayStore'
import { useCalendarStore } from '../../stores/calendarStore'
import type { Alarm, RepeatType } from '../../types'
import { REPEAT_LABELS } from '../../types'
import { getHolidayMap } from '../../utils/holidays'

interface AlarmPanelProps {
  dayId: string
}

export function AlarmPanel({ dayId }: AlarmPanelProps) {
  const { alarms, upsertAlarm, removeAlarm } = useDayStore()
  const selectDate = useCalendarStore(s => s.selectDate)
  const loadMonth = useCalendarStore(s => s.loadMonth)
  const currentMonth = useCalendarStore(s => s.currentMonth)

  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [time, setTime] = useState('09:00')
  const [label, setLabel] = useState('')
  const [date, setDate] = useState(dayId)
  const [repeat, setRepeat] = useState<RepeatType>('none')
  const [showUpcoming, setShowUpcoming] = useState(false)
  const [upcomingAlarms, setUpcomingAlarms] = useState<Alarm[]>([])
  const [collapsed, setCollapsed] = useState(true)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [showTimePicker, setShowTimePicker] = useState(false)
  const [pickerMonth, setPickerMonth] = useState(dayId.slice(0, 7)) // YYYY-MM
  const datePickerRef = useRef<HTMLDivElement>(null)
  const timePickerRef = useRef<HTMLDivElement>(null)

  // 날짜 변경 시 date 리셋
  useEffect(() => { setDate(dayId) }, [dayId])

  // 피커 외부 클릭 시 닫기
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (datePickerRef.current && !datePickerRef.current.contains(e.target as Node)) setShowDatePicker(false)
      if (timePickerRef.current && !timePickerRef.current.contains(e.target as Node)) setShowTimePicker(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function startAdd() {
    setAdding(true)
    setEditId(null)
    setTime('09:00')
    setLabel('')
    setDate(dayId)
    setRepeat('none')
    setCollapsed(false)
  }

  function startEdit(alarm: Alarm) {
    setAdding(false)
    setEditId(alarm.id)
    setTime(alarm.time)
    setLabel(alarm.label)
    setDate(alarm.day_id)
    setRepeat(alarm.repeat || 'none')
    setCollapsed(false)
  }

  function cancelForm() {
    setAdding(false)
    setEditId(null)
  }

  async function handleSave() {
    const now = Date.now()
    const existingAlarm = editId ? alarms.find(a => a.id === editId) : null
    const alarm: Alarm = {
      id: editId || uuid(),
      day_id: date,
      time,
      label: label.trim(),
      repeat,
      enabled: 1,
      fired: 0,
      created_at: existingAlarm?.created_at ?? now,
      updated_at: now,
    }
    const ok = await upsertAlarm(alarm)
    if (ok) {
      // 날짜가 변경되었으면 달력 알람 아이콘 갱신
      const dateChanged = !editId ? (date !== dayId) : (existingAlarm && existingAlarm.day_id !== date)
      if (dateChanged) {
        // 현재 월 달력 새로고침 (알람 아이콘 갱신)
        loadMonth(currentMonth)
      }
      cancelForm()
    }
  }

  async function handleToggleEnabled(alarm: Alarm) {
    const ok = await upsertAlarm({ ...alarm, enabled: alarm.enabled ? 0 : 1, updated_at: Date.now() })
    if (ok) loadMonth(currentMonth) // 달력 알람 아이콘 갱신
  }

  async function handleDelete(id: string) {
    const ok = await removeAlarm(id)
    if (ok) loadMonth(currentMonth) // 달력 알람 아이콘 갱신
    if (editId === id) cancelForm()
  }

  async function loadUpcoming() {
    const today = dayjs().format('YYYY-MM-DD')
    const list = await window.api.getUpcomingAlarms(today)
    setUpcomingAlarms(list)
    setShowUpcoming(true)
  }

  function navigateToAlarmDate(alarmDayId: string) {
    const [y, m] = alarmDayId.split('-')
    loadMonth(`${y}-${m}`)
    selectDate(alarmDayId)
    setShowUpcoming(false)
  }

  const showForm = adding || editId !== null
  const hasAlarms = alarms.length > 0

  // 알람이 없고 축소 상태면 최소 표시
  if (!hasAlarms && collapsed && !showForm) {
    return (
      <div className="px-4 py-1.5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
        <button
          onClick={() => setCollapsed(false)}
          className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1 hover:text-gray-600 dark:hover:text-gray-300"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path d="M12 6v6l4 2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="10" />
          </svg>
          알람
        </button>
        <div className="flex items-center gap-2">
          <button onClick={loadUpcoming} className="text-[10px] text-gray-400 hover:text-blue-500" title="다가오는 알람">
            📋
          </button>
          <button onClick={startAdd} className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400">+ 추가</button>
        </div>
      </div>
    )
  }

  return (
    <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800">
      <div className="flex items-center justify-between mb-1">
        <button
          onClick={() => !showForm && setCollapsed(true)}
          className="text-xs font-medium text-gray-500 dark:text-gray-400 flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path d="M12 6v6l4 2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="10" />
          </svg>
          알람 {hasAlarms && <span className="text-[10px] text-gray-400">({alarms.length})</span>}
        </button>
        <div className="flex items-center gap-2">
          <button onClick={loadUpcoming} className="text-[10px] text-gray-400 hover:text-blue-500" title="다가오는 알람">
            📋
          </button>
          {!showForm && (
            <button onClick={startAdd} className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400">+ 추가</button>
          )}
        </div>
      </div>

      {/* 알람 목록 */}
      {hasAlarms && (
        <div className="space-y-1 mb-1">
          {alarms.map(alarm => (
            <div
              key={alarm.id}
              className={`flex items-center gap-2 px-2 py-1 rounded text-sm group ${
                alarm.fired && alarm.repeat === 'none' ? 'opacity-50' : ''
              } ${editId === alarm.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
            >
              <button
                onClick={() => handleToggleEnabled(alarm)}
                className={`w-4 h-4 rounded-full border-2 flex-shrink-0 transition-colors ${
                  alarm.enabled
                    ? 'border-blue-500 bg-blue-500'
                    : 'border-gray-300 dark:border-gray-600'
                }`}
                title={alarm.enabled ? '알람 끄기' : '알람 켜기'}
              >
                {alarm.enabled ? (
                  <svg className="w-full h-full text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </button>

              <span className="font-mono text-gray-800 dark:text-gray-200 min-w-[3rem]">
                {alarm.time}
              </span>

              {/* 반복 배지 */}
              {alarm.repeat && alarm.repeat !== 'none' && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 whitespace-nowrap">
                  {REPEAT_LABELS[alarm.repeat]}
                </span>
              )}

              {/* 날짜가 현재 보고 있는 날짜와 다르면 표시 */}
              {alarm.day_id !== dayId && (
                <span className="text-[10px] text-orange-500">
                  {dayjs(alarm.day_id).format('M/D')}
                </span>
              )}

              <span className="text-gray-600 dark:text-gray-400 truncate flex-1">
                {alarm.label || '(라벨 없음)'}
              </span>

              <div className="hidden group-hover:flex items-center gap-1">
                <button onClick={() => startEdit(alarm)} className="p-0.5 text-gray-400 hover:text-blue-500" title="수정">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button onClick={() => handleDelete(alarm.id)} className="p-0.5 text-gray-400 hover:text-red-500" title="삭제">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 추가/수정 폼 */}
      {showForm && (
        <div className="space-y-2 mt-1 p-2 rounded bg-gray-50 dark:bg-gray-800/50">
          {/* 1행: 날짜 + 시간 피커 */}
          <div className="flex items-center gap-2">
            {/* 날짜 피커 */}
            <div className="relative" ref={datePickerRef}>
              <button
                type="button"
                onClick={() => { setShowDatePicker(!showDatePicker); setShowTimePicker(false); setPickerMonth(date.slice(0, 7)) }}
                className="px-2 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 hover:border-blue-400 flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
                </svg>
                {dayjs(date).format('YYYY. M. D (ddd)')}
              </button>
              {showDatePicker && <MiniCalendar
                value={date}
                month={pickerMonth}
                onMonthChange={setPickerMonth}
                onSelect={d => { setDate(d); setShowDatePicker(false) }}
              />}
            </div>

            {/* 시간 피커 */}
            <div className="relative" ref={timePickerRef}>
              <button
                type="button"
                onClick={() => { setShowTimePicker(!showTimePicker); setShowDatePicker(false) }}
                className="px-2 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 hover:border-blue-400 flex items-center gap-1 font-mono"
              >
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" strokeLinecap="round" />
                </svg>
                {time}
              </button>
              {showTimePicker && <TimePickerDropdown
                value={time}
                onChange={t => setTime(t)}
                onClose={() => setShowTimePicker(false)}
              />}
            </div>
          </div>
          {/* 2행: 라벨 */}
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="라벨 (선택)"
            className="w-full px-2 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 placeholder-gray-400"
            onKeyDown={e => e.key === 'Enter' && handleSave()}
          />
          {/* 3행: 반복 + 버튼 */}
          <div className="flex items-center gap-2">
            <select
              value={repeat}
              onChange={e => setRepeat(e.target.value as RepeatType)}
              className="px-2 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
            >
              {(Object.keys(REPEAT_LABELS) as RepeatType[]).map(k => (
                <option key={k} value={k}>{REPEAT_LABELS[k]}</option>
              ))}
            </select>
            <div className="flex-1" />
            <button
              onClick={handleSave}
              className="px-3 py-1 text-xs font-medium text-white bg-blue-500 hover:bg-blue-600 rounded"
            >
              {editId ? '수정' : '추가'}
            </button>
            <button
              onClick={cancelForm}
              className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* 다가오는 알람 모아보기 (아래에서 계속) */}
      {showUpcoming && (
        <div className="mt-2 p-2 rounded bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-800">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-blue-600 dark:text-blue-400">다가오는 알람</span>
            <button onClick={() => setShowUpcoming(false)} className="text-[10px] text-gray-400 hover:text-gray-600">닫기</button>
          </div>
          {upcomingAlarms.length === 0 ? (
            <p className="text-xs text-gray-400">예정된 알람이 없습니다.</p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {upcomingAlarms.map(alarm => (
                <button
                  key={alarm.id}
                  onClick={() => navigateToAlarmDate(alarm.day_id)}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded text-left hover:bg-blue-100 dark:hover:bg-blue-800/30 transition-colors"
                >
                  <span className="text-[11px] text-blue-500 dark:text-blue-400 font-mono min-w-[4.5rem]">
                    {dayjs(alarm.day_id).format('M/D (ddd)')}
                  </span>
                  <span className="text-[11px] font-mono text-gray-700 dark:text-gray-300">
                    {alarm.time}
                  </span>
                  {alarm.repeat !== 'none' && (
                    <span className="text-[9px] px-1 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-500">
                      {REPEAT_LABELS[alarm.repeat]}
                    </span>
                  )}
                  <span className="text-[11px] text-gray-500 dark:text-gray-400 truncate flex-1">
                    {alarm.label || '(라벨 없음)'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ──────────── 미니 달력 피커 ──────────── */

function MiniCalendar({ value, month, onMonthChange, onSelect }: {
  value: string
  month: string         // YYYY-MM
  onMonthChange: (m: string) => void
  onSelect: (date: string) => void
}) {
  const year = parseInt(month.slice(0, 4))
  const mon = parseInt(month.slice(5, 7))
  const holidayMap = getHolidayMap(month)

  const firstDay = new Date(year, mon - 1, 1).getDay()
  const daysInMonth = new Date(year, mon, 0).getDate()
  const prevDays = new Date(year, mon - 1, 0).getDate()

  const cells: Array<{ day: number; dateStr: string; isCurrentMonth: boolean }> = []

  // 이전 달
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevDays - i
    const pm = mon === 1 ? 12 : mon - 1
    const py = mon === 1 ? year - 1 : year
    cells.push({ day: d, dateStr: `${py}-${String(pm).padStart(2, '0')}-${String(d).padStart(2, '0')}`, isCurrentMonth: false })
  }
  // 현재 달
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, dateStr: `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`, isCurrentMonth: true })
  }
  // 다음 달
  const remaining = 42 - cells.length
  for (let d = 1; d <= remaining; d++) {
    const nm = mon === 12 ? 1 : mon + 1
    const ny = mon === 12 ? year + 1 : year
    cells.push({ day: d, dateStr: `${ny}-${String(nm).padStart(2, '0')}-${String(d).padStart(2, '0')}`, isCurrentMonth: false })
  }

  const todayStr = dayjs().format('YYYY-MM-DD')
  const DOW = ['일', '월', '화', '수', '목', '금', '토']

  function prevMonth() {
    const d = new Date(year, mon - 2, 1)
    onMonthChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  function nextMonth() {
    const d = new Date(year, mon, 1)
    onMonthChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  return (
    <div className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2 w-[240px]">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-1.5">
        <button onClick={prevMonth} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 text-xs">◀</button>
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{year}년 {mon}월</span>
        <button onClick={nextMonth} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 text-xs">▶</button>
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 mb-0.5">
        {DOW.map((d, i) => (
          <span key={d} className={`text-center text-[10px] font-medium ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-400'}`}>{d}</span>
        ))}
      </div>

      {/* 날짜 그리드 */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((cell, idx) => {
          const isSelected = cell.dateStr === value
          const isToday = cell.dateStr === todayStr
          const dow = idx % 7
          const isHoliday = !!holidayMap[cell.dateStr]
          const isRedDay = isHoliday || dow === 0

          return (
            <button
              key={cell.dateStr}
              type="button"
              onClick={() => onSelect(cell.dateStr)}
              className={`
                w-7 h-7 text-[11px] rounded flex items-center justify-center transition-colors
                ${!cell.isCurrentMonth ? 'opacity-30' : ''}
                ${isSelected ? 'bg-blue-500 text-white font-bold'
                  : isToday ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold'
                  : isRedDay ? 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10'
                  : dow === 6 ? 'text-blue-500 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}
              `}
              title={holidayMap[cell.dateStr] || undefined}
            >
              {cell.day}
            </button>
          )
        })}
      </div>

      {/* 오늘 버튼 */}
      <div className="mt-1.5 flex justify-center">
        <button
          type="button"
          onClick={() => { onSelect(todayStr); onMonthChange(todayStr.slice(0, 7)) }}
          className="text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400"
        >
          오늘
        </button>
      </div>
    </div>
  )
}

/* ──────────── 시간 피커 ──────────── */

function TimePickerDropdown({ value, onChange, onClose }: {
  value: string       // "HH:mm"
  onChange: (t: string) => void
  onClose: () => void
}) {
  const [hour, setHour] = useState(parseInt(value.split(':')[0]))
  const [minute, setMinute] = useState(parseInt(value.split(':')[1]))
  const hourRef = useRef<HTMLDivElement>(null)
  const minRef = useRef<HTMLDivElement>(null)

  // 스크롤 초기 위치
  useEffect(() => {
    if (hourRef.current) hourRef.current.scrollTop = hour * 28 - 56
    if (minRef.current) minRef.current.scrollTop = (minute / 5) * 28 - 56
  }, [])

  function selectHour(h: number) {
    setHour(h)
    const t = `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    onChange(t)
  }

  function selectMinute(m: number) {
    setMinute(m)
    const t = `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    onChange(t)
  }

  const hours = Array.from({ length: 24 }, (_, i) => i)
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5)

  // 프리셋
  const presets = [
    { label: '아침 7시', h: 7, m: 0 },
    { label: '아침 9시', h: 9, m: 0 },
    { label: '정오', h: 12, m: 0 },
    { label: '오후 2시', h: 14, m: 0 },
    { label: '오후 6시', h: 18, m: 0 },
    { label: '밤 9시', h: 21, m: 0 },
  ]

  return (
    <div className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2 w-[220px]">
      {/* 현재 시간 표시 */}
      <div className="text-center text-sm font-mono font-bold text-gray-800 dark:text-gray-200 mb-2">
        {String(hour).padStart(2, '0')} : {String(minute).padStart(2, '0')}
      </div>

      {/* 시/분 스크롤 */}
      <div className="flex gap-1 mb-2">
        {/* 시간 */}
        <div className="flex-1">
          <div className="text-[10px] text-center text-gray-400 mb-0.5">시</div>
          <div ref={hourRef} className="h-[140px] overflow-y-auto scrollbar-thin">
            {hours.map(h => (
              <button
                key={h}
                type="button"
                onClick={() => selectHour(h)}
                className={`w-full py-1 text-xs text-center rounded transition-colors ${
                  h === hour
                    ? 'bg-blue-500 text-white font-bold'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                {String(h).padStart(2, '0')}
              </button>
            ))}
          </div>
        </div>

        <div className="w-px bg-gray-200 dark:bg-gray-700" />

        {/* 분 */}
        <div className="flex-1">
          <div className="text-[10px] text-center text-gray-400 mb-0.5">분</div>
          <div ref={minRef} className="h-[140px] overflow-y-auto scrollbar-thin">
            {minutes.map(m => (
              <button
                key={m}
                type="button"
                onClick={() => selectMinute(m)}
                className={`w-full py-1 text-xs text-center rounded transition-colors ${
                  m === minute
                    ? 'bg-blue-500 text-white font-bold'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                {String(m).padStart(2, '0')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 프리셋 */}
      <div className="grid grid-cols-3 gap-1 border-t border-gray-100 dark:border-gray-700 pt-1.5">
        {presets.map(p => (
          <button
            key={p.label}
            type="button"
            onClick={() => { selectHour(p.h); selectMinute(p.m); onChange(`${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`); onClose() }}
            className="text-[10px] py-1 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* 확인 버튼 */}
      <div className="mt-1.5 flex justify-center">
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] px-3 py-0.5 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          확인
        </button>
      </div>
    </div>
  )
}
