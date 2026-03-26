import { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog, Tray, Menu, Notification, net, safeStorage, screen, nativeImage } from 'electron'
import { join, basename, extname, resolve } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, copyFileSync, statSync, appendFileSync } from 'fs'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import { initializeSchema } from './db/schema'
import * as Q from './db/queries'
import * as Sync from './sync'
import { registerAuthHandlers, autoReLogin, getAuthBase } from './ipc/auth'
import { registerAlarmHandlers, startAlarmChecker, stopAlarmChecker } from './ipc/alarm'
import { registerBackupHandlers, startAutoBackup, stopAutoBackup, runAutoBackup } from './ipc/backup'
import { registerSyncHandlers } from './ipc/sync-handlers'
import { registerOnedriveHandlers, oneDrivePullIfNewer, scheduleOneDriveExport, startOneDriveSync, stopOneDriveSync, exportDbToOneDrive } from './ipc/onedrive'

// 글로벌 에러 핸들러 — 크래시 원인 파악용
const crashLogPath = join(process.env.APPDATA || process.env.HOME || '.', 'Wition', 'crash.log')
const logCrash = (label: string, err: unknown) => {
  const msg = `[${new Date().toISOString()}] ${label}: ${err instanceof Error ? err.stack : String(err)}\n`
  try { appendFileSync(crashLogPath, msg) } catch {}
}
process.on('uncaughtException', (err) => {
  // portable exe 종료 시 임시 폴더 정리로 ENOENT 발생 → 무시
  if (err && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT' && err.message?.includes('package.json')) return
  logCrash('uncaughtException', err)
})
process.on('unhandledRejection', (err) => { logCrash('unhandledRejection', err); })

/* ─────────────────────────── 설정 관리 ──────────────────────────── */

interface AppConfig {
  dataPath: string
  darkMode: 'system' | 'light' | 'dark'
  windowBounds?: { x: number; y: number; width: number; height: number }
  autoLaunch?: boolean
  autoBackup?: boolean
  backupPath?: string
  backupIntervalMin?: number
  backupKeepCount?: number
  calendarWidth?: number
  lastSyncAt?: number
  authToken?: string
  authRefreshToken?: string
  authUser?: { id: string; email: string }
  savedEmail?: string
  savedPasswordEnc?: string
  onedriveSyncPath?: string
  onedriveSyncEnabled?: boolean
  closeToTray?: boolean
  autoLogin?: boolean
  localAccounts?: Array<{ id: string; email: string; passwordEnc: string }>
  lockPin?: string    // PIN 해시 (SHA-256)
  [key: string]: unknown
}

// Portable exe 실행 시: exe 옆 폴더에 설정 저장
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  ? join(process.env.PORTABLE_EXECUTABLE_DIR, 'WitionData')
  : null

function getConfigBase(): string {
  if (PORTABLE_DIR) return PORTABLE_DIR
  try {
    return app.getPath('userData')
  } catch {
    return join(process.env.APPDATA || process.env.HOME || '.', 'Wition')
  }
}
const CONFIG_BASE = getConfigBase()
if (PORTABLE_DIR && !existsSync(CONFIG_BASE)) mkdirSync(CONFIG_BASE, { recursive: true })
const CONFIG_FILE = join(CONFIG_BASE, 'config.json')

function getDefaultDataPath(): string {
  return join(CONFIG_BASE, 'data')
}

function loadConfig(): AppConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return { dataPath: getDefaultDataPath(), darkMode: 'system', ...JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) }
    }
  } catch { /* 파싱 실패 시 기본값 */ }
  return { dataPath: getDefaultDataPath(), darkMode: 'system' }
}

function saveConfig(cfg: AppConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
}

let config = loadConfig()

/* ───────────── DB 경로 마이그레이션 (OneDrive → AppData) ──────────── */

function migrateDataPath(): void {
  const newDefault = getDefaultDataPath()
  const oldPath = config.dataPath

  if (oldPath === newDefault) return

  const oldDb = join(oldPath, 'wition.db')
  const newDb = join(newDefault, 'wition.db')

  if (existsSync(newDb)) {
    config.dataPath = newDefault
    saveConfig(config)
    console.log(`[migrate] 새 경로에 DB 존재 — dataPath 업데이트: ${newDefault}`)
    return
  }

  if (!existsSync(oldDb)) {
    config.dataPath = newDefault
    saveConfig(config)
    console.log(`[migrate] 이전 DB 없음 — 새 경로 사용: ${newDefault}`)
    return
  }

  try {
    if (!existsSync(newDefault)) mkdirSync(newDefault, { recursive: true })

    const tempDb = new Database(oldDb)
    tempDb.pragma('wal_checkpoint(TRUNCATE)')
    tempDb.close()

    copyFileSync(oldDb, newDb)
    console.log(`[migrate] DB 복사 완료: ${oldDb} → ${newDb}`)

    const oldAttach = join(oldPath, 'attachments')
    const newAttach = join(newDefault, 'attachments')
    if (existsSync(oldAttach)) {
      if (!existsSync(newAttach)) mkdirSync(newAttach, { recursive: true })
      for (const f of readdirSync(oldAttach)) {
        const src = join(oldAttach, f)
        const dst = join(newAttach, f)
        if (!existsSync(dst) && statSync(src).isFile()) {
          copyFileSync(src, dst)
        }
      }
      console.log(`[migrate] 첨부파일 복사 완료`)
    }

    config.dataPath = newDefault
    saveConfig(config)
    console.log(`[migrate] 마이그레이션 완료 — 새 dataPath: ${newDefault}`)
  } catch (err) {
    console.error(`[migrate] 마이그레이션 실패 — 기존 경로 유지:`, err)
  }
}

migrateDataPath()

/* ─────────────────────────── DB 초기화 ──────────────────────────── */

let db: Database.Database

const syncLogPath = join(CONFIG_BASE, 'sync.log')
const syncLog = (msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  console.log(msg)
  try { writeFileSync(syncLogPath, line, { flag: 'a' }) } catch {}
}

function ensureDataDir(): void {
  if (!existsSync(config.dataPath)) {
    mkdirSync(config.dataPath, { recursive: true })
  }
  const attachDir = join(config.dataPath, 'attachments')
  if (!existsSync(attachDir)) {
    mkdirSync(attachDir, { recursive: true })
  }
}

/** 사용자별 DB 파일명 반환 */
function getDbFileName(userId?: string): string {
  if (userId) return `wition_${userId.substring(0, 8)}.db`
  return 'wition.db'
}

/** 기존 wition.db → 사용자별 DB로 마이그레이션 (최초 1회) */
function migrateToUserDb(userId: string): void {
  const oldPath = join(config.dataPath, 'wition.db')
  const newPath = join(config.dataPath, getDbFileName(userId))
  if (!existsSync(oldPath) || existsSync(newPath)) return
  try {
    const tempDb = new Database(oldPath)
    tempDb.pragma('wal_checkpoint(TRUNCATE)')
    tempDb.close()
    copyFileSync(oldPath, newPath)
    for (const ext of ['-wal', '-shm']) {
      const f = oldPath + ext
      if (existsSync(f)) try { unlinkSync(f) } catch {}
    }
    console.log(`[migrate-user-db] wition.db → ${getDbFileName(userId)}`)
  } catch (err) {
    console.error('[migrate-user-db] 실패:', err)
  }
}

function openDatabase(userId?: string): Database.Database {
  ensureDataDir()
  const dbPath = join(config.dataPath, getDbFileName(userId))
  const database = new Database(dbPath)
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')
  initializeSchema(database)
  console.log(`[DB] opened: ${dbPath}`)
  return database
}

/* ────────────────── DB 소유자 (owner_id) ───────────────────── */

function getDbOwnerId(database: Database.Database): string | null {
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key = 'owner_id'").get() as { value: string } | undefined
    return row?.value ?? null
  } catch { return null }
}

function setDbOwnerId(database: Database.Database, userId: string): void {
  try {
    database.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('owner_id', ?)").run(userId)
  } catch (e) { console.error('[owner_id] 저장 실패:', e) }
}

/* ─────────────────── 오프라인 로그인용 로컬 계정 관리 ─────────────────── */

function saveLocalAccount(userId: string, email: string, password: string): void {
  if (!config.localAccounts) config.localAccounts = []
  let passwordEnc: string
  if (safeStorage.isEncryptionAvailable()) {
    passwordEnc = safeStorage.encryptString(password).toString('base64')
  } else {
    passwordEnc = Buffer.from(password).toString('base64')
  }
  const idx = config.localAccounts.findIndex(a => a.id === userId)
  if (idx >= 0) {
    config.localAccounts[idx] = { id: userId, email, passwordEnc }
  } else {
    config.localAccounts.push({ id: userId, email, passwordEnc })
  }
  saveConfig(config)
}

function verifyLocalPassword(account: { passwordEnc: string }, password: string): boolean {
  try {
    let stored: string
    if (safeStorage.isEncryptionAvailable()) {
      stored = safeStorage.decryptString(Buffer.from(account.passwordEnc, 'base64'))
    } else {
      stored = Buffer.from(account.passwordEnc, 'base64').toString()
    }
    return stored === password
  } catch { return false }
}

/* ─────────────────────── 타이머 변수 ──────────────────────────── */

let quickPullInterval: ReturnType<typeof setInterval> | null = null
let fullSyncInterval: ReturnType<typeof setInterval> | null = null
let healthCheckInterval: ReturnType<typeof setInterval> | null = null
let testHttpServer: ReturnType<typeof createServer> | null = null

/* ── sync:done debounce (150ms 내 중복 방지) ── */
let syncDoneTimer: ReturnType<typeof setTimeout> | null = null
function sendSyncDone(): void {
  if (syncDoneTimer) clearTimeout(syncDoneTimer)
  syncDoneTimer = setTimeout(() => {
    syncDoneTimer = null
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) {
        w.webContents.send('sync:done')
        w.webContents.executeJavaScript(`
          (() => {
            const e = new Event('sync-refresh');
            window.dispatchEvent(e);
          })()
        `).catch(() => {})
      }
    })
    updateTrayMenu()
  }, 150)
}

/* ─────────────────────── 시스템 트레이 ──────────────────────────── */

let tray: Tray | null = null
let isQuitting = false

function getIconPath(): string {
  const { existsSync } = require('fs')
  const candidates = [
    join(process.resourcesPath, 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(__dirname, '../build/icon.ico'),
    join(__dirname, '../../build/icon.ico'),
    join(__dirname, '../../resources/resources/icon.ico'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return app.getPath('exe')
}

function buildTrayMenu() {
  const menuItems: Array<{ label?: string; type?: 'separator' | 'normal'; click?: () => void; enabled?: boolean }> = [
    {
      label: '열기',
      click: () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) { win.show(); win.focus() }
      }
    },
    { type: 'separator' },
  ]

  // 오늘 메모 요약 (최대 5개)
  try {
    if (db) {
      const todayStr = new Date().toISOString().slice(0, 10)
      const items = Q.getNoteItems(db, todayStr)
      if (items.length > 0) {
        const displayItems = items.slice(0, 5)
        for (const item of displayItems) {
          let label = ''
          if (item.type === 'checklist') {
            try {
              const entries = JSON.parse(item.content) as Array<{ text: string; done: boolean }>
              const done = entries.filter(e => e.done).length
              label = `☑ ${done}/${entries.length} ${entries[0]?.text || '체크리스트'}`
            } catch { label = '☑ 체크리스트' }
          } else if (item.type === 'image') {
            label = '🖼 이미지'
          } else if (item.type === 'divider') {
            label = '── 구분선 ──'
          } else {
            label = item.content.replace(/\n/g, ' ').slice(0, 40)
            if (item.content.length > 40) label += '…'
          }
          menuItems.push({ label, enabled: false })
        }
        if (items.length > 5) {
          menuItems.push({ label: `… 외 ${items.length - 5}개`, enabled: false })
        }
        menuItems.push({ type: 'separator' })
      } else {
        menuItems.push({ label: '오늘 메모 없음', enabled: false })
        menuItems.push({ type: 'separator' })
      }
    }
  } catch (err) {
    console.error('[Tray] 메모 요약 로드 실패:', err)
  }

  menuItems.push({
    label: '종료',
    click: () => {
      isQuitting = true
      app.quit()
    }
  })

  return menuItems
}

function updateTrayMenu(): void {
  if (!tray) return
  try {
    const contextMenu = Menu.buildFromTemplate(buildTrayMenu() as any)
    tray.setContextMenu(contextMenu)
  } catch (err) {
    console.error('[Tray] 메뉴 갱신 실패:', err)
  }
}

function createTray(): void {
  try {
    const iconPath = getIconPath()
    console.log('[Tray] 아이콘 경로:', iconPath, '존재:', existsSync(iconPath))
    const icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      console.error('[Tray] 아이콘 로드 실패 — 빈 이미지')
    }
    const trayIcon = icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 })
    tray = new Tray(trayIcon)
    tray.setToolTip('Wition')

    const contextMenu = Menu.buildFromTemplate(buildTrayMenu() as any)
    tray.setContextMenu(contextMenu)

    const restoreWindow = () => {
      const win = BrowserWindow.getAllWindows()[0]
      console.log('[Tray] restoreWindow called, win exists:', !!win)
      if (win) {
        console.log('[Tray] isVisible:', win.isVisible(), 'isMinimized:', win.isMinimized(), 'isDestroyed:', win.isDestroyed())
        win.show()
        win.restore()
        win.setAlwaysOnTop(true)
        win.focus()
        win.setAlwaysOnTop(false)
        console.log('[Tray] after restore — isVisible:', win.isVisible())
      } else {
        console.log('[Tray] no window found, recreating')
        createWindow()
      }
    }
    tray.on('click', restoreWindow)
    tray.on('double-click', restoreWindow)
  } catch (err) {
    console.error('Tray creation failed:', err)
  }
}

/* ─────────────────────────── 윈도우 ─────────────────────────────── */

function createWindow(): BrowserWindow {
  const darkPref = config.darkMode
  const isDark = darkPref === 'system' ? nativeTheme.shouldUseDarkColors : darkPref === 'dark'

  const defaultBounds = { width: 1060, height: 720 }
  let bounds = config.windowBounds ?? defaultBounds

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize
  const { x: screenX, y: screenY } = primaryDisplay.workArea
  if (
    bounds.x !== undefined && bounds.y !== undefined && (
      bounds.x + (bounds.width ?? 1060) < screenX ||
      bounds.y + (bounds.height ?? 720) < screenY ||
      bounds.x > screenX + screenW ||
      bounds.y > screenY + screenH
    )
  ) {
    bounds = { width: bounds.width ?? defaultBounds.width, height: bounds.height ?? defaultBounds.height }
  }

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: isDark ? '#111827' : '#ffffff',
    frame: false,
    show: false,
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.on('close', (e) => {
    console.log('[Window] close event — isQuitting:', isQuitting, 'closeToTray:', config.closeToTray)
    if (!isQuitting && config.closeToTray) {
      e.preventDefault()
      win.hide()
      console.log('[Window] hidden to tray — isVisible:', win.isVisible(), 'isDestroyed:', win.isDestroyed())
    }
  })

  const saveWindowBounds = () => {
    if (!win.isMinimized() && !win.isMaximized()) {
      config.windowBounds = win.getBounds()
      saveConfig(config)
    }
  }
  win.on('resized', saveWindowBounds)
  win.on('moved', saveWindowBounds)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173/src/')
  } else {
    win.loadFile(join(__dirname, '../../out/index.html'))
  }

  return win
}

/* ──────────────────────── IPC 핸들러 등록 ────────────────────────── */

function registerIpcHandlers(): void {
  // ── 공통 deps ──
  const getDb = () => db
  const setDb = (newDb: Database.Database) => { db = newDb }

  // ── 모듈별 IPC 핸들러 등록 ──
  const AUTH_URLS = [
    process.env.VITE_SUPABASE_URL,
    'http://localhost:8000',
    'http://100.122.232.19:8000',
    'http://192.168.45.152:8000',
  ].filter((v, i, a) => v && a.indexOf(v) === i) as string[]
  const AUTH_KEY = process.env.VITE_SUPABASE_ANON_KEY || ''

  registerAuthHandlers({
    getDb, setDb, config, saveConfig, openDatabase,
    migrateToUserDb, setDbOwnerId, saveLocalAccount, verifyLocalPassword,
    AUTH_URLS, AUTH_KEY
  })

  registerAlarmHandlers({
    getDb, config, saveConfig, getIconPath, scheduleOneDriveExport
  })

  registerBackupHandlers({
    getDb, config, saveConfig
  })

  registerSyncHandlers({
    getDb, config, saveConfig, sendSyncDone
  })

  registerOnedriveHandlers({
    getDb, config, saveConfig, getDbFileName, getDbOwnerId
  })

  // ── DB 읽기 ──
  ipcMain.handle('db:getNoteDays', (_e, yearMonth: string) => {
    try { return Q.getNoteDaysByMonth(db, yearMonth) }
    catch (err) { console.error('getNoteDays error:', err); return [] }
  })

  ipcMain.handle('db:getNoteDay', (_e, date: string) => {
    try { return Q.getNoteDay(db, date) ?? null }
    catch (err) { console.error('getNoteDay error:', err); return null }
  })

  // 디버그: preload 로드 확인
  ipcMain.on('debug:preloadLoaded', () => {
  })

  ipcMain.handle('db:getNoteItems', (_e, dayId: string) => {
    try {
      const items = Q.getNoteItems(db, dayId)
      syncLog(`[IPC] getNoteItems(${dayId}) → ${items.length}개`)
      return items
    }
    catch (err) { console.error('getNoteItems error:', err); return [] }
  })

  ipcMain.handle('db:search', (_e, query: string) => {
    try { return Q.searchItems(db, query) }
    catch (err) { console.error('search error:', err); return [] }
  })

  // DB 쓰기 (로컬 즉시 + Supabase 백그라운드 동기화)
  ipcMain.handle('db:upsertNoteItem', (_e, item: Q.NoteItemRow) => {
    try {
      const day = Q.upsertNoteItem(db, item) ?? null
      const savedItem = db.prepare('SELECT * FROM note_item WHERE id = ?').get(item.id) as Q.NoteItemRow
      if (savedItem) Sync.syncNoteItem(savedItem)
      if (day) Sync.syncNoteDay(day)
      scheduleOneDriveExport()
      return day
    }
    catch (err) { console.error('upsertNoteItem error:', err); return null }
  })

  ipcMain.handle('db:deleteNoteItem', (_e, id: string, dayId: string) => {
    try {
      const day = Q.deleteNoteItem(db, id, dayId) ?? null
      Sync.syncDeleteNoteItem(id)
      if (day) Sync.syncNoteDay(day)
      scheduleOneDriveExport()
      return day
    }
    catch (err) { console.error('deleteNoteItem error:', err); return null }
  })

  ipcMain.handle('db:deleteAllItemsByDay', (_e, dayId: string) => {
    try {
      const deleted = Q.deleteAllItemsByDay(db, dayId)
      Sync.syncDeleteAllByDay(dayId)
      scheduleOneDriveExport()
      return deleted
    }
    catch (err) { console.error('deleteAllItemsByDay error:', err); return 0 }
  })

  ipcMain.handle('db:reorderNoteItems', (_e, dayId: string, orderedIds: string[]) => {
    try {
      Q.reorderNoteItems(db, dayId, orderedIds)
      const items = Q.getNoteItems(db, dayId)
      items.forEach(item => Sync.syncNoteItem(item))
      scheduleOneDriveExport()
    }
    catch (err) { console.error('reorderNoteItems error:', err) }
  })

  ipcMain.handle('db:updateMood', (_e, dayId: string, mood: string | null) => {
    try {
      Q.updateMood(db, dayId, mood)
      const day = Q.getNoteDay(db, dayId)
      if (day) Sync.syncNoteDay(day)
      scheduleOneDriveExport()
    }
    catch (err) { console.error('updateMood error:', err) }
  })

  // 다크모드
  ipcMain.handle('app:isDarkMode', () => {
    if (config.darkMode === 'system') return nativeTheme.shouldUseDarkColors
    return config.darkMode === 'dark'
  })

  ipcMain.handle('app:setDarkMode', (_e, mode: 'system' | 'light' | 'dark') => {
    config.darkMode = mode
    saveConfig(config)
    if (mode === 'system') return nativeTheme.shouldUseDarkColors
    return mode === 'dark'
  })

  // 자동실행
  ipcMain.handle('app:getAutoLaunch', () => {
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('app:setAutoLaunch', (_e, enabled: boolean) => {
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe')
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: exePath
    })
    config.autoLaunch = enabled
    saveConfig(config)
  })

  ipcMain.handle('app:getCloseToTray', () => {
    return config.closeToTray ?? false
  })

  ipcMain.handle('app:setCloseToTray', (_e, enabled: boolean) => {
    config.closeToTray = enabled
    saveConfig(config)
  })

  // ── 설정: 저장 경로 ──
  ipcMain.handle('app:getDataPath', () => config.dataPath)

  ipcMain.handle('app:changeDataPath', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: '데이터 저장 경로 선택',
      defaultPath: config.dataPath,
      properties: ['openDirectory', 'createDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) return null

    const newPath = result.filePaths[0]
    db.close()
    config.dataPath = newPath
    saveConfig(config)
    db = openDatabase(config.authUser?.id)
    return newPath
  })

  ipcMain.handle('app:openDataFolder', () => {
    shell.openPath(config.dataPath)
  })

  // ── 데이터 내보내기/가져오기 ──
  ipcMain.handle('app:exportData', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null

    const result = await dialog.showSaveDialog(win, {
      title: '데이터 내보내기',
      defaultPath: `wition-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })

    if (result.canceled || !result.filePath) return null

    try {
      const days = db.prepare('SELECT * FROM note_day').all()
      const items = db.prepare('SELECT * FROM note_item ORDER BY day_id, order_index').all()
      const exportData = { version: 1, exportedAt: new Date().toISOString(), days, items }
      writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
      return result.filePath
    } catch (err) {
      console.error('export error:', err)
      return null
    }
  })

  ipcMain.handle('app:importData', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false

    const result = await dialog.showOpenDialog(win, {
      title: '데이터 가져오기',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) return false

    try {
      const raw = readFileSync(result.filePaths[0], 'utf-8')
      const data = JSON.parse(raw) as {
        version: number
        days: Q.NoteDayRow[]
        items: Q.NoteItemRow[]
      }

      if (!data.days || !data.items) return false

      const confirmResult = dialog.showMessageBoxSync(win, {
        type: 'question',
        title: '데이터 가져오기',
        message: `${data.days.length}일, ${data.items.length}개 메모를 가져옵니다.\n기존 데이터와 병합됩니다.`,
        buttons: ['가져오기', '취소'],
        defaultId: 0
      })

      if (confirmResult === 1) return false

      const importRun = db.transaction(() => {
        for (const day of data.days) {
          db.prepare(`
            INSERT INTO note_day (id, mood, summary, note_count, has_notes, updated_at)
            VALUES (@id, @mood, @summary, @note_count, @has_notes, @updated_at)
            ON CONFLICT(id) DO UPDATE SET
              mood=COALESCE(@mood, mood), summary=@summary,
              note_count=@note_count, has_notes=@has_notes, updated_at=@updated_at
          `).run(day)
        }
        for (const item of data.items) {
          db.prepare(`
            INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
            VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)
            ON CONFLICT(id) DO UPDATE SET
              content=@content, tags=@tags, pinned=@pinned, order_index=@order_index, updated_at=@updated_at
          `).run(item)
        }
      })
      importRun()
      return true
    } catch (err) {
      console.error('import error:', err)
      dialog.showMessageBoxSync(win, {
        type: 'error',
        title: '가져오기 실패',
        message: '파일 형식이 올바르지 않습니다.'
      })
      return false
    }
  })

  // ── 파일 첨부 ──
  ipcMain.handle('app:attachFile', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: '파일 첨부',
      properties: ['openFile', 'multiSelections']
    })

    if (result.canceled || result.filePaths.length === 0) return null

    const attachDir = join(config.dataPath, 'attachments')
    if (!existsSync(attachDir)) mkdirSync(attachDir, { recursive: true })

    const attached: { name: string; path: string; size: number }[] = []
    for (const srcPath of result.filePaths) {
      const name = basename(srcPath)
      const ts = Date.now()
      const ext = extname(name)
      const base = basename(name, ext)
      const destName = `${ts}_${base}${ext}`
      const destPath = join(attachDir, destName)
      try {
        copyFileSync(srcPath, destPath)
        const stat = statSync(destPath)
        attached.push({ name, path: destName, size: stat.size })
        Sync.syncAttachmentFile(attachDir, destName)
      } catch (err) {
        console.error('attachFile copy error:', err)
      }
    }
    return attached
  })

  ipcMain.handle('app:openAttachment', async (_e, fileName: string) => {
    let filePath = resolve(join(config.dataPath, 'attachments', fileName))

    if (!existsSync(filePath) && existsSync(fileName)) {
      filePath = resolve(fileName)
    }

    if (!existsSync(filePath)) {
      console.error('[openAttachment] 파일 없음:', filePath)
      dialog.showMessageBox({
        type: 'error',
        title: '파일 열기 실패',
        message: `파일을 찾을 수 없습니다:\n${filePath}`
      })
      return false
    }

    try {
      await shell.openExternal(pathToFileURL(filePath).href)
      return true
    } catch (err) {
      console.error('[openAttachment] 열기 실패:', err)
      const errMsg = await shell.openPath(filePath)
      if (errMsg) {
        console.error('[openAttachment] openPath도 실패:', errMsg)
        return false
      }
      return true
    }
  })

  // ── 클립보드 이미지 저장 ──
  ipcMain.handle('app:saveClipboardImage', (_e, base64: string) => {
    try {
      const attachDir = join(config.dataPath, 'attachments')
      if (!existsSync(attachDir)) mkdirSync(attachDir, { recursive: true })

      const ts = Date.now()
      const fileName = `${ts}_screenshot.png`
      const filePath = join(attachDir, fileName)

      const buffer = Buffer.from(base64, 'base64')
      writeFileSync(filePath, buffer)
      const size = statSync(filePath).size

      Sync.syncAttachmentFile(attachDir, fileName)
      return { name: 'screenshot.png', path: fileName, size }
    } catch (err) {
      console.error('saveClipboardImage error:', err)
      return null
    }
  })

  // ── 달력 패널 너비 영속화 ──
  ipcMain.handle('app:getCalendarWidth', () => config.calendarWidth ?? 420)
  ipcMain.handle('app:setCalendarWidth', (_e, width: number) => {
    config.calendarWidth = width
    saveConfig(config)
  })

  // ── 마크다운 내보내기 ──
  ipcMain.handle('app:exportMarkdown', async (e, dayId?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    const items = dayId ? Q.getNoteItems(db, dayId) : Q.getAllNoteItems(db)
    if (items.length === 0) return null

    const md = items.map(item => {
      switch (item.type) {
        case 'heading1': return `# ${item.content}`
        case 'heading2': return `## ${item.content}`
        case 'heading3': return `### ${item.content}`
        case 'bulleted_list': return `- ${item.content}`
        case 'numbered_list': return `1. ${item.content}`
        case 'quote': return `> ${item.content}`
        case 'divider': return '---'
        case 'code': {
          try {
            const d = JSON.parse(item.content)
            return '```' + (d.language || '') + '\n' + (d.code || '') + '\n```'
          } catch { return '```\n' + item.content + '\n```' }
        }
        case 'checklist': {
          try {
            const entries = JSON.parse(item.content) as Array<{ text: string; done: boolean }>
            return entries.map(e => `- [${e.done ? 'x' : ' '}] ${e.text}`).join('\n')
          } catch { return item.content }
        }
        default: return item.content
      }
    }).join('\n\n')

    const defaultName = dayId ? `wition-${dayId}.md` : `wition-all-${new Date().toISOString().slice(0, 10)}.md`
    const result = await dialog.showSaveDialog(win, {
      title: '마크다운 내보내기',
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, md, 'utf-8')
    return result.filePath
  })

  // ── 토글 블록 상태 ──
  ipcMain.handle('db:getToggleStates', () => {
    try { return Q.getToggleStates(db) }
    catch { return {} }
  })
  ipcMain.handle('db:setToggleState', (_e, blockId: string, open: boolean) => {
    try { Q.setToggleState(db, blockId, open) }
    catch (err) { console.error('setToggleState error:', err) }
  })

  // ── 태그 필터 ──
  ipcMain.handle('db:getNoteDaysWithTag', (_e, yearMonth: string, tag: string) => {
    try { return Q.getNoteDaysByMonthWithTag(db, yearMonth, tag) }
    catch (err) { console.error('getNoteDaysWithTag error:', err); return [] }
  })

  // ── 템플릿 CRUD ──
  ipcMain.handle('db:getTemplates', () => {
    try { return Q.getTemplates(db) }
    catch (err) { console.error('getTemplates error:', err); return [] }
  })

  ipcMain.handle('db:upsertTemplate', (_e, template: { id: string; name: string; blocks: string; created_at: number }) => {
    try { Q.upsertTemplate(db, template); return true }
    catch (err) { console.error('upsertTemplate error:', err); return false }
  })

  ipcMain.handle('db:deleteTemplate', (_e, id: string) => {
    try { Q.deleteTemplate(db, id); return true }
    catch (err) { console.error('deleteTemplate error:', err); return false }
  })

  ipcMain.handle('db:applyTemplate', (_e, templateId: string, dayId: string) => {
    try {
      const template = Q.getTemplateById(db, templateId)
      if (!template) return { ok: false, error: '템플릿을 찾을 수 없습니다.' }
      const blocks = JSON.parse(template.blocks) as Array<{ type: string; content: string }>
      const existingItems = Q.getNoteItems(db, dayId)
      const now = Date.now()
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]
        const item: Q.NoteItemRow = {
          id: crypto.randomUUID(),
          day_id: dayId,
          type: block.type,
          content: block.content,
          tags: '[]',
          pinned: 0,
          order_index: existingItems.length + i,
          created_at: now,
          updated_at: now,
        }
        Q.upsertNoteItem(db, item)
        const saved = db.prepare('SELECT * FROM note_item WHERE id = ?').get(item.id) as Q.NoteItemRow
        if (saved) Sync.syncNoteItem(saved)
      }
      const day = Q.getNoteDay(db, dayId)
      if (day) Sync.syncNoteDay(day)
      scheduleOneDriveExport()
      return { ok: true }
    } catch (err) {
      console.error('applyTemplate error:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── PIN 잠금 ──
  ipcMain.handle('app:getPinEnabled', () => {
    return !!config.lockPin
  })

  ipcMain.handle('app:setPin', (_e, pin: string | null) => {
    if (pin === null) {
      config.lockPin = undefined
    } else {
      config.lockPin = createHash('sha256').update(pin).digest('hex')
    }
    saveConfig(config)
    return { ok: true }
  })

  ipcMain.handle('app:verifyPin', (_e, pin: string) => {
    if (!config.lockPin) return { ok: true }
    const hash = createHash('sha256').update(pin).digest('hex')
    return { ok: hash === config.lockPin }
  })

  // ── 통계 ──
  ipcMain.handle('db:getMonthlyStats', (_e, yearMonth: string) => {
    try { return Q.getMonthlyStats(db, yearMonth) }
    catch (err) { console.error('getMonthlyStats error:', err); return [] }
  })

  ipcMain.handle('db:getMoodStats', (_e, yearMonth: string) => {
    try { return Q.getMoodStats(db, yearMonth) }
    catch (err) { console.error('getMoodStats error:', err); return [] }
  })

  ipcMain.handle('db:getTagStats', () => {
    try { return Q.getTagStats(db) }
    catch (err) { console.error('getTagStats error:', err); return [] }
  })

  // ── 반복 메모 ──
  ipcMain.handle('db:getRecurringBlocks', () => {
    try { return Q.getRecurringBlocks(db) }
    catch (err) { console.error('getRecurringBlocks error:', err); return [] }
  })

  ipcMain.handle('db:upsertRecurringBlock', (_e, block: Q.RecurringBlockRow) => {
    try { Q.upsertRecurringBlock(db, block); return true }
    catch (err) { console.error('upsertRecurringBlock error:', err); return false }
  })

  ipcMain.handle('db:deleteRecurringBlock', (_e, id: string) => {
    try { Q.deleteRecurringBlock(db, id); return true }
    catch (err) { console.error('deleteRecurringBlock error:', err); return false }
  })

  // ── 메모 암호화/복호화 ──
  ipcMain.handle('db:encryptBlock', (_e, id: string, password: string) => {
    try {
      const item = db.prepare('SELECT * FROM note_item WHERE id = ?').get(id) as Q.NoteItemRow | undefined
      if (!item) return false

      const { createCipheriv, randomBytes, createHash: cHash } = require('crypto')
      const key = cHash('sha256').update(password).digest()
      const iv = randomBytes(16)
      const cipher = createCipheriv('aes-256-cbc', key, iv)
      let encrypted = cipher.update(item.content, 'utf8', 'hex')
      encrypted += cipher.final('hex')
      const encryptedContent = iv.toString('hex') + ':' + encrypted

      db.prepare('UPDATE note_item SET content = ?, encrypted = 1, updated_at = ? WHERE id = ?')
        .run(encryptedContent, Date.now(), id)

      const saved = db.prepare('SELECT * FROM note_item WHERE id = ?').get(id) as Q.NoteItemRow
      if (saved) Sync.syncNoteItem(saved)
      return true
    } catch (err) {
      console.error('encryptBlock error:', err)
      return false
    }
  })

  ipcMain.handle('db:decryptBlock', (_e, id: string, password: string) => {
    try {
      const item = db.prepare('SELECT * FROM note_item WHERE id = ?').get(id) as Q.NoteItemRow | undefined
      if (!item) return null

      const { createDecipheriv, createHash: cHash } = require('crypto')
      const key = cHash('sha256').update(password).digest()
      const [ivHex, encryptedHex] = item.content.split(':')
      if (!ivHex || !encryptedHex) return null

      const iv = Buffer.from(ivHex, 'hex')
      const decipher = createDecipheriv('aes-256-cbc', key, iv)
      let decrypted = decipher.update(encryptedHex, 'hex', 'utf8')
      decrypted += decipher.final('utf8')

      // 복호화 성공 → 원본 복원 + encrypted=0
      db.prepare('UPDATE note_item SET content = ?, encrypted = 0, updated_at = ? WHERE id = ?')
        .run(decrypted, Date.now(), id)

      const saved = db.prepare('SELECT * FROM note_item WHERE id = ?').get(id) as Q.NoteItemRow
      if (saved) Sync.syncNoteItem(saved)
      return decrypted
    } catch (err) {
      console.error('decryptBlock error:', err)
      return null
    }
  })

  // 윈도우 컨트롤 (frameless 타이틀바)
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    w?.isMaximized() ? w.unmaximize() : w?.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
}

/* ──────────────────────────── 앱 시작 ────────────────────────────── */

app.setAppUserModelId('com.wition.app')

/* ─────────────────── 중복 실행 방지 (Single Instance) ────────────────── */

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  try { appendFileSync(crashLogPath, `[${new Date().toISOString()}] SingleInstanceLock 실패 — 다른 인스턴스 실행 중. 종료합니다.\n`) } catch {}
  app.quit()
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

app.whenReady().then(() => {
  const userId = config.authUser?.id
  if (userId) migrateToUserDb(userId)
  db = openDatabase(userId)
  if (userId) setDbOwnerId(db, userId)
  Q.refreshAllSummaries(db)

  // 반복 메모 자동 생성
  try {
    const todayStr = new Date().toISOString().slice(0, 10)
    const created = Q.checkRecurringBlocks(db, todayStr)
    if (created > 0) console.log(`[Recurring] 오늘 ${created}개 반복 메모 생성`)
  } catch (err) {
    console.error('[Recurring] 반복 메모 생성 실패:', err)
  }

  registerIpcHandlers()    // deps 초기화 (모든 IPC 모듈 등록)
  oneDrivePullIfNewer()    // deps 초기화 이후에 호출
  startAutoBackup()
  startOneDriveSync()
  startAlarmChecker()
  createTray()
  createWindow()

  // ── 하이브리드 동기화 (Supabase + OneDrive) ──
  Sync.setLogFn(syncLog)
  const HEALTH_CHECK_MS = 60 * 1000
  let wasReachable = false

  /** 동기화 실행 + UI 알림 */
  async function runSync() {
    if (!Sync.isOnline() || !db) return
    const reachable = await Sync.checkConnection()
    broadcastSyncStatus(reachable ? 'syncing' : 'offline')
    if (!reachable) {
      syncLog('서버 연결 불가 — OneDrive 모드')
      return
    }
    try {
      const { pulled, pushed, cleaned, syncedAt, authFailed } = await Sync.fullSync(db!, config.lastSyncAt)

      if (authFailed) {
        syncLog('인증 실패 → 자동 재로그인 시도')
        const ok = await autoReLogin({
          getDb: () => db, setDb: (d) => { db = d }, config, saveConfig, openDatabase,
          migrateToUserDb, setDbOwnerId, saveLocalAccount, verifyLocalPassword,
          AUTH_URLS: [process.env.VITE_SUPABASE_URL, 'http://localhost:8000', 'http://100.122.232.19:8000', 'http://192.168.45.152:8000'].filter((v, i, a) => v && a.indexOf(v) === i) as string[],
          AUTH_KEY: process.env.VITE_SUPABASE_ANON_KEY || '',
        })
        if (ok) {
          syncLog('재로그인 성공 → fullSync 재시도')
          const retry = await Sync.fullSync(db!, config.lastSyncAt)
          if (retry.syncedAt > 0) {
            config.lastSyncAt = retry.syncedAt
            saveConfig(config)
          }
          if (retry.pulled > 0 || retry.pushed > 0 || retry.cleaned > 0) {
            sendSyncDone()
          }
          broadcastSyncStatus('online')
          return
        } else {
          syncLog('자동 재로그인 실패 → UI에 로그인 필요 알림')
          broadcastSyncStatus('auth_required')
          return
        }
      }

      if (syncedAt > 0) {
        config.lastSyncAt = syncedAt
        saveConfig(config)
      }

      const attachDir = join(config.dataPath, 'attachments')
      const filePulled = await Sync.pullAttachmentFiles(attachDir)
      const filePushed = await Sync.pushAttachmentFiles(attachDir)

      if (pulled > 0 || pushed > 0 || filePulled > 0 || filePushed > 0) {
        syncLog(`fullSync: pulled=${pulled}, pushed=${pushed}, files: pulled=${filePulled}, pushed=${filePushed}`)
      }
      broadcastSyncStatus('online')
      if (pulled > 0 || pushed > 0 || cleaned > 0 || filePulled > 0) {
        sendSyncDone()
      }
    } catch (err) {
      syncLog(`fullSync 실패: ${err}`)
      broadcastSyncStatus('error')
    }
  }

  function broadcastSyncStatus(status: string) {
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('sync:status', status)
    )
  }

  // 앱 시작 시 저장된 인증 정보로 Sync 세션 복원
  if (config.authUser?.id) {
    Sync.setUserId(config.authUser.id)
    syncLog(`userId 복원: ${config.authUser.id}`)
  }
  Sync.initSync().then(async online => {
    syncLog(`initSync: online=${online}, db=${!!db}, lastSyncAt=${config.lastSyncAt}, userId=${Sync.getUserId()}`)

    if (online && config.authToken && config.authRefreshToken) {
      await Sync.setAuthSession(config.authToken, config.authRefreshToken)
      syncLog('Supabase 세션 복원 완료 (저장된 토큰)')
    }

    if (online && !Sync.getUserId() && config.savedEmail && config.savedPasswordEnc) {
      syncLog('토큰 없음 → 저장된 credentials로 자동 로그인 시도')
      const ok = await autoReLogin({
        getDb: () => db, setDb: (d) => { db = d }, config, saveConfig, openDatabase,
        migrateToUserDb, setDbOwnerId, saveLocalAccount, verifyLocalPassword,
        AUTH_URLS: [process.env.VITE_SUPABASE_URL, 'http://localhost:8000', 'http://100.122.232.19:8000', 'http://192.168.45.152:8000'].filter((v, i, a) => v && a.indexOf(v) === i) as string[],
        AUTH_KEY: process.env.VITE_SUPABASE_ANON_KEY || '',
      })
      if (ok) {
        syncLog(`자동 로그인 성공 — userId: ${Sync.getUserId()}`)
      } else {
        syncLog('자동 로그인 실패 → 수동 로그인 필요')
      }
    }

    if (Sync.isOnline() && db) {
      setTimeout(async () => {
        await runSync()
        const startRealtimeIfReady = () => {
          const uid = Sync.getUserId()
          if (uid && db) {
            syncLog(`[Realtime] userId=${uid} — 실시간 구독 시작`)
            Sync.startRealtime(db, () => {
              syncLog(`[Realtime] 변경 감지 → UI 갱신 (debounced sendSyncDone)`)
              sendSyncDone()
            })
          } else {
            syncLog(`[Realtime] userId 없음 — 1초 후 재시도`)
            setTimeout(startRealtimeIfReady, 1000)
          }
        }
        startRealtimeIfReady()
      }, 3000)

      quickPullInterval = setInterval(async () => {
        if (!db || !Sync.isOnline()) return
        try {
          const pulled = await Sync.quickPull(db)
          if (pulled > 0) {
            sendSyncDone()
          }
        } catch {}
      }, 3000)

      fullSyncInterval = setInterval(() => runSync(), 7000)

      healthCheckInterval = setInterval(async () => {
        const nowReachable = await Sync.checkConnection()
        broadcastSyncStatus(nowReachable ? 'online' : 'offline')
        if (nowReachable && !wasReachable) {
          syncLog('네트워크 복구 감지 → 즉시 동기화 + Realtime 재연결')
          runSync()
          Sync.reconnectRealtime()
        } else if (nowReachable && !Sync.isRealtimeConnected()) {
          syncLog('Realtime 끊김 감지 → 재연결')
          Sync.reconnectRealtime()
        }
        wasReachable = nowReachable
      }, HEALTH_CHECK_MS)
    } else {
      syncLog('Supabase 미설정 — OneDrive 전용 모드')
      broadcastSyncStatus('offline')
    }
  })

  // ── 테스트용 HTTP 서버 ──
  if (process.env.NODE_ENV !== 'production' || process.env.WITION_TEST_HTTP === '1') {
    const TEST_PORT = 19876
    testHttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Content-Type', 'application/json')
      const url = req.url || '/'

      try {
        if (url === '/sync' && req.method === 'POST') {
          if (!db) { res.end(JSON.stringify({ ok: false, reason: 'no db' })); return }
          for (let w = 0; w < 20 && Sync.isSyncing(); w++) {
            await new Promise(r => setTimeout(r, 500))
          }
          const { pulled, pushed, cleaned, syncedAt } = await Sync.fullSync(db!, config.lastSyncAt)
          if (syncedAt > 0) { config.lastSyncAt = syncedAt; saveConfig(config) }
          if (pulled > 0 || pushed > 0 || cleaned > 0) {
            sendSyncDone()
          }
          res.end(JSON.stringify({ ok: true, pulled, pushed, cleaned }))
        } else if (url.startsWith('/query') && req.method === 'GET') {
          const u = new URL(req.url!, `http://localhost:${TEST_PORT}`)
          const sql = u.searchParams.get('sql')
          if (!sql || !db) { res.end(JSON.stringify({ rows: [] })); return }
          const sqlFirst = sql.trim().split(/\s/)[0].toLowerCase()
          if (['drop', 'alter', 'create'].includes(sqlFirst)) {
            res.end(JSON.stringify({ error: 'forbidden' })); return
          }
          const sqlCmd = sql.trim().split(/\s/)[0].toLowerCase()
          const isMetaTable = /deleted_items|pending_sync|tombstone/i.test(sql)
          // 테스트 날짜(2027-/2098-) 포함 OR 테스트 아이템 ID 프리픽스가 WHERE에 있으면 허용
          const isTestData = /20(27|98)-/.test(sql) || /WHERE.*(?:id|day_id)\s*=\s*'(?:p2m|3ev|rt|udc|mob|ndd|mof|rdp|bulk|flk|conc|offl|strm|ndp|tmbs|lww|empt|odv|race|3way|qtest)-/i.test(sql)
          if ((sqlCmd === 'insert' || sqlCmd === 'update' || sqlCmd === 'delete') && !isMetaTable && !isTestData) {
            res.end(JSON.stringify({ error: `only test-date ${sqlCmd.toUpperCase()} allowed` })); return
          }
          if (sqlCmd === 'insert' || sqlCmd === 'update' || sqlCmd === 'delete') {
            const info = db.prepare(sql).run()
            res.end(JSON.stringify({ changes: info.changes }))
          } else {
            const rows = db.prepare(sql).all()
            res.end(JSON.stringify({ rows }))
          }
        } else if (url === '/ping') {
          res.end(JSON.stringify({ ok: true, time: Date.now() }))
        } else {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'not found' }))
        }
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
    testHttpServer.listen(TEST_PORT, '127.0.0.1', () => {
      syncLog(`[TestHTTP] 테스트 서버 시작: http://127.0.0.1:${TEST_PORT}`)
    })
    testHttpServer.on('error', (err) => {
      syncLog(`[TestHTTP] 서버 시작 실패: ${err.message}`)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})

process.on('SIGTERM', () => {
  db?.close()
})

app.on('before-quit', () => {
  isQuitting = true
  Sync.stopRealtime()
  try { runAutoBackup() } catch (e) { console.error('Exit backup failed:', e) }
  try { exportDbToOneDrive() } catch (e) { console.error('Exit OneDrive export failed:', e) }
  stopAutoBackup()
  stopOneDriveSync()
  stopAlarmChecker()
  if (quickPullInterval) { clearInterval(quickPullInterval); quickPullInterval = null }
  if (fullSyncInterval) { clearInterval(fullSyncInterval); fullSyncInterval = null }
  if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null }
  if (testHttpServer) { testHttpServer.close(); testHttpServer = null }
})

app.on('window-all-closed', () => {
  if (!isQuitting && config.closeToTray) return
  stopAutoBackup()
  db?.close()
  if (process.platform !== 'darwin') app.quit()
})
