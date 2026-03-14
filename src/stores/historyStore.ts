import { create } from 'zustand'
import type { NoteItem } from '../types'

export type HistoryEntryType = 'add' | 'update' | 'delete' | 'reorder'

export interface HistoryEntry {
  type: HistoryEntryType
  /** add: 추가된 아이템, delete: 삭제된 아이템, update: 변경 전 아이템 */
  item?: NoteItem
  /** update: 변경 후 아이템 */
  newItem?: NoteItem
  /** reorder: 변경 전 ID 순서 */
  prevOrder?: string[]
  /** reorder: 변경 후 ID 순서 */
  newOrder?: string[]
  dayId: string
}

const MAX_HISTORY = 50

interface HistoryState {
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
}

interface HistoryActions {
  push: (entry: HistoryEntry) => void
  undo: () => HistoryEntry | null
  redo: () => HistoryEntry | null
  clear: () => void
}

export type HistoryStore = HistoryState & HistoryActions

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  undoStack: [],
  redoStack: [],

  push: (entry) => {
    set((s) => ({
      undoStack: [...s.undoStack.slice(-(MAX_HISTORY - 1)), entry],
      redoStack: [], // redo 클리어
    }))
  },

  undo: () => {
    const { undoStack } = get()
    if (undoStack.length === 0) return null
    const entry = undoStack[undoStack.length - 1]
    set((s) => ({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, entry],
    }))
    return entry
  },

  redo: () => {
    const { redoStack } = get()
    if (redoStack.length === 0) return null
    const entry = redoStack[redoStack.length - 1]
    set((s) => ({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, entry],
    }))
    return entry
  },

  clear: () => set({ undoStack: [], redoStack: [] }),
}))
