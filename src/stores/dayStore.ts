import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { NoteItem, BlockType, ChecklistEntry, NoteDay, Alarm } from '../types'
import { getDefaultContent } from '../types'
import { useHistoryStore } from './historyStore'

interface DayState {
  dayId: string | null
  items: NoteItem[]
  alarms: Alarm[]
  loading: boolean
}

interface DayActions {
  /** 날짜 선택 시 아이템 로드 */
  load: (dayId: string) => Promise<void>
  /** sync:done 시 호출 — 변경된 항목만 머지 (불필요한 리렌더 방지) */
  softReload: (dayId: string) => Promise<void>
  /** 텍스트 블록 추가 */
  addText: (text: string) => Promise<NoteDay | null>
  /** 체크리스트 블록 추가 (첫 항목 텍스트 선택적) */
  addChecklist: (firstText?: string) => Promise<NoteDay | null>
  /** 범용 블록 추가 (노션 스타일) */
  addBlock: (type: BlockType, content?: string) => Promise<NoteDay | null>
  /** 블록 수정 (content, pinned, tags 등) */
  update: (id: string, patch: Partial<Pick<NoteItem, 'content' | 'pinned' | 'tags'>>) => Promise<NoteDay | null>
  /** 블록 삭제 */
  remove: (id: string) => Promise<NoteDay | null>
  /** 핀 토글 → DB 갱신 후 재로드 */
  togglePin: (id: string) => Promise<NoteDay | null>
  /** 순서 변경 */
  reorder: (orderedIds: string[]) => Promise<void>
  /** 스토어 초기화 (날짜 해제 시) */
  reset: () => void
  /** 알람 로드 */
  loadAlarms: (dayId: string) => Promise<void>
  /** 알람 추가/수정 */
  upsertAlarm: (alarm: Alarm) => Promise<boolean>
  /** 알람 삭제 */
  removeAlarm: (id: string) => Promise<boolean>
}

export type DayStore = DayState & DayActions

// race condition 방지: 마지막 load 요청만 반영
let _dayLoadSeq = 0

export const useDayStore = create<DayStore>((set, get) => ({
  dayId: null,
  items: [],
  alarms: [],
  loading: false,

  load: async (dayId) => {
    const seq = ++_dayLoadSeq
    set({ loading: true, dayId })
    try {
      const [items, alarms] = await Promise.all([
        window.api.getNoteItems(dayId),
        window.api.getAlarms(dayId),
      ])
      // stale 응답 무시
      if (seq !== _dayLoadSeq) return
      set({ items, alarms })
    } catch (err) {
      console.error('dayStore.load:', err)
      if (seq === _dayLoadSeq) set({ items: [], alarms: [] })
    } finally {
      if (seq === _dayLoadSeq) set({ loading: false })
    }
  },

  softReload: async (dayId) => {
    const current = get()
    if (current.dayId !== dayId) return
    try {
      const [freshItems, freshAlarms] = await Promise.all([
        window.api.getNoteItems(dayId),
        window.api.getAlarms(dayId),
      ])
      // dayId가 로드 중 바뀌었으면 무시
      if (get().dayId !== dayId) return

      const oldItems = get().items
      // 변경 여부 비교: 개수, id 순서, 각 항목의 updated_at
      let itemsChanged = oldItems.length !== freshItems.length
      if (!itemsChanged) {
        for (let i = 0; i < oldItems.length; i++) {
          if (oldItems[i].id !== freshItems[i].id ||
              oldItems[i].updated_at !== freshItems[i].updated_at ||
              oldItems[i].content !== freshItems[i].content ||
              oldItems[i].tags !== freshItems[i].tags ||
              oldItems[i].pinned !== freshItems[i].pinned ||
              oldItems[i].order_index !== freshItems[i].order_index) {
            itemsChanged = true
            break
          }
        }
      }

      const oldAlarms = get().alarms
      let alarmsChanged = oldAlarms.length !== freshAlarms.length
      if (!alarmsChanged) {
        for (let i = 0; i < oldAlarms.length; i++) {
          if (oldAlarms[i].id !== freshAlarms[i].id ||
              oldAlarms[i].time !== freshAlarms[i].time ||
              oldAlarms[i].enabled !== freshAlarms[i].enabled) {
            alarmsChanged = true
            break
          }
        }
      }

      // 변경된 것만 set (변경 없으면 리렌더 없음)
      if (itemsChanged && alarmsChanged) {
        set({ items: freshItems, alarms: freshAlarms })
      } else if (itemsChanged) {
        set({ items: freshItems })
      } else if (alarmsChanged) {
        set({ alarms: freshAlarms })
      }
      // 둘 다 변경 없으면 set 호출 안 함 → 리렌더 없음
    } catch (err) {
      console.error('dayStore.softReload:', err)
    }
  },

  addText: async (text) => {
    const { dayId, items } = get()
    if (!dayId || !text.trim()) return null

    const now = Date.now()
    const newItem: NoteItem = {
      id: uuid(), day_id: dayId, type: 'text',
      content: text.trim(), tags: '[]', pinned: 0,
      order_index: items.length,
      created_at: now, updated_at: now
    }

    try {
      const updatedDay = await window.api.upsertNoteItem(newItem)
      // 성공한 경우에만 로컬 상태 반영
      if (updatedDay) {
        set((s) => ({ items: [...s.items, newItem] }))
        useHistoryStore.getState().push({ type: 'add', item: newItem, dayId })
      }
      return updatedDay
    } catch (err) {
      console.error('addText:', err)
      return null
    }
  },

  addChecklist: async (firstText = '') => {
    const { dayId, items } = get()
    if (!dayId) return null

    const now = Date.now()
    const entries: ChecklistEntry[] = [{ id: uuid(), text: firstText, done: false }]
    const newItem: NoteItem = {
      id: uuid(), day_id: dayId, type: 'checklist',
      content: JSON.stringify(entries), tags: '[]', pinned: 0,
      order_index: items.length,
      created_at: now, updated_at: now
    }

    try {
      const updatedDay = await window.api.upsertNoteItem(newItem)
      if (updatedDay) {
        set((s) => ({ items: [...s.items, newItem] }))
        useHistoryStore.getState().push({ type: 'add', item: newItem, dayId })
      }
      return updatedDay
    } catch (err) {
      console.error('addChecklist:', err)
      return null
    }
  },

  addBlock: async (type, content) => {
    const { dayId, items } = get()
    if (!dayId) return null

    const now = Date.now()
    const newItem: NoteItem = {
      id: uuid(), day_id: dayId, type,
      content: content ?? getDefaultContent(type),
      tags: '[]', pinned: 0,
      order_index: items.length,
      created_at: now, updated_at: now
    }

    try {
      const updatedDay = await window.api.upsertNoteItem(newItem)
      if (updatedDay) {
        set((s) => ({ items: [...s.items, newItem] }))
        useHistoryStore.getState().push({ type: 'add', item: newItem, dayId })
      }
      return updatedDay
    } catch (err) {
      console.error('addBlock:', err)
      return null
    }
  },

  update: async (id, patch) => {
    const item = get().items.find(i => i.id === id)
    if (!item) return null

    const updated: NoteItem = { ...item, ...patch, updated_at: Date.now() }
    try {
      const updatedDay = await window.api.upsertNoteItem(updated)
      if (updatedDay) {
        set((s) => ({ items: s.items.map(i => i.id === id ? updated : i) }))
        useHistoryStore.getState().push({ type: 'update', item, newItem: updated, dayId: item.day_id })
      }
      return updatedDay
    } catch (err) {
      console.error('update:', err)
      return null
    }
  },

  remove: async (id) => {
    const { dayId, items } = get()
    if (!dayId) return null

    const deletedItem = items.find(i => i.id === id)
    try {
      const updatedDay = await window.api.deleteNoteItem(id, dayId)
      set((s) => ({ items: s.items.filter(i => i.id !== id) }))
      if (deletedItem) {
        useHistoryStore.getState().push({ type: 'delete', item: deletedItem, dayId })
      }
      return updatedDay
    } catch (err) {
      console.error('remove:', err)
      return null
    }
  },

  togglePin: async (id) => {
    const { dayId } = get()
    const item = get().items.find(i => i.id === id)
    if (!item || !dayId) return null

    const updated: NoteItem = { ...item, pinned: item.pinned ? 0 : 1, updated_at: Date.now() }
    try {
      const updatedDay = await window.api.upsertNoteItem(updated)
      // pin 변경 후 정렬이 달라지므로 DB에서 다시 로드
      if (updatedDay) await get().load(dayId)
      return updatedDay
    } catch (err) {
      console.error('togglePin:', err)
      return null
    }
  },

  reorder: async (orderedIds) => {
    const { dayId, items } = get()
    if (!dayId) return

    const prevOrder = items.map(i => i.id)

    // 즉시 UI 반영 (낙관적)
    const reordered = orderedIds
      .map(id => items.find(i => i.id === id))
      .filter((i): i is NoteItem => !!i)
      .map((item, idx) => ({ ...item, order_index: idx }))
    set({ items: reordered })

    try {
      await window.api.reorderNoteItems(dayId, orderedIds)
      useHistoryStore.getState().push({ type: 'reorder', prevOrder, newOrder: orderedIds, dayId })
    } catch (err) {
      console.error('reorder:', err)
      // 실패 시 DB에서 다시 로드
      await get().load(dayId)
    }
  },

  reset: () => set({ dayId: null, items: [], alarms: [], loading: false }),

  loadAlarms: async (dayId) => {
    try {
      const alarms = await window.api.getAlarms(dayId)
      set({ alarms })
    } catch (err) {
      console.error('loadAlarms:', err)
    }
  },

  upsertAlarm: async (alarm) => {
    try {
      const ok = await window.api.upsertAlarm(alarm)
      if (ok) {
        const currentDayId = get().dayId
        set((s) => {
          const existing = s.alarms.find(a => a.id === alarm.id)
          // 날짜가 변경된 경우: 현재 날짜 목록에서 제거
          if (existing && existing.day_id !== alarm.day_id) {
            // 다른 날짜로 이동됨 → 현재 목록에서 삭제
            if (alarm.day_id !== currentDayId) {
              return { alarms: s.alarms.filter(a => a.id !== alarm.id) }
            }
          }
          // 새 알람이 현재 날짜가 아닌 경우: 목록에 추가하지 않음
          if (!existing && alarm.day_id !== currentDayId) {
            return {}
          }
          // 일반 업데이트 또는 같은 날짜 내 수정
          const exists = s.alarms.some(a => a.id === alarm.id)
          return {
            alarms: exists
              ? s.alarms.map(a => a.id === alarm.id ? alarm : a)
              : [...s.alarms, alarm].sort((a, b) => a.time.localeCompare(b.time))
          }
        })
      }
      return ok
    } catch (err) {
      console.error('upsertAlarm:', err)
      return false
    }
  },

  removeAlarm: async (id) => {
    try {
      const ok = await window.api.deleteAlarm(id)
      if (ok) set((s) => ({ alarms: s.alarms.filter(a => a.id !== id) }))
      return ok
    } catch (err) {
      console.error('removeAlarm:', err)
      return false
    }
  },
}))
