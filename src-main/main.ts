import { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog, Tray, Menu, Notification, net, safeStorage } from 'electron'
import { join, basename, extname, resolve } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, copyFileSync, statSync, appendFileSync } from 'fs'
import Database from 'better-sqlite3'
import { initializeSchema } from './db/schema'
import * as Q from './db/queries'
import * as Sync from './sync'

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
  autoBackup?: boolean           // 자동 백업 활성화 여부
  backupPath?: string            // 백업 저장 경로 (미지정 시 dataPath/backups/)
  backupIntervalMin?: number     // 백업 주기 (분, 기본 30)
  backupKeepCount?: number       // 보관 개수 (기본 10)
  calendarWidth?: number         // 달력 패널 너비 (px, 기본 420)
  lastSyncAt?: number            // 마지막 동기화 시각 (epoch ms, 증분 동기화용)
  authToken?: string             // GoTrue 액세스 토큰
  authRefreshToken?: string      // GoTrue 리프레시 토큰
  authUser?: { id: string; email: string }  // 로그인된 사용자 정보
  savedEmail?: string                       // 기억된 이메일
  savedPasswordEnc?: string                 // 기억된 비밀번호 (safeStorage 암호화, base64)
  onedriveSyncPath?: string                 // OneDrive DB 동기화 경로
  onedriveSyncEnabled?: boolean             // OneDrive 자동 동기화 활성화
}

const CONFIG_FILE = join(app.getPath('userData'), 'config.json')

function getDefaultDataPath(): string {
  return join(app.getPath('userData'), 'data')
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

  // 이미 새 기본 경로를 사용 중이면 스킵
  if (oldPath === newDefault) return

  const oldDb = join(oldPath, 'wition.db')
  const newDb = join(newDefault, 'wition.db')

  // 새 경로에 이미 DB가 있으면 마이그레이션 불필요 (경로만 갱신)
  if (existsSync(newDb)) {
    config.dataPath = newDefault
    saveConfig(config)
    console.log(`[migrate] 새 경로에 DB 존재 — dataPath 업데이트: ${newDefault}`)
    return
  }

  // 이전 경로에 DB가 없으면 새 경로 사용
  if (!existsSync(oldDb)) {
    config.dataPath = newDefault
    saveConfig(config)
    console.log(`[migrate] 이전 DB 없음 — 새 경로 사용: ${newDefault}`)
    return
  }

  // 이전 DB를 새 경로로 복사 (WAL checkpoint 후)
  try {
    if (!existsSync(newDefault)) mkdirSync(newDefault, { recursive: true })

    // WAL checkpoint: .db-wal 내용을 .db에 반영
    const tempDb = new Database(oldDb)
    tempDb.pragma('wal_checkpoint(TRUNCATE)')
    tempDb.close()

    // DB 파일 복사
    copyFileSync(oldDb, newDb)
    console.log(`[migrate] DB 복사 완료: ${oldDb} → ${newDb}`)

    // 첨부파일 폴더도 복사
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
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')
  initializeSchema(database)
  return database
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

/* ─────────────────── OneDrive DB 동기화 ─────────────────────── */

let onedriveSyncTimer: ReturnType<typeof setInterval> | null = null
let onedriveSyncDebounce: ReturnType<typeof setTimeout> | null = null

/** OneDrive 동기화 경로의 DB 파일 경로 */
function getOneDriveDbPath(): string | null {
  if (!config.onedriveSyncPath) return null
  return join(config.onedriveSyncPath, 'wition.db')
}

/** 양방향 동기화: OneDrive DB에서 병합 후, 로컬 DB를 OneDrive로 복사 */
function exportDbToOneDrive(): { ok: boolean; error?: string } {
  const remotePath = getOneDriveDbPath()
  if (!remotePath) return { ok: false, error: 'OneDrive 경로가 설정되지 않았습니다.' }
  try {
    const localDbPath = join(config.dataPath, 'wition.db')
    if (!existsSync(localDbPath)) return { ok: false, error: '로컬 DB가 없습니다.' }
    if (!existsSync(config.onedriveSyncPath!)) mkdirSync(config.onedriveSyncPath!, { recursive: true })

    // 1) OneDrive DB가 있으면 먼저 병합 (다른 PC 데이터 보존)
    if (existsSync(remotePath)) {
      mergeFromOneDrive()
    }

    // 2) WAL 체크포인트 후 로컬 DB를 OneDrive로 복사
    if (db) {
      try { db.pragma('wal_checkpoint(TRUNCATE)') } catch {}
    }
    copyFileSync(localDbPath, remotePath)

    // 3) 첨부파일 양방향 복사 (없는 파일만)
    const localAttach = join(config.dataPath, 'attachments')
    const remoteAttach = join(config.onedriveSyncPath!, 'attachments')
    if (!existsSync(remoteAttach)) mkdirSync(remoteAttach, { recursive: true })
    // 로컬 → OneDrive
    if (existsSync(localAttach)) {
      for (const f of readdirSync(localAttach)) {
        const dest = join(remoteAttach, f)
        if (!existsSync(dest)) {
          try { copyFileSync(join(localAttach, f), dest) } catch {}
        }
      }
    }
    // OneDrive → 로컬 (다른 PC에서 추가한 첨부파일)
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

/** OneDrive DB와 로컬 DB를 레코드 단위 병합 (데이터 유실 없음) */
function mergeFromOneDrive(): { ok: boolean; merged: number; error?: string } {
  const remotePath = getOneDriveDbPath()
  if (!remotePath) return { ok: false, merged: 0, error: 'OneDrive 경로가 설정되지 않았습니다.' }
  if (!existsSync(remotePath)) return { ok: false, merged: 0, error: 'OneDrive에 DB 파일이 없습니다.' }
  if (!db) return { ok: false, merged: 0, error: '로컬 DB가 열려있지 않습니다.' }
  let remoteDb: Database.Database | null = null
  try {
    // OneDrive DB를 읽기 전용으로 열기
    remoteDb = new Database(remotePath, { readonly: true })
    let merged = 0

    // note_item 병합: 양쪽 모두의 레코드를 보존, updated_at이 더 큰 쪽 우선
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

    // note_day 병합
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

    // alarm 병합
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

    db.transaction(() => {
      for (const rd of remoteDays) {
        const local = localSelectDay.get(rd.id) as { updated_at: number } | undefined
        if (!local || (rd.updated_at as number) > local.updated_at) {
          upsertDay.run(rd)
          merged++
        }
      }
      for (const ri of remoteItems) {
        const local = localSelectItem.get(ri.id) as { updated_at: number } | undefined
        if (!local || (ri.updated_at as number) > local.updated_at) {
          ensureDay.run({ id: ri.day_id, updated_at: ri.updated_at })
          upsertItem.run(ri)
          merged++
        }
      }
      for (const ra of remoteAlarms) {
        const local = localSelectAlarm.get(ra.id) as { updated_at: number } | undefined
        if (!local || (ra.updated_at as number) > local.updated_at) {
          upsertAlarm.run(ra)
          merged++
        }
      }
    })()

    // 첨부파일 병합 (없는 파일만 복사, 덮어쓰기 안 함)
    const remoteAttach = join(config.onedriveSyncPath!, 'attachments')
    const localAttach = join(config.dataPath, 'attachments')
    if (existsSync(remoteAttach)) {
      if (!existsSync(localAttach)) mkdirSync(localAttach, { recursive: true })
      for (const f of readdirSync(remoteAttach)) {
        const dest = join(localAttach, f)
        if (!existsSync(dest)) {
          try { copyFileSync(join(remoteAttach, f), dest) } catch {}
        }
      }
    }

    // note_day 캐시 재계산
    Q.refreshAllSummaries(db)
    console.log(`[onedrive-sync] 병합 완료: ${merged}건`)
    return { ok: true, merged }
  } catch (err) {
    console.error('[onedrive-sync] 병합 실패:', err)
    return { ok: false, merged: 0, error: String(err) }
  } finally {
    if (remoteDb) { try { remoteDb.close() } catch {} }
  }
}

/** 하위 호환: importDbFromOneDrive → mergeFromOneDrive로 대체 */
function importDbFromOneDrive(): { ok: boolean; error?: string } {
  const result = mergeFromOneDrive()
  return { ok: result.ok, error: result.error }
}

/** 앱 시작 시: OneDrive DB가 있으면 병합 */
function oneDrivePullIfNewer(): void {
  if (!config.onedriveSyncEnabled || !config.onedriveSyncPath) return
  const remotePath = getOneDriveDbPath()
  if (!remotePath || !existsSync(remotePath)) return
  try {
    console.log('[onedrive-sync] 앱 시작 → OneDrive DB 병합 시도')
    mergeFromOneDrive()
  } catch (err) {
    console.error('[onedrive-sync] 시작 시 병합 실패:', err)
  }
}

/** 데이터 변경 시 OneDrive로 내보내기 (5초 디바운스) */
function scheduleOneDriveExport(): void {
  if (!config.onedriveSyncEnabled || !config.onedriveSyncPath) return
  if (onedriveSyncDebounce) clearTimeout(onedriveSyncDebounce)
  onedriveSyncDebounce = setTimeout(() => exportDbToOneDrive(), 5000)
}

/** OneDrive 자동 동기화 시작 (5분마다 내보내기) */
function startOneDriveSync(): void {
  stopOneDriveSync()
  if (!config.onedriveSyncEnabled || !config.onedriveSyncPath) return
  onedriveSyncTimer = setInterval(() => exportDbToOneDrive(), 5 * 60 * 1000)
}

function stopOneDriveSync(): void {
  if (onedriveSyncTimer) { clearInterval(onedriveSyncTimer); onedriveSyncTimer = null }
  if (onedriveSyncDebounce) { clearTimeout(onedriveSyncDebounce); onedriveSyncDebounce = null }
}

/* ─────────────────────── 알람 타이머 ──────────────────────────── */

let alarmInterval: ReturnType<typeof setInterval> | null = null

let lastResetDate = ''

function checkAlarms(): void {
  if (!db) return
  try {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const todayDow = now.getDay() // 0=일, 6=토

    // 날짜가 바뀌면 반복 알람의 fired를 리셋
    if (lastResetDate !== todayStr) {
      console.log(`[alarm] 날짜 변경 감지: ${lastResetDate} → ${todayStr}, 반복 알람 fired 리셋`)
      Q.resetRepeatingAlarmsFired(db)
      lastResetDate = todayStr
    }

    const pending = Q.getPendingAlarms(db)
    // 반복 알람도 포함
    const repeating = Q.getRepeatingAlarms(db).filter(a => a.fired === 0)
    // 중복 제거 (pending에 이미 포함된 것 제외)
    const pendingIds = new Set(pending.map(a => a.id))
    const allAlarms = [...pending, ...repeating.filter(a => !pendingIds.has(a.id))]

    if (allAlarms.length === 0) return

    // Windows 알림 지원 여부 체크
    const notifSupported = Notification.isSupported()

    for (const alarm of allAlarms) {
      const shouldFire = shouldAlarmFire(alarm, todayStr, currentTime, todayDow)

      if (shouldFire) {
        console.log(`[alarm] 발동! id=${alarm.id}, time=${alarm.time}, label="${alarm.label}", repeat=${alarm.repeat}`)
        Q.markAlarmFired(db, alarm.id)

        const win = BrowserWindow.getAllWindows()[0]

        // 1) 앱 내부 알림 (렌더러에 이벤트 전송 — 가장 확실)
        if (win) {
          win.webContents.send('alarm:fire', {
            id: alarm.id,
            day_id: alarm.day_id,
            time: alarm.time,
            label: alarm.label,
            repeat: alarm.repeat
          })
          win.show()
          win.focus()
        }

        // 2) OS 알림도 시도 (선택적)
        try {
          if (notifSupported) {
            const notification = new Notification({
              title: 'Wition 알람',
              body: alarm.label || `${alarm.time} 알람`,
              icon: getIconPath(),
              silent: false
            })
            notification.on('click', () => {
              if (win) { win.show(); win.focus() }
              win?.webContents.send('alarm:navigate', alarm.day_id)
            })
            notification.show()
          }
        } catch (notifErr) {
          console.error('[alarm] OS Notification 실패 (앱 내부 알림은 정상):', notifErr)
        }
      }
      // 일회성 알람이고, 지난 날짜 → fired 처리
      else if (alarm.repeat === 'none' && alarm.day_id < todayStr) {
        Q.markAlarmFired(db, alarm.id)
      }
    }
  } catch (err) {
    console.error('[alarm] check error:', err)
  }
}

function shouldAlarmFire(alarm: Q.AlarmRow, todayStr: string, currentTime: string, todayDow: number): boolean {
  if (alarm.time > currentTime) return false

  switch (alarm.repeat) {
    case 'none':
      return alarm.day_id === todayStr
    case 'daily':
      // 시작일(day_id) 이후부터만 발동
      return todayStr >= alarm.day_id
    case 'weekdays':
      // 시작일 이후 + 평일만
      return todayStr >= alarm.day_id && todayDow >= 1 && todayDow <= 5
    case 'weekly': {
      // 시작일 이후 + 원래 설정된 요일과 같은 요일에만 발동
      if (todayStr < alarm.day_id) return false
      const origDate = new Date(alarm.day_id + 'T00:00:00')
      return origDate.getDay() === todayDow
    }
    default:
      return alarm.day_id === todayStr
  }
}

function startAlarmChecker(): void {
  // 30초마다 알람 체크
  checkAlarms()
  alarmInterval = setInterval(checkAlarms, 30 * 1000)
}

function stopAlarmChecker(): void {
  if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null }
}

/* ─────────────────────── 시스템 트레이 ──────────────────────────── */

let tray: Tray | null = null
let isQuitting = false   // 실제 종료 vs 트레이 최소화 구분

function getIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'icon.ico')
  }
  return join(__dirname, '../../build/icon.ico')
}

function createTray(): void {
  try {
    const iconPath = getIconPath()
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
  } catch (err) {
    console.error('Tray creation failed:', err)
  }
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
    icon: getIconPath(),
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
    // portable exe는 Temp에 풀리므로, 원본 exe 경로를 사용
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe')
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: exePath
    })
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
    db.close()
    config.dataPath = newPath
    saveConfig(config)
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
        // 백그라운드 동기화
        Sync.syncAttachmentFile(attachDir, destName)
      } catch (err) {
        console.error('attachFile copy error:', err)
      }
    }
    return attached
  })

  // 첨부 파일 열기
  ipcMain.handle('app:openAttachment', async (_e, fileName: string) => {
    // attachments/ 폴더에서 찾기
    let filePath = resolve(join(config.dataPath, 'attachments', fileName))

    // 없으면 fileName 자체가 전체 경로인지 확인
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

    // pathToFileURL로 한글 경로 자동 인코딩 (file:/// + percent-encoding)
    try {
      await shell.openExternal(pathToFileURL(filePath).href)
      return true
    } catch (err) {
      console.error('[openAttachment] 열기 실패:', err)
      // 폴백: shell.openPath
      const errMsg = await shell.openPath(filePath)
      if (errMsg) {
        console.error('[openAttachment] openPath도 실패:', errMsg)
        return false
      }
      return true
    }
  })

  // ── 클립보드 이미지 저장 (스크린샷 붙여넣기) ──
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

      // 백그라운드 동기화
      Sync.syncAttachmentFile(attachDir, fileName)
      return { name: 'screenshot.png', path: fileName, size }
    } catch (err) {
      console.error('saveClipboardImage error:', err)
      return null
    }
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

  // ── 달력 패널 너비 영속화 ──
  ipcMain.handle('app:getCalendarWidth', () => config.calendarWidth ?? 420)
  ipcMain.handle('app:setCalendarWidth', (_e, width: number) => {
    config.calendarWidth = width
    saveConfig(config)
  })

  // ── 알람 ──
  ipcMain.handle('db:getAlarms', (_e, dayId: string) => {
    try { return Q.getAlarmsByDay(db, dayId) }
    catch (err) { console.error('getAlarms error:', err); return [] }
  })

  ipcMain.handle('db:upsertAlarm', (_e, alarm: Q.AlarmRow) => {
    try {
      Q.upsertAlarm(db, alarm)
      Sync.syncAlarm(alarm)
      // 알람 저장 즉시 체크 (30초 주기를 기다리지 않음)
      checkAlarms()
      return true
    }
    catch (err) { console.error('upsertAlarm error:', err); return false }
  })

  ipcMain.handle('db:deleteAlarm', (_e, id: string) => {
    try {
      Q.deleteAlarm(db, id)
      Sync.syncDeleteAlarm(id)
      return true
    }
    catch (err) { console.error('deleteAlarm error:', err); return false }
  })

  ipcMain.handle('db:getAlarmDaysByMonth', (_e, yearMonth: string) => {
    try { return Q.getAlarmDaysByMonth(db, yearMonth) }
    catch (err) { console.error('getAlarmDaysByMonth error:', err); return [] }
  })

  ipcMain.handle('db:getUpcomingAlarms', (_e, todayStr: string) => {
    try { return Q.getUpcomingAlarms(db, todayStr) }
    catch (err) { console.error('getUpcomingAlarms error:', err); return [] }
  })

  // ── 동기화 ──
  ipcMain.handle('sync:now', async () => {
    if (!Sync.isOnline() || !db) return { ok: false, reason: 'offline' }
    if (Sync.isSyncing()) return { ok: false, reason: 'already_syncing' }
    const reachable = await Sync.checkConnection()
    if (!reachable) return { ok: false, reason: 'unreachable' }
    try {
      const { pulled, pushed, cleaned, syncedAt } = await Sync.fullSync(db!, config.lastSyncAt)
      // syncedAt이 0이면 lastSyncAt을 덮어쓰지 않음 (동기화 실패/중복 방지)
      if (syncedAt > 0) {
        config.lastSyncAt = syncedAt
        saveConfig(config)
      }
      // 첨부파일 동기화
      const attachDir = join(config.dataPath, 'attachments')
      await Sync.pullAttachmentFiles(attachDir)
      await Sync.pushAttachmentFiles(attachDir)

      if (pulled > 0 || pushed > 0 || cleaned > 0) {
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('sync:done'))
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
      lastSyncAt: config.lastSyncAt ?? 0,
    }
  })

  // ── 인증 (GoTrue) ──
  const AUTH_URLS = [
    process.env.VITE_SUPABASE_URL,       // Tailscale VPN IP (원격)
    'http://localhost:8000',               // 로컬 (같은 PC)
  ].filter(Boolean) as string[]
  let AUTH_BASE = AUTH_URLS[0]
  const AUTH_KEY = process.env.VITE_SUPABASE_ANON_KEY

  // 앱 시작 시 접속 가능한 서버 자동 탐색
  async function detectAuthBase() {
    for (const base of AUTH_URLS) {
      try {
        const res = await net.fetch(`${base}/auth/v1/`, { method: 'GET', headers: { 'apikey': AUTH_KEY || '' } })
        if (res.status > 0) { AUTH_BASE = base; console.log('[auth] 서버 연결:', base); return }
      } catch { /* 다음 URL 시도 */ }
    }
    console.warn('[auth] 모든 서버 연결 실패, 기본값 사용:', AUTH_BASE)
  }
  detectAuthBase()

  async function authFetch(path: string, opts: { method?: string; body?: unknown; token?: string; timeout?: number } = {}) {
    const url = `${AUTH_BASE}/auth/v1${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'apikey': AUTH_KEY || '',
    }
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeout ?? 5000)
    try {
      const res = await net.fetch(url, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      })
      const text = await res.text()
      try { return { ok: res.ok, status: res.status, data: JSON.parse(text) } }
      catch { return { ok: res.ok, status: res.status, data: text } }
    } finally {
      clearTimeout(timer)
    }
  }

  // 회원가입
  ipcMain.handle('auth:signup', async (_e, email: string, password: string) => {
    try {
      console.log('[auth:signup] URL:', `${AUTH_BASE}/auth/v1/signup`, 'KEY:', AUTH_KEY?.slice(0, 20) + '...')
      const res = await authFetch('/signup', {
        method: 'POST',
        body: { email, password }
      })
      console.log('[auth:signup] status:', res.status, 'ok:', res.ok, 'data:', JSON.stringify(res.data).slice(0, 200))
      if (!res.ok) return { ok: false, error: res.data?.msg || res.data?.error_description || '회원가입 실패' }
      return { ok: true }
    } catch (err) {
      console.error('[auth:signup] error:', err)
      return { ok: false, error: `서버 연결 실패: ${err}` }
    }
  })

  // 로그인 (다중 기기 세션 허용)
  ipcMain.handle('auth:login', async (_e, email: string, password: string) => {
    try {
      const res = await authFetch('/token?grant_type=password', {
        method: 'POST',
        body: { email, password }
      })
      if (!res.ok) return { ok: false, error: res.data?.msg || res.data?.error_description || '로그인 실패' }

      const token = res.data.access_token
      const refresh = res.data.refresh_token
      const user = res.data.user

      // config에 저장
      config.authToken = token
      config.authRefreshToken = refresh
      config.authUser = { id: user.id, email: user.email }
      saveConfig(config)

      // 동기화에 사용자 ID + GoTrue 세션 전달
      Sync.setUserId(user.id)
      await Sync.setAuthSession(token, refresh)

      return { ok: true, user: { id: user.id, email: user.email } }
    } catch (err) {
      return { ok: false, error: `서버 연결 실패: ${err}` }
    }
  })

  // 로그아웃 (현재 기기만 — 다른 기기 세션 유지)
  ipcMain.handle('auth:logout', async () => {
    try {
      const token = config.authToken
      if (token) {
        await authFetch('/logout?scope=local', { method: 'POST', token })
      }
    } catch { /* 무시 */ }
    config.authToken = undefined
    config.authRefreshToken = undefined
    config.authUser = undefined
    saveConfig(config)
    Sync.setUserId(null)
    await Sync.clearAuthSession()
    return { ok: true }
  })

  // 현재 세션 확인
  ipcMain.handle('auth:getSession', async () => {
    const token = config.authToken
    const refreshToken = config.authRefreshToken
    const user = config.authUser

    if (!token || !user) {
      Sync.setUserId(null)
      return { authenticated: false }
    }
    // 토큰 유효성 확인
    try {
      const res = await authFetch('/user', { token })
      if (res.ok) {
        Sync.setUserId(user.id)
        if (refreshToken) await Sync.setAuthSession(token, refreshToken)
        return { authenticated: true, user }
      }
      // 토큰 만료 → refresh 시도
      if (refreshToken) {
        const refresh = await authFetch('/token?grant_type=refresh_token', {
          method: 'POST',
          body: { refresh_token: refreshToken }
        })
        if (refresh.ok) {
          config.authToken = refresh.data.access_token
          config.authRefreshToken = refresh.data.refresh_token
          config.authUser = { id: refresh.data.user.id, email: refresh.data.user.email }
          saveConfig(config)
          Sync.setUserId(refresh.data.user.id)
          await Sync.setAuthSession(refresh.data.access_token, refresh.data.refresh_token)
          return { authenticated: true, user: config.authUser }
        }
      }
      // refresh도 실패 → 로그아웃
      config.authToken = undefined
      config.authRefreshToken = undefined
      config.authUser = undefined
      saveConfig(config)
      Sync.setUserId(null)
      return { authenticated: false, reason: 'session_expired' }
    } catch {
      // 서버 연결 불가 → 오프라인 인증
      Sync.setUserId(user.id)
      return { authenticated: true, user, offline: true }
    }
  })

  // ── 로그인 정보 기억 (safeStorage 암호화) ──
  ipcMain.handle('auth:saveCredentials', (_e, email: string, password: string) => {
    try {
      config.savedEmail = email
      if (safeStorage.isEncryptionAvailable()) {
        config.savedPasswordEnc = safeStorage.encryptString(password).toString('base64')
      } else {
        config.savedPasswordEnc = Buffer.from(password).toString('base64')
      }
      saveConfig(config)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('auth:getCredentials', () => {
    if (!config.savedEmail || !config.savedPasswordEnc) return { ok: false }
    try {
      let password: string
      if (safeStorage.isEncryptionAvailable()) {
        password = safeStorage.decryptString(Buffer.from(config.savedPasswordEnc, 'base64'))
      } else {
        password = Buffer.from(config.savedPasswordEnc, 'base64').toString()
      }
      return { ok: true, email: config.savedEmail, password }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('auth:clearCredentials', () => {
    config.savedEmail = undefined
    config.savedPasswordEnc = undefined
    saveConfig(config)
    return { ok: true }
  })

  // ── OneDrive DB 동기화 ──
  ipcMain.handle('onedrive:getConfig', () => ({
    enabled: config.onedriveSyncEnabled ?? false,
    path: config.onedriveSyncPath ?? '',
  }))

  ipcMain.handle('onedrive:setPath', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false }
    const result = await dialog.showOpenDialog(win, {
      title: 'OneDrive 동기화 폴더 선택',
      properties: ['openDirectory'],
      defaultPath: config.onedriveSyncPath || join(process.env.USERPROFILE || '', 'OneDrive'),
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false }
    config.onedriveSyncPath = result.filePaths[0]
    config.onedriveSyncEnabled = true
    saveConfig(config)
    startOneDriveSync()
    return { ok: true, path: config.onedriveSyncPath }
  })

  ipcMain.handle('onedrive:setEnabled', (_e, enabled: boolean) => {
    config.onedriveSyncEnabled = enabled
    saveConfig(config)
    if (enabled) startOneDriveSync()
    else stopOneDriveSync()
    return { ok: true }
  })

  ipcMain.handle('onedrive:export', () => {
    const result = exportDbToOneDrive()
    if (result.ok) scheduleOneDriveExport() // 타이머 리셋
    return result
  })

  ipcMain.handle('onedrive:import', () => {
    return importDbFromOneDrive()
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
  // 이미 실행 중인 인스턴스가 있으면 즉시 종료
  try { appendFileSync(crashLogPath, `[${new Date().toISOString()}] SingleInstanceLock 실패 — 다른 인스턴스 실행 중. 종료합니다.\n`) } catch {}
  app.quit()
}

app.on('second-instance', () => {
  // 두 번째 인스턴스가 실행되면, 기존 창을 포커스
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

app.whenReady().then(() => {
  db = openDatabase()
  oneDrivePullIfNewer()        // OneDrive DB가 더 최신이면 가져오기
  Q.refreshAllSummaries(db)   // summary 캐시 재계산 (마크다운 태그 제거 반영)
  registerIpcHandlers()
  startAutoBackup()
  startOneDriveSync()          // OneDrive 자동 동기화 시작
  startAlarmChecker()
  createTray()
  createWindow()

  // ── 하이브리드 동기화 (Supabase + OneDrive) ──
  const syncLogPath = join(app.getPath('userData'), 'sync.log')
  const syncLog = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    console.log(msg)
    try { writeFileSync(syncLogPath, line, { flag: 'a' }) } catch {}
  }

  Sync.setLogFn(syncLog)
  const HEALTH_CHECK_MS = 60 * 1000        // 1분마다 연결 상태 체크
  let wasReachable = false

  /** 저장된 credentials로 자동 재로그인 */
  async function autoReLogin(): Promise<boolean> {
    if (!config.savedEmail || !config.savedPasswordEnc) return false
    try {
      let password: string
      if (safeStorage.isEncryptionAvailable()) {
        password = safeStorage.decryptString(Buffer.from(config.savedPasswordEnc, 'base64'))
      } else {
        password = Buffer.from(config.savedPasswordEnc, 'base64').toString()
      }
      syncLog('[autoReLogin] 저장된 credentials로 재로그인 시도...')
      // GoTrue 인증 API 직접 호출 (authFetch는 다른 스코프에 있으므로 net.fetch 사용)
      const authBase = process.env.VITE_SUPABASE_URL || 'http://localhost:8000'
      const authKey = process.env.VITE_SUPABASE_ANON_KEY || ''
      const fetchRes = await net.fetch(`${authBase}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': authKey },
        body: JSON.stringify({ email: config.savedEmail, password })
      })
      const text = await fetchRes.text()
      let data: Record<string, unknown>
      try { data = JSON.parse(text) } catch { data = {} }
      if (!fetchRes.ok) {
        syncLog(`[autoReLogin] 실패: ${(data as any)?.error_description || fetchRes.status}`)
        return false
      }
      const { access_token, refresh_token, user } = data as any
      config.authToken = access_token
      config.authRefreshToken = refresh_token
      config.authUser = { id: user.id, email: user.email }
      saveConfig(config)
      Sync.setUserId(user.id)
      await Sync.setAuthSession(access_token, refresh_token)
      syncLog('[autoReLogin] 성공')
      return true
    } catch (err) {
      syncLog(`[autoReLogin] 에러: ${err}`)
      return false
    }
  }

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

      // 인증 실패 시 저장된 credentials로 자동 재로그인 후 재시도
      if (authFailed) {
        syncLog('인증 실패 → 자동 재로그인 시도')
        const ok = await autoReLogin()
        if (ok) {
          syncLog('재로그인 성공 → fullSync 재시도')
          const retry = await Sync.fullSync(db!, config.lastSyncAt)
          if (retry.syncedAt > 0) {
            config.lastSyncAt = retry.syncedAt
            saveConfig(config)
          }
          if (retry.pulled > 0 || retry.pushed > 0 || retry.cleaned > 0) {
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send('sync:done'))
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

      // 첨부파일 동기화
      const attachDir = join(config.dataPath, 'attachments')
      const filePulled = await Sync.pullAttachmentFiles(attachDir)
      const filePushed = await Sync.pushAttachmentFiles(attachDir)

      if (pulled > 0 || pushed > 0 || filePulled > 0 || filePushed > 0) {
        syncLog(`fullSync: pulled=${pulled}, pushed=${pushed}, files: pulled=${filePulled}, pushed=${filePushed}`)
      }
      broadcastSyncStatus('online')
      if (pulled > 0 || pushed > 0 || cleaned > 0 || filePulled > 0) {
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('sync:done'))
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

    // 저장된 토큰으로 Supabase 세션 복원
    if (online && config.authToken && config.authRefreshToken) {
      await Sync.setAuthSession(config.authToken, config.authRefreshToken)
      syncLog('Supabase 세션 복원 완료 (저장된 토큰)')
    }

    // 토큰이 없지만 저장된 credentials가 있으면 → 자동 재로그인
    if (online && !Sync.getUserId() && config.savedEmail && config.savedPasswordEnc) {
      syncLog('토큰 없음 → 저장된 credentials로 자동 로그인 시도')
      const ok = await autoReLogin()
      if (ok) {
        syncLog(`자동 로그인 성공 — userId: ${Sync.getUserId()}`)
      } else {
        syncLog('자동 로그인 실패 → 수동 로그인 필요')
      }
    }

    if (Sync.isOnline() && db) {
      // 앱 시작 3초 후 첫 동기화 + Realtime 구독 시작
      setTimeout(async () => {
        await runSync()
        // Realtime 구독: userId가 있을 때만 시작
        const startRealtimeIfReady = () => {
          const uid = Sync.getUserId()
          if (uid && db) {
            syncLog(`[Realtime] userId=${uid} — 실시간 구독 시작`)
            Sync.startRealtime(db, () => {
              syncLog('[Realtime] 변경 감지 → UI 갱신')
              BrowserWindow.getAllWindows().forEach(w => w.webContents.send('sync:done'))
            })
          } else {
            syncLog(`[Realtime] userId 없음 — 1초 후 재시도`)
            setTimeout(startRealtimeIfReady, 1000)
          }
        }
        startRealtimeIfReady()
      }, 3000)

      // 경량 폴링: 5초 간격 (Realtime이 메인, quickPull은 fallback)
      setInterval(async () => {
        if (!db || !Sync.isOnline()) return
        try {
          const pulled = await Sync.quickPull(db)
          if (pulled > 0) {
            BrowserWindow.getAllWindows().forEach(w => w.webContents.send('sync:done'))
          }
        } catch {}
      }, 5000)

      // 전체 동기화: 10초 간격 (push + 삭제 감지 + 첨부파일)
      setInterval(() => runSync(), 10000)

      // 1분마다 연결 상태 체크 (오프라인→온라인 전환 시 즉시 동기화 + Realtime 재연결)
      setInterval(async () => {
        const nowReachable = await Sync.checkConnection()
        broadcastSyncStatus(nowReachable ? 'online' : 'offline')
        if (nowReachable && !wasReachable) {
          syncLog('네트워크 복구 감지 → 즉시 동기화 + Realtime 재연결')
          runSync()
          Sync.reconnectRealtime()
        } else if (nowReachable && !Sync.isRealtimeConnected()) {
          // 서버 연결은 되는데 Realtime이 끊겨 있으면 재연결
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
  // 종료 시 마지막 백업 실행
  try { runAutoBackup() } catch (e) { console.error('Exit backup failed:', e) }
  // 종료 시 OneDrive로 내보내기
  try { exportDbToOneDrive() } catch (e) { console.error('Exit OneDrive export failed:', e) }
  stopAutoBackup()
  stopOneDriveSync()
  stopAlarmChecker()
})

app.on('window-all-closed', () => {
  // 트레이 모드에서는 창이 닫혀도 앱 종료하지 않음
  if (!isQuitting) return
  stopAutoBackup()
  db?.close()
  if (process.platform !== 'darwin') app.quit()
})
