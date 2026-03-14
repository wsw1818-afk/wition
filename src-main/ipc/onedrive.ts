/**
 * OneDrive DB 동기화 관련 IPC 핸들러 + 로직
 */
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import DatabaseCtor from 'better-sqlite3'
import * as Q from '../db/queries'

interface OnedriveDeps {
  getDb: () => Database.Database
  config: {
    dataPath: string
    onedriveSyncPath?: string
    onedriveSyncEnabled?: boolean
    authUser?: { id: string; email: string }
    lastSyncAt?: number
    [key: string]: unknown
  }
  saveConfig: (cfg: any) => void
  getDbFileName: (userId?: string) => string
  getDbOwnerId: (db: Database.Database) => string | null
}

let deps: OnedriveDeps
let onedriveSyncTimer: ReturnType<typeof setInterval> | null = null
let onedriveSyncDebounce: ReturnType<typeof setTimeout> | null = null

/** OneDrive 동기화 경로의 DB 파일 경로 (사용자별) */
function getOneDriveDbPath(): string | null {
  if (!deps.config.onedriveSyncPath) return null
  const userId = deps.config.authUser?.id
  return join(deps.config.onedriveSyncPath, deps.getDbFileName(userId))
}

/** 양방향 동기화: OneDrive DB에서 병합 후, 로컬 DB를 OneDrive로 복사 */
export function exportDbToOneDrive(): { ok: boolean; error?: string } {
  const remotePath = getOneDriveDbPath()
  if (!remotePath) return { ok: false, error: 'OneDrive 경로가 설정되지 않았습니다.' }
  try {
    const localDbPath = join(deps.config.dataPath, deps.getDbFileName(deps.config.authUser?.id))
    if (!existsSync(localDbPath)) return { ok: false, error: '로컬 DB가 없습니다.' }
    if (!existsSync(deps.config.onedriveSyncPath!)) mkdirSync(deps.config.onedriveSyncPath!, { recursive: true })

    // 1) OneDrive DB가 있으면 먼저 병합 (다른 PC 데이터 보존)
    if (existsSync(remotePath)) {
      mergeFromOneDrive()
    }

    // 2) WAL 체크포인트 후 로컬 DB를 OneDrive로 복사
    const db = deps.getDb()
    if (db) {
      try { db.pragma('wal_checkpoint(TRUNCATE)') } catch {}
    }
    copyFileSync(localDbPath, remotePath)
    const walPath = localDbPath + '-wal'
    const shmPath = localDbPath + '-shm'
    const remoteWal = remotePath + '-wal'
    const remoteShm = remotePath + '-shm'
    if (existsSync(walPath)) {
      try { copyFileSync(walPath, remoteWal) } catch {}
    } else {
      try { if (existsSync(remoteWal)) unlinkSync(remoteWal) } catch {}
      try { if (existsSync(remoteShm)) unlinkSync(remoteShm) } catch {}
    }

    // 3) 첨부파일 양방향 복사
    const localAttach = join(deps.config.dataPath, 'attachments')
    const remoteAttach = join(deps.config.onedriveSyncPath!, 'attachments')
    if (!existsSync(remoteAttach)) mkdirSync(remoteAttach, { recursive: true })
    if (existsSync(localAttach)) {
      for (const f of readdirSync(localAttach)) {
        const dest = join(remoteAttach, f)
        if (!existsSync(dest)) {
          try { copyFileSync(join(localAttach, f), dest) } catch {}
        }
      }
    }
    for (const f of readdirSync(remoteAttach)) {
      if (!existsSync(localAttach)) mkdirSync(localAttach, { recursive: true })
      const dest = join(localAttach, f)
      if (!existsSync(dest)) {
        try { copyFileSync(join(remoteAttach, f), dest) } catch {}
      }
    }

    console.log('[onedrive-sync] 양방향 동기화 완료:', remotePath)
    return { ok: true }
  } catch (err) {
    console.error('[onedrive-sync] 내보내기 실패:', err)
    return { ok: false, error: String(err) }
  }
}

/** OneDrive DB와 로컬 DB를 레코드 단위 병합 */
function mergeFromOneDrive(): { ok: boolean; merged: number; error?: string } {
  const remotePath = getOneDriveDbPath()
  if (!remotePath) return { ok: false, merged: 0, error: 'OneDrive 경로가 설정되지 않았습니다.' }
  if (!existsSync(remotePath)) return { ok: false, merged: 0, error: 'OneDrive에 DB 파일이 없습니다.' }
  const db = deps.getDb()
  if (!db) return { ok: false, merged: 0, error: '로컬 DB가 열려있지 않습니다.' }
  let remoteDb: Database.Database | null = null
  try {
    remoteDb = new DatabaseCtor(remotePath, { readonly: true })

    const remoteOwnerId = deps.getDbOwnerId(remoteDb)
    const currentUserId = deps.config.authUser?.id
    if (remoteOwnerId && currentUserId && remoteOwnerId !== currentUserId) {
      console.warn(`[onedrive-sync] 소유자 불일치: DB=${remoteOwnerId}, 현재=${currentUserId} → 병합 거부`)
      return { ok: false, merged: 0, error: '다른 사용자의 데이터입니다. 로그인 정보가 일치하지 않습니다.' }
    }

    let merged = 0

    const remoteItems = remoteDb.prepare('SELECT * FROM note_item').all() as Array<Record<string, unknown>>
    const localSelectItem = db.prepare('SELECT updated_at FROM note_item WHERE id = ?')
    const upsertItem = db.prepare(`
      INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        type=@type, content=@content, tags=@tags, pinned=@pinned,
        order_index=@order_index, updated_at=@updated_at
      WHERE @updated_at > note_item.updated_at
    `)
    const ensureDay = db.prepare(`
      INSERT OR IGNORE INTO note_day (id, note_count, has_notes, updated_at)
      VALUES (@id, 0, 0, @updated_at)
    `)

    const remoteDays = remoteDb.prepare('SELECT * FROM note_day').all() as Array<Record<string, unknown>>
    const localSelectDay = db.prepare('SELECT updated_at FROM note_day WHERE id = ?')
    const upsertDay = db.prepare(`
      INSERT INTO note_day (id, mood, summary, note_count, has_notes, updated_at)
      VALUES (@id, @mood, @summary, @note_count, @has_notes, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        mood=@mood, summary=@summary, note_count=@note_count,
        has_notes=@has_notes, updated_at=@updated_at
      WHERE @updated_at > note_day.updated_at
    `)

    const remoteAlarms = remoteDb.prepare('SELECT * FROM alarm').all() as Array<Record<string, unknown>>
    const localSelectAlarm = db.prepare('SELECT updated_at FROM alarm WHERE id = ?')
    const upsertAlarm = db.prepare(`
      INSERT INTO alarm (id, day_id, time, label, repeat, enabled, fired, created_at, updated_at)
      VALUES (@id, @day_id, @time, @label, @repeat, @enabled, @fired, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        day_id=@day_id, time=@time, label=@label, repeat=@repeat,
        enabled=@enabled, fired=@fired, updated_at=@updated_at
      WHERE @updated_at > alarm.updated_at
    `)

    const localTombstones = new Map<string, number>()
    try {
      const rows = db.prepare('SELECT table_name, item_id, deleted_at FROM deleted_items').all() as Array<{ table_name: string; item_id: string; deleted_at: number }>
      for (const r of rows) localTombstones.set(`${r.table_name}:${r.item_id}`, r.deleted_at)
    } catch {}

    try {
      const remoteTombstones = remoteDb.prepare('SELECT table_name, item_id, deleted_at FROM deleted_items').all() as Array<{ table_name: string; item_id: string; deleted_at: number }>
      const insertTombstone = db.prepare('INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES (?, ?, ?)')
      for (const rt of remoteTombstones) {
        const localDelAt = localTombstones.get(`${rt.table_name}:${rt.item_id}`)
        if (!localDelAt || rt.deleted_at > localDelAt) {
          insertTombstone.run(rt.table_name, rt.item_id, rt.deleted_at)
          localTombstones.set(`${rt.table_name}:${rt.item_id}`, rt.deleted_at)
        }
      }
    } catch {}

    db.transaction(() => {
      for (const rd of remoteDays) {
        const delAt = localTombstones.get(`note_day:${rd.id}`)
        if (delAt !== undefined && (rd.updated_at as number) <= delAt) continue
        const local = localSelectDay.get(rd.id) as { updated_at: number } | undefined
        if (!local || (rd.updated_at as number) > local.updated_at) {
          upsertDay.run(rd)
          merged++
        }
      }
      for (const ri of remoteItems) {
        const delAt = localTombstones.get(`note_item:${ri.id}`)
        if (delAt !== undefined && (ri.updated_at as number) <= delAt) continue
        const local = localSelectItem.get(ri.id) as { updated_at: number } | undefined
        if (!local || (ri.updated_at as number) > local.updated_at) {
          ensureDay.run({ id: ri.day_id, updated_at: ri.updated_at })
          upsertItem.run(ri)
          merged++
        }
      }
      for (const ra of remoteAlarms) {
        const delAt = localTombstones.get(`alarm:${ra.id}`)
        if (delAt !== undefined && (ra.updated_at as number) <= delAt) continue
        const local = localSelectAlarm.get(ra.id) as { updated_at: number } | undefined
        if (!local || (ra.updated_at as number) > local.updated_at) {
          upsertAlarm.run(ra)
          merged++
        }
      }

      const deleteItem = db.prepare('DELETE FROM note_item WHERE id = ? AND updated_at <= ?')
      const deleteAlarm = db.prepare('DELETE FROM alarm WHERE id = ? AND updated_at <= ?')
      for (const [key, delAt] of localTombstones) {
        const [table, id] = key.split(':')
        if (table === 'note_item') deleteItem.run(id, delAt)
        else if (table === 'alarm') deleteAlarm.run(id, delAt)
      }
    })()

    const remoteAttach = join(deps.config.onedriveSyncPath!, 'attachments')
    const localAttach = join(deps.config.dataPath, 'attachments')
    if (existsSync(remoteAttach)) {
      if (!existsSync(localAttach)) mkdirSync(localAttach, { recursive: true })
      for (const f of readdirSync(remoteAttach)) {
        const dest = join(localAttach, f)
        if (!existsSync(dest)) {
          try { copyFileSync(join(remoteAttach, f), dest) } catch {}
        }
      }
    }

    Q.refreshAllSummaries(db)
    console.log(`[onedrive-sync] 병합 완료: ${merged}건`)

    if (merged > 0) {
      deps.config.lastSyncAt = 0
      deps.saveConfig(deps.config)
      console.log('[onedrive-sync] lastSyncAt 리셋 → 다음 fullSync에서 전체 동기화')
    }

    return { ok: true, merged }
  } catch (err) {
    console.error('[onedrive-sync] 병합 실패:', err)
    return { ok: false, merged: 0, error: String(err) }
  } finally {
    if (remoteDb) { try { remoteDb.close() } catch {} }
  }
}

function importDbFromOneDrive(): { ok: boolean; error?: string } {
  const result = mergeFromOneDrive()
  return { ok: result.ok, error: result.error }
}

export function oneDrivePullIfNewer(): void {
  if (!deps || !deps.config?.onedriveSyncEnabled || !deps.config?.onedriveSyncPath) return
  const remotePath = getOneDriveDbPath()
  if (!remotePath || !existsSync(remotePath)) return
  try {
    console.log('[onedrive-sync] 앱 시작 → OneDrive DB 병합 시도')
    mergeFromOneDrive()
  } catch (err) {
    console.error('[onedrive-sync] 시작 시 병합 실패:', err)
  }
}

export function scheduleOneDriveExport(): void {
  if (!deps || !deps.config?.onedriveSyncEnabled || !deps.config?.onedriveSyncPath) return
  if (onedriveSyncDebounce) clearTimeout(onedriveSyncDebounce)
  onedriveSyncDebounce = setTimeout(() => exportDbToOneDrive(), 5000)
}

export function startOneDriveSync(): void {
  stopOneDriveSync()
  if (!deps || !deps.config?.onedriveSyncEnabled || !deps.config?.onedriveSyncPath) return
  onedriveSyncTimer = setInterval(() => exportDbToOneDrive(), 5 * 60 * 1000)
}

export function stopOneDriveSync(): void {
  if (onedriveSyncTimer) { clearInterval(onedriveSyncTimer); onedriveSyncTimer = null }
  if (onedriveSyncDebounce) { clearTimeout(onedriveSyncDebounce); onedriveSyncDebounce = null }
}

export function registerOnedriveHandlers(d: OnedriveDeps): void {
  deps = d

  ipcMain.handle('onedrive:getConfig', () => ({
    enabled: deps.config.onedriveSyncEnabled ?? false,
    path: deps.config.onedriveSyncPath ?? '',
  }))

  ipcMain.handle('onedrive:setPath', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false }
    const result = await dialog.showOpenDialog(win, {
      title: 'OneDrive 동기화 폴더 선택',
      properties: ['openDirectory'],
      defaultPath: deps.config.onedriveSyncPath || join(process.env.USERPROFILE || '', 'OneDrive'),
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false }
    deps.config.onedriveSyncPath = result.filePaths[0]
    deps.config.onedriveSyncEnabled = true
    deps.saveConfig(deps.config)
    startOneDriveSync()
    return { ok: true, path: deps.config.onedriveSyncPath }
  })

  ipcMain.handle('onedrive:setEnabled', (_e, enabled: boolean) => {
    deps.config.onedriveSyncEnabled = enabled
    deps.saveConfig(deps.config)
    if (enabled) startOneDriveSync()
    else stopOneDriveSync()
    return { ok: true }
  })

  ipcMain.handle('onedrive:export', () => {
    const result = exportDbToOneDrive()
    if (result.ok) scheduleOneDriveExport()
    return result
  })

  ipcMain.handle('onedrive:import', () => {
    return importDbFromOneDrive()
  })
}
