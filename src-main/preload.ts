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
  deleteNoteItem:      (id: string, dayId: string)          => ipcRenderer.invoke('db:deleteNoteItem', id, dayId),
  deleteAllItemsByDay: (dayId: string)                      => ipcRenderer.invoke('db:deleteAllItemsByDay', dayId),
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
    const handler = () => cb()
    ipcRenderer.on('sync:done', handler)
    return () => { ipcRenderer.removeListener('sync:done', handler) }
  },
  onSyncStatus: (cb: (status: string) => void) => {
    const handler = (_e: unknown, status: string) => cb(status)
    ipcRenderer.on('sync:status', handler)
    return () => { ipcRenderer.removeListener('sync:status', handler) }
  },

  // ── 토글 블록 상태 ──
  getToggleStates:  () => ipcRenderer.invoke('db:getToggleStates') as Promise<Record<string, boolean>>,
  setToggleState:   (blockId: string, open: boolean) => ipcRenderer.invoke('db:setToggleState', blockId, open),

  // ── 마크다운 내보내기 ──
  exportMarkdown:   (dayId?: string) => ipcRenderer.invoke('app:exportMarkdown', dayId) as Promise<string | null>,

  // ── 동기화 히스토리 ──
  getSyncHistory:   () => ipcRenderer.invoke('sync:getHistory') as Promise<Array<{ timestamp: number; pulled: number; pushed: number; cleaned: number; duration: number }>>,

  // ── 마지막 백업 시간 ──
  getLastBackupAt:  () => ipcRenderer.invoke('app:getLastBackupAt') as Promise<number>,

  // ── 백업 실패 이벤트 ──
  onBackupFailed: (cb: (error: string) => void) => {
    const handler = (_e: unknown, error: string) => cb(error)
    ipcRenderer.on('backup:failed', handler)
    return () => { ipcRenderer.removeListener('backup:failed', handler) }
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
  authGetAutoLogin:    () => ipcRenderer.invoke('auth:getAutoLogin') as Promise<boolean>,
  authSetAutoLogin:    (enabled: boolean) => ipcRenderer.invoke('auth:setAutoLogin', enabled) as Promise<{ ok: boolean }>,
  authGetLocalAccounts:() => ipcRenderer.invoke('auth:getLocalAccounts') as Promise<Array<{ id: string; email: string }>>,
  authOfflineLogin:    (userId: string, password: string) => ipcRenderer.invoke('auth:offlineLogin', userId, password) as Promise<{ ok: boolean; user?: { id: string; email: string }; error?: string }>,

  // ── OneDrive DB 동기화 ──
  onedriveGetConfig: () => ipcRenderer.invoke('onedrive:getConfig') as Promise<{ enabled: boolean; path: string }>,
  onedriveSetPath:   () => ipcRenderer.invoke('onedrive:setPath') as Promise<{ ok: boolean; path?: string }>,
  onedriveSetEnabled:(enabled: boolean) => ipcRenderer.invoke('onedrive:setEnabled', enabled) as Promise<{ ok: boolean }>,
  onedriveExport:    () => ipcRenderer.invoke('onedrive:export') as Promise<{ ok: boolean; error?: string }>,
  onedriveImport:    () => ipcRenderer.invoke('onedrive:import') as Promise<{ ok: boolean; error?: string }>,

  // ── Realtime 상태 ──
  getRealtimeStatus: () => ipcRenderer.invoke('sync:getRealtimeStatus') as Promise<'connected' | 'disconnected' | 'reconnecting'>,

  // ── 동기화 충돌 알림 ──
  onSyncConflict: (cb: (msg: string) => void) => {
    const handler = (_e: unknown, msg: string) => cb(msg)
    ipcRenderer.on('sync:conflict', handler)
    return () => { ipcRenderer.removeListener('sync:conflict', handler) }
  },

  // ── 태그 필터 ──
  getNoteDaysWithTag: (yearMonth: string, tag: string) => ipcRenderer.invoke('db:getNoteDaysWithTag', yearMonth, tag),

  // ── 템플릿 ──
  getTemplates:     () => ipcRenderer.invoke('db:getTemplates'),
  upsertTemplate:   (template: unknown) => ipcRenderer.invoke('db:upsertTemplate', template),
  deleteTemplate:   (id: string) => ipcRenderer.invoke('db:deleteTemplate', id),
  applyTemplate:    (templateId: string, dayId: string) => ipcRenderer.invoke('db:applyTemplate', templateId, dayId),

  // ── PIN 잠금 ──
  getPinEnabled:  () => ipcRenderer.invoke('app:getPinEnabled') as Promise<boolean>,
  setPin:         (pin: string | null) => ipcRenderer.invoke('app:setPin', pin) as Promise<{ ok: boolean }>,
  verifyPin:      (pin: string) => ipcRenderer.invoke('app:verifyPin', pin) as Promise<{ ok: boolean }>,

  // ── 통계 ──
  getMonthlyStats:  (yearMonth: string) => ipcRenderer.invoke('db:getMonthlyStats', yearMonth) as Promise<Array<{ day: string; count: number }>>,
  getMoodStats:     (yearMonth: string) => ipcRenderer.invoke('db:getMoodStats', yearMonth) as Promise<Array<{ mood: string; count: number }>>,
  getTagStats:      () => ipcRenderer.invoke('db:getTagStats') as Promise<Array<{ tag: string; count: number }>>,

  // ── 반복 메모 ──
  getRecurringBlocks:    () => ipcRenderer.invoke('db:getRecurringBlocks') as Promise<Array<{ id: string; type: string; content: string; repeat: string; day_of_week: number; created_at: number }>>,
  upsertRecurringBlock:  (block: { id: string; type: string; content: string; repeat: string; day_of_week: number; created_at: number }) => ipcRenderer.invoke('db:upsertRecurringBlock', block) as Promise<boolean>,
  deleteRecurringBlock:  (id: string) => ipcRenderer.invoke('db:deleteRecurringBlock', id) as Promise<boolean>,

  // ── 메모 암호화 ──
  encryptBlock:     (id: string, password: string) => ipcRenderer.invoke('db:encryptBlock', id, password) as Promise<boolean>,
  decryptBlock:     (id: string, password: string) => ipcRenderer.invoke('db:decryptBlock', id, password) as Promise<string | null>,

  // ── 윈도우 컨트롤 (frameless) ──
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),
} as const

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
