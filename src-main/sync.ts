/**
 * Supabase 동기화 서비스
 * - 로컬 SQLite ↔ Supabase PostgreSQL 양방향 동기화
 * - updated_at 기준 "마지막 수정 우선" 전략
 * - user_id 기반 사용자별 데이터 분리
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type Database from 'better-sqlite3'
import type { NoteDayRow, NoteItemRow, AlarmRow } from './db/queries'
import { getTombstones, clearTombstones, isTombstoned, addTombstone } from './db/queries'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
import WebSocket from 'ws'

let supabase: SupabaseClient | null = null
let supabaseRealtime: SupabaseClient | null = null  // Realtime 전용 (service_role)
let syncing = false
let quickPulling = false
let reachable = false
let currentUserId: string | null = null
let realtimeChannel: ReturnType<SupabaseClient['channel']> | null = null
let realtimeDb: Database.Database | null = null
let onRealtimeChange: (() => void) | null = null
let _logFn: ((msg: string) => void) | null = null

/** sync 내부 로그를 외부(main.ts의 syncLog)로 전달하는 설정 */
export function setLogFn(fn: (msg: string) => void): void {
  _logFn = fn
}

function slog(msg: string): void {
  console.log(msg)
  if (_logFn) _logFn(msg)
}

/** 단건 sync 실패 시 재시도 큐 */
interface PendingSync {
  action: 'upsert' | 'delete'
  table: string
  data?: Record<string, unknown>
  id?: string
}
const pendingSyncQueue: PendingSync[] = []

export function setUserId(userId: string | null) {
  currentUserId = userId
}

export function getUserId(): string | null {
  return currentUserId
}

/** GoTrue 토큰을 Supabase 클라이언트에 설정 (JWT 기반 RLS용) */
export async function setAuthSession(accessToken: string, refreshToken: string): Promise<void> {
  if (!supabase) return
  await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
}

/** Supabase 클라이언트 세션 해제 */
export async function clearAuthSession(): Promise<void> {
  if (!supabase) return
  await supabase.auth.signOut()
}

// service_role key (self-hosted용 — Realtime RLS 우회)
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

export async function initSync(): Promise<boolean> {
  const urls = [
    process.env.VITE_SUPABASE_URL,
    'http://localhost:8000',
    'http://100.122.232.19:8000',
    'http://192.168.45.152:8000',
  ].filter((v, i, a) => v && a.indexOf(v) === i) as string[]
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!urls.length || !key) {
    console.log('[Sync] Supabase 설정 없음 — OneDrive 전용 모드')
    return false
  }
  // 접속 가능한 서버 자동 탐색
  for (const url of urls) {
    try {
      const res = await fetch(`${url}/rest/v1/`, { method: 'HEAD', headers: { 'apikey': key }, signal: AbortSignal.timeout(3000) })
      if (res.status >= 200 && res.status < 500) {
        supabase = createClient(url, key, {
          realtime: {
            params: { apikey: key },
            heartbeatIntervalMs: 15000,
            reconnectAfterMs: (tries: number) => Math.min(1000 * Math.pow(2, tries), 30000),
          },
        })
        // Realtime 전용 클라이언트 (service_role — RLS 우회하여 모든 이벤트 수신)
        supabaseRealtime = createClient(url, SERVICE_ROLE_KEY, {
          realtime: {
            params: { apikey: SERVICE_ROLE_KEY },
            heartbeatIntervalMs: 15000,
            reconnectAfterMs: (tries: number) => Math.min(1000 * Math.pow(2, tries), 30000),
            timeout: 30000,
            transport: WebSocket as any,
          },
        })
        console.log('[Sync] Supabase 연결:', url)
        return true
      }
    } catch { /* 다음 URL 시도 */ }
  }
  // 모든 URL 실패 시 기본값으로 초기화
  supabase = createClient(urls[0], key, {
    realtime: {
      params: { apikey: key },
      heartbeatIntervalMs: 15000,
      reconnectAfterMs: (tries: number) => Math.min(1000 * Math.pow(2, tries), 30000),
    },
  })
  supabaseRealtime = createClient(urls[0], SERVICE_ROLE_KEY, {
    realtime: {
      params: { apikey: SERVICE_ROLE_KEY },
      heartbeatIntervalMs: 15000,
      reconnectAfterMs: (tries: number) => Math.min(1000 * Math.pow(2, tries), 30000),
      timeout: 30000,
      transport: WebSocket as any,
    },
  })
  console.log('[Sync] 서버 응답 없음, 기본값 사용:', urls[0])
  return true
}

export function isOnline(): boolean {
  return supabase !== null
}

export function isReachable(): boolean {
  return reachable
}

export function isSyncing(): boolean {
  return syncing
}

/* ────────────── Supabase Realtime (실시간 동기화) ────────────── */

let realtimeRetryCount = 0
let realtimeRetryTimer: ReturnType<typeof setTimeout> | null = null
let realtimeSubscribed = false

/** Realtime 구독이 활성 상태인지 확인 */
export function isRealtimeConnected(): boolean {
  return realtimeSubscribed && realtimeChannel !== null
}

/** Realtime 구독 시작 — DB 변경 시 즉시 로컬 반영 + UI 갱신 콜백 호출 */
export function startRealtime(db: Database.Database, onChange: () => void): void {
  slog('[Realtime] startRealtime 호출 — supabaseRealtime:' + !!supabaseRealtime + ' userId:' + currentUserId)
  if (!supabaseRealtime || !currentUserId) return

  // 이미 구독 중이면 중복 시작 방지
  if (realtimeSubscribed && realtimeChannel) {
    slog('[Realtime] 이미 구독 중 — 스킵')
    return
  }

  stopRealtime()

  realtimeDb = db
  onRealtimeChange = onChange
  realtimeRetryCount = 0

  connectRealtime()
}

/** 실제 Realtime 채널 연결 (내부용) */
function connectRealtime(): void {
  if (!supabaseRealtime || !currentUserId || !realtimeDb) return

  // 이전 retry 타이머 취소
  if (realtimeRetryTimer) {
    clearTimeout(realtimeRetryTimer)
    realtimeRetryTimer = null
  }

  // 기존 채널 정리
  if (realtimeChannel) {
    try { supabaseRealtime.removeChannel(realtimeChannel) } catch {}
    realtimeChannel = null
  }
  realtimeSubscribed = false

  slog(`[Realtime] 채널 생성 중...`)

  realtimeChannel = supabaseRealtime
    .channel('sync-realtime')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'note_day', filter: `user_id=eq.${currentUserId}` },
      (payload) => handleRealtimeEvent('note_day', payload)
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'note_item', filter: `user_id=eq.${currentUserId}` },
      (payload) => handleRealtimeEvent('note_item', payload)
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'alarm', filter: `user_id=eq.${currentUserId}` },
      (payload) => handleRealtimeEvent('alarm', payload)
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        realtimeSubscribed = true
        realtimeRetryCount = 0
        slog('[Realtime] ✅ 구독 성공 — 실시간 동기화 활성')
      } else if (status === 'CHANNEL_ERROR') {
        realtimeSubscribed = false
        realtimeRetryCount++
        // 지수 백오프: 5s, 10s, 20s, 40s, 최대 60s
        const delay = Math.min(5000 * Math.pow(2, realtimeRetryCount - 1), 60000)
        slog(`[Realtime] ❌ 채널 에러 (${realtimeRetryCount}회) — ${delay / 1000}초 후 재시도` + (err ? ` 에러: ${err.message}` : ''))
        realtimeRetryTimer = setTimeout(() => {
          if (realtimeDb && onRealtimeChange) connectRealtime()
        }, delay)
      } else if (status === 'TIMED_OUT') {
        realtimeSubscribed = false
        slog('[Realtime] ⏰ 타임아웃 — 10초 후 재연결')
        realtimeRetryTimer = setTimeout(() => {
          if (realtimeDb && onRealtimeChange) connectRealtime()
        }, 10000)
      } else if (status === 'CLOSED') {
        realtimeSubscribed = false
        slog('[Realtime] 🔒 채널 닫힘')
      } else {
        slog('[Realtime] 상태: ' + status)
      }
    })
}

/** Realtime 강제 재연결 (외부에서 호출 — 네트워크 복구 시) */
export function reconnectRealtime(): void {
  if (!realtimeDb || !onRealtimeChange) return
  slog('[Realtime] 강제 재연결 요청')
  realtimeSubscribed = false
  realtimeRetryCount = 0
  connectRealtime()
}

/** Realtime 구독 중지 */
export function stopRealtime(): void {
  if (realtimeRetryTimer) {
    clearTimeout(realtimeRetryTimer)
    realtimeRetryTimer = null
  }
  realtimeSubscribed = false
  if (realtimeChannel && supabaseRealtime) {
    try { supabaseRealtime.removeChannel(realtimeChannel) } catch {}
    realtimeChannel = null
    slog('[Realtime] 구독 해제')
  }
}

/** Realtime 이벤트 핸들러 — INSERT/UPDATE는 로컬 upsert, DELETE는 로컬 삭제 */
function handleRealtimeEvent(table: string, payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }): void {
  if (!realtimeDb) return
  const { eventType } = payload

  try {
    if (eventType === 'DELETE') {
      const oldRow = payload.old as Record<string, unknown>
      const id = oldRow.id as string
      if (!id) {
        slog(`[Realtime] ${table} DELETE 이벤트에 id 없음 (replica identity 확인 필요): ${JSON.stringify(payload.old)}`)
        return
      }
      const info = realtimeDb.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
      // tombstone 기록: pushChanges에서 삭제된 아이템을 재업로드하는 것 방지
      addTombstone(realtimeDb, table, id)
      // note_item 삭제 시 day 카운트 갱신 (preserveUpdatedAt: push 핑퐁 방지)
      if (table === 'note_item' && oldRow.day_id) {
        updateDayCount(realtimeDb, oldRow.day_id as string, true)
      }
      slog(`[Realtime] ${table} 삭제+tombstone: ${id} (changes=${info.changes})`)
    } else {
      // INSERT or UPDATE
      const row = payload.new as Record<string, unknown>
      if (!row.id) return
      // tombstone에 있는 아이템이면 무시 (삭제한 아이템이 되살아나는 것 방지)
      if (isTombstoned(realtimeDb, table, row.id as string)) {
        console.log(`[Realtime] ${table} ${eventType} 무시 (tombstone): ${row.id}`)
        return
      }
      applyRealtimeUpsert(realtimeDb, table, row)
      slog(`[Realtime] ${table} ${eventType}: ${row.id}`)
    }

    // UI 갱신 콜백
    if (onRealtimeChange) onRealtimeChange()
  } catch (err) {
    console.error(`[Realtime] ${table} 처리 실패:`, err)
  }
}

/** 단건 upsert (Realtime 이벤트용) */
function applyRealtimeUpsert(db: Database.Database, table: string, row: Record<string, unknown>): void {
  if (table === 'note_day') {
    db.prepare(`
      INSERT INTO note_day (id, mood, summary, note_count, has_notes, updated_at)
      VALUES (@id, @mood, @summary, @note_count, @has_notes, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        mood=@mood, summary=@summary, note_count=@note_count,
        has_notes=@has_notes, updated_at=@updated_at
      WHERE @updated_at > note_day.updated_at
    `).run(row)
  } else if (table === 'note_item') {
    // day_id에 해당하는 note_day가 없으면 생성
    db.prepare(`INSERT OR IGNORE INTO note_day (id, note_count, has_notes, updated_at) VALUES (@id, 0, 0, @updated_at)`)
      .run({ id: row.day_id, updated_at: row.updated_at })
    db.prepare(`
      INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        type=@type, content=@content, tags=@tags, pinned=@pinned,
        order_index=@order_index, updated_at=@updated_at
      WHERE @updated_at > note_item.updated_at
    `).run(row)
    updateDayCount(db, row.day_id as string, true)
  } else if (table === 'alarm') {
    db.prepare(`
      INSERT INTO alarm (id, day_id, time, label, repeat, enabled, fired, created_at, updated_at)
      VALUES (@id, @day_id, @time, @label, @repeat, @enabled, @fired, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        day_id=@day_id, time=@time, label=@label, repeat=@repeat,
        enabled=@enabled, fired=@fired, updated_at=@updated_at
      WHERE @updated_at > alarm.updated_at
    `).run(row)
  }
}

/** note_item 변경 시 해당 day의 note_count/has_notes 갱신 */
function updateDayCount(db: Database.Database, dayId: string, preserveUpdatedAt = false): void {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM note_item WHERE day_id = ?').get(dayId) as { cnt: number }
  if (row.cnt === 0) {
    const day = db.prepare('SELECT mood FROM note_day WHERE id = ?').get(dayId) as { mood: string | null } | undefined
    if (!day?.mood) {
      db.prepare('DELETE FROM note_day WHERE id = ?').run(dayId)
    } else if (preserveUpdatedAt) {
      db.prepare('UPDATE note_day SET note_count = 0, has_notes = 0, summary = NULL WHERE id = ?').run(dayId)
    } else {
      db.prepare('UPDATE note_day SET note_count = 0, has_notes = 0, summary = NULL, updated_at = ? WHERE id = ?').run(Date.now(), dayId)
    }
  } else if (preserveUpdatedAt) {
    db.prepare('UPDATE note_day SET note_count = ?, has_notes = 1 WHERE id = ?').run(row.cnt, dayId)
  } else {
    db.prepare('UPDATE note_day SET note_count = ?, has_notes = 1, updated_at = ? WHERE id = ?').run(row.cnt, Date.now(), dayId)
  }
}

/** 로컬 note_day 캐시를 실제 note_item 기준으로 전체 재계산 (updated_at 변경 안 함 — push 핑퐁 방지) */
function recalcAllDayCounts(db: Database.Database): void {
  const allDays = db.prepare('SELECT id, mood, note_count, updated_at FROM note_day').all() as Array<{ id: string; mood: string | null; note_count: number; updated_at: number }>
  for (const day of allDays) {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM note_item WHERE day_id = ?').get(day.id) as { cnt: number }
    if (row.cnt !== day.note_count) {
      if (row.cnt === 0 && !day.mood) {
        db.prepare('DELETE FROM note_day WHERE id = ?').run(day.id)
      } else {
        // updated_at을 기존 값 유지 — 캐시 재계산은 로컬 전용이므로 서버 push 트리거 방지
        db.prepare('UPDATE note_day SET note_count = ?, has_notes = ?, summary = CASE WHEN ? = 0 THEN NULL ELSE summary END WHERE id = ?')
          .run(row.cnt, row.cnt > 0 ? 1 : 0, row.cnt, day.id)
      }
    }
  }
}

/** Supabase 서버 도달 가능 여부 확인 (빠른 health check) */
export async function checkConnection(): Promise<boolean> {
  if (!supabase) { reachable = false; return false }
  try {
    const { error } = await supabase.from('note_day').select('id').limit(1)
    reachable = !error
  } catch {
    reachable = false
  }
  return reachable
}

/* ────────────── 경량 폴링 (quickPull) — Realtime 보완 ────────────── */

let lastQuickPullAt = 0

/**
 * quickPull — fullSync 대신 최근 변경만 빠르게 가져오는 경량 동기화
 * 인증 체크 생략, updated_at 기준으로 최근 변경만 조회
 * 반환: pulled 건수 (UI 갱신 필요 여부 판단용)
 */
export async function quickPull(db: Database.Database): Promise<number> {
  if (!supabase || quickPulling || !currentUserId) return 0
  quickPulling = true
  try {
    const since = lastQuickPullAt || (Date.now() - 10000) // 최초는 10초 전부터
    const now = Date.now()

    // note_item 변경분 조회 (추가/수정 감지 — 삭제는 fullSync 3초 간격에서 처리)
    const { data: items, error: e2 } = await supabase.from('note_item').select('*').eq('user_id', currentUserId).gt('updated_at', since)

    if (e2) return 0

    const remoteItems = (items ?? []) as NoteItemRow[]

    if (remoteItems.length === 0) {
      lastQuickPullAt = now
      return 0
    }

    let count = 0
    const tombstones = getTombstones(db)
    const tombstoneSet = new Set(tombstones.map(t => `${t.table_name}:${t.item_id}`))

    db.transaction(() => {
      for (const ri of remoteItems) {
        if (tombstoneSet.has(`note_item:${ri.id}`)) continue
        db.prepare(`INSERT OR IGNORE INTO note_day (id, note_count, has_notes, updated_at) VALUES (@id, 0, 0, @updated_at)`)
          .run({ id: ri.day_id, updated_at: ri.updated_at })
        const info = db.prepare(`
          INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
          VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            type=@type, content=@content, tags=@tags, pinned=@pinned,
            order_index=@order_index, updated_at=@updated_at
          WHERE @updated_at > note_item.updated_at
        `).run(ri)
        if (info.changes > 0) {
          updateDayCount(db, ri.day_id as string, true)
          count++
        }
      }
    })()

    if (count > 0) slog(`[quickPull] ${count}건 동기화 (items=${remoteItems.length})`)
    lastQuickPullAt = now
    return count
  } catch (err) {
    return 0
  } finally {
    quickPulling = false
  }
}

/* ────────────── 인증 캐싱 ────────────── */

let lastAuthCheckAt = 0
const AUTH_CHECK_INTERVAL = 5 * 60 * 1000  // 5분마다만 서버 인증 확인

/**
 * 증분 동기화 (사용자별)
 */
export async function fullSync(
  db: Database.Database,
  lastSyncAt?: number
): Promise<{ pulled: number; pushed: number; cleaned: number; syncedAt: number; authFailed?: boolean }> {
  if (!supabase || syncing || !currentUserId) {
    if (syncing) slog('[Sync] 스킵 (이미 syncing)')
    return { pulled: 0, pushed: 0, cleaned: 0, syncedAt: lastSyncAt ?? 0 }
  }
  syncing = true
  const start = Date.now()
  const syncedAt = Date.now()
  try {
    // JWT 세션 확인 — 5분 간격으로만 서버 검증 (매번 하면 느림)
    let authenticated = false
    const now = Date.now()
    if (now - lastAuthCheckAt < AUTH_CHECK_INTERVAL) {
      // 캐시된 인증 사용
      authenticated = true
    } else {
      try {
        const { data: { user }, error: userErr } = await supabase.auth.getUser()
        if (userErr || !user) {
          slog(`[Sync] getUser 실패 (${userErr?.message || '세션 없음'}) → refresh 시도`)
          const { data: refreshData, error: refreshErr } = await supabase.auth.refreshSession()
          if (refreshData?.session) {
            slog('[Sync] 세션 갱신 성공')
            authenticated = true
            lastAuthCheckAt = now
          } else {
            slog(`[Sync] 세션 갱신 실패 (${refreshErr?.message}) → sync 중단 (authFailed=true)`)
            lastAuthCheckAt = 0
            return { pulled: 0, pushed: 0, cleaned: 0, syncedAt: lastSyncAt ?? 0, authFailed: true }
          }
        } else {
          authenticated = true
          lastAuthCheckAt = now
        }
      } catch (sessErr) {
        slog(`[Sync] 세션 확인 실패 → sync 중단: ${sessErr}`)
        lastAuthCheckAt = 0
        return { pulled: 0, pushed: 0, cleaned: 0, syncedAt: lastSyncAt ?? 0, authFailed: true }
      }
    }

    // 0) tombstone 처리 먼저: 로컬에서 삭제된 항목을 원격에서 삭제
    const tombstoneCount = await pushTombstones(db)

    // 1) 원격 전체 데이터 조회 (tombstone 삭제 반영 후 fetch)
    const [{ data: days, error: e1 }, { data: items, error: e2 }, { data: alarms, error: e3 }] = await Promise.all([
      supabase.from('note_day').select('*').eq('user_id', currentUserId),
      supabase.from('note_item').select('*').eq('user_id', currentUserId),
      supabase.from('alarm').select('*').eq('user_id', currentUserId)
    ])
    if (e1) slog(`[Sync] note_day 조회 실패: ${e1.message}`)
    if (e2) slog(`[Sync] note_item 조회 실패: ${e2.message}`)
    if (e3) slog(`[Sync] alarm 조회 실패: ${e3.message}`)
    const remoteDays = (days ?? []) as NoteDayRow[]
    const remoteItems = (items ?? []) as NoteItemRow[]
    const remoteAlarms = (alarms ?? []) as AlarmRow[]
    slog(`[Sync] 원격: ${remoteDays.length}일 + ${remoteItems.length}아이템 + ${remoteAlarms.length}알람 (userId=${currentUserId}, lastSyncAt=${lastSyncAt})`)

    // RLS 안전장치: 서버에서 0건인데 로컬에 데이터가 있으면 인증 문제 가능성
    // → 로컬 데이터를 보호하고 authFailed 반환
    if (remoteDays.length === 0 && remoteItems.length === 0) {
      const localCount = (db.prepare('SELECT COUNT(*) as cnt FROM note_item').get() as { cnt: number }).cnt
      if (localCount > 0) {
        slog(`[Sync] ⚠️ 서버 0건이지만 로컬 ${localCount}건 → RLS 인증 문제 의심 (authFailed=true)`)
        return { pulled: 0, pushed: 0, cleaned: 0, syncedAt: lastSyncAt ?? 0, authFailed: true }
      }
    }

    // 서버 = SSOT: 서버에 없는 로컬 데이터는 삭제 (pull 전에 실행하여 UI 깜빡임 방지)
    // 단, 서버 데이터가 충분히 있을 때만 실행 (0건이면 인증/네트워크 문제 가능)
    let cleaned = 0
    if (authenticated && remoteItems.length > 0) {
      cleaned = cleanDeletedFromRemote(db, remoteDays, remoteItems, lastSyncAt)
    }

    let pulled = applyPull(db, remoteDays, remoteItems, remoteAlarms, db)
    if (pulled > 0) slog(`[Sync] pulled ${pulled}건`)

    // 서버 note_day 캐시 정합성 수정 (모바일이 item 삭제 시 day count를 안 바꾸는 문제 보정)
    if (authenticated) {
      await fixRemoteDayCounts(remoteDays, remoteItems)
    }

    // note_day 캐시를 실제 note_item 기준으로 재계산 (원격과 불일치 방지)
    recalcAllDayCounts(db)

    // Push: 로컬 새 데이터를 원격에 반영 (cleanDeleted 후 실행하여 삭제된 아이템 재업로드 방지)
    // pull에서 이미 조회한 remote 데이터를 재사용 → 서버 재조회 제거 (성능 개선)
    const pushed = await pushChanges(db, lastSyncAt, remoteDays, remoteItems, remoteAlarms)

    slog(`[Sync] 완료: pulled=${pulled}, pushed=${pushed}, cleaned=${cleaned}, tombstones=${tombstoneCount} (${Date.now() - start}ms)`)
    // fullSync 완료 후 quickPull 기준점 갱신 (push가 변경한 데이터를 다시 pull하지 않도록)
    lastQuickPullAt = Date.now()
    return { pulled, pushed, cleaned, syncedAt }
  } catch (err) {
    console.error('[Sync] 동기화 실패:', err)
    return { pulled: 0, pushed: 0, cleaned: 0, syncedAt: lastSyncAt ?? 0 }
  } finally {
    syncing = false
  }
}

/** 원격 데이터를 로컬에 반영 (더 새로운 것만, tombstone 항목은 무시) */
function applyPull(
  db: Database.Database,
  remoteDays: NoteDayRow[],
  remoteItems: NoteItemRow[],
  remoteAlarms: AlarmRow[],
  dbForTombstone: Database.Database
): number {
  let count = 0

  // tombstone 로드 (deleted_at 포함하여 비교)
  const tombstones = getTombstones(dbForTombstone)
  const tombstoneMap = new Map(tombstones.map(t => [`${t.table_name}:${t.item_id}`, t.deleted_at]))
  const deleteTombstone = dbForTombstone.prepare('DELETE FROM deleted_items WHERE table_name = ? AND item_id = ?')

  const selectDay  = db.prepare('SELECT updated_at FROM note_day WHERE id = ?')
  const selectItem = db.prepare('SELECT updated_at FROM note_item WHERE id = ?')
  const selectAlarm = db.prepare('SELECT updated_at FROM alarm WHERE id = ?')

  const upsertDay = db.prepare(`
    INSERT INTO note_day (id, mood, summary, note_count, has_notes, updated_at)
    VALUES (@id, @mood, @summary, @note_count, @has_notes, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      mood=@mood, summary=@summary, note_count=@note_count,
      has_notes=@has_notes, updated_at=@updated_at
    WHERE @updated_at > note_day.updated_at
  `)

  const upsertItem = db.prepare(`
    INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
    VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      type=@type, content=@content, tags=@tags, pinned=@pinned,
      order_index=@order_index, updated_at=@updated_at
    WHERE @updated_at > note_item.updated_at
  `)

  const upsertAlarm = db.prepare(`
    INSERT INTO alarm (id, day_id, time, label, repeat, enabled, fired, created_at, updated_at)
    VALUES (@id, @day_id, @time, @label, @repeat, @enabled, @fired, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      day_id=@day_id, time=@time, label=@label, repeat=@repeat,
      enabled=@enabled, fired=@fired, updated_at=@updated_at
    WHERE @updated_at > alarm.updated_at
  `)

  const ensureDay = db.prepare(`
    INSERT OR IGNORE INTO note_day (id, note_count, has_notes, updated_at)
    VALUES (@id, 0, 0, @updated_at)
  `)

  const affectedDayIds = new Set<string>()

  db.transaction(() => {
    for (const rd of remoteDays) {
      const delAt = tombstoneMap.get(`note_day:${rd.id}`)
      if (delAt !== undefined) {
        if (rd.updated_at > delAt) {
          deleteTombstone.run('note_day', rd.id)
        } else {
          continue
        }
      }
      const local = selectDay.get(rd.id) as { updated_at: number } | undefined
      if (!local || rd.updated_at > local.updated_at) {
        upsertDay.run(rd)
        count++
      }
    }
    let itemSkippedByTombstone = 0, itemSkippedByLocal = 0, itemNew = 0, itemUpdated = 0
    for (const ri of remoteItems) {
      const delAtItem = tombstoneMap.get(`note_item:${ri.id}`)
      if (delAtItem !== undefined) {
        if (ri.updated_at > delAtItem) {
          deleteTombstone.run('note_item', ri.id)
        } else {
          itemSkippedByTombstone++
          continue
        }
      }
      const local = selectItem.get(ri.id) as { updated_at: number } | undefined
      if (!local) {
        ensureDay.run({ id: ri.day_id, updated_at: ri.updated_at })
        upsertItem.run(ri)
        affectedDayIds.add(ri.day_id as string)
        count++
        itemNew++
      } else if (ri.updated_at > local.updated_at) {
        ensureDay.run({ id: ri.day_id, updated_at: ri.updated_at })
        upsertItem.run(ri)
        affectedDayIds.add(ri.day_id as string)
        count++
        itemUpdated++
      } else {
        itemSkippedByLocal++
      }
    }
    if (itemNew > 0 || itemUpdated > 0 || itemSkippedByTombstone > 0) {
      slog(`[Sync] items: new=${itemNew}, updated=${itemUpdated}, skippedLocal=${itemSkippedByLocal}, skippedTombstone=${itemSkippedByTombstone}`)
    }
    for (const ra of remoteAlarms) {
      const delAtAlarm = tombstoneMap.get(`alarm:${ra.id}`)
      if (delAtAlarm !== undefined) {
        if (ra.updated_at > delAtAlarm) {
          deleteTombstone.run('alarm', ra.id)
        } else {
          continue
        }
      }
      const local = selectAlarm.get(ra.id) as { updated_at: number } | undefined
      if (!local || ra.updated_at > local.updated_at) {
        upsertAlarm.run(ra)
        count++
      }
    }

    // note_item이 변경된 day들의 note_count 재계산 (preserveUpdatedAt: push 핑퐁 방지)
    for (const dayId of affectedDayIds) {
      updateDayCount(db, dayId, true)
    }
  })()

  return count
}

/** 원격에서 삭제된 항목을 로컬에서도 삭제 (전체 동기화 시, 모바일 버전과 동일) */
function cleanDeletedFromRemote(
  db: Database.Database,
  remoteDays: NoteDayRow[],
  remoteItems: NoteItemRow[],
  lastSyncAt?: number
): number {
  try {
    const remoteItemIds = new Set(remoteItems.map(i => i.id))
    const remoteDayIds = new Set(remoteDays.map(d => d.id))

    // 보호 대상: lastSyncAt 이후에 로컬에서 생성/변경된 아이템 (아직 push 안 됐을 수 있음)
    // OneDrive 병합으로 들어온 데이터는 created_at이 오래됐지만 updated_at은 원본 시각
    // → created_at 또는 updated_at이 lastSyncAt 이후면 보호
    const protectAfter = lastSyncAt ?? 0
    const localItems = db.prepare('SELECT id, day_id, created_at, updated_at FROM note_item').all() as Array<{ id: string; day_id: string; created_at: number; updated_at: number }>
    let deleted = 0
    const affectedDayIds = new Set<string>()

    db.transaction(() => {
      for (const li of localItems) {
        if (!remoteItemIds.has(li.id)) {
          if (li.created_at > protectAfter || li.updated_at > protectAfter) {
            slog(`[Sync] lastSyncAt 이후 생성/변경 아이템 보호 (삭제 스킵): ${li.id} created=${li.created_at} updated=${li.updated_at}`)
            continue
          }
          db.prepare('DELETE FROM note_item WHERE id = ?').run(li.id)
          affectedDayIds.add(li.day_id)
          deleted++
        }
      }
    })()

    if (deleted > 0) {
      slog(`[Sync] 원격에서 삭제된 로컬 아이템 ${deleted}개 정리`)
      for (const dayId of affectedDayIds) {
        updateDayCount(db, dayId, true)
      }
    }
    return deleted
  } catch (err) {
    slog(`[Sync] cleanDeletedFromRemote 실패: ${err}`)
    return 0
  }
}

/** 서버 note_day의 note_count가 실제 note_item과 불일치할 때 서버를 수정 (배치 처리) */
async function fixRemoteDayCounts(remoteDays: NoteDayRow[], remoteItems: NoteItemRow[]): Promise<void> {
  if (!supabase || !currentUserId) return
  try {
    // 실제 item 수 계산
    const countByDay = new Map<string, number>()
    for (const item of remoteItems) {
      countByDay.set(item.day_id as string, (countByDay.get(item.day_id as string) || 0) + 1)
    }

    const toDelete: string[] = []
    const toUpdate: Array<{ id: string; note_count: number; has_notes: number }> = []

    for (const day of remoteDays) {
      const actual = countByDay.get(day.id as string) || 0
      const cached = (day.note_count as number) || 0

      if (actual === 0 && cached > 0 && !day.mood) {
        toDelete.push(day.id as string)
      } else if (actual !== cached) {
        toUpdate.push({ id: day.id as string, note_count: actual, has_notes: actual > 0 ? 1 : 0 })
      }
    }

    // 배치 삭제
    if (toDelete.length > 0) {
      const { error } = await supabase.from('note_day').delete().in('id', toDelete).eq('user_id', currentUserId)
      if (!error) slog(`[Sync] 서버 stale day 배치 삭제: ${toDelete.length}건`)
      else console.error('[Sync] 서버 stale day 삭제 실패:', error.message)
    }

    // 배치 업데이트 (개별 UPDATE → 병렬 처리)
    if (toUpdate.length > 0) {
      await Promise.all(toUpdate.map(u =>
        supabase!.from('note_day').update({ note_count: u.note_count, has_notes: u.has_notes })
          .eq('id', u.id).eq('user_id', currentUserId)
      ))
      slog(`[Sync] 서버 day count 배치 수정: ${toUpdate.length}건`)
    }
  } catch (err) {
    console.error('[Sync] fixRemoteDayCounts 실패:', err)
  }
}

/** tombstone에 기록된 삭제를 Supabase에 반영 (tombstone 자체는 일정 시간 후 정리) */
async function pushTombstones(db: Database.Database): Promise<number> {
  if (!supabase || !currentUserId) return 0
  const tombstones = getTombstones(db)
  if (tombstones.length === 0) return 0

  let count = 0
  const byTable = new Map<string, string[]>()
  for (const t of tombstones) {
    const list = byTable.get(t.table_name) ?? []
    list.push(t.item_id)
    byTable.set(t.table_name, list)
  }

  for (const [tableName, ids] of byTable) {
    // 배치 삭제: .in()으로 한 번에 처리 (50개씩)
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50)
      try {
        const { error } = await supabase.from(tableName).delete().in('id', batch).eq('user_id', currentUserId)
        if (!error) {
          count += batch.length
        } else {
          console.error(`[Sync] tombstone 배치 삭제 실패 (${tableName}):`, error.message)
        }
      } catch (err) {
        console.error(`[Sync] tombstone 배치 삭제 에러 (${tableName}):`, err)
      }
    }
  }

  // tombstone은 삭제 후 60초 경과한 것만 정리 (Realtime 재삽입 방어)
  const TOMBSTONE_KEEP_MS = 60 * 1000
  const cutoff = Date.now() - TOMBSTONE_KEEP_MS
  const expiredByTable = new Map<string, string[]>()
  for (const t of tombstones) {
    if (t.deleted_at < cutoff) {
      const list = expiredByTable.get(t.table_name) ?? []
      list.push(t.item_id)
      expiredByTable.set(t.table_name, list)
    }
  }
  for (const [tableName, ids] of expiredByTable) {
    if (ids.length > 0) {
      clearTombstones(db, tableName, ids)
      console.log(`[Sync] 만료된 tombstone 정리: ${tableName} ${ids.length}건`)
    }
  }

  console.log(`[Sync] tombstone 처리: ${count}건 삭제`)
  return count
}

/**
 * pushChanges — Notion/Google Sheets 방식:
 * - 원격에 **이미 존재하는** 항목 중 로컬이 더 새로운 것만 업데이트
 * - 원격에 **없는** 항목은 push하지 않음 (다른 기기에서 삭제된 것으로 간주)
 * - 새로 생성된 항목은 단건 sync(syncNoteItem 등)로 즉시 올라감
 * - 단건 sync 실패 시 pendingSyncQueue에서 재시도
 * - cachedRemote*: pull에서 이미 조회한 서버 데이터를 재사용 (서버 재조회 제거)
 */
async function pushChanges(
  db: Database.Database,
  lastSyncAt?: number,
  cachedRemoteDays?: NoteDayRow[],
  cachedRemoteItems?: NoteItemRow[],
  cachedRemoteAlarms?: AlarmRow[]
): Promise<number> {
  if (!supabase || !currentUserId) return 0
  let count = 0

  // 1) pendingSyncQueue 재시도 (단건 sync 실패분, tombstone 체크 포함)
  count += await flushPendingSyncQueue(db)

  // 2) pull에서 이미 가져온 데이터 재사용 (서버 재조회 제거 → 성능 개선)
  const remoteDayMap = new Map<string, number>()
  const remoteItemMap = new Map<string, number>()
  const remoteAlarmMap = new Map<string, number>()

  if (cachedRemoteDays && cachedRemoteItems && cachedRemoteAlarms) {
    for (const r of cachedRemoteDays) remoteDayMap.set(r.id as string, r.updated_at as number)
    for (const r of cachedRemoteItems) remoteItemMap.set(r.id as string, r.updated_at as number)
    for (const r of cachedRemoteAlarms) remoteAlarmMap.set(r.id as string, r.updated_at as number)
  } else {
    // fallback: 캐시가 없으면 서버 조회 (하위 호환)
    const [{ data: remoteDays }, { data: remoteItems }, { data: remoteAlarms }] = await Promise.all([
      supabase.from('note_day').select('id, updated_at').eq('user_id', currentUserId),
      supabase.from('note_item').select('id, updated_at').eq('user_id', currentUserId),
      supabase.from('alarm').select('id, updated_at').eq('user_id', currentUserId),
    ])
    for (const r of remoteDays ?? []) remoteDayMap.set(r.id, r.updated_at)
    for (const r of remoteItems ?? []) remoteItemMap.set(r.id, r.updated_at)
    for (const r of remoteAlarms ?? []) remoteAlarmMap.set(r.id, r.updated_at)
  }

  // tombstone 제외
  const tombstones = getTombstones(db)
  const tombstoneSet = new Set(tombstones.map(t => `${t.table_name}:${t.item_id}`))

  // 3) 로컬이 더 새로운 항목만 push (서버에 없는 항목은 삭제된 것으로 간주)
  const protectAfter = lastSyncAt ?? 0  // 이 시점 이후 생성된 아이템은 "새로 만든 것"으로 보호

  const allDays = (db.prepare('SELECT * FROM note_day').all() as NoteDayRow[])
    .filter(d => !tombstoneSet.has(`note_day:${d.id}`))
  const allItems = (db.prepare('SELECT * FROM note_item').all() as NoteItemRow[])
    .filter(i => !tombstoneSet.has(`note_item:${i.id}`))
  const allAlarms = (db.prepare('SELECT * FROM alarm').all() as AlarmRow[])
    .filter(a => !tombstoneSet.has(`alarm:${a.id}`))

  // 서버에 없는 아이템 처리:
  // - created_at > lastSyncAt → 이번 세션에서 새로 만든 것 → push
  // - created_at <= lastSyncAt → 다른 기기에서 삭제된 것 → push 안 함
  // note_day는 캐시 테이블 → 서버에 없으면 항상 push (삭제 복원 위험 없음)
  const daysToUpdate = allDays
    .filter(ld => {
      const ts = remoteDayMap.get(ld.id as string)
      if (ts === undefined) {
        slog(`[Sync:push] day ${ld.id} NEW (서버에 없음 → push)`)
        return true
      }
      if ((ld.updated_at as number) > ts) {
        slog(`[Sync:push] day ${ld.id} local_at=${ld.updated_at} remote_at=${ts}`)
        return true
      }
      return false
    })
    .map(d => ({ ...d, user_id: currentUserId }))
  const itemsToUpdate = allItems
    .filter(li => {
      const ts = remoteItemMap.get(li.id as string)
      if (ts === undefined) {
        // 서버에 없는 아이템: created_at 또는 updated_at이 lastSyncAt 이후면 push
        // (OneDrive 병합으로 들어온 데이터는 created_at이 오래됐지만 updated_at은 원본 시각)
        if ((li.created_at as number) > protectAfter || (li.updated_at as number) > protectAfter) {
          slog(`[Sync:push] item ${li.id} NEW (created=${li.created_at}, updated=${li.updated_at}, lastSync=${protectAfter})`)
          return true
        }
        // created_at과 updated_at 모두 lastSyncAt 이전 → 서버에서 삭제된 아이템
        return false
      }
      if ((li.updated_at as number) > ts) {
        slog(`[Sync:push] item ${li.id} local_at=${li.updated_at} remote_at=${ts}`)
        return true
      }
      return false
    })
    .map(i => ({ ...i, user_id: currentUserId }))
  const alarmsToUpdate = allAlarms
    .filter(la => {
      const ts = remoteAlarmMap.get(la.id as string)
      if (ts === undefined) {
        // OneDrive 병합으로 들어온 알람도 push되도록 updated_at도 체크
        return (la.created_at as number) > protectAfter || (la.updated_at as number) > protectAfter
      }
      return (la.updated_at as number) > ts
    })
    .map(a => ({ ...a, user_id: currentUserId }))

  // LWW push: 서버에 이미 있는 항목은 updated_at 비교 후 update, 없는 항목은 insert
  // upsert는 서버측 LWW 없이 무조건 덮어쓰므로 사용하지 않음
  async function lwwPush(table: string, items: Record<string, unknown>[], remoteMap: Map<string, number>): Promise<number> {
    if (!supabase || items.length === 0) return 0
    let pushed = 0
    const toInsert: Record<string, unknown>[] = []
    const toUpdate: Record<string, unknown>[] = []

    for (const item of items) {
      const remoteTs = remoteMap.get(item.id as string)
      if (remoteTs === undefined) {
        toInsert.push(item)
      } else if ((item.updated_at as number) > remoteTs) {
        toUpdate.push(item)
      }
    }

    // 새 항목 insert (배치)
    for (let i = 0; i < toInsert.length; i += 50) {
      const batch = toInsert.slice(i, i + 50)
      const { error } = await supabase.from(table).upsert(batch, { onConflict: 'id,user_id' })
      if (!error) pushed += batch.length
      else console.error(`[Sync] ${table} insert 실패:`, error.message)
    }

    // 기존 항목 update: 서버측 LWW — .lt('updated_at', localValue)로 서버가 더 오래된 경우만
    for (const item of toUpdate) {
      const { error, count: updatedCount } = await supabase.from(table)
        .update(item)
        .eq('id', item.id)
        .eq('user_id', currentUserId)
        .lt('updated_at', item.updated_at as number)
      if (!error) pushed++
      else console.error(`[Sync] ${table} update 실패:`, error.message)
    }

    return pushed
  }

  count += await lwwPush('note_day', daysToUpdate, remoteDayMap)
  count += await lwwPush('note_item', itemsToUpdate, remoteItemMap)
  count += await lwwPush('alarm', alarmsToUpdate, remoteAlarmMap)

  return count
}

/** pendingSyncQueue 재시도 (단건 sync 실패분 처리, tombstone 항목은 건너뜀) */
async function flushPendingSyncQueue(db?: Database.Database): Promise<number> {
  if (!supabase || !currentUserId || pendingSyncQueue.length === 0) return 0
  let count = 0
  const remaining: PendingSync[] = []

  // tombstone에 있는 아이템은 upsert하면 안 됨 (삭제된 아이템 부활 방지)
  let tombstoneSet: Set<string> | null = null
  if (db) {
    const tombstones = getTombstones(db)
    tombstoneSet = new Set(tombstones.map(t => `${t.table_name}:${t.item_id}`))
  }

  for (const p of pendingSyncQueue) {
    try {
      if (p.action === 'upsert' && p.data) {
        const itemId = (p.data as Record<string, unknown>).id as string
        // tombstone에 있으면 건너뜀 (삭제된 아이템 재업로드 방지)
        if (tombstoneSet && tombstoneSet.has(`${p.table}:${itemId}`)) {
          slog(`[Sync] pendingQueue 건너뜀 (tombstone): ${p.table}/${itemId}`)
          continue
        }
        const { error } = await supabase.from(p.table).upsert(
          { ...p.data, user_id: currentUserId }, { onConflict: 'id,user_id' }
        )
        if (error) { remaining.push(p); continue }
      } else if (p.action === 'delete' && p.id) {
        const { error } = await supabase.from(p.table).delete().eq('id', p.id).eq('user_id', currentUserId)
        if (error) { remaining.push(p); continue }
      }
      count++
    } catch {
      remaining.push(p)
    }
  }

  pendingSyncQueue.length = 0
  pendingSyncQueue.push(...remaining)
  if (count > 0) console.log(`[Sync] pendingQueue 재시도 성공: ${count}건, 남은: ${remaining.length}건`)
  return count
}

/** 단건 sync 실패 시 큐에 추가 (다음 fullSync에서 재시도) */
function enqueuePendingSync(p: PendingSync): void {
  // 중복 방지
  const key = `${p.action}:${p.table}:${p.id ?? (p.data as Record<string, unknown>)?.id}`
  const exists = pendingSyncQueue.some(q => {
    const qKey = `${q.action}:${q.table}:${q.id ?? (q.data as Record<string, unknown>)?.id}`
    return qKey === key
  })
  if (!exists) {
    pendingSyncQueue.push(p)
    console.log(`[Sync] pendingQueue 추가: ${p.action} ${p.table} (큐 크기: ${pendingSyncQueue.length})`)
  }
}

/** 단건 변경 즉시 동기화 (user_id 포함) — 실패 시 pendingQueue에 추가 */
export async function syncNoteDay(day: NoteDayRow): Promise<void> {
  if (!supabase || !currentUserId) return
  try {
    // note_count=0 이고 mood도 없으면 원격에서 삭제 (빈 note_day 남기지 않음)
    if (day.note_count === 0 && !day.mood) {
      const { error } = await supabase.from('note_day').delete().eq('id', day.id).eq('user_id', currentUserId)
      if (error) {
        console.error('[Sync] note_day 삭제 실패:', error.message)
        enqueuePendingSync({ action: 'delete', table: 'note_day', id: day.id })
      } else {
        console.log('[Sync] note_day 원격 삭제 (빈 day):', day.id)
      }
      return
    }
    const { error } = await supabase.from('note_day').upsert({ ...day, user_id: currentUserId }, { onConflict: 'id,user_id' })
    if (error) {
      console.error('[Sync] note_day 동기화 실패:', error.message)
      enqueuePendingSync({ action: 'upsert', table: 'note_day', data: day as unknown as Record<string, unknown> })
    }
  } catch (err) {
    console.error('[Sync] note_day 동기화 실패:', err)
    enqueuePendingSync({ action: 'upsert', table: 'note_day', data: day as unknown as Record<string, unknown> })
  }
}

export async function syncNoteItem(item: NoteItemRow): Promise<void> {
  if (!supabase || !currentUserId) return
  try {
    const { error } = await supabase.from('note_item').upsert({ ...item, user_id: currentUserId }, { onConflict: 'id,user_id' })
    if (error) {
      console.error('[Sync] note_item 동기화 실패:', error.message)
      enqueuePendingSync({ action: 'upsert', table: 'note_item', data: item as unknown as Record<string, unknown> })
    }
  } catch (err) {
    console.error('[Sync] note_item 동기화 실패:', err)
    enqueuePendingSync({ action: 'upsert', table: 'note_item', data: item as unknown as Record<string, unknown> })
  }
}

export async function syncDeleteNoteItem(id: string): Promise<void> {
  if (!supabase || !currentUserId) return
  try {
    const { error } = await supabase.from('note_item').delete().eq('id', id).eq('user_id', currentUserId)
    if (error) {
      console.error('[Sync] note_item 삭제 실패:', error.message)
      enqueuePendingSync({ action: 'delete', table: 'note_item', id })
    }
  } catch (err) {
    console.error('[Sync] note_item 삭제 동기화 실패:', err)
    enqueuePendingSync({ action: 'delete', table: 'note_item', id })
  }
}

export async function syncAlarm(alarm: AlarmRow): Promise<void> {
  if (!supabase || !currentUserId) return
  try {
    const { error } = await supabase.from('alarm').upsert({ ...alarm, user_id: currentUserId }, { onConflict: 'id,user_id' })
    if (error) {
      console.error('[Sync] alarm 동기화 실패:', error.message)
      enqueuePendingSync({ action: 'upsert', table: 'alarm', data: alarm as unknown as Record<string, unknown> })
    }
  } catch (err) {
    console.error('[Sync] alarm 동기화 실패:', err)
    enqueuePendingSync({ action: 'upsert', table: 'alarm', data: alarm as unknown as Record<string, unknown> })
  }
}

export async function syncDeleteAlarm(id: string): Promise<void> {
  if (!supabase || !currentUserId) return
  try {
    const { error } = await supabase.from('alarm').delete().eq('id', id).eq('user_id', currentUserId)
    if (error) {
      console.error('[Sync] alarm 삭제 실패:', error.message)
      enqueuePendingSync({ action: 'delete', table: 'alarm', id })
    }
  } catch (err) {
    console.error('[Sync] alarm 삭제 동기화 실패:', err)
    enqueuePendingSync({ action: 'delete', table: 'alarm', id })
  }
}

/* ────────────── 첨부파일 동기화 (사용자별) ────────────── */

const MIME_MAP: Record<string, string> = {
  // 이미지
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
  // 문서
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.log': 'text/plain',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv', '.rtf': 'application/rtf',
  // 압축
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.gz': 'application/gzip', '.tar': 'application/x-tar',
  // 오디오/비디오
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  // 코드/데이터
  '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.ts': 'text/typescript', '.md': 'text/markdown',
  '.py': 'text/x-python', '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++',
}

/** 첨부파일 1건을 Supabase에 업로드 (user_id 포함) */
export async function syncAttachmentFile(attachDir: string, fileName: string): Promise<void> {
  if (!supabase || !currentUserId) return
  const filePath = join(attachDir, fileName)
  if (!existsSync(filePath)) return

  try {
    const { data: existing } = await supabase
      .from('attachment_file')
      .select('file_name')
      .eq('file_name', fileName)
      .eq('user_id', currentUserId)
      .maybeSingle()
    if (existing) return

    const buffer = readFileSync(filePath)
    const base64 = buffer.toString('base64')
    const ext = extname(fileName).toLowerCase()
    const mimeType = MIME_MAP[ext] || 'application/octet-stream'
    const now = Date.now()

    const { error } = await supabase.from('attachment_file').upsert({
      file_name: fileName,
      user_id: currentUserId,
      data: base64,
      size: buffer.length,
      mime_type: mimeType,
      created_at: now,
      updated_at: now
    }, { onConflict: 'file_name,user_id' })

    if (error) console.error('[Sync] 첨부파일 업로드 실패:', fileName, error.message)
    else console.log(`[Sync] 첨부파일 업로드 완료: ${fileName} (${buffer.length} bytes)`)
  } catch (err) {
    console.error('[Sync] 첨부파일 업로드 실패:', fileName, err)
  }
}

/** 원격에 있지만 로컬에 없는 첨부파일을 다운로드 (해당 user만) */
export async function pullAttachmentFiles(attachDir: string): Promise<number> {
  if (!supabase || !currentUserId) return 0
  let count = 0

  try {
    const { data: remoteFiles, error } = await supabase
      .from('attachment_file')
      .select('file_name, size')
      .eq('user_id', currentUserId)

    if (error) {
      console.error('[Sync] 첨부파일 목록 조회 실패:', error.message)
      return 0
    }
    if (!remoteFiles || remoteFiles.length === 0) return 0

    for (const rf of remoteFiles) {
      const localPath = join(attachDir, rf.file_name)
      if (existsSync(localPath)) continue

      const { data: fileData, error: dlErr } = await supabase
        .from('attachment_file')
        .select('data')
        .eq('file_name', rf.file_name)
        .eq('user_id', currentUserId)
        .single()

      if (dlErr || !fileData) {
        console.error('[Sync] 첨부파일 다운로드 실패:', rf.file_name, dlErr?.message)
        continue
      }

      try {
        const buffer = Buffer.from(fileData.data, 'base64')
        writeFileSync(localPath, buffer)
        console.log(`[Sync] 첨부파일 다운로드 완료: ${rf.file_name} (${buffer.length} bytes)`)
        count++
      } catch (writeErr) {
        console.error('[Sync] 첨부파일 저장 실패:', rf.file_name, writeErr)
      }
    }
  } catch (err) {
    console.error('[Sync] 첨부파일 pull 실패:', err)
  }
  return count
}

/** 로컬에 있지만 원격에 없는 첨부파일을 업로드 (해당 user만) */
export async function pushAttachmentFiles(attachDir: string): Promise<number> {
  if (!supabase || !existsSync(attachDir) || !currentUserId) return 0
  let count = 0

  try {
    const { data: remoteFiles } = await supabase
      .from('attachment_file')
      .select('file_name')
      .eq('user_id', currentUserId)

    const remoteSet = new Set((remoteFiles ?? []).map(f => f.file_name))

    const { readdirSync } = await import('fs')
    const localFiles = readdirSync(attachDir)

    for (const fileName of localFiles) {
      if (remoteSet.has(fileName)) continue

      const filePath = join(attachDir, fileName)
      try {
        const buffer = readFileSync(filePath)
        if (buffer.length > 10 * 1024 * 1024) {
          console.warn(`[Sync] 첨부파일 스킵 (10MB 초과): ${fileName}`)
          continue
        }

        const base64 = buffer.toString('base64')
        const ext = extname(fileName).toLowerCase()
        const mimeType = MIME_MAP[ext] || 'application/octet-stream'
        const now = Date.now()

        const { error } = await supabase.from('attachment_file').upsert({
          file_name: fileName,
          user_id: currentUserId,
          data: base64,
          size: buffer.length,
          mime_type: mimeType,
          created_at: now,
          updated_at: now
        }, { onConflict: 'file_name,user_id' })

        if (error) console.error('[Sync] 첨부파일 push 실패:', fileName, error.message)
        else { count++; console.log(`[Sync] 첨부파일 push 완료: ${fileName}`) }
      } catch (readErr) {
        console.error('[Sync] 첨부파일 읽기 실패:', fileName, readErr)
      }
    }
  } catch (err) {
    console.error('[Sync] 첨부파일 push 실패:', err)
  }
  return count
}
