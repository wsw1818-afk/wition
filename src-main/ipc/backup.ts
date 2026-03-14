/**
 * 자동 백업 관련 IPC 핸들러 + 백업 로직
 */
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'

interface BackupDeps {
  getDb: () => Database.Database
  config: {
    dataPath: string
    autoBackup?: boolean
    backupPath?: string
    backupIntervalMin?: number
    backupKeepCount?: number
    [key: string]: unknown
  }
  saveConfig: (cfg: any) => void
}

let deps: BackupDeps
let backupInterval: ReturnType<typeof setInterval> | null = null
let lastBackupAt = 0

function getBackupDir(): string {
  const dir = deps.config.backupPath || join(deps.config.dataPath, 'backups')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function runAutoBackup(): void {
  const db = deps.getDb()
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
    const keepCount = deps.config.backupKeepCount ?? 10
    const files = readdirSync(dir)
      .filter(f => f.startsWith('wition-auto-') && f.endsWith('.json'))
      .sort()
    if (files.length > keepCount) {
      for (const old of files.slice(0, files.length - keepCount)) {
        try { unlinkSync(join(dir, old)) } catch { /* 무시 */ }
      }
    }
    lastBackupAt = Date.now()
    console.log(`[auto-backup] saved: ${filePath}`)
  } catch (err) {
    console.error('[auto-backup] error:', err)
  }
}

export function startAutoBackup(): void {
  if (!deps || deps.config?.autoBackup === false) return
  const intervalMin = deps.config.backupIntervalMin ?? 30
  // 앱 시작 시 1회 즉시 백업
  setTimeout(() => runAutoBackup(), 5000)
  backupInterval = setInterval(() => runAutoBackup(), intervalMin * 60 * 1000)
}

export function stopAutoBackup(): void {
  if (backupInterval) { clearInterval(backupInterval); backupInterval = null }
}

export function registerBackupHandlers(d: BackupDeps): void {
  deps = d

  ipcMain.handle('app:getBackupConfig', () => {
    return {
      autoBackup: deps.config.autoBackup !== false,
      backupPath: deps.config.backupPath || join(deps.config.dataPath, 'backups'),
      backupIntervalMin: deps.config.backupIntervalMin ?? 30,
      backupKeepCount: deps.config.backupKeepCount ?? 10
    }
  })

  ipcMain.handle('app:setBackupConfig', (_e, cfg: {
    autoBackup?: boolean
    backupPath?: string
    backupIntervalMin?: number
    backupKeepCount?: number
  }) => {
    if (cfg.autoBackup !== undefined) deps.config.autoBackup = cfg.autoBackup
    if (cfg.backupPath !== undefined) deps.config.backupPath = cfg.backupPath
    if (cfg.backupIntervalMin !== undefined) deps.config.backupIntervalMin = cfg.backupIntervalMin
    if (cfg.backupKeepCount !== undefined) deps.config.backupKeepCount = cfg.backupKeepCount
    deps.saveConfig(deps.config)

    // 백업 재시작
    stopAutoBackup()
    startAutoBackup()
  })

  ipcMain.handle('app:changeBackupPath', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: '백업 저장 경로 선택',
      defaultPath: deps.config.backupPath || join(deps.config.dataPath, 'backups'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    deps.config.backupPath = result.filePaths[0]
    deps.saveConfig(deps.config)
    stopAutoBackup()
    startAutoBackup()
    return result.filePaths[0]
  })

  ipcMain.handle('app:runBackupNow', () => {
    runAutoBackup()
    return true
  })

  ipcMain.handle('app:getLastBackupAt', () => {
    return lastBackupAt
  })
}
