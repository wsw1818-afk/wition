import { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog, Tray, Menu } from 'electron'
import { join, basename, extname } from 'path'
import { hostname } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, copyFileSync, statSync } from 'fs'
import Database from 'better-sqlite3'
import { initializeSchema } from './db/schema'
import * as Q from './db/queries'

/* ─────────────────────────── 설정 관리 ──────────────────────────── */

interface AppConfig {
  dataPath: string
  darkMode: 'system' | 'light' | 'dark'
  windowBounds?: { x: number; y: number; width: number; height: number }
  autoLaunch?: boolean
  autoBackup?: boolean           // 자동 백업 활성화 여부
  backupPath?: string            // 백업 저장 경로 (미지정 시 dataPath/backups/)
  backupIntervalMin?: number     // 백업 주기 (분, 기본 30)
  backupKeepCount?: number       // 보관 개수 (기본 10)
}

const CONFIG_FILE = join(app.getPath('userData'), 'config.json')

function getDefaultDataPath(): string {
  return join(app.getPath('documents'), 'Wition')
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

/* ─────────────────────────── DB 초기화 ──────────────────────────── */

let db: Database.Database

function ensureDataDir(): void {
  if (!existsSync(config.dataPath)) {
    mkdirSync(config.dataPath, { recursive: true })
  }
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

/* ─────────────────────── 동시 접근 잠금 (OneDrive 공유용) ──────────────── */

let lockFilePath = ''

interface LockInfo {
  host: string
  pid: number
  startedAt: string
  version?: string
}

function getLockFilePath(): string {
  return join(config.dataPath, 'wition.lock')
}

function checkLock(): LockInfo | null {
  const lockPath = getLockFilePath()
  if (!existsSync(lockPath)) return null
  try {
    const info: LockInfo = JSON.parse(readFileSync(lockPath, 'utf-8'))
    if (info.host === hostname() && info.pid === process.pid) return null
    if (info.host === hostname()) {
      try { process.kill(info.pid, 0); return info }
      catch { return null }
    }
    const lockAge = Date.now() - new Date(info.startedAt).getTime()
    if (lockAge > 5 * 60 * 1000) return null
    return info
  } catch {
    return null
  }
}

function acquireLock(): boolean {
  const existing = checkLock()
  if (existing) return false
  ensureDataDir()
  lockFilePath = getLockFilePath()
  const info: LockInfo = {
    host: hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: app.getVersion()
  }
  writeFileSync(lockFilePath, JSON.stringify(info, null, 2), 'utf-8')
  return true
}

function releaseLock(): void {
  if (lockFilePath && existsSync(lockFilePath)) {
    try {
      // 자기 자신의 락인지 확인 후 삭제 (비정상 종료 개선 #15)
      const raw = readFileSync(lockFilePath, 'utf-8')
      const info: LockInfo = JSON.parse(raw)
      if (info.host === hostname() && info.pid === process.pid) {
        unlinkSync(lockFilePath)
      }
    } catch { /* 무시 */ }
    lockFilePath = ''
  }
}

let lockInterval: ReturnType<typeof setInterval> | null = null

function startLockHeartbeat(): void {
  lockInterval = setInterval(() => {
    if (lockFilePath && existsSync(lockFilePath)) {
      const info: LockInfo = {
        host: hostname(),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        version: app.getVersion()
      }
      try { writeFileSync(lockFilePath, JSON.stringify(info, null, 2), 'utf-8') } catch { /* 무시 */ }
    }
  }, 60 * 1000)
}

function stopLockHeartbeat(): void {
  if (lockInterval) {
    clearInterval(lockInterval)
    lockInterval = null
  }
}

/* ─────────────────── 자동 백업 ─────────────────────────────── */

let backupInterval: ReturnType<typeof setInterval> | null = null

function getBackupDir(): string {
  const dir = config.backupPath || join(config.dataPath, 'backups')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function runAutoBackup(): void {
  if (!db) return
  try {
    const dir = getBackupDir()
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = join(dir, `wition-auto-${ts}.json`)

    const days = db.prepare('SELECT * FROM note_day').all()
    const items = db.prepare('SELECT * FROM note_item ORDER BY day_id, order_index').all()
    const exportData = { version: 1, exportedAt: new Date().toISOString(), auto: true, days, items }
    writeFileSync(filePath, JSON.stringify(exportData), 'utf-8')

    // 오래된 백업 정리
    const keepCount = config.backupKeepCount ?? 10
    const files = readdirSync(dir)
      .filter(f => f.startsWith('wition-auto-') && f.endsWith('.json'))
      .sort()
    if (files.length > keepCount) {
      for (const old of files.slice(0, files.length - keepCount)) {
        try { unlinkSync(join(dir, old)) } catch { /* 무시 */ }
      }
    }
    console.log(`[auto-backup] saved: ${filePath}`)
  } catch (err) {
    console.error('[auto-backup] error:', err)
  }
}

function startAutoBackup(): void {
  if (config.autoBackup === false) return
  const intervalMin = config.backupIntervalMin ?? 30
  // 앱 시작 시 1회 즉시 백업
  setTimeout(() => runAutoBackup(), 5000)
  backupInterval = setInterval(() => runAutoBackup(), intervalMin * 60 * 1000)
}

function stopAutoBackup(): void {
  if (backupInterval) { clearInterval(backupInterval); backupInterval = null }
}

/* ─────────────── OneDrive 충돌 파일 감지 (#14) ────────────────── */

function detectConflictFiles(): string[] {
  try {
    const files = readdirSync(config.dataPath)
    // OneDrive 충돌 파일 패턴: "filename (PC이름의 충돌 복사본).ext"
    return files.filter(f =>
      /충돌/.test(f) || /conflict/i.test(f) || /\(.*\s.*\)/.test(f.replace(/\.[^.]+$/, ''))
    ).filter(f => f.includes('wition'))
  } catch {
    return []
  }
}

/* ─────────────────────── 시스템 트레이 ──────────────────────────── */

let tray: Tray | null = null
let isQuitting = false   // 실제 종료 vs 트레이 최소화 구분

function createTray(): void {
  const iconPath = join(__dirname, '../../build/icon.ico')
  tray = new Tray(iconPath)
  tray.setToolTip('Wition')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '열기',
      click: () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) { win.show(); win.focus() }
      }
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  // 트레이 아이콘 더블클릭 → 창 복원
  tray.on('double-click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { win.show(); win.focus() }
  })
}

/* ─────────────────────────── 윈도우 ─────────────────────────────── */

function createWindow(): BrowserWindow {
  const darkPref = config.darkMode
  const isDark = darkPref === 'system' ? nativeTheme.shouldUseDarkColors : darkPref === 'dark'

  const bounds = config.windowBounds ?? { width: 1060, height: 720 }

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: isDark ? '#111827' : '#ffffff',
    frame: false,
    show: false,
    icon: join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  // 로딩 완료 후 표시
  win.once('ready-to-show', () => win.show())

  // 닫기 버튼 → 트레이로 최소화 (실제 종료가 아닌 경우)
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  // 윈도우 크기/위치 기억 (#10)
  const saveWindowBounds = () => {
    if (!win.isMinimized() && !win.isMaximized()) {
      config.windowBounds = win.getBounds()
      saveConfig(config)
    }
  }
  win.on('resized', saveWindowBounds)
  win.on('moved', saveWindowBounds)

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

  // 다크모드 (#9 영속화)
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

  // 자동실행 (#11)
  ipcMain.handle('app:getAutoLaunch', () => {
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('app:setAutoLaunch', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled })
    config.autoLaunch = enabled
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

    releaseLock()
    db.close()
    config.dataPath = newPath
    saveConfig(config)

    if (!acquireLock()) {
      const lockInfo = checkLock()
      const confirmResult = dialog.showMessageBoxSync(win, {
        type: 'warning',
        title: '동시 접근 감지',
        message: `이 경로를 다른 PC(${lockInfo?.host ?? '알 수 없음'})에서 사용 중입니다.\n강제로 전환하겠습니까?`,
        buttons: ['강제 전환', '취소'],
        defaultId: 1
      })
      if (confirmResult === 1) {
        const oldConfig = loadConfig()
        config.dataPath = oldConfig.dataPath
        acquireLock()
        db = openDatabase()
        return null
      }
      lockFilePath = getLockFilePath()
      const info: LockInfo = { host: hostname(), pid: process.pid, startedAt: new Date().toISOString() }
      writeFileSync(lockFilePath, JSON.stringify(info, null, 2), 'utf-8')
    }

    db = openDatabase()
    return newPath
  })

  ipcMain.handle('app:openDataFolder', () => {
    shell.openPath(config.dataPath)
  })

  // ── 데이터 내보내기/가져오기 (#7) ──
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

  // ── 파일 첨부 (업로드 → attachments/) ──
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
      // 이름 충돌 방지: timestamp 접두사
      const ts = Date.now()
      const ext = extname(name)
      const base = basename(name, ext)
      const destName = `${ts}_${base}${ext}`
      const destPath = join(attachDir, destName)
      try {
        copyFileSync(srcPath, destPath)
        const stat = statSync(destPath)
        attached.push({ name, path: destName, size: stat.size })
      } catch (err) {
        console.error('attachFile copy error:', err)
      }
    }
    return attached
  })

  // 첨부 파일 열기
  ipcMain.handle('app:openAttachment', (_e, fileName: string) => {
    const filePath = join(config.dataPath, 'attachments', fileName)
    if (existsSync(filePath)) {
      shell.openPath(filePath)
      return true
    }
    return false
  })

  // ── 자동 백업 설정 ──
  ipcMain.handle('app:getBackupConfig', () => {
    return {
      autoBackup: config.autoBackup !== false,
      backupPath: config.backupPath || join(config.dataPath, 'backups'),
      backupIntervalMin: config.backupIntervalMin ?? 30,
      backupKeepCount: config.backupKeepCount ?? 10
    }
  })

  ipcMain.handle('app:setBackupConfig', (_e, cfg: {
    autoBackup?: boolean
    backupPath?: string
    backupIntervalMin?: number
    backupKeepCount?: number
  }) => {
    if (cfg.autoBackup !== undefined) config.autoBackup = cfg.autoBackup
    if (cfg.backupPath !== undefined) config.backupPath = cfg.backupPath
    if (cfg.backupIntervalMin !== undefined) config.backupIntervalMin = cfg.backupIntervalMin
    if (cfg.backupKeepCount !== undefined) config.backupKeepCount = cfg.backupKeepCount
    saveConfig(config)

    // 백업 재시작
    stopAutoBackup()
    startAutoBackup()
  })

  ipcMain.handle('app:changeBackupPath', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: '백업 저장 경로 선택',
      defaultPath: config.backupPath || join(config.dataPath, 'backups'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    config.backupPath = result.filePaths[0]
    saveConfig(config)
    stopAutoBackup()
    startAutoBackup()
    return result.filePaths[0]
  })

  ipcMain.handle('app:runBackupNow', () => {
    runAutoBackup()
    return true
  })

  // OneDrive 충돌 파일 감지 (#14)
  ipcMain.handle('app:checkConflicts', () => {
    return detectConflictFiles()
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
  if (!acquireLock()) {
    const lockInfo = checkLock()
    const msg = lockInfo
      ? `다른 PC(${lockInfo.host})에서 Wition을 사용 중입니다.\n동시에 사용하면 데이터가 손상될 수 있습니다.\n\n강제로 열겠습니까?`
      : '다른 곳에서 Wition을 사용 중입니다.\n강제로 열겠습니까?'

    const result = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Wition - 동시 접근 감지',
      message: msg,
      buttons: ['강제 열기', '종료'],
      defaultId: 1,
      cancelId: 1
    })

    if (result === 1) {
      app.quit()
      return
    }
    lockFilePath = getLockFilePath()
    const info: LockInfo = { host: hostname(), pid: process.pid, startedAt: new Date().toISOString() }
    writeFileSync(lockFilePath, JSON.stringify(info, null, 2), 'utf-8')
  }

  startLockHeartbeat()
  db = openDatabase()
  registerIpcHandlers()
  startAutoBackup()
  createTray()
  createWindow()

  // 시작 시 OneDrive 충돌 파일 확인
  const conflicts = detectConflictFiles()
  if (conflicts.length > 0) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'OneDrive 동기화 충돌 감지',
      message: `다음 충돌 파일이 발견되었습니다:\n${conflicts.join('\n')}\n\n데이터 폴더를 확인해주세요.`
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 비정상 종료 시에도 락 해제 시도 (#15)
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  releaseLock()
})

process.on('SIGTERM', () => {
  stopLockHeartbeat()
  releaseLock()
  db?.close()
})

app.on('before-quit', () => {
  isQuitting = true
  // 종료 시 마지막 백업 실행
  try { runAutoBackup() } catch (e) { console.error('Exit backup failed:', e) }
  stopAutoBackup()
  stopLockHeartbeat()
  releaseLock()
})

app.on('window-all-closed', () => {
  // 트레이 모드에서는 창이 닫혀도 앱 종료하지 않음
  if (!isQuitting) return
  stopAutoBackup()
  stopLockHeartbeat()
  releaseLock()
  db?.close()
  if (process.platform !== 'darwin') app.quit()
})
