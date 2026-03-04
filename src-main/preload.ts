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
  isDarkMode:    () => ipcRenderer.invoke('app:isDarkMode'),
  setDarkMode:   (mode: string) => ipcRenderer.invoke('app:setDarkMode', mode),
  getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke('app:setAutoLaunch', enabled),

  // ── 설정: 저장 경로 ──
  getDataPath:    () => ipcRenderer.invoke('app:getDataPath'),
  changeDataPath: () => ipcRenderer.invoke('app:changeDataPath'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),

  // ── 데이터 내보내기/가져오기 ──
  exportData:     () => ipcRenderer.invoke('app:exportData'),
  importData:     () => ipcRenderer.invoke('app:importData'),

  // ── 파일 첨부 ──
  attachFile:       () => ipcRenderer.invoke('app:attachFile'),
  openAttachment:   (fileName: string) => ipcRenderer.invoke('app:openAttachment', fileName),

  // ── 자동 백업 ──
  getBackupConfig:  () => ipcRenderer.invoke('app:getBackupConfig'),
  setBackupConfig:  (cfg: Record<string, unknown>) => ipcRenderer.invoke('app:setBackupConfig', cfg),
  changeBackupPath: () => ipcRenderer.invoke('app:changeBackupPath'),
  runBackupNow:     () => ipcRenderer.invoke('app:runBackupNow'),

  // ── OneDrive 충돌 감지 ──
  checkConflicts: () => ipcRenderer.invoke('app:checkConflicts'),

  // ── 윈도우 컨트롤 (frameless) ──
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),
} as const

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
