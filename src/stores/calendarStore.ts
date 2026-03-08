import { create } from 'zustand'
import dayjs from 'dayjs'
import type { NoteDay } from '../types'

interface CalendarState {
  /** 현재 표시 중인 월 "YYYY-MM" */
  currentMonth: string
  /** 선택된 날짜 "YYYY-MM-DD" (null이면 달력 뷰) */
  selectedDate: string | null
  /** 해당 월의 NoteDay 맵 (key: "YYYY-MM-DD") */
  dayMap: Record<string, NoteDay>
  /** 해당 월에서 알람이 있는 날짜 세트 */
  alarmDays: Set<string>
  loading: boolean
}

interface CalendarActions {
  loadMonth: (yearMonth: string) => Promise<void>
  goToPrevMonth: () => Promise<void>
  goToNextMonth: () => Promise<void>
  goToToday: () => Promise<void>
  selectDate: (date: string) => void
  clearSelection: () => void
  /** DB에서 반환된 NoteDay로 캐시 갱신 (아이템 추가/삭제 후 호출) */
  patchDay: (day: NoteDay | null) => void
}

export type CalendarStore = CalendarState & CalendarActions

export const useCalendarStore = create<CalendarStore>((set, get) => ({
  currentMonth: dayjs().format('YYYY-MM'),
  selectedDate: null,
  dayMap: {},
  alarmDays: new Set<string>(),
  loading: false,

  loadMonth: async (yearMonth) => {
    set({ loading: true, currentMonth: yearMonth })
    try {
      const [rows, alarmDayList] = await Promise.all([
        window.api.getNoteDays(yearMonth),
        window.api.getAlarmDaysByMonth(yearMonth),
      ])
      const map: Record<string, NoteDay> = {}
      for (const r of rows) map[r.id] = r
      set({ dayMap: map, alarmDays: new Set(alarmDayList) })
    } catch (err) {
      console.error('loadMonth:', err)
    } finally {
      set({ loading: false })
    }
  },

  goToPrevMonth: async () => {
    const prev = dayjs(get().currentMonth + '-01').subtract(1, 'month').format('YYYY-MM')
    await get().loadMonth(prev)
  },

  goToNextMonth: async () => {
    const next = dayjs(get().currentMonth + '-01').add(1, 'month').format('YYYY-MM')
    await get().loadMonth(next)
  },

  goToToday: async () => {
    const today = dayjs().format('YYYY-MM')
    if (get().currentMonth !== today) {
      await get().loadMonth(today)
    }
    set({ selectedDate: dayjs().format('YYYY-MM-DD') })
  },

  selectDate: (date) => set({ selectedDate: date }),
  clearSelection: () => set({ selectedDate: null }),

  patchDay: (day) => {
    if (!day) return
    set((s) => {
      const next = { ...s.dayMap }
      if (day.note_count === 0 && !day.mood) {
        delete next[day.id]
      } else {
        next[day.id] = day
      }
      return { dayMap: next }
    })
  }
}))
