import { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import Database from 'better-sqlite3'
import { initializeSchema } from './db/schema'
import * as Q from './db/queries'

/* ─────────────────────────── 설정 관리 ──────────────────────────── */

interface AppConfig {
  dataPath: string  // DB + 첨부파일 저장 경로
}

const CONFIG_FILE = join(app.getPath('userData'), 'config.json')

function getDefaultDataPath(): string {
  return join(app.getPath('documents'), 'Wition')
}

function loadConfig(): AppConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    }
  } catch { /* 파싱 실패 시 기본값 */ }
  return { dataPath: getDefaultDataPath() }
}

function saveConfig(config: AppConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

let config = loadConfig()

/* ─────────────────────────── DB 초기화 ──────────────────────────── */

let db: Database.Database

function ensureDataDir(): void {
  if (!existsSync(config.dataPath)) {
    mkdirSync(config.dataPath, { recursive: true })
  }
  // 첨부파일 폴더
  const attachDir = join(config.dataPath, 'attachments')
  if (!existsSync(attachDir)) {
    mkdirSync(attachDir, { recursive: true })
  }
}

function openDatabase(): Database.Database {
  ensureDataDir()
  const dbPath = join(config.dataPath, 'wition.db')
  const database = new Database(dbPath)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  initializeSchema(database)
  return database
}

/* ─────────────────────────── 윈도우 ─────────────────────────────── */

function createWindow(): BrowserWindow {
  const isDark = nativeTheme.shouldUseDarkColors

  const win = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: isDark ? '#111827' : '#ffffff',
    frame: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false // better-sqlite3이 네이티브 모듈이라 sandbox 불가
    }
  })

  // 로딩 완료 후 표시
  win.once('ready-to-show', () => win.show())

  // 외부 링크는 브라우저에서 열기
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Dev: HMR 서버, Prod: 빌드된 HTML
  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173/src/')
  } else {
    win.loadFile(join(__dirname, '../../out/index.html'))
  }

  return win
}

/* ──────────────────────── IPC 핸들러 등록 ────────────────────────── */

function registerIpcHandlers(): void {
  // DB 읽기
  ipcMain.handle('db:getNoteDays', (_e, yearMonth: string) => {
    try { return Q.getNoteDaysByMonth(db, yearMonth) }
    catch (err) { console.error('getNoteDays error:', err); return [] }
  })

  ipcMain.handle('db:getNoteDay', (_e, date: string) => {
    try { return Q.getNoteDay(db, date) ?? null }
    catch (err) { console.error('getNoteDay error:', err); return null }
  })

  ipcMain.handle('db:getNoteItems', (_e, dayId: string) => {
    try { return Q.getNoteItems(db, dayId) }
    catch (err) { console.error('getNoteItems error:', err); return [] }
  })

  ipcMain.handle('db:search', (_e, query: string) => {
    try { return Q.searchItems(db, query) }
    catch (err) { console.error('search error:', err); return [] }
  })

  // DB 쓰기
  ipcMain.handle('db:upsertNoteItem', (_e, item: Q.NoteItemRow) => {
    try { return Q.upsertNoteItem(db, item) ?? null }
    catch (err) { console.error('upsertNoteItem error:', err); return null }
  })

  ipcMain.handle('db:deleteNoteItem', (_e, id: string, dayId: string) => {
    try { return Q.deleteNoteItem(db, id, dayId) ?? null }
    catch (err) { console.error('deleteNoteItem error:', err); return null }
  })

  ipcMain.handle('db:reorderNoteItems', (_e, dayId: string, orderedIds: string[]) => {
    try { Q.reorderNoteItems(db, dayId, orderedIds) }
    catch (err) { console.error('reorderNoteItems error:', err) }
  })

  ipcMain.handle('db:updateMood', (_e, dayId: string, mood: string | null) => {
    try { Q.updateMood(db, dayId, mood) }
    catch (err) { console.error('updateMood error:', err) }
  })

  // 다크모드
  ipcMain.handle('app:isDarkMode', () => nativeTheme.shouldUseDarkColors)

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

    // DB 닫고 새 경로로 전환
    db.close()
    config.dataPath = newPath
    saveConfig(config)
    db = openDatabase()

    return newPath
  })

  ipcMain.handle('app:openDataFolder', () => {
    shell.openPath(config.dataPath)
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

app.whenReady().then(() => {
  db = openDatabase()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  db?.close()
  if (process.platform !== 'darwin') app.quit()
})
