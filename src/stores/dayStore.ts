import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { NoteItem, BlockType, ChecklistEntry, NoteDay } from '../types'

interface DayState {
  dayId: string | null
  items: NoteItem[]
  loading: boolean
}

interface DayActions {
  /** 날짜 선택 시 아이템 로드 */
  load: (dayId: string) => Promise<void>
  /** 텍스트 블록 추가 */
  addText: (text: string) => Promise<NoteDay | null>
  /** 체크리스트 블록 추가 (첫 항목 텍스트 선택적) */
  addChecklist: (firstText?: string) => Promise<NoteDay | null>
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
}

export type DayStore = DayState & DayActions

export const useDayStore = create<DayStore>((set, get) => ({
  dayId: null,
  items: [],
  loading: false,

  load: async (dayId) => {
    set({ loading: true, dayId })
    try {
      const items = await window.api.getNoteItems(dayId)
      set({ items })
    } catch (err) {
      console.error('dayStore.load:', err)
      set({ items: [] })
    } finally {
      set({ loading: false })
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
      if (updatedDay) set((s) => ({ items: [...s.items, newItem] }))
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
      if (updatedDay) set((s) => ({ items: [...s.items, newItem] }))
      return updatedDay
    } catch (err) {
      console.error('addChecklist:', err)
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
      }
      return updatedDay
    } catch (err) {
      console.error('update:', err)
      return null
    }
  },

  remove: async (id) => {
    const { dayId } = get()
    if (!dayId) return null

    try {
      const updatedDay = await window.api.deleteNoteItem(id, dayId)
      set((s) => ({ items: s.items.filter(i => i.id !== id) }))
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

    // 즉시 UI 반영 (낙관적)
    const reordered = orderedIds
      .map(id => items.find(i => i.id === id))
      .filter((i): i is NoteItem => !!i)
      .map((item, idx) => ({ ...item, order_index: idx }))
    set({ items: reordered })

    try {
      await window.api.reorderNoteItems(dayId, orderedIds)
    } catch (err) {
      console.error('reorder:', err)
      // 실패 시 DB에서 다시 로드
      await get().load(dayId)
    }
  },

  reset: () => set({ dayId: null, items: [], loading: false })
}))
