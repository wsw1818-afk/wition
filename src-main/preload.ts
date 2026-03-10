import { contextBridge, ipcRenderer } from 'electron'

// 디버그: preload 로드 확인
ipcRenderer.send('debug:preloadLoaded')

// 디버그: preload 레벨에서 sync:done 직접 수신 테스트
ipcRenderer.on('sync:done', (...args: unknown[]) => {
  console.log('[preload-direct] sync:done 수신!', args)
  ipcRenderer.send('debug:syncDoneReceived')
})

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
  getCloseToTray: () => ipcRenderer.invoke('app:getCloseToTray'),
  setCloseToTray: (enabled: boolean) => ipcRenderer.invoke('app:setCloseToTray', enabled),

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

  // ── 클립보드 이미지 저장 ──
  saveClipboardImage: (base64: string) => ipcRenderer.invoke('app:saveClipboardImage', base64) as Promise<{ name: string; path: string; size: number } | null>,

  // ── 자동 백업 ──
  getBackupConfig:  () => ipcRenderer.invoke('app:getBackupConfig'),
  setBackupConfig:  (cfg: Record<string, unknown>) => ipcRenderer.invoke('app:setBackupConfig', cfg),
  changeBackupPath: () => ipcRenderer.invoke('app:changeBackupPath'),
  runBackupNow:     () => ipcRenderer.invoke('app:runBackupNow'),

  // ── 달력 패널 너비 ──
  getCalendarWidth: () => ipcRenderer.invoke('app:getCalendarWidth') as Promise<number>,
  setCalendarWidth: (width: number) => ipcRenderer.invoke('app:setCalendarWidth', width),

  // ── 동기화 ──
  syncNow:        () => ipcRenderer.invoke('sync:now'),
  getSyncStatus:  () => ipcRenderer.invoke('sync:getStatus'),
  onSyncDone: (cb: () => void) => {
    const handler = () => {
      console.log('[preload] sync:done 수신!')
      ipcRenderer.send('debug:syncDoneReceived')
      cb()
    }
    ipcRenderer.on('sync:done', handler)
    return () => { ipcRenderer.removeListener('sync:done', handler) }
  },
  onSyncStatus: (cb: (status: string) => void) => {
    const handler = (_e: unknown, status: string) => cb(status)
    ipcRenderer.on('sync:status', handler)
    return () => { ipcRenderer.removeListener('sync:status', handler) }
  },

  // ── 알람 ──
  getAlarms:          (dayId: string) => ipcRenderer.invoke('db:getAlarms', dayId),
  upsertAlarm:        (alarm: unknown) => ipcRenderer.invoke('db:upsertAlarm', alarm),
  deleteAlarm:        (id: string) => ipcRenderer.invoke('db:deleteAlarm', id),
  getAlarmDaysByMonth:(yearMonth: string) => ipcRenderer.invoke('db:getAlarmDaysByMonth', yearMonth),
  getUpcomingAlarms:  (todayStr: string) => ipcRenderer.invoke('db:getUpcomingAlarms', todayStr),

  // ── 알람 이벤트 ──
  onAlarmNavigate: (cb: (dayId: string) => void) => {
    const handler = (_e: unknown, dayId: string) => cb(dayId)
    ipcRenderer.on('alarm:navigate', handler)
    return () => { ipcRenderer.removeListener('alarm:navigate', handler) }
  },
  onAlarmFire: (cb: (alarm: { id: string; day_id: string; time: string; label: string; repeat: string }) => void) => {
    const handler = (_e: unknown, alarm: { id: string; day_id: string; time: string; label: string; repeat: string }) => cb(alarm)
    ipcRenderer.on('alarm:fire', handler)
    return () => { ipcRenderer.removeListener('alarm:fire', handler) }
  },

  // ── 인증 ──
  authSignup:          (email: string, password: string) => ipcRenderer.invoke('auth:signup', email, password) as Promise<{ ok: boolean; error?: string }>,
  authLogin:           (email: string, password: string) => ipcRenderer.invoke('auth:login', email, password) as Promise<{ ok: boolean; user?: { id: string; email: string }; error?: string }>,
  authLogout:          () => ipcRenderer.invoke('auth:logout') as Promise<{ ok: boolean }>,
  authGetSession:      () => ipcRenderer.invoke('auth:getSession') as Promise<{ authenticated: boolean; user?: { id: string; email: string }; offline?: boolean; reason?: string }>,
  authSaveCredentials: (email: string, password: string) => ipcRenderer.invoke('auth:saveCredentials', email, password) as Promise<{ ok: boolean }>,
  authGetCredentials:  () => ipcRenderer.invoke('auth:getCredentials') as Promise<{ ok: boolean; email?: string; password?: string }>,
  authClearCredentials:() => ipcRenderer.invoke('auth:clearCredentials') as Promise<{ ok: boolean }>,

  // ── OneDrive DB 동기화 ──
  onedriveGetConfig: () => ipcRenderer.invoke('onedrive:getConfig') as Promise<{ enabled: boolean; path: string }>,
  onedriveSetPath:   () => ipcRenderer.invoke('onedrive:setPath') as Promise<{ ok: boolean; path?: string }>,
  onedriveSetEnabled:(enabled: boolean) => ipcRenderer.invoke('onedrive:setEnabled', enabled) as Promise<{ ok: boolean }>,
  onedriveExport:    () => ipcRenderer.invoke('onedrive:export') as Promise<{ ok: boolean; error?: string }>,
  onedriveImport:    () => ipcRenderer.invoke('onedrive:import') as Promise<{ ok: boolean; error?: string }>,

  // ── 윈도우 컨트롤 (frameless) ──
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),
} as const

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
