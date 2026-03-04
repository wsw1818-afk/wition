import { create } from 'zustand'
import type { NoteItem } from '../types'

interface SearchState {
  /** 검색 패널 열림 여부 */
  isOpen: boolean
  /** 검색어 */
  query: string
  /** 검색 결과 */
  results: NoteItem[]
  /** 로딩 중 */
  loading: boolean
}

interface SearchActions {
  /** 패널 열기 */
  open: () => void
  /** 패널 닫기 */
  close: () => void
  /** 패널 토글 */
  toggle: () => void
  /** 검색 실행 */
  search: (query: string) => Promise<void>
  /** 상태 초기화 */
  reset: () => void
}

export type SearchStore = SearchState & SearchActions

export const useSearchStore = create<SearchStore>((set, get) => ({
  isOpen: false,
  query: '',
  results: [],
  loading: false,

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false, query: '', results: [] }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen, query: '', results: [] })),

  search: async (query) => {
    const trimmed = query.trim()
    if (!trimmed) {
      set({ query, results: [], loading: false })
      return
    }

    set({ query, loading: true })
    try {
      const results = await window.api.search(trimmed)
      set({ results })
    } catch (err) {
      console.error('search:', err)
      set({ results: [] })
    } finally {
      set({ loading: false })
    }
  },

  reset: () => set({ isOpen: false, query: '', results: [], loading: false })
}))
