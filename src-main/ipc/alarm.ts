/**
 * 알람 관련 IPC 핸들러 + 알람 체크 로직
 */
import { ipcMain, BrowserWindow, Notification, nativeImage } from 'electron'
import type Database from 'better-sqlite3'
import * as Q from '../db/queries'
import * as Sync from '../sync'

interface AlarmDeps {
  getDb: () => Database.Database
  config: { [key: string]: unknown }
  saveConfig: (cfg: any) => void
  getIconPath: () => string
  scheduleOneDriveExport: () => void
}

let deps: AlarmDeps
let alarmInterval: ReturnType<typeof setInterval> | null = null
let lastResetDate = ''
let appStartTime = '' // 앱 시작 시각 (HH:MM) — 시작 전 알람은 무시

function checkAlarms(): void {
  const db = deps.getDb()
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

    // 지난 날짜의 일회성 알람은 즉시 fired 처리 (울리지 않고 정리만)
    for (const alarm of allAlarms) {
      if (alarm.repeat === 'none' && alarm.day_id < todayStr && alarm.fired === 0) {
        console.log(`[alarm] 지난 날짜 일회성 알람 정리: id=${alarm.id}, day_id=${alarm.day_id}`)
        Q.markAlarmFired(db, alarm.id)
      }
    }

    // Windows 알림 지원 여부 체크
    const notifSupported = Notification.isSupported()

    // 정리 후 남은 알람만 체크
    const activeAlarms = allAlarms.filter(a => !(a.repeat === 'none' && a.day_id < todayStr))

    for (const alarm of activeAlarms) {
      const shouldFire = shouldAlarmFire(alarm, todayStr, currentTime, todayDow)

      if (shouldFire) {
        // 앱 시작 전에 이미 지난 알람은 소리 없이 fired만 처리 (앱 켤 때 과거 알람 울리는 것 방지)
        if (appStartTime && alarm.time < appStartTime) {
          console.log(`[alarm] 시작 전 알람 무시: id=${alarm.id}, time=${alarm.time} < appStart=${appStartTime}`)
          Q.markAlarmFired(db, alarm.id)
          continue
        }

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
              icon: deps.getIconPath(),
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
      // 일회성: 정확히 오늘 날짜만 울림 (지난 날짜 절대 불가)
      return alarm.day_id === todayStr
    case 'daily':
      // 매일: 설정일 이후, 오늘 날짜에만 울림 (day_id가 미래면 불가)
      return alarm.day_id <= todayStr
    case 'weekdays':
      // 평일: 설정일 이후 + 월~금만
      return alarm.day_id <= todayStr && todayDow >= 1 && todayDow <= 5
    case 'weekly': {
      // 매주: 설정일 이후 + 같은 요일만
      if (alarm.day_id > todayStr) return false
      const origDate = new Date(alarm.day_id + 'T00:00:00')
      return origDate.getDay() === todayDow
    }
    default:
      // 알 수 없는 repeat 값 → 일회성처럼 취급
      return alarm.day_id === todayStr
  }
}

export function startAlarmChecker(): void {
  if (!deps) return
  const now = new Date()
  appStartTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  checkAlarms()
  alarmInterval = setInterval(checkAlarms, 30 * 1000)
}

export function stopAlarmChecker(): void {
  if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null }
}

export function registerAlarmHandlers(d: AlarmDeps): void {
  deps = d

  ipcMain.handle('db:getAlarms', (_e, dayId: string) => {
    try { return Q.getAlarmsByDay(deps.getDb(), dayId) }
    catch (err) { console.error('getAlarms error:', err); return [] }
  })

  ipcMain.handle('db:upsertAlarm', (_e, alarm: Q.AlarmRow) => {
    try {
      Q.upsertAlarm(deps.getDb(), alarm)
      Sync.syncAlarm(alarm)
      // 알람 저장 즉시 체크 (30초 주기를 기다리지 않음)
      checkAlarms()
      return true
    }
    catch (err) { console.error('upsertAlarm error:', err); return false }
  })

  ipcMain.handle('db:deleteAlarm', (_e, id: string) => {
    try {
      Q.deleteAlarm(deps.getDb(), id)
      Sync.syncDeleteAlarm(id)
      return true
    }
    catch (err) { console.error('deleteAlarm error:', err); return false }
  })

  ipcMain.handle('db:getAlarmDaysByMonth', (_e, yearMonth: string) => {
    try { return Q.getAlarmDaysByMonth(deps.getDb(), yearMonth) }
    catch (err) { console.error('getAlarmDaysByMonth error:', err); return [] }
  })

  ipcMain.handle('db:getUpcomingAlarms', (_e, todayStr: string) => {
    try { return Q.getUpcomingAlarms(deps.getDb(), todayStr) }
    catch (err) { console.error('getUpcomingAlarms error:', err); return [] }
  })
}
