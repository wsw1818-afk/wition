import { contextBridge, ipcRenderer } from 'electron'

/** 렌더러에서 사용할 API — window.api로 노출 */
const api = {
  // ── DB 읽기 ──
  getNoteDays:  (yearMonth: string) => ipcRenderer.invoke('db:getNoteDays', yearMonth),
  getNoteDay:   (date: string)      => ipcRenderer.invoke('db:getNoteDay', date),
  getNoteItems: (dayId: string)     => ipcRenderer.invoke('db:getNoteItems', dayId),
  search:       (query: string)     => ipcRenderer.invoke('db:search', query),

  // ── DB 쓰기 ──
  upsertNoteItem:   (item: unknown)                        => ipcRenderer.invoke('db:upsertNoteItem', item),
  deleteNoteItem:   (id: string, dayId: string)            => ipcRenderer.invoke('db:deleteNoteItem', id, dayId),
  reorderNoteItems: (dayId: string, orderedIds: string[])  => ipcRenderer.invoke('db:reorderNoteItems', dayId, orderedIds),
  updateMood:       (dayId: string, mood: string | null)   => ipcRenderer.invoke('db:updateMood', dayId, mood),

  // ── 앱 ──
  isDarkMode: () => ipcRenderer.invoke('app:isDarkMode'),

  // ── 설정: 저장 경로 ──
  getDataPath:    () => ipcRenderer.invoke('app:getDataPath'),
  changeDataPath: () => ipcRenderer.invoke('app:changeDataPath'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),

  // ── 윈도우 컨트롤 (frameless) ──
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),
} as const

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
