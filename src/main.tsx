import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 브라우저 테스트용 mock API (Electron 환경이 아닐 때만)
if (!window.api) {
  const store: { days: Record<string, import('./types').NoteDay>; items: import('./types').NoteItem[] } = {
    days: {},
    items: []
  }

  function refreshDay(dayId: string): import('./types').NoteDay {
    const dayItems = store.items.filter(i => i.day_id === dayId)
    const count = dayItems.length
    const first = [...dayItems].sort((a, b) => a.order_index - b.order_index)[0]
    let summary: string | null = null
    if (first) {
      if (first.type === 'checklist') {
        try { summary = JSON.parse(first.content).map((e: any) => e.text).join(', ').slice(0, 80) } catch {}
      } else {
        summary = first.content.slice(0, 80)
      }
    }
    const day: import('./types').NoteDay = store.days[dayId]
      ? { ...store.days[dayId], note_count: count, has_notes: count > 0 ? 1 : 0, summary, updated_at: Date.now() }
      : { id: dayId, mood: null, summary, note_count: count, has_notes: count > 0 ? 1 : 0, updated_at: Date.now() }
    store.days[dayId] = day
    return day
  }

  window.api = {
    getNoteDays: async (ym) => Object.values(store.days).filter(d => d.id.startsWith(ym)),
    getNoteDay: async (date) => store.days[date] ?? null,
    getNoteItems: async (dayId) =>
      store.items.filter(i => i.day_id === dayId).sort((a, b) => (b.pinned - a.pinned) || (a.order_index - b.order_index)),
    search: async (q) =>
      store.items.filter(i => i.content.includes(q) || i.tags.includes(q)).slice(0, 100),
    upsertNoteItem: async (item: any) => {
      const idx = store.items.findIndex(i => i.id === item.id)
      const updated = { ...item, updated_at: Date.now() }
      if (idx >= 0) store.items[idx] = updated
      else store.items.push(updated)
      return refreshDay(item.day_id)
    },
    deleteNoteItem: async (id, dayId) => {
      store.items = store.items.filter(i => i.id !== id)
      return refreshDay(dayId)
    },
    reorderNoteItems: async (dayId, orderedIds) => {
      orderedIds.forEach((id, idx) => {
        const item = store.items.find(i => i.id === id && i.day_id === dayId)
        if (item) item.order_index = idx
      })
    },
    updateMood: async (dayId, mood) => {
      if (!store.days[dayId]) {
        store.days[dayId] = { id: dayId, mood, summary: null, note_count: 0, has_notes: 0, updated_at: Date.now() }
      } else {
        store.days[dayId] = { ...store.days[dayId], mood, updated_at: Date.now() }
      }
    },
    isDarkMode: async () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    setDarkMode: async () => false,
    getAutoLaunch: async () => false,
    setAutoLaunch: async () => {},
    getDataPath: async () => 'C:\\Users\\Documents\\Wition',
    changeDataPath: async () => null,
    openDataFolder: async () => {},
    exportData: async () => null,
    importData: async () => false,
    attachFile: async () => null,
    openAttachment: async () => false,
    getBackupConfig: async () => ({ autoBackup: true, backupPath: 'C:\\Users\\Documents\\Wition\\backups', backupIntervalMin: 30, backupKeepCount: 10 }),
    setBackupConfig: async () => {},
    changeBackupPath: async () => null,
    runBackupNow: async () => true,
    checkConflicts: async () => [],
    minimize: () => {},
    maximize: () => {},
    close: () => {}
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
