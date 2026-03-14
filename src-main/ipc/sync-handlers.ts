/**
 * 동기화 IPC 핸들러 (sync:now, sync:getStatus)
 */
import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import type Database from 'better-sqlite3'
import * as Sync from '../sync'

interface SyncDeps {
  getDb: () => Database.Database
  config: {
    dataPath: string
    lastSyncAt?: number
    [key: string]: unknown
  }
  saveConfig: (cfg: any) => void
  sendSyncDone: () => void
}

let deps: SyncDeps

export function registerSyncHandlers(d: SyncDeps): void {
  deps = d

  ipcMain.handle('sync:now', async () => {
    const db = deps.getDb()
    if (!Sync.isOnline() || !db) return { ok: false, reason: 'offline' }
    if (Sync.isSyncing()) return { ok: false, reason: 'already_syncing' }
    const reachable = await Sync.checkConnection()
    if (!reachable) return { ok: false, reason: 'unreachable' }
    try {
      const { pulled, pushed, cleaned, syncedAt } = await Sync.fullSync(db, deps.config.lastSyncAt)
      if (syncedAt > 0) {
        deps.config.lastSyncAt = syncedAt
        deps.saveConfig(deps.config)
      }
      // 첨부파일 동기화
      const attachDir = join(deps.config.dataPath, 'attachments')
      await Sync.pullAttachmentFiles(attachDir)
      await Sync.pushAttachmentFiles(attachDir)

      if (pulled > 0 || pushed > 0 || cleaned > 0) {
        deps.sendSyncDone()
      }
      return { ok: true, pulled, pushed, cleaned }
    } catch (err) {
      return { ok: false, reason: String(err) }
    }
  })

  ipcMain.handle('sync:getStatus', () => {
    return {
      online: Sync.isOnline(),
      reachable: Sync.isReachable(),
      lastSyncAt: deps.config.lastSyncAt ?? 0,
    }
  })

  ipcMain.handle('sync:getRealtimeStatus', () => {
    return Sync.getRealtimeStatus()
  })

  ipcMain.handle('sync:getHistory', () => {
    return Sync.getSyncHistory()
  })
}
