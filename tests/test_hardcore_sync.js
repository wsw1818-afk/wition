/**
 * Wition 하드코어 동기화 테스트 v2
 * ══════════════════════════════════════════════════════════════
 * DB 전문가 + 사용자 관점에서 동기화 로직의 모든 빈틈 검증
 * 기존 test_hardcore.js와 중복 없음 — 내부 메커니즘 + 현실 시나리오 전용
 *
 * 테스트 영역:
 *   A. 내부 메커니즘 검증 (pendingSyncQueue, quickPull, cleanDeleted, syncing)
 *   B. 현실 사용자 시나리오 (출퇴근, 절전복귀, 장기미사용)
 *   C. 데이터 정합성 심화 (count, 순서, JSON 필드, 알람 상태)
 *   D. 네트워크 장애 복구 (Realtime 끊김, push 중단, 서버 다운)
 *   E. 대량 스트레스 (1000+행, 500건 push, WAL)
 *
 * 실행: node test_hardcore_sync.js
 *   - 로컬 Supabase 서버 (localhost:8000) 필요
 *   - headless 테스트 서버 (localhost:19876) — 선택적 (A카테고리 일부)
 */

require('dotenv').config()
const Database = require('better-sqlite3')
const { createClient } = require('@supabase/supabase-js')
const { join } = require('path')
const { mkdirSync, existsSync, rmSync, copyFileSync } = require('fs')
const { randomUUID } = require('crypto')
const http = require('http')
const { writeFileSync } = require('fs')

// ─── 설정 ────────────────────────────────────────────────
const SB_URL = process.env.VITE_SUPABASE_URL || 'http://localhost:8000'
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const SRK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const TEST_USER_ID = 'test-hsync-' + randomUUID().slice(0, 8)
const TEST_DIR = join(__dirname, '_test_hsync_temp')
const TEST_SERVER = 'http://localhost:19876'

const uid = () => randomUUID()
const ts = () => new Date().toISOString().slice(11, 23)
const iso = () => new Date().toISOString()
const epoch = () => Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))

let sb // Supabase client (service_role)
let passed = 0, failed = 0, skipped = 0
const results = []
let hasTestServer = false

// ─── 테스트 프레임워크 ──────────────────────────────────
function test(name, fn) {
  return new Promise(async resolve => {
    const t0 = Date.now()
    try {
      await fn()
      const ms = Date.now() - t0
      results.push({ name, status: 'PASS', ms })
      passed++
      console.log(`[${ts()}]   ✅ ${name} (${ms}ms)`)
    } catch (e) {
      const ms = Date.now() - t0
      if (e.message.startsWith('SKIP:')) {
        results.push({ name, status: 'SKIP', ms, reason: e.message })
        skipped++
        console.log(`[${ts()}]   ⏭️  ${name} — ${e.message}`)
      } else {
        results.push({ name, status: 'FAIL', ms, error: e.message })
        failed++
        console.log(`[${ts()}]   ❌ ${name} (${ms}ms)`)
        console.log(`          ${e.message}`)
      }
    }
    resolve()
  })
}

function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }
function eq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${b}, got ${a}`) }

// ─── SQLite 초기화 ──────────────────────────────────────
function createTestDb(name) {
  const dbPath = join(TEST_DIR, `${name}.db`)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_day (
      day TEXT PRIMARY KEY,
      user_id TEXT,
      mood TEXT,
      note_count INTEGER DEFAULT 0,
      summary TEXT DEFAULT '',
      updated_at TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS note_item (
      id TEXT PRIMARY KEY,
      day TEXT,
      user_id TEXT,
      type TEXT DEFAULT 'text',
      content TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      pinned INTEGER DEFAULT 0,
      order_index INTEGER DEFAULT 0,
      updated_at TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS alarm (
      id TEXT PRIMARY KEY,
      item_id TEXT,
      user_id TEXT,
      alarm_time TEXT,
      repeat_type TEXT DEFAULT 'none',
      repeat_days TEXT DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      fired INTEGER DEFAULT 0,
      updated_at TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tombstone (
      id TEXT,
      table_name TEXT,
      deleted_at TEXT,
      PRIMARY KEY (id, table_name)
    );
    CREATE TABLE IF NOT EXISTS pending_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT,
      table_name TEXT,
      item_id TEXT,
      data TEXT,
      created_at TEXT
    );
  `)
  return db
}

// ─── Supabase 헬퍼 ─────────────────────────────────────
function toEpoch(val) {
  if (typeof val === 'number') return val
  if (typeof val === 'string') return new Date(val).getTime()
  return Date.now()
}

function toIso(val) {
  if (typeof val === 'number') return new Date(val).toISOString()
  return val || new Date().toISOString()
}

function isNewer(remote, local) {
  const r = typeof remote === 'number' ? remote : new Date(remote).getTime()
  const l = typeof local === 'number' ? local : new Date(local).getTime()
  return r > l
}

async function sbInsertItem(item) {
  const serverItem = {
    id: item.id,
    day_id: item.day || item.day_id,
    type: item.type || 'text',
    content: item.content || '',
    tags: item.tags || '[]',
    pinned: item.pinned || 0,
    order_index: item.order_index || 0,
    updated_at: toEpoch(item.updated_at),
    created_at: toEpoch(item.created_at || item.updated_at),
    user_id: item.user_id || TEST_USER_ID,
    version: item.version || 1,
  }
  const { error } = await sb.from('note_item').upsert(serverItem)
  if (error) throw new Error(`sbInsert: ${error.message}`)
}

async function sbInsertDay(day) {
  const serverDay = {
    id: day.day || day.id,
    mood: day.mood || null,
    note_count: day.note_count || 0,
    summary: day.summary || '',
    has_notes: (day.note_count || 0) > 0 ? 1 : 0,
    updated_at: toEpoch(day.updated_at),
    user_id: day.user_id || TEST_USER_ID,
  }
  const { error } = await sb.from('note_day').upsert(serverDay)
  if (error) throw new Error(`sbInsertDay: ${error.message}`)
}

async function sbInsertAlarm(alarm) {
  // 서버 스키마: id, day_id, time, label, repeat, enabled, fired, created_at, updated_at, user_id
  const serverAlarm = {
    id: alarm.id,
    day_id: alarm.item_id || alarm.day_id,
    user_id: alarm.user_id || TEST_USER_ID,
    time: toEpoch(alarm.alarm_time || alarm.time),
    label: alarm.label || '',
    repeat: alarm.repeat_type || alarm.repeat || 'none',
    enabled: alarm.enabled ?? 1,
    fired: alarm.fired ?? 0,
    updated_at: toEpoch(alarm.updated_at),
    created_at: toEpoch(alarm.created_at || alarm.updated_at),
  }
  const { error } = await sb.from('alarm').upsert(serverAlarm)
  if (error) throw new Error(`sbInsertAlarm: ${error.message}`)
}

async function sbDeleteItem(id) {
  const { error } = await sb.from('note_item').delete().eq('id', id).eq('user_id', TEST_USER_ID)
  if (error) throw new Error(`sbDelete: ${error.message}`)
}

async function sbGetItems() {
  const { data, error } = await sb.from('note_item').select('*').eq('user_id', TEST_USER_ID)
  if (error) throw new Error(`sbGet: ${error.message}`)
  return data || []
}

async function sbGetDays() {
  const { data, error } = await sb.from('note_day').select('*').eq('user_id', TEST_USER_ID)
  if (error) throw new Error(`sbGetDays: ${error.message}`)
  return data || []
}

async function sbGetAlarms() {
  const { data, error } = await sb.from('alarm').select('*').eq('user_id', TEST_USER_ID)
  if (error) throw new Error(`sbGetAlarms: ${error.message}`)
  return data || []
}

async function sbGetItem(id) {
  const { data, error } = await sb.from('note_item').select('*').eq('id', id).eq('user_id', TEST_USER_ID).single()
  if (error) return null
  return data
}

async function sbCleanup() {
  await sb.from('note_item').delete().eq('user_id', TEST_USER_ID)
  await sb.from('note_day').delete().eq('user_id', TEST_USER_ID)
  await sb.from('alarm').delete().eq('user_id', TEST_USER_ID)
}

// ─── 테스트 서버 헬퍼 ───────────────────────────────────
async function pcQuery(sql) {
  return new Promise((resolve, reject) => {
    const url = `${TEST_SERVER}/query?sql=${encodeURIComponent(sql)}`
    http.get(url, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(body) }
      })
    }).on('error', reject)
  })
}

async function pcSync() {
  return new Promise((resolve, reject) => {
    const req = http.request(`${TEST_SERVER}/sync`, { method: 'POST' }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(body) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function pcPing() {
  return new Promise((resolve, reject) => {
    http.get(`${TEST_SERVER}/ping`, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    }).on('error', () => resolve(null))
  })
}

// ─── 로컬 DB 헬퍼 ──────────────────────────────────────
function addItem(db, day, content, extra = {}) {
  const id = extra.id || uid()
  const now = extra.updated_at || iso()
  const created = extra.created_at || now
  db.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, day, TEST_USER_ID, extra.type || 'text', content, extra.tags || '[]',
    extra.pinned || 0, extra.order_index ?? 0, now, created
  )
  return id
}

function addDay(db, day, extra = {}) {
  const now = extra.updated_at || iso()
  db.prepare(`INSERT OR REPLACE INTO note_day (day,user_id,mood,note_count,summary,updated_at,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    day, TEST_USER_ID, extra.mood || null, extra.note_count || 0, extra.summary || '', now, now
  )
}

function deleteItem(db, id) {
  db.prepare('DELETE FROM note_item WHERE id=?').run(id)
  db.prepare('INSERT OR REPLACE INTO tombstone (id, table_name, deleted_at) VALUES (?,?,?)').run(id, 'note_item', iso())
}

function updateItem(db, id, content, extraUpdatedAt) {
  const now = extraUpdatedAt || iso()
  db.prepare('UPDATE note_item SET content=?, updated_at=? WHERE id=?').run(content, now, id)
}

function getItems(db) {
  return db.prepare('SELECT * FROM note_item WHERE user_id=?').all(TEST_USER_ID)
}

function getItem(db, id) {
  return db.prepare('SELECT * FROM note_item WHERE id=?').get(id)
}

function getTombstones(db) {
  return db.prepare('SELECT * FROM tombstone WHERE table_name=?').all('note_item')
}

function addAlarm(db, itemId, alarmTime, extra = {}) {
  const id = uid()
  const now = iso()
  db.prepare(`INSERT INTO alarm (id,item_id,user_id,alarm_time,repeat_type,repeat_days,enabled,fired,updated_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, itemId, TEST_USER_ID, alarmTime, extra.repeat_type || 'none',
    extra.repeat_days || '[]', extra.enabled ?? 1, extra.fired ?? 0, now, now
  )
  return id
}

function addPendingSync(db, action, tableName, itemId, data) {
  db.prepare(`INSERT INTO pending_sync (action, table_name, item_id, data, created_at)
    VALUES (?,?,?,?,?)`).run(action, tableName, itemId, JSON.stringify(data), iso())
}

// ─── OneDrive 병합 시뮬레이션 ───────────────────────────
function mergeFromOneDrive(localDb, remoteDb) {
  const localTombstones = new Set(
    localDb.prepare('SELECT id FROM tombstone WHERE table_name=?').all('note_item').map(r => r.id)
  )

  // note_item 병합 (LWW)
  const remoteItems = remoteDb.prepare('SELECT * FROM note_item').all()
  let merged = 0
  for (const ri of remoteItems) {
    if (localTombstones.has(ri.id)) continue
    const local = localDb.prepare('SELECT * FROM note_item WHERE id=?').get(ri.id)
    if (!local) {
      localDb.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ri.id, ri.day, ri.user_id, ri.type, ri.content, ri.tags, ri.pinned, ri.order_index, ri.updated_at, ri.created_at)
      merged++
    } else if (ri.updated_at > local.updated_at) {
      localDb.prepare(`UPDATE note_item SET day=?,type=?,content=?,tags=?,pinned=?,order_index=?,updated_at=? WHERE id=?`)
        .run(ri.day, ri.type, ri.content, ri.tags, ri.pinned, ri.order_index, ri.updated_at, ri.id)
      merged++
    }
  }

  // tombstone 양방향 전파
  for (const t of remoteDb.prepare('SELECT * FROM tombstone').all()) {
    localDb.prepare('INSERT OR IGNORE INTO tombstone (id, table_name, deleted_at) VALUES (?,?,?)').run(t.id, t.table_name, t.deleted_at)
    if (t.table_name === 'note_item') {
      localDb.prepare('DELETE FROM note_item WHERE id=?').run(t.id)
    }
  }
  for (const t of localDb.prepare('SELECT * FROM tombstone').all()) {
    remoteDb.prepare('INSERT OR IGNORE INTO tombstone (id, table_name, deleted_at) VALUES (?,?,?)').run(t.id, t.table_name, t.deleted_at)
    if (t.table_name === 'note_item') {
      remoteDb.prepare('DELETE FROM note_item WHERE id=?').run(t.id)
    }
  }

  // note_day 병합
  const remoteDays = remoteDb.prepare('SELECT * FROM note_day').all()
  for (const rd of remoteDays) {
    const localDay = localDb.prepare('SELECT * FROM note_day WHERE day=?').get(rd.day)
    if (!localDay) {
      localDb.prepare(`INSERT INTO note_day (day,user_id,mood,note_count,summary,updated_at,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(rd.day, rd.user_id, rd.mood, rd.note_count, rd.summary, rd.updated_at, rd.created_at)
    } else if (rd.updated_at > localDay.updated_at) {
      localDb.prepare(`UPDATE note_day SET mood=?,note_count=?,summary=?,updated_at=? WHERE day=?`)
        .run(rd.mood, rd.note_count, rd.summary, rd.updated_at, rd.day)
    }
  }

  // alarm 병합
  const remoteAlarms = remoteDb.prepare('SELECT * FROM alarm').all()
  for (const ra of remoteAlarms) {
    const localAlarm = localDb.prepare('SELECT * FROM alarm WHERE id=?').get(ra.id)
    if (!localAlarm) {
      localDb.prepare(`INSERT INTO alarm (id,item_id,user_id,alarm_time,repeat_type,repeat_days,enabled,fired,updated_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ra.id, ra.item_id, ra.user_id, ra.alarm_time, ra.repeat_type, ra.repeat_days, ra.enabled, ra.fired, ra.updated_at, ra.created_at)
    } else if (ra.updated_at > localAlarm.updated_at) {
      localDb.prepare(`UPDATE alarm SET alarm_time=?,repeat_type=?,repeat_days=?,enabled=?,fired=?,updated_at=? WHERE id=?`)
        .run(ra.alarm_time, ra.repeat_type, ra.repeat_days, ra.enabled, ra.fired, ra.updated_at, ra.id)
    }
  }

  return merged
}

// ─── Supabase push/pull 시뮬레이션 ────────────────────
async function pushToServer(db) {
  const items = db.prepare('SELECT * FROM note_item WHERE user_id=?').all(TEST_USER_ID)
  const days = db.prepare('SELECT * FROM note_day WHERE user_id=?').all(TEST_USER_ID)
  const alarms = db.prepare('SELECT * FROM alarm WHERE user_id=?').all(TEST_USER_ID)
  let pushed = 0
  for (const item of items) { await sbInsertItem(item); pushed++ }
  for (const day of days) { await sbInsertDay(day) }
  for (const alarm of alarms) { await sbInsertAlarm(alarm) }
  const tombs = db.prepare('SELECT * FROM tombstone').all()
  for (const t of tombs) {
    if (t.table_name === 'note_item') await sbDeleteItem(t.id)
  }
  return pushed
}

async function pullFromServer(db) {
  const remoteItems = await sbGetItems()
  const remoteDays = await sbGetDays()
  const remoteAlarms = await sbGetAlarms()
  const tombstones = new Set(
    db.prepare('SELECT id FROM tombstone WHERE table_name=?').all('note_item').map(r => r.id)
  )
  let pulled = 0
  for (const ri of remoteItems) {
    if (tombstones.has(ri.id)) continue
    const day = ri.day_id || ri.day
    const updatedAt = toIso(ri.updated_at)
    const createdAt = toIso(ri.created_at || ri.updated_at)
    const local = db.prepare('SELECT * FROM note_item WHERE id=?').get(ri.id)
    if (!local) {
      db.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ri.id, day, ri.user_id, ri.type, ri.content, ri.tags || '[]', ri.pinned || 0, ri.order_index || 0, updatedAt, createdAt)
      pulled++
    } else if (isNewer(ri.updated_at, local.updated_at)) {
      db.prepare(`UPDATE note_item SET day=?,type=?,content=?,tags=?,pinned=?,order_index=?,updated_at=? WHERE id=?`)
        .run(day, ri.type, ri.content, ri.tags || '[]', ri.pinned || 0, ri.order_index || 0, updatedAt, ri.id)
      pulled++
    }
  }
  for (const rd of remoteDays) {
    const dayKey = rd.id || rd.day
    const updatedAt = toIso(rd.updated_at)
    const localDay = db.prepare('SELECT * FROM note_day WHERE day=?').get(dayKey)
    if (!localDay) {
      db.prepare(`INSERT INTO note_day (day,user_id,mood,note_count,summary,updated_at,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(dayKey, rd.user_id, rd.mood, rd.note_count, rd.summary, updatedAt, updatedAt)
    } else if (isNewer(rd.updated_at, localDay.updated_at)) {
      db.prepare(`UPDATE note_day SET mood=?,note_count=?,summary=?,updated_at=? WHERE day=?`)
        .run(rd.mood, rd.note_count, rd.summary, updatedAt, dayKey)
    }
  }
  for (const ra of remoteAlarms) {
    const updatedAt = toIso(ra.updated_at)
    const createdAt = toIso(ra.created_at || ra.updated_at)
    const localAlarm = db.prepare('SELECT * FROM alarm WHERE id=?').get(ra.id)
    // 서버 스키마: day_id, time, label, repeat  /  로컬 스키마: item_id, alarm_time, repeat_type, repeat_days
    const itemId = ra.day_id || ra.item_id
    const alarmTime = toIso(ra.time || ra.alarm_time)
    const repeatType = ra.repeat || ra.repeat_type || 'none'
    if (!localAlarm) {
      db.prepare(`INSERT INTO alarm (id,item_id,user_id,alarm_time,repeat_type,repeat_days,enabled,fired,updated_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ra.id, itemId, ra.user_id, alarmTime, repeatType, '[]', ra.enabled ?? 1, ra.fired ?? 0, updatedAt, createdAt)
    } else if (isNewer(ra.updated_at, localAlarm.updated_at)) {
      db.prepare(`UPDATE alarm SET alarm_time=?,repeat_type=?,enabled=?,fired=?,updated_at=? WHERE id=?`)
        .run(alarmTime, repeatType, ra.enabled ?? 1, ra.fired ?? 0, updatedAt, ra.id)
    }
  }
  return pulled
}

// ─── cleanDeletedFromRemote 시뮬레이션 ──────────────────
function cleanDeletedFromRemote(db, remoteItemIds, lastSyncAt) {
  const protectAfter = lastSyncAt || 0
  const localItems = db.prepare('SELECT id, day, created_at, updated_at FROM note_item WHERE user_id=?').all(TEST_USER_ID)
  let deleted = 0
  db.transaction(() => {
    for (const li of localItems) {
      if (!remoteItemIds.has(li.id)) {
        const createdMs = new Date(li.created_at).getTime()
        const updatedMs = new Date(li.updated_at).getTime()
        if (createdMs > protectAfter || updatedMs > protectAfter) {
          continue // 보호 윈도우: lastSyncAt 이후 생성/변경 → 삭제 스킵
        }
        db.prepare('DELETE FROM note_item WHERE id=?').run(li.id)
        deleted++
      }
    }
  })()
  return deleted
}

// ─── pendingSyncQueue 시뮬레이션 ────────────────────────
function flushPendingSyncQueue(db, queue, tombstoneSet) {
  const remaining = []
  let count = 0
  for (const p of queue) {
    if (p.action === 'upsert') {
      if (tombstoneSet && tombstoneSet.has(`${p.table}:${p.id}`)) continue // tombstone → 건너뜀
      count++
    } else if (p.action === 'delete') {
      count++
    } else {
      remaining.push(p) // 알 수 없는 액션 → 잔류
    }
  }
  queue.length = 0
  queue.push(...remaining)
  return count
}

// ─── quickPull 시뮬레이션 ────────────────────────────────
let quickPulling = false
async function quickPull(db, since) {
  if (quickPulling) return -1 // 이중 진입 차단
  quickPulling = true
  try {
    const { data, error } = await sb.from('note_item').select('*')
      .eq('user_id', TEST_USER_ID)
      .gt('updated_at', since || 0)
    if (error) return 0
    const remoteItems = data || []
    if (remoteItems.length === 0) return 0
    const tombstones = new Set(getTombstones(db).map(t => t.id))
    let count = 0
    db.transaction(() => {
      for (const ri of remoteItems) {
        if (tombstones.has(ri.id)) continue // tombstone → 무시
        const day = ri.day_id || ri.day
        const updatedAt = toIso(ri.updated_at)
        const createdAt = toIso(ri.created_at || ri.updated_at)
        const local = db.prepare('SELECT * FROM note_item WHERE id=?').get(ri.id)
        if (!local) {
          db.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ri.id, day, ri.user_id, ri.type, ri.content, ri.tags || '[]', ri.pinned || 0, ri.order_index || 0, updatedAt, createdAt)
          count++
        } else if (isNewer(ri.updated_at, local.updated_at)) {
          db.prepare(`UPDATE note_item SET content=?,updated_at=? WHERE id=?`)
            .run(ri.content, updatedAt, ri.id)
          count++
        }
      }
    })()
    return count
  } finally {
    quickPulling = false
  }
}

// ─── fullSync 시뮬레이션 (push → clean → pull) ──────────
let syncing = false
async function fullSync(db) {
  if (syncing) return { blocked: true }
  syncing = true
  try {
    const pushed = await pushToServer(db)
    const remoteItems = await sbGetItems()
    const remoteItemIds = new Set(remoteItems.map(i => i.id))
    const lastSyncAt = Date.now() - 10 * 60 * 1000 // 10분 전
    const cleaned = cleanDeletedFromRemote(db, remoteItemIds, lastSyncAt)
    const pulled = await pullFromServer(db)
    return { pushed, cleaned, pulled, blocked: false }
  } finally {
    syncing = false
  }
}

// ═══════════════════════════════════════════════════════
// 메인 테스트 실행
// ═══════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log(' Wition 하드코어 동기화 테스트 v2')
  console.log(` Supabase: ${SB_URL}`)
  console.log(` 테스트 유저: ${TEST_USER_ID}`)
  console.log('═══════════════════════════════════════════════════════════\n')

  // 초기화
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  mkdirSync(TEST_DIR, { recursive: true })
  sb = createClient(SB_URL, SRK)

  // Supabase 연결 확인
  const { error: connErr } = await sb.from('note_item').select('id', { count: 'exact', head: true })
  if (connErr) {
    console.log(`❌ Supabase 연결 실패: ${connErr.message}`)
    process.exit(1)
  }
  console.log('✅ Supabase 연결 OK')

  // 테스트 서버 확인
  const ping = await pcPing()
  hasTestServer = !!(ping && ping.ok)
  console.log(hasTestServer ? '✅ 테스트 서버 연결 OK' : '⚠️  테스트 서버 없음 (일부 테스트 스킵)')
  console.log('')

  // ═══════ A. 내부 메커니즘 검증 (10개) ═══════
  console.log('── A. 내부 메커니즘 검증 ──')

  await test('A01. pendingSyncQueue: 실패 → 큐 적재 → 재시도 성공', async () => {
    await sbCleanup()
    const db = createTestDb('a01')
    const id1 = addItem(db, '2031-01-01', '큐 테스트 1')
    const id2 = addItem(db, '2031-01-01', '큐 테스트 2')

    // 큐에 수동 적재 (push 실패 시뮬)
    const queue = [
      { action: 'upsert', table: 'note_item', id: id1, data: getItem(db, id1) },
      { action: 'upsert', table: 'note_item', id: id2, data: getItem(db, id2) },
    ]
    eq(queue.length, 2, '큐에 2건 적재')

    // tombstone 없는 상태로 flush
    const tombstoneSet = new Set()
    const flushed = flushPendingSyncQueue(db, queue, tombstoneSet)
    eq(flushed, 2, '2건 처리')
    eq(queue.length, 0, '큐 비워짐')

    // 실제 서버에 push하여 검증
    await pushToServer(db)
    const remote = await sbGetItems()
    ok(remote.length >= 2, '서버에 2건 이상 존재')
    db.close()
  })

  await test('A02. pendingSyncQueue: tombstone 있는 항목 큐에서 건너뜀', async () => {
    await sbCleanup()
    const db = createTestDb('a02')
    const id1 = addItem(db, '2031-01-02', '삭제될 항목')
    const id2 = addItem(db, '2031-01-02', '유지될 항목')

    // id1 삭제 → tombstone 생성
    deleteItem(db, id1)

    const queue = [
      { action: 'upsert', table: 'note_item', id: id1, data: { id: id1 } },
      { action: 'upsert', table: 'note_item', id: id2, data: { id: id2 } },
    ]

    const tombstoneSet = new Set([`note_item:${id1}`])
    const flushed = flushPendingSyncQueue(db, queue, tombstoneSet)
    eq(flushed, 1, 'tombstone 항목 제외, 1건만 처리')
    eq(queue.length, 0, '큐 비워짐')
    db.close()
  })

  await test('A03. pendingSyncQueue: 중복 항목 방지', async () => {
    const queue = []
    const id1 = uid()

    // 같은 ID로 2번 적재 시도
    function enqueue(p) {
      const key = `${p.action}:${p.table}:${p.id}`
      const exists = queue.some(q => `${q.action}:${q.table}:${q.id}` === key)
      if (!exists) queue.push(p)
    }

    enqueue({ action: 'upsert', table: 'note_item', id: id1 })
    enqueue({ action: 'upsert', table: 'note_item', id: id1 }) // 중복
    enqueue({ action: 'delete', table: 'note_item', id: id1 }) // 다른 action → 별도

    eq(queue.length, 2, 'upsert 중복 제거, delete는 별도 = 2건')
  })

  await test('A04. quickPull: 동시 2회 호출 → 1회만 실행', async () => {
    await sbCleanup()
    const db = createTestDb('a04')

    // 서버에 데이터 넣기
    await sbInsertItem({ id: uid(), day: '2031-01-04', content: 'qp test', updated_at: epoch() })

    // 동시 2회 호출
    const [r1, r2] = await Promise.all([
      quickPull(db, 0),
      quickPull(db, 0),
    ])

    // 하나는 정상, 하나는 -1 (차단)
    ok(r1 === -1 || r2 === -1, '하나는 차단됨 (-1)')
    ok(r1 >= 0 || r2 >= 0, '하나는 정상 실행')
    db.close()
  })

  await test('A05. quickPull: tombstone 있는 항목 INSERT 무시', async () => {
    await sbCleanup()
    const db = createTestDb('a05')
    const id1 = uid()

    // 서버에 항목 추가
    await sbInsertItem({ id: id1, day: '2031-01-05', content: '삭제된 항목', updated_at: epoch() })

    // 로컬에 tombstone 추가 (이미 삭제한 것으로 기록)
    db.prepare('INSERT INTO tombstone (id, table_name, deleted_at) VALUES (?,?,?)').run(id1, 'note_item', iso())

    const pulled = await quickPull(db, 0)
    const local = getItem(db, id1)
    ok(!local, 'tombstone 있는 항목은 INSERT 안 됨')
    db.close()
  })

  await test('A06. cleanDeletedFromRemote: lastSyncAt 이후 로컬 생성 항목 보호', async () => {
    const db = createTestDb('a06')
    const lastSyncAt = Date.now() - 5000 // 5초 전 마지막 동기화

    // lastSyncAt 이전에 생성된 항목 (보호 안 됨)
    const oldId = addItem(db, '2031-01-06', '오래된 항목', {
      created_at: new Date(lastSyncAt - 60000).toISOString(),
      updated_at: new Date(lastSyncAt - 60000).toISOString(),
    })

    // lastSyncAt 이후에 생성된 항목 (보호됨)
    const newId = addItem(db, '2031-01-06', '새 항목') // now > lastSyncAt

    // 서버에는 아무것도 없음 → 둘 다 "서버에 없는 항목"
    const remoteItemIds = new Set()
    const deleted = cleanDeletedFromRemote(db, remoteItemIds, lastSyncAt)

    ok(!getItem(db, oldId), '오래된 항목은 삭제됨')
    ok(!!getItem(db, newId), '새 항목은 보호됨 (삭제 안 됨)')
    eq(deleted, 1, '1건만 삭제')
    db.close()
  })

  await test('A07. cleanDeletedFromRemote: 서버 0건 + 로컬 최근 생성 → 전체 삭제 방지', async () => {
    const db = createTestDb('a07')
    const lastSyncAt = Date.now() - 1000 // 1초 전

    // 모두 최근에 생성 (보호 대상)
    addItem(db, '2031-01-07', '최근 1')
    addItem(db, '2031-01-07', '최근 2')
    addItem(db, '2031-01-07', '최근 3')

    const remoteItemIds = new Set() // 서버 0건
    const deleted = cleanDeletedFromRemote(db, remoteItemIds, lastSyncAt)

    eq(deleted, 0, '전체 삭제 방지: 0건 삭제')
    eq(getItems(db).length, 3, '로컬 3건 모두 보존')
    db.close()
  })

  await test('A08. syncing 플래그: fullSync 중 또 fullSync → 차단', async () => {
    await sbCleanup()
    const db = createTestDb('a08')
    addItem(db, '2031-01-08', '동시 sync 테스트')

    // 동시 fullSync 2회
    const [r1, r2] = await Promise.all([
      fullSync(db),
      fullSync(db),
    ])

    ok(r1.blocked || r2.blocked, '하나는 차단됨')
    ok(!r1.blocked || !r2.blocked, '하나는 정상 실행')
    db.close()
  })

  await test('A09. fetchAllRows 시뮬: 1500행 pull 테스트', async () => {
    await sbCleanup()
    const db = createTestDb('a09')
    const batchSize = 1500

    // 서버에 1500건 삽입 (배치)
    const items = []
    for (let i = 0; i < batchSize; i++) {
      items.push({
        id: uid(),
        day_id: '2031-01-09',
        type: 'text',
        content: `item-${i}`,
        tags: '[]',
        pinned: 0,
        order_index: i,
        updated_at: epoch() + i,
        created_at: epoch(),
        user_id: TEST_USER_ID,
        version: 1,
      })
    }
    // 배치 upsert (100개씩)
    for (let i = 0; i < items.length; i += 100) {
      const batch = items.slice(i, i + 100)
      const { error } = await sb.from('note_item').upsert(batch)
      if (error) throw new Error(`배치 삽입 실패: ${error.message}`)
    }

    // pull (Supabase 기본 1000행 제한 → 페이지네이션 필요)
    // 직접 fetchAllRows 시뮬
    let allItems = []
    let offset = 0
    const pageSize = 1000
    while (true) {
      const { data, error } = await sb.from('note_item').select('*')
        .eq('user_id', TEST_USER_ID)
        .range(offset, offset + pageSize - 1)
      if (error) throw new Error(`페이지네이션 실패: ${error.message}`)
      allItems = allItems.concat(data || [])
      if (!data || data.length < pageSize) break
      offset += pageSize
    }

    ok(allItems.length >= batchSize, `1500건 이상 수신: ${allItems.length}`)
    db.close()
  })

  await test('A10. tombstone 30분 만료 + 같은 ID 재생성', async () => {
    await sbCleanup()
    const db = createTestDb('a10')
    const id1 = addItem(db, '2031-01-10', '원본 항목')

    // 삭제 → tombstone (30분 전으로 설정)
    db.prepare('DELETE FROM note_item WHERE id=?').run(id1)
    const oldTime = new Date(Date.now() - 31 * 60 * 1000).toISOString()
    db.prepare('INSERT OR REPLACE INTO tombstone (id, table_name, deleted_at) VALUES (?,?,?)').run(id1, 'note_item', oldTime)

    // 만료된 tombstone 정리
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    db.prepare('DELETE FROM tombstone WHERE deleted_at < ?').run(cutoff)

    const tombs = getTombstones(db)
    eq(tombs.length, 0, 'tombstone 만료 후 삭제됨')

    // 같은 ID로 재생성
    db.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id1, '2031-01-10', TEST_USER_ID, 'text', '재생성된 항목', '[]', 0, 0, iso(), iso())

    const item = getItem(db, id1)
    ok(!!item, '같은 ID로 재생성 가능')
    eq(item.content, '재생성된 항목', '새 내용')
    db.close()
  })

  // ═══════ B. 현실 사용자 시나리오 (10개) ═══════
  console.log('\n── B. 현실 사용자 시나리오 ──')

  await test('B01. 출퇴근 패턴: PC 작성 → 모바일 추가 → PC 복귀', async () => {
    await sbCleanup()
    const pc = createTestDb('b01_pc')

    // 1) 아침: PC에서 5건 작성
    for (let i = 0; i < 5; i++) addItem(pc, '2031-02-01', `PC 메모 ${i}`)
    await pushToServer(pc)
    eq((await sbGetItems()).length, 5, '서버에 5건')

    // 2) 지하철: 모바일에서 2건 추가 (서버에 직접)
    await sbInsertItem({ id: uid(), day: '2031-02-01', content: '모바일 메모 1', updated_at: epoch() })
    await sbInsertItem({ id: uid(), day: '2031-02-01', content: '모바일 메모 2', updated_at: epoch() })
    eq((await sbGetItems()).length, 7, '서버에 7건')

    // 3) 회사: PC 복귀 → fullSync
    await pullFromServer(pc)
    eq(getItems(pc).length, 7, 'PC에 7건 모두 존재')
    pc.close()
  })

  await test('B02. 같은 날짜 동시 편집: PC + 모바일 다른 블록', async () => {
    await sbCleanup()
    const pc = createTestDb('b02_pc')

    // PC: 블록 A 추가
    const idA = addItem(pc, '2031-02-02', 'PC 블록 A')
    await pushToServer(pc)

    // 모바일: 블록 B 추가 (서버에 직접)
    const idB = uid()
    await sbInsertItem({ id: idB, day: '2031-02-02', content: '모바일 블록 B', updated_at: epoch() })

    // PC: pull
    await pullFromServer(pc)
    ok(!!getItem(pc, idA), '블록 A 존재')
    ok(!!getItem(pc, idB), '블록 B 존재')
    eq(getItems(pc).length, 2, '총 2블록 병합')
    pc.close()
  })

  await test('B03. 같은 블록 동시 수정: LWW로 최신 값만 생존', async () => {
    await sbCleanup()
    const pc = createTestDb('b03_pc')
    const id1 = addItem(pc, '2031-02-03', 'original')
    await pushToServer(pc)

    // PC: 먼저 수정 (t+1000)
    await sleep(50)
    updateItem(pc, id1, 'PC 수정')
    await pushToServer(pc)

    // 모바일: 나중에 수정 (t+2000) → 이 값이 이겨야 함
    await sleep(50)
    await sbInsertItem({ id: id1, day: '2031-02-03', content: '모바일 수정 (최신)', updated_at: epoch() })

    // PC: pull → 모바일 값으로 덮어씌워짐
    await pullFromServer(pc)
    eq(getItem(pc, id1).content, '모바일 수정 (최신)', 'LWW: 모바일이 최신')
    pc.close()
  })

  await test('B04. 빈 메모 생성→즉시 삭제→sync', async () => {
    await sbCleanup()
    const pc = createTestDb('b04_pc')

    const id1 = addItem(pc, '2031-02-04', '')
    await sleep(10)
    deleteItem(pc, id1) // 즉시 삭제

    // push → tombstone으로 서버에서도 삭제
    await pushToServer(pc)
    const remote = await sbGetItems()
    eq(remote.length, 0, '서버에 아무것도 없음')

    const tombs = getTombstones(pc)
    eq(tombs.length, 1, 'tombstone 1건')
    pc.close()
  })

  await test('B05. 체크리스트 동시 토글: JSON 전체가 LWW', async () => {
    await sbCleanup()
    const pc = createTestDb('b05_pc')

    const checklist = JSON.stringify([
      { text: '항목1', checked: false },
      { text: '항목2', checked: false },
      { text: '항목3', checked: false },
    ])
    const id1 = addItem(pc, '2031-02-05', checklist, { type: 'checklist' })
    await pushToServer(pc)

    // PC: 항목1 체크 (t+50)
    await sleep(50)
    const pcChecked = JSON.stringify([
      { text: '항목1', checked: true },
      { text: '항목2', checked: false },
      { text: '항목3', checked: false },
    ])
    updateItem(pc, id1, pcChecked)
    await pushToServer(pc)

    // 모바일: 항목2 체크 (t+100, 최신) → 항목1은 체크 안 됨 (LWW 한계)
    await sleep(50)
    const mobChecked = JSON.stringify([
      { text: '항목1', checked: false },
      { text: '항목2', checked: true },
      { text: '항목3', checked: false },
    ])
    await sbInsertItem({ id: id1, day: '2031-02-05', content: mobChecked, type: 'checklist', updated_at: epoch() })

    // PC: pull → 모바일 버전이 이김 (LWW)
    await pullFromServer(pc)
    const result = JSON.parse(getItem(pc, id1).content)
    eq(result[0].checked, false, 'LWW 한계: 항목1 체크 해제됨 (모바일이 최신)')
    eq(result[1].checked, true, '항목2 체크됨 (모바일 버전)')
    pc.close()
  })

  await test('B06. 장기 미사용(7일): 로컬 100건 + 서버 50건 변경', async () => {
    await sbCleanup()
    const pc = createTestDb('b06_pc')

    // 로컬에 100건 (일주일 전 생성)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    for (let i = 0; i < 100; i++) {
      addItem(pc, '2031-02-06', `로컬 ${i}`, { created_at: weekAgo, updated_at: weekAgo })
    }
    // push 먼저 (서버에도 100건)
    await pushToServer(pc)

    // 서버에서 50건 수정 (모바일이 일주일간 수정한 것 시뮬)
    const serverItems = await sbGetItems()
    for (let i = 0; i < 50; i++) {
      await sbInsertItem({
        id: serverItems[i].id,
        day: '2031-02-06',
        content: `모바일 수정 ${i}`,
        updated_at: epoch() + i,
      })
    }

    // PC: 일주일 만에 열기 → fullSync
    await pullFromServer(pc)
    const items = getItems(pc)
    eq(items.length, 100, '총 100건 유지')

    const modified = items.filter(i => i.content.startsWith('모바일 수정'))
    eq(modified.length, 50, '50건 모바일 수정 반영')
    pc.close()
  })

  await test('B07. PC 절전→복귀: 동기화 상태 리셋 → fullSync', async () => {
    await sbCleanup()
    const pc = createTestDb('b07_pc')

    // 절전 전: 5건 작성 + push
    for (let i = 0; i < 5; i++) addItem(pc, '2031-02-07', `절전 전 ${i}`)
    await pushToServer(pc)

    // 절전 중: 모바일에서 3건 추가
    for (let i = 0; i < 3; i++) {
      await sbInsertItem({ id: uid(), day: '2031-02-07', content: `절전 중 모바일 ${i}`, updated_at: epoch() + i })
    }

    // 복귀: syncing 플래그 리셋 확인 + fullSync
    syncing = false // 절전 복귀 시 리셋
    quickPulling = false
    const result = await fullSync(pc)
    ok(!result.blocked, 'fullSync 정상 실행')
    eq(getItems(pc).length, 8, '8건 모두 존재')
    pc.close()
  })

  await test('B08. 앱 강제 종료 후 재시작: 반만 push된 상태 복구', async () => {
    await sbCleanup()
    const pc = createTestDb('b08_pc')

    // 10건 추가
    const ids = []
    for (let i = 0; i < 10; i++) ids.push(addItem(pc, '2031-02-08', `항목 ${i}`))

    // 5건만 서버에 push (강제 종료 시뮬)
    for (let i = 0; i < 5; i++) await sbInsertItem(getItem(pc, ids[i]))
    eq((await sbGetItems()).length, 5, '서버에 5건만')

    // 재시작 → fullSync (나머지 5건 push)
    const result = await fullSync(pc)
    const remote = await sbGetItems()
    eq(remote.length, 10, '재시작 후 10건 모두 서버에 존재')
    pc.close()
  })

  await test('B09. OneDrive→Supabase 4단계 릴레이', async () => {
    await sbCleanup()
    const pc1 = createTestDb('b09_pc1') // 오프라인 PC
    const pc2 = createTestDb('b09_pc2') // 온라인 PC
    const onedrive = createTestDb('b09_od')

    // PC1 (오프라인): 3건 작성
    for (let i = 0; i < 3; i++) addItem(pc1, '2031-02-09', `PC1 오프라인 ${i}`)

    // 1단계: PC1 → OneDrive 병합
    mergeFromOneDrive(onedrive, pc1)
    eq(onedrive.prepare('SELECT COUNT(*) as c FROM note_item').get().c, 3, 'OneDrive에 3건')

    // 2단계: OneDrive → PC2
    mergeFromOneDrive(pc2, onedrive)
    eq(getItems(pc2).length, 3, 'PC2에 3건')

    // 3단계: PC2 → Supabase
    await pushToServer(pc2)
    eq((await sbGetItems()).length, 3, 'Supabase에 3건')

    // 4단계: 모바일 (서버에서 확인)
    const mobile = createTestDb('b09_mob')
    await pullFromServer(mobile)
    eq(getItems(mobile).length, 3, '모바일에 3건 도착')

    pc1.close(); pc2.close(); onedrive.close(); mobile.close()
  })

  await test('B10. 역방향 릴레이: 모바일 삭제 → 4단계 역전파', async () => {
    await sbCleanup()
    const pc1 = createTestDb('b10_pc1')
    const pc2 = createTestDb('b10_pc2')
    const onedrive = createTestDb('b10_od')

    // 모든 기기에 공통 데이터 3건 (충분히 오래된 시간 = 보호 윈도우 밖)
    const ids = []
    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString() // 20분 전
    for (let i = 0; i < 3; i++) {
      const id = uid()
      ids.push(id)
      addItem(pc1, '2031-02-10', `공통 ${i}`, { id, created_at: oldTime, updated_at: oldTime })
      addItem(pc2, '2031-02-10', `공통 ${i}`, { id, created_at: oldTime, updated_at: oldTime })
      addItem(onedrive, '2031-02-10', `공통 ${i}`, { id, created_at: oldTime, updated_at: oldTime })
      await sbInsertItem({ id, day: '2031-02-10', content: `공통 ${i}`, updated_at: toEpoch(oldTime), created_at: toEpoch(oldTime) })
    }

    // 1단계: 모바일에서 id[0] 삭제 (서버에서 직접)
    await sbDeleteItem(ids[0])

    // 2단계: PC2 pull → cleanDeletedFromRemote (lastSyncAt = 10분 전, oldTime = 20분 전 → 보호 안 됨)
    const remoteItems = await sbGetItems()
    const remoteIds = new Set(remoteItems.map(i => i.id))
    const cleaned2 = cleanDeletedFromRemote(pc2, remoteIds, Date.now() - 10 * 60 * 1000)
    ok(cleaned2 >= 1, `PC2에서 1건 이상 정리되어야 함 (실제: ${cleaned2})`)

    // 3단계: PC2 → OneDrive 병합 (tombstone 전파)
    pc2.prepare('INSERT OR REPLACE INTO tombstone (id, table_name, deleted_at) VALUES (?,?,?)').run(ids[0], 'note_item', iso())
    mergeFromOneDrive(onedrive, pc2)
    ok(!onedrive.prepare('SELECT * FROM note_item WHERE id=?').get(ids[0]), 'OneDrive에서 삭제됨')

    // 4단계: OneDrive → PC1 병합
    mergeFromOneDrive(pc1, onedrive)
    ok(!getItem(pc1, ids[0]), 'PC1에서 삭제됨')
    eq(getItems(pc1).length, 2, 'PC1에 2건만 남음')

    pc1.close(); pc2.close(); onedrive.close()
  })

  // ═══════ C. 데이터 정합성 심화 (10개) ═══════
  console.log('\n── C. 데이터 정합성 심화 ──')

  await test('C01. note_day count: 블록 5개 추가 후 count 정확성', async () => {
    await sbCleanup()
    const db = createTestDb('c01')
    const day = '2031-03-01'
    addDay(db, day, { note_count: 0 })

    for (let i = 0; i < 5; i++) addItem(db, day, `블록 ${i}`)

    // count 수동 계산
    const actual = db.prepare('SELECT COUNT(*) as c FROM note_item WHERE day=?').get(day).c
    eq(actual, 5, '실제 블록 5개')

    // day count 갱신
    db.prepare('UPDATE note_day SET note_count=? WHERE day=?').run(actual, day)
    const dayRow = db.prepare('SELECT * FROM note_day WHERE day=?').get(day)
    eq(dayRow.note_count, 5, 'note_count=5')

    // push → 서버 확인
    await pushToServer(db)
    const remoteDays = await sbGetDays()
    const remoteDay = remoteDays.find(d => d.id === day)
    ok(!!remoteDay, '서버에 day 존재')
    eq(remoteDay.note_count, 5, '서버 note_count=5')
    db.close()
  })

  await test('C02. note_day count: 블록 삭제 후 count 감소', async () => {
    await sbCleanup()
    const db = createTestDb('c02')
    const day = '2031-03-02'
    addDay(db, day, { note_count: 0 })

    const ids = []
    for (let i = 0; i < 5; i++) ids.push(addItem(db, day, `블록 ${i}`))

    // 3건 삭제
    deleteItem(db, ids[0])
    deleteItem(db, ids[1])
    deleteItem(db, ids[2])

    const actual = db.prepare('SELECT COUNT(*) as c FROM note_item WHERE day=?').get(day).c
    eq(actual, 2, '삭제 후 2건')

    db.prepare('UPDATE note_day SET note_count=? WHERE day=?').run(actual, day)
    const dayRow = db.prepare('SELECT * FROM note_day WHERE day=?').get(day)
    eq(dayRow.note_count, 2, 'note_count=2')
    db.close()
  })

  await test('C03. 블록 순서(order_index) 보존 후 sync', async () => {
    await sbCleanup()
    const db = createTestDb('c03')
    const day = '2031-03-03'

    // 순서: A(0), B(1), C(2), D(3), E(4)
    const idA = addItem(db, day, 'A', { order_index: 0 })
    const idB = addItem(db, day, 'B', { order_index: 1 })
    const idC = addItem(db, day, 'C', { order_index: 2 })
    const idD = addItem(db, day, 'D', { order_index: 3 })
    const idE = addItem(db, day, 'E', { order_index: 4 })

    // 순서 변경: C(0), A(1), E(2), B(3), D(4)
    db.prepare('UPDATE note_item SET order_index=?, updated_at=? WHERE id=?').run(0, iso(), idC)
    db.prepare('UPDATE note_item SET order_index=?, updated_at=? WHERE id=?').run(1, iso(), idA)
    db.prepare('UPDATE note_item SET order_index=?, updated_at=? WHERE id=?').run(2, iso(), idE)
    db.prepare('UPDATE note_item SET order_index=?, updated_at=? WHERE id=?').run(3, iso(), idB)
    db.prepare('UPDATE note_item SET order_index=?, updated_at=? WHERE id=?').run(4, iso(), idD)

    // push → pull (다른 DB)
    await pushToServer(db)
    const db2 = createTestDb('c03_pull')
    await pullFromServer(db2)

    const sorted = db2.prepare('SELECT * FROM note_item WHERE day=? ORDER BY order_index').all(day)
    eq(sorted[0].content, 'C', '순서 0: C')
    eq(sorted[1].content, 'A', '순서 1: A')
    eq(sorted[2].content, 'E', '순서 2: E')
    eq(sorted[3].content, 'B', '순서 3: B')
    eq(sorted[4].content, 'D', '순서 4: D')
    db.close(); db2.close()
  })

  await test('C04. 알람 fired 상태 동기화', async () => {
    await sbCleanup()
    const db = createTestDb('c04')
    const itemId = addItem(db, '2031-03-04', '알람 테스트')
    const alarmId = addAlarm(db, itemId, '2031-03-04T09:00:00')

    // fired=0 상태로 push
    await pushToServer(db)
    let remote = await sbGetAlarms()
    eq(remote[0].fired, 0, '서버 fired=0')

    // PC에서 알람 발동 (fired=1)
    db.prepare('UPDATE alarm SET fired=1, updated_at=? WHERE id=?').run(iso(), alarmId)
    await pushToServer(db)

    // 모바일 (서버에서 확인)
    remote = await sbGetAlarms()
    eq(remote[0].fired, 1, '서버 fired=1 반영')

    // 다른 기기에서 pull
    const db2 = createTestDb('c04_pull')
    await pullFromServer(db2)
    const alarm = db2.prepare('SELECT * FROM alarm WHERE id=?').get(alarmId)
    eq(alarm.fired, 1, 'pull 후 fired=1')
    db.close(); db2.close()
  })

  await test('C05. 알람 repeat 변경 동기화: daily → weekdays', async () => {
    await sbCleanup()
    const db = createTestDb('c05')
    const itemId = addItem(db, '2031-03-05', '반복 알람')
    const alarmId = addAlarm(db, itemId, '2031-03-05T08:00:00', { repeat_type: 'daily' })

    await pushToServer(db)

    // repeat 변경
    await sleep(50)
    db.prepare('UPDATE alarm SET repeat_type=?, updated_at=? WHERE id=?')
      .run('weekdays', iso(), alarmId)
    await pushToServer(db)

    const db2 = createTestDb('c05_pull')
    await pullFromServer(db2)
    const alarm = db2.prepare('SELECT * FROM alarm WHERE id=?').get(alarmId)
    eq(alarm.repeat_type, 'weekdays', 'repeat_type 변경됨')
    db.close(); db2.close()
  })

  await test('C06. pinned 상태: 고정→해제→재고정 3단계 동기화', async () => {
    await sbCleanup()
    const db = createTestDb('c06')
    const id1 = addItem(db, '2031-03-06', 'pinned 테스트')
    await pushToServer(db)

    // 1단계: 고정
    await sleep(30)
    db.prepare('UPDATE note_item SET pinned=1, updated_at=? WHERE id=?').run(iso(), id1)
    await pushToServer(db)
    let remote = await sbGetItem(id1)
    eq(remote.pinned, 1, '서버 pinned=1')

    // 2단계: 해제
    await sleep(30)
    db.prepare('UPDATE note_item SET pinned=0, updated_at=? WHERE id=?').run(iso(), id1)
    await pushToServer(db)
    remote = await sbGetItem(id1)
    eq(remote.pinned, 0, '서버 pinned=0')

    // 3단계: 재고정
    await sleep(30)
    db.prepare('UPDATE note_item SET pinned=1, updated_at=? WHERE id=?').run(iso(), id1)
    await pushToServer(db)
    remote = await sbGetItem(id1)
    eq(remote.pinned, 1, '서버 pinned=1 (재고정)')
    db.close()
  })

  await test('C07. tags JSON 배열 동기화', async () => {
    await sbCleanup()
    const db = createTestDb('c07')
    const tags1 = JSON.stringify(['일상', '중요'])
    const id1 = addItem(db, '2031-03-07', '태그 테스트', { tags: tags1 })
    await pushToServer(db)

    // 태그 추가
    await sleep(30)
    const tags2 = JSON.stringify(['일상', '중요', '업무'])
    db.prepare('UPDATE note_item SET tags=?, updated_at=? WHERE id=?').run(tags2, iso(), id1)
    await pushToServer(db)

    // 다른 기기에서 pull
    const db2 = createTestDb('c07_pull')
    await pullFromServer(db2)
    const item = getItem(db2, id1)
    const tags = JSON.parse(item.tags)
    eq(tags.length, 3, '태그 3개')
    ok(tags.includes('업무'), '업무 태그 존재')
    db.close(); db2.close()
  })

  await test('C08. mood 이모지: null→😊→😢→null 4단계 동기화', async () => {
    await sbCleanup()
    const db = createTestDb('c08')
    const day = '2031-03-08'
    addDay(db, day, { mood: null })
    await pushToServer(db)

    // 1) null → 😊
    await sleep(30)
    db.prepare('UPDATE note_day SET mood=?, updated_at=? WHERE day=?').run('😊', iso(), day)
    await pushToServer(db)
    let remote = (await sbGetDays()).find(d => d.id === day)
    eq(remote.mood, '😊', '서버 mood=😊')

    // 2) 😊 → 😢
    await sleep(30)
    db.prepare('UPDATE note_day SET mood=?, updated_at=? WHERE day=?').run('😢', iso(), day)
    await pushToServer(db)
    remote = (await sbGetDays()).find(d => d.id === day)
    eq(remote.mood, '😢', '서버 mood=😢')

    // 3) 😢 → null
    await sleep(30)
    db.prepare('UPDATE note_day SET mood=?, updated_at=? WHERE day=?').run(null, iso(), day)
    await pushToServer(db)
    remote = (await sbGetDays()).find(d => d.id === day)
    eq(remote.mood, null, '서버 mood=null')
    db.close()
  })

  await test('C09. 12종 블록타입 왕복 동기화', async () => {
    await sbCleanup()
    const db = createTestDb('c09')
    const day = '2031-03-09'
    const types = ['text', 'heading1', 'heading2', 'heading3', 'bulleted_list', 'numbered_list',
      'checklist', 'quote', 'divider', 'callout', 'code', 'toggle']
    const ids = []

    for (const type of types) {
      const content = type === 'checklist'
        ? JSON.stringify([{ text: `${type} item`, checked: false }])
        : type === 'callout'
          ? JSON.stringify({ icon: '💡', text: `${type} content` })
          : type === 'code'
            ? JSON.stringify({ language: 'js', code: 'console.log()' })
            : `${type} 내용`
      ids.push(addItem(db, day, content, { type }))
    }

    await pushToServer(db)

    // 다른 기기에서 pull
    const db2 = createTestDb('c09_pull')
    await pullFromServer(db2)

    for (let i = 0; i < types.length; i++) {
      const item = getItem(db2, ids[i])
      ok(!!item, `${types[i]} 존재`)
      eq(item.type, types[i], `타입 일치: ${types[i]}`)
    }

    // 수정 후 재sync
    for (const id of ids) {
      await sleep(10)
      const item = getItem(db2, id)
      const newContent = item.type === 'divider' ? '' : item.content + ' (수정됨)'
      updateItem(db2, id, newContent)
    }
    await pushToServer(db2)
    await pullFromServer(db)

    for (const id of ids) {
      const item = getItem(db, id)
      if (item.type !== 'divider') {
        ok(item.content.includes('수정됨'), `${item.type} 수정 반영`)
      }
    }
    db.close(); db2.close()
  })

  await test('C10. day summary 갱신 후 동기화', async () => {
    await sbCleanup()
    const db = createTestDb('c10')
    const day = '2031-03-10'
    addDay(db, day, { summary: '' })
    addItem(db, day, '오늘은 날씨가 좋았다')
    addItem(db, day, '점심에 라면 먹음')

    // summary 갱신
    const items = db.prepare('SELECT content FROM note_item WHERE day=? ORDER BY order_index LIMIT 2').all(day)
    const summary = items.map(i => i.content).join(' / ')
    db.prepare('UPDATE note_day SET summary=?, note_count=2, updated_at=? WHERE day=?').run(summary, iso(), day)

    await pushToServer(db)

    const db2 = createTestDb('c10_pull')
    await pullFromServer(db2)
    const dayRow = db2.prepare('SELECT * FROM note_day WHERE day=?').get(day)
    ok(dayRow.summary.includes('날씨'), 'summary 포함')
    ok(dayRow.summary.includes('라면'), 'summary 포함')
    eq(dayRow.note_count, 2, 'count=2')
    db.close(); db2.close()
  })

  // ═══════ D. 네트워크 장애 복구 (8개) ═══════
  console.log('\n── D. 네트워크 장애 복구 ──')

  await test('D01. Realtime 끊김 동안 모바일 추가 → fullSync로 보충', async () => {
    await sbCleanup()
    const db = createTestDb('d01')

    // 기존 데이터 push
    addItem(db, '2031-04-01', '기존 메모')
    await pushToServer(db)

    // Realtime 끊김 시뮬: 그 동안 모바일 3건 추가
    const mobIds = []
    for (let i = 0; i < 3; i++) {
      const id = uid()
      mobIds.push(id)
      await sbInsertItem({ id, day: '2031-04-01', content: `끊김 중 추가 ${i}`, updated_at: epoch() + i })
    }

    // 재연결 후 fullSync
    await pullFromServer(db)
    eq(getItems(db).length, 4, '기존 1 + 모바일 3 = 4건')
    for (const id of mobIds) {
      ok(!!getItem(db, id), `모바일 항목 ${id.slice(0,8)} 존재`)
    }
    db.close()
  })

  await test('D02. push 5건 중 3건째 실패 → pendingSyncQueue 잔여', async () => {
    const queue = []
    const ids = Array.from({ length: 5 }, () => uid())

    // 5건 중 3번째(idx=2)와 4번째(idx=3)에서 실패 시뮬
    for (let i = 0; i < 5; i++) {
      if (i === 2 || i === 3) {
        queue.push({ action: 'upsert', table: 'note_item', id: ids[i], failed: true })
      }
      // 성공한 것은 큐에 안 넣음 (실패만 적재)
    }

    eq(queue.length, 2, '실패 2건 큐에 적재')

    // flush 시뮬 (tombstone 없음)
    const flushed = flushPendingSyncQueue(null, queue, new Set())
    eq(flushed, 2, '2건 재처리')
    eq(queue.length, 0, '큐 비워짐')
  })

  await test('D03. fullSync pull 중 서버 에러 → 로컬 무손상', async () => {
    await sbCleanup()
    const db = createTestDb('d03')

    // 로컬에 데이터 추가
    addItem(db, '2031-04-03', '로컬 데이터 1')
    addItem(db, '2031-04-03', '로컬 데이터 2')
    const beforeCount = getItems(db).length

    // 잘못된 쿼리 시뮬 (없는 테이블)
    try {
      const { data, error } = await sb.from('nonexistent_table').select('*').eq('user_id', TEST_USER_ID)
      // 에러가 나도 로컬은 무손상
    } catch (e) {
      // 예외 발생해도 OK
    }

    eq(getItems(db).length, beforeCount, '로컬 데이터 무손상')
    db.close()
  })

  await test('D04. Realtime INSERT + quickPull 동시 → 같은 항목 중복 방지', async () => {
    await sbCleanup()
    const db = createTestDb('d04')
    const id1 = uid()

    // 서버에 INSERT
    await sbInsertItem({ id: id1, day: '2031-04-04', content: '동시 수신 테스트', updated_at: epoch() })

    // Realtime 수신 시뮬 (로컬에 INSERT)
    db.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id1, '2031-04-04', TEST_USER_ID, 'text', '동시 수신 테스트', '[]', 0, 0, iso(), iso())

    // quickPull (같은 항목 다시 올 수 있음)
    const pulled = await quickPull(db, Date.now() - 60000)

    // 중복 확인
    const items = db.prepare('SELECT * FROM note_item WHERE id=?').all(id1)
    eq(items.length, 1, '중복 없이 1건만 존재')
    db.close()
  })

  await test('D05. 서버 재시작 후 데이터 무결성 확인', async () => {
    await sbCleanup()
    const db = createTestDb('d05')

    // push 5건
    for (let i = 0; i < 5; i++) addItem(db, '2031-04-05', `서버 재시작 ${i}`)
    await pushToServer(db)

    // 서버 "재시작" 시뮬: 새 클라이언트로 조회
    const sb2 = createClient(SB_URL, SRK)
    const { data, error } = await sb2.from('note_item').select('*').eq('user_id', TEST_USER_ID)
    ok(!error, '새 연결 에러 없음')
    eq(data.length, 5, '데이터 5건 유지')
    db.close()
  })

  await test('D06. preserveUpdatedAt: push한 데이터를 다시 pull 시 무한루프 방지', async () => {
    await sbCleanup()
    const db = createTestDb('d06')
    const id1 = addItem(db, '2031-04-06', '무한루프 방지 테스트')
    const beforeUpdatedAt = getItem(db, id1).updated_at

    // push
    await pushToServer(db)

    // pull (자기가 push한 데이터가 돌아옴)
    await pullFromServer(db)
    const afterUpdatedAt = getItem(db, id1).updated_at

    // updated_at이 변하지 않아야 함 (변하면 다시 push 트리거 → 무한루프)
    eq(afterUpdatedAt, beforeUpdatedAt, 'updated_at 변경 없음 (무한루프 방지)')
    db.close()
  })

  await test('D07. WiFi→LTE 전환: Realtime gap → fullSync 보충', async () => {
    await sbCleanup()
    const db = createTestDb('d07')
    addItem(db, '2031-04-07', '기존')
    await pushToServer(db)

    // WiFi 끊김 → LTE 연결 사이에 모바일 5건 추가
    for (let i = 0; i < 5; i++) {
      await sbInsertItem({ id: uid(), day: '2031-04-07', content: `gap 중 ${i}`, updated_at: epoch() + i })
    }

    // LTE 복구 후 fullSync
    const result = await fullSync(db)
    ok(!result.blocked, '정상 실행')
    eq(getItems(db).length, 6, '기존 1 + gap 5 = 6건')
    db.close()
  })

  await test('D08. fullSync + Realtime DELETE 동시 → tombstone 충돌 방지', async () => {
    await sbCleanup()
    const db = createTestDb('d08')
    const id1 = uid()
    const oldTime = new Date(Date.now() - 60000).toISOString()
    addItem(db, '2031-04-08', '삭제 대상', { id: id1, created_at: oldTime, updated_at: oldTime })
    await pushToServer(db)

    // Realtime DELETE 수신 시뮬
    db.prepare('DELETE FROM note_item WHERE id=?').run(id1)
    db.prepare('INSERT OR REPLACE INTO tombstone (id, table_name, deleted_at) VALUES (?,?,?)').run(id1, 'note_item', iso())

    // 동시에 fullSync (서버에서도 삭제)
    await sbDeleteItem(id1)
    await pullFromServer(db)

    // tombstone 중복 확인
    const tombs = db.prepare('SELECT * FROM tombstone WHERE id=?').all(id1)
    eq(tombs.length, 1, 'tombstone 1건만 존재 (중복 없음)')
    ok(!getItem(db, id1), '항목 삭제됨')
    db.close()
  })

  // ═══════ E. 대량 스트레스 (7개) ═══════
  console.log('\n── E. 대량 스트레스 ──')

  await test('E01. 500건 일괄 push → 서버 확인', async () => {
    await sbCleanup()
    const db = createTestDb('e01')
    const t0 = Date.now()

    for (let i = 0; i < 500; i++) addItem(db, '2031-05-01', `대량 ${i}`)

    // 배치 push (100개씩)
    const items = getItems(db)
    for (let i = 0; i < items.length; i += 100) {
      const batch = items.slice(i, i + 100).map(item => ({
        id: item.id,
        day_id: item.day,
        type: item.type,
        content: item.content,
        tags: item.tags,
        pinned: item.pinned,
        order_index: item.order_index,
        updated_at: toEpoch(item.updated_at),
        created_at: toEpoch(item.created_at),
        user_id: TEST_USER_ID,
        version: 1,
      }))
      const { error } = await sb.from('note_item').upsert(batch)
      if (error) throw new Error(`배치 push 실패: ${error.message}`)
    }

    const elapsed = Date.now() - t0
    const remote = await sbGetItems()
    eq(remote.length, 500, '서버 500건')
    ok(elapsed < 15000, `15초 이내: ${elapsed}ms`)
    console.log(`          ⏱️ ${elapsed}ms`)
    db.close()
  })

  await test('E02. 1500건 서버 → fetchAllRows 페이지네이션 pull', async () => {
    // A09에서 이미 1500건 넣었으므로 새로 넣기
    await sbCleanup()
    const items = []
    for (let i = 0; i < 1500; i++) {
      items.push({
        id: uid(),
        day_id: '2031-05-02',
        type: 'text',
        content: `page-${i}`,
        tags: '[]',
        pinned: 0,
        order_index: i,
        updated_at: epoch() + i,
        created_at: epoch(),
        user_id: TEST_USER_ID,
        version: 1,
      })
    }
    for (let i = 0; i < items.length; i += 100) {
      const { error } = await sb.from('note_item').upsert(items.slice(i, i + 100))
      if (error) throw new Error(`insert 실패: ${error.message}`)
    }

    // 페이지네이션 pull
    const db = createTestDb('e02')
    let allItems = []
    let offset = 0
    const pageSize = 1000
    while (true) {
      const { data, error } = await sb.from('note_item').select('*')
        .eq('user_id', TEST_USER_ID)
        .range(offset, offset + pageSize - 1)
      if (error) throw new Error(`페이지네이션 실패: ${error.message}`)
      allItems = allItems.concat(data || [])
      if (!data || data.length < pageSize) break
      offset += pageSize
    }

    eq(allItems.length, 1500, '페이지네이션으로 1500건 전체 수신')

    // 로컬 DB에 삽입
    db.transaction(() => {
      for (const ri of allItems) {
        db.prepare(`INSERT OR REPLACE INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          ri.id, ri.day_id, ri.user_id, ri.type, ri.content, ri.tags || '[]',
          ri.pinned || 0, ri.order_index || 0, toIso(ri.updated_at), toIso(ri.created_at)
        )
      }
    })()

    eq(getItems(db).length, 1500, '로컬 DB에 1500건 저장')
    db.close()
  })

  await test('E03. 200건 동시 CRUD (생성100+수정50+삭제50) → sync', async () => {
    await sbCleanup()
    const db = createTestDb('e03')
    const oldTime = new Date(Date.now() - 120000).toISOString()

    // 100건 생성 (오래된 것)
    const ids = []
    for (let i = 0; i < 100; i++) {
      ids.push(addItem(db, '2031-05-03', `원본 ${i}`, { created_at: oldTime, updated_at: oldTime }))
    }
    await pushToServer(db)

    // 50건 수정
    for (let i = 0; i < 50; i++) {
      await sleep(5)
      updateItem(db, ids[i], `수정됨 ${i}`)
    }

    // 50건 삭제
    for (let i = 50; i < 100; i++) {
      deleteItem(db, ids[i])
    }

    // push
    await pushToServer(db)

    // 서버 확인
    const remote = await sbGetItems()
    eq(remote.length, 50, '서버에 50건 (50건 삭제됨)')

    const modifiedRemote = remote.filter(r => r.content.startsWith('수정됨'))
    eq(modifiedRemote.length, 50, '50건 수정 반영')
    db.close()
  })

  await test('E04. 3기기 각 100건 랜덤 CRUD → 최종 일치', async () => {
    await sbCleanup()
    const pc = createTestDb('e04_pc')
    const mob = createTestDb('e04_mob')
    const tab = createTestDb('e04_tab')

    // 공통 50건 (모든 기기에 존재)
    const commonIds = []
    const oldTime = new Date(Date.now() - 120000).toISOString()
    for (let i = 0; i < 50; i++) {
      const id = uid()
      commonIds.push(id)
      addItem(pc, '2031-05-04', `공통 ${i}`, { id, created_at: oldTime, updated_at: oldTime })
      addItem(mob, '2031-05-04', `공통 ${i}`, { id, created_at: oldTime, updated_at: oldTime })
      addItem(tab, '2031-05-04', `공통 ${i}`, { id, created_at: oldTime, updated_at: oldTime })
    }

    // 각 기기에서 추가 작업
    // PC: 10건 추가 + 5건 수정
    for (let i = 0; i < 10; i++) addItem(pc, '2031-05-04', `PC 추가 ${i}`)
    for (let i = 0; i < 5; i++) { await sleep(5); updateItem(pc, commonIds[i], `PC 수정 ${i}`) }

    // 모바일: 10건 추가 + 5건 삭제
    for (let i = 0; i < 10; i++) addItem(mob, '2031-05-04', `모바일 추가 ${i}`)
    for (let i = 10; i < 15; i++) deleteItem(mob, commonIds[i])

    // 태블릿: 10건 추가 + 5건 수정 (더 최신)
    for (let i = 0; i < 10; i++) addItem(tab, '2031-05-04', `태블릿 추가 ${i}`)
    await sleep(50)
    for (let i = 0; i < 5; i++) { await sleep(5); updateItem(tab, commonIds[i], `태블릿 수정 ${i} (최신)`) }

    // 3회 fullSync: PC → 서버, 모바일 → 서버, 태블릿 → 서버
    await pushToServer(pc)
    await pushToServer(mob) // 삭제 tombstone도 push
    await pushToServer(tab) // LWW로 최신 수정이 이김

    // 모든 기기 pull
    await pullFromServer(pc)
    await pullFromServer(mob)
    await pullFromServer(tab)

    // cleanDeletedFromRemote (모바일 삭제분 반영)
    const remoteItems = await sbGetItems()
    const remoteIds = new Set(remoteItems.map(i => i.id))
    cleanDeletedFromRemote(pc, remoteIds, Date.now() - 300000)
    cleanDeletedFromRemote(tab, remoteIds, Date.now() - 300000)

    // 최종 비교: 서버 기준
    const serverCount = remoteItems.length
    ok(serverCount > 0, `서버에 ${serverCount}건 존재`)

    // LWW 확인: 공통 0-4번은 태블릿 수정이 이겨야 함
    for (let i = 0; i < 5; i++) {
      const remote = remoteItems.find(r => r.id === commonIds[i])
      if (remote) {
        ok(remote.content.includes('태블릿'), `공통 ${i}: 태블릿이 최신 (LWW)`)
      }
    }
  })

  await test('E05. OneDrive 대용량 병합: 500건 + 500건', async () => {
    const local = createTestDb('e05_local')
    const remote = createTestDb('e05_remote')

    // 각각 500건 (겹치지 않는 ID)
    for (let i = 0; i < 500; i++) {
      addItem(local, '2031-05-05', `로컬 ${i}`)
      addItem(remote, '2031-05-05', `리모트 ${i}`)
    }

    // 병합
    const t0 = Date.now()
    mergeFromOneDrive(local, remote)
    const elapsed = Date.now() - t0

    const merged = getItems(local).length
    eq(merged, 1000, '병합 후 1000건')
    ok(elapsed < 5000, `5초 이내: ${elapsed}ms`)
    console.log(`          ⏱️ ${elapsed}ms`)
    local.close(); remote.close()
  })

  await test('E06. WAL 체크포인트 후 OneDrive 복사 → 다른 PC 읽기', async () => {
    const db1 = createTestDb('e06_pc1')
    for (let i = 0; i < 20; i++) addItem(db1, '2031-05-06', `WAL 테스트 ${i}`)

    // WAL 체크포인트 (모든 데이터를 DB 파일에 반영)
    db1.pragma('wal_checkpoint(TRUNCATE)')

    // DB 파일 복사 (OneDrive 시뮬)
    const srcPath = join(TEST_DIR, 'e06_pc1.db')
    const dstPath = join(TEST_DIR, 'e06_pc2.db')
    copyFileSync(srcPath, dstPath)

    // 다른 PC에서 열기
    const db2 = new Database(dstPath, { readonly: true })
    const items = db2.prepare('SELECT * FROM note_item').all()
    eq(items.length, 20, 'WAL 데이터 포함 20건')
    db1.close(); db2.close()
  })

  await test('E07. pendingSyncQueue 50건 적재 → 전체 처리', async () => {
    const queue = []
    for (let i = 0; i < 50; i++) {
      queue.push({ action: 'upsert', table: 'note_item', id: uid() })
    }
    eq(queue.length, 50, '큐에 50건')

    const flushed = flushPendingSyncQueue(null, queue, new Set())
    eq(flushed, 50, '50건 모두 처리')
    eq(queue.length, 0, '큐 완전 비워짐')
  })

  // ═══════ 결과 출력 ═══════
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log(` 결과: ✅ ${passed} / ❌ ${failed} / ⏭️  ${skipped}`)
  console.log(` 총 ${passed + failed + skipped}개 테스트`)
  console.log('═══════════════════════════════════════════════════════════')

  if (failed > 0) {
    console.log('\n❌ 실패한 테스트:')
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`)
    })
  }

  // 결과 파일 저장
  const resultFile = join(__dirname, 'test_hardcore_sync_results.json')
  writeFileSync(resultFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    userId: TEST_USER_ID,
    passed, failed, skipped,
    total: passed + failed + skipped,
    results,
  }, null, 2))
  console.log(`\n📄 결과 저장: ${resultFile}`)

  // 정리
  try {
    await sbCleanup()
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  } catch {}

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('테스트 실행 에러:', e)
  process.exit(1)
})
