/**
 * OneDrive DB 병합 테스트
 * 두 개의 SQLite DB를 만들어 mergeFromOneDrive 로직을 검증
 *
 * 테스트 항목:
 * 1. 기본 병합 (LWW)
 * 2. tombstone 존중 (삭제된 항목 부활 방지)
 * 3. 양방향 tombstone 전파
 * 4. 충돌 시 LWW 우선
 * 5. 삭제 후 재생성 (tombstone보다 새로운 데이터)
 * 6. 대량 데이터 병합
 * 7. 알람 + mood + 체크리스트 병합
 * 8. 첨부파일 목록 정합성
 */
const Database = require('better-sqlite3')
const { join } = require('path')
const { mkdirSync, existsSync, rmSync, writeFileSync, readdirSync } = require('fs')
const { randomUUID } = require('crypto')

const TEST_DIR = join(__dirname, '_test_onedrive_temp')
const LOCAL_DB_PATH = join(TEST_DIR, 'local.db')
const REMOTE_DB_PATH = join(TEST_DIR, 'remote.db')

let localDb, remoteDb
let passed = 0, failed = 0
const results = []

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) }

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_day (
      id TEXT PRIMARY KEY,
      mood TEXT,
      summary TEXT,
      note_count INTEGER DEFAULT 0,
      has_notes INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_item (
      id TEXT PRIMARY KEY,
      day_id TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      content TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      pinned INTEGER DEFAULT 0,
      order_index INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alarm (
      id TEXT PRIMARY KEY,
      day_id TEXT NOT NULL,
      time TEXT NOT NULL,
      label TEXT DEFAULT '',
      repeat TEXT DEFAULT 'none',
      enabled INTEGER DEFAULT 1,
      fired INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_items (
      table_name TEXT NOT NULL,
      item_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (table_name, item_id)
    );
  `)
}

/**
 * mergeFromOneDrive 로직 복제 (main.ts의 실제 로직과 동일)
 */
function mergeFromOneDrive(localDb, remoteDb) {
  let merged = 0

  const localSelectItem = localDb.prepare('SELECT updated_at FROM note_item WHERE id = ?')
  const upsertItem = localDb.prepare(`
    INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
    VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      type=@type, content=@content, tags=@tags, pinned=@pinned,
      order_index=@order_index, updated_at=@updated_at
    WHERE @updated_at > note_item.updated_at
  `)
  const ensureDay = localDb.prepare(`
    INSERT OR IGNORE INTO note_day (id, note_count, has_notes, updated_at)
    VALUES (@id, 0, 0, @updated_at)
  `)

  const localSelectDay = localDb.prepare('SELECT updated_at FROM note_day WHERE id = ?')
  const upsertDay = localDb.prepare(`
    INSERT INTO note_day (id, mood, summary, note_count, has_notes, updated_at)
    VALUES (@id, @mood, @summary, @note_count, @has_notes, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      mood=@mood, summary=@summary, note_count=@note_count,
      has_notes=@has_notes, updated_at=@updated_at
    WHERE @updated_at > note_day.updated_at
  `)

  const localSelectAlarm = localDb.prepare('SELECT updated_at FROM alarm WHERE id = ?')
  const upsertAlarm = localDb.prepare(`
    INSERT INTO alarm (id, day_id, time, label, repeat, enabled, fired, created_at, updated_at)
    VALUES (@id, @day_id, @time, @label, @repeat, @enabled, @fired, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      day_id=@day_id, time=@time, label=@label, repeat=@repeat,
      enabled=@enabled, fired=@fired, updated_at=@updated_at
    WHERE @updated_at > alarm.updated_at
  `)

  // tombstone 로드
  const localTombstones = new Map()
  try {
    const rows = localDb.prepare('SELECT table_name, item_id, deleted_at FROM deleted_items').all()
    for (const r of rows) localTombstones.set(`${r.table_name}:${r.item_id}`, r.deleted_at)
  } catch {}

  // OneDrive DB의 tombstone도 로컬에 반영
  try {
    const remoteTombstones = remoteDb.prepare('SELECT table_name, item_id, deleted_at FROM deleted_items').all()
    const insertTombstone = localDb.prepare('INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES (?, ?, ?)')
    for (const rt of remoteTombstones) {
      const localDelAt = localTombstones.get(`${rt.table_name}:${rt.item_id}`)
      if (!localDelAt || rt.deleted_at > localDelAt) {
        insertTombstone.run(rt.table_name, rt.item_id, rt.deleted_at)
        localTombstones.set(`${rt.table_name}:${rt.item_id}`, rt.deleted_at)
      }
    }
  } catch {}

  const remoteItems = remoteDb.prepare('SELECT * FROM note_item').all()
  const remoteDays = remoteDb.prepare('SELECT * FROM note_day').all()
  const remoteAlarms = remoteDb.prepare('SELECT * FROM alarm').all()

  localDb.transaction(() => {
    for (const rd of remoteDays) {
      const delAt = localTombstones.get(`note_day:${rd.id}`)
      if (delAt !== undefined && rd.updated_at <= delAt) continue
      const local = localSelectDay.get(rd.id)
      if (!local || rd.updated_at > local.updated_at) {
        upsertDay.run(rd)
        merged++
      }
    }
    for (const ri of remoteItems) {
      const delAt = localTombstones.get(`note_item:${ri.id}`)
      if (delAt !== undefined && ri.updated_at <= delAt) continue
      const local = localSelectItem.get(ri.id)
      if (!local || ri.updated_at > local.updated_at) {
        ensureDay.run({ id: ri.day_id, updated_at: ri.updated_at })
        upsertItem.run(ri)
        merged++
      }
    }
    for (const ra of remoteAlarms) {
      const delAt = localTombstones.get(`alarm:${ra.id}`)
      if (delAt !== undefined && ra.updated_at <= delAt) continue
      const local = localSelectAlarm.get(ra.id)
      if (!local || ra.updated_at > local.updated_at) {
        upsertAlarm.run(ra)
        merged++
      }
    }

    // tombstone에 해당하는 로컬 데이터도 삭제 (단, tombstone보다 새로운 데이터는 보호)
    const deleteItem = localDb.prepare('DELETE FROM note_item WHERE id = ? AND updated_at <= ?')
    const deleteAlarm = localDb.prepare('DELETE FROM alarm WHERE id = ? AND updated_at <= ?')
    for (const [key, delAt] of localTombstones) {
      const [table, id] = key.split(':')
      if (table === 'note_item') deleteItem.run(id, delAt)
      else if (table === 'alarm') deleteAlarm.run(id, delAt)
    }
  })()

  return merged
}

function resetDbs() {
  if (localDb) localDb.close()
  if (remoteDb) remoteDb.close()
  if (existsSync(LOCAL_DB_PATH)) rmSync(LOCAL_DB_PATH)
  if (existsSync(REMOTE_DB_PATH)) rmSync(REMOTE_DB_PATH)
  // WAL 파일도 제거
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(LOCAL_DB_PATH + ext)) rmSync(LOCAL_DB_PATH + ext)
    if (existsSync(REMOTE_DB_PATH + ext)) rmSync(REMOTE_DB_PATH + ext)
  }
  localDb = new Database(LOCAL_DB_PATH)
  remoteDb = new Database(REMOTE_DB_PATH)
  initSchema(localDb)
  initSchema(remoteDb)
}

function makeItem(day_id, content, updated_at) {
  return {
    id: randomUUID(), day_id, type: 'text', content,
    tags: '[]', pinned: 0, order_index: 0,
    created_at: updated_at, updated_at
  }
}

function makeDay(id, mood, updated_at) {
  return { id, mood, summary: null, note_count: 0, has_notes: 0, updated_at }
}

function makeAlarm(day_id, time, label, updated_at) {
  return {
    id: randomUUID(), day_id, time, label,
    repeat: 'none', enabled: 1, fired: 0,
    created_at: updated_at, updated_at
  }
}

async function runTest(num, name, fn) {
  const start = Date.now()
  try {
    resetDbs()
    await fn()
    const ms = Date.now() - start
    log(`  ✅ PASS (${ms}ms)`)
    passed++
    results.push({ num, name, status: 'PASS', ms })
  } catch (err) {
    const ms = Date.now() - start
    log(`  ❌ FAIL (${ms}ms): ${err.message}`)
    failed++
    results.push({ num, name, status: 'FAIL', ms, error: err.message })
  }
}

async function main() {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true })
  const totalStart = Date.now()

  console.log('═'.repeat(60))
  console.log('  📂 OneDrive DB 병합 테스트')
  console.log('═'.repeat(60))

  // ── t01: 기본 병합 (새 데이터 가져오기) ──
  log('▶ 01. 기본 병합 — OneDrive에만 있는 데이터 로컬로 가져오기')
  await runTest(1, '기본 병합', () => {
    const now = Date.now()
    const item = makeItem('2027-09-01', '리모트에서 온 메모', now)
    remoteDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)`).run(item)
    remoteDb.prepare(`INSERT INTO note_day (id, mood, summary, note_count, has_notes, updated_at)
      VALUES (?, NULL, NULL, 1, 1, ?)`).run('2027-09-01', now)

    const merged = mergeFromOneDrive(localDb, remoteDb)
    assert(merged >= 1, `merged=${merged}, expected >= 1`)
    const local = localDb.prepare('SELECT * FROM note_item WHERE id = ?').get(item.id)
    assert(local, '로컬에 아이템이 없음')
    assert(local.content === '리모트에서 온 메모', `content mismatch: ${local.content}`)
  })

  // ── t02: LWW — 로컬이 더 새로우면 리모트 무시 ──
  log('▶ 02. LWW — 로컬이 더 새로우면 리모트 무시')
  await runTest(2, 'LWW 로컬 우선', () => {
    const now = Date.now()
    const id = randomUUID()
    // 로컬: 최신
    localDb.prepare(`INSERT INTO note_day (id, updated_at) VALUES (?, ?)`).run('2027-09-02', now + 1000)
    localDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (?, ?, 'text', '로컬 최신', '[]', 0, 0, ?, ?)`).run(id, '2027-09-02', now, now + 1000)
    // 리모트: 오래된
    remoteDb.prepare(`INSERT INTO note_day (id, updated_at) VALUES (?, ?)`).run('2027-09-02', now)
    remoteDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (?, ?, 'text', '리모트 오래된', '[]', 0, 0, ?, ?)`).run(id, '2027-09-02', now, now)

    mergeFromOneDrive(localDb, remoteDb)
    const local = localDb.prepare('SELECT content FROM note_item WHERE id = ?').get(id)
    assert(local.content === '로컬 최신', `content should be '로컬 최신', got '${local.content}'`)
  })

  // ── t03: LWW — 리모트가 더 새로우면 업데이트 ──
  log('▶ 03. LWW — 리모트가 더 새로우면 업데이트')
  await runTest(3, 'LWW 리모트 우선', () => {
    const now = Date.now()
    const id = randomUUID()
    localDb.prepare(`INSERT INTO note_day (id, updated_at) VALUES (?, ?)`).run('2027-09-03', now)
    localDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (?, ?, 'text', '로컬 오래된', '[]', 0, 0, ?, ?)`).run(id, '2027-09-03', now, now)
    remoteDb.prepare(`INSERT INTO note_day (id, updated_at) VALUES (?, ?)`).run('2027-09-03', now + 1000)
    remoteDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (?, ?, 'text', '리모트 최신', '[]', 0, 0, ?, ?)`).run(id, '2027-09-03', now, now + 1000)

    mergeFromOneDrive(localDb, remoteDb)
    const local = localDb.prepare('SELECT content FROM note_item WHERE id = ?').get(id)
    assert(local.content === '리모트 최신', `content should be '리모트 최신', got '${local.content}'`)
  })

  // ── t04: tombstone — 로컬에서 삭제한 항목은 OneDrive에서 부활 안 함 ──
  log('▶ 04. tombstone — 로컬 삭제 항목 부활 방지')
  await runTest(4, 'tombstone 로컬 삭제 존중', () => {
    const now = Date.now()
    const id = randomUUID()
    // 로컬: 삭제됨 (tombstone만 있음)
    localDb.prepare('INSERT INTO deleted_items (table_name, item_id, deleted_at) VALUES (?, ?, ?)').run('note_item', id, now + 500)
    // 리모트: 데이터가 아직 있음 (삭제 전 버전)
    remoteDb.prepare(`INSERT INTO note_day (id, updated_at) VALUES (?, ?)`).run('2027-09-04', now)
    remoteDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (?, ?, 'text', '삭제된 메모', '[]', 0, 0, ?, ?)`).run(id, '2027-09-04', now, now)

    mergeFromOneDrive(localDb, remoteDb)
    const local = localDb.prepare('SELECT * FROM note_item WHERE id = ?').get(id)
    assert(!local, `삭제된 메모가 부활함! content: ${local?.content}`)
  })

  // ── t05: 양방향 tombstone 전파 — 리모트에서 삭제 → 로컬에서도 삭제 ──
  log('▶ 05. 양방향 tombstone 전파 (리모트 삭제 → 로컬 삭제)')
  await runTest(5, '양방향 tombstone 전파', () => {
    const now = Date.now()
    const id = randomUUID()
    // 로컬: 데이터 있음
    localDb.prepare(`INSERT INTO note_day (id, updated_at) VALUES (?, ?)`).run('2027-09-05', now)
    localDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (?, ?, 'text', '곧 삭제될 메모', '[]', 0, 0, ?, ?)`).run(id, '2027-09-05', now, now)
    // 리모트: tombstone만 있음 (다른 PC에서 삭제)
    remoteDb.prepare('INSERT INTO deleted_items (table_name, item_id, deleted_at) VALUES (?, ?, ?)').run('note_item', id, now + 1000)

    mergeFromOneDrive(localDb, remoteDb)
    const local = localDb.prepare('SELECT * FROM note_item WHERE id = ?').get(id)
    assert(!local, '리모트 tombstone이 로컬 데이터를 삭제하지 못함')
    const tombstone = localDb.prepare('SELECT * FROM deleted_items WHERE item_id = ?').get(id)
    assert(tombstone, '로컬에 tombstone이 전파되지 않음')
  })

  // ── t06: 삭제 후 재생성 — tombstone보다 새로운 데이터는 병합 ──
  log('▶ 06. 삭제 후 재생성 — tombstone보다 새로운 데이터 병합')
  await runTest(6, '삭제 후 재생성', () => {
    const now = Date.now()
    const id = randomUUID()
    // 로컬: tombstone (오래전 삭제)
    localDb.prepare('INSERT INTO deleted_items (table_name, item_id, deleted_at) VALUES (?, ?, ?)').run('note_item', id, now)
    // 리모트: tombstone보다 훨씬 후에 재생성
    remoteDb.prepare(`INSERT INTO note_day (id, updated_at) VALUES (?, ?)`).run('2027-09-06', now + 5000)
    remoteDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (?, ?, 'text', '재생성된 메모', '[]', 0, 0, ?, ?)`).run(id, '2027-09-06', now + 5000, now + 5000)

    mergeFromOneDrive(localDb, remoteDb)
    const local = localDb.prepare('SELECT * FROM note_item WHERE id = ?').get(id)
    assert(local, '재생성된 메모가 병합되지 않음')
    assert(local.content === '재생성된 메모', `content mismatch: ${local.content}`)
  })

  // ── t07: 대량 데이터 병합 (50개 item + 10개 day) ──
  log('▶ 07. 대량 데이터 병합 (50개 item + 10개 day)')
  await runTest(7, '대량 병합', () => {
    const now = Date.now()
    for (let d = 1; d <= 10; d++) {
      const dayId = `2027-09-${String(d).padStart(2, '0')}`
      remoteDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run(dayId, now + d)
      for (let i = 0; i < 5; i++) {
        const item = makeItem(dayId, `메모 ${d}-${i}`, now + d * 100 + i)
        remoteDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
          VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)`).run(item)
      }
    }

    const merged = mergeFromOneDrive(localDb, remoteDb)
    assert(merged >= 50, `merged=${merged}, expected >= 50`)
    const count = localDb.prepare('SELECT COUNT(*) as cnt FROM note_item').get().cnt
    assert(count === 50, `item count=${count}, expected 50`)
    const dayCount = localDb.prepare('SELECT COUNT(*) as cnt FROM note_day').get().cnt
    assert(dayCount === 10, `day count=${dayCount}, expected 10`)
  })

  // ── t08: 알람 병합 + tombstone ──
  log('▶ 08. 알람 병합 + tombstone')
  await runTest(8, '알람 병합 + tombstone', () => {
    const now = Date.now()
    const alarmKeep = makeAlarm('2027-09-08', '09:00', '출근 알람', now)
    const alarmDel = makeAlarm('2027-09-08', '18:00', '삭제된 알람', now)

    remoteDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run('2027-09-08', now)
    remoteDb.prepare(`INSERT INTO alarm (id, day_id, time, label, repeat, enabled, fired, created_at, updated_at)
      VALUES (@id, @day_id, @time, @label, @repeat, @enabled, @fired, @created_at, @updated_at)`).run(alarmKeep)
    remoteDb.prepare(`INSERT INTO alarm (id, day_id, time, label, repeat, enabled, fired, created_at, updated_at)
      VALUES (@id, @day_id, @time, @label, @repeat, @enabled, @fired, @created_at, @updated_at)`).run(alarmDel)

    // 로컬에서 하나는 삭제됨
    localDb.prepare('INSERT INTO deleted_items (table_name, item_id, deleted_at) VALUES (?, ?, ?)').run('alarm', alarmDel.id, now + 500)

    mergeFromOneDrive(localDb, remoteDb)
    const kept = localDb.prepare('SELECT * FROM alarm WHERE id = ?').get(alarmKeep.id)
    assert(kept, '유지할 알람이 없음')
    const deleted = localDb.prepare('SELECT * FROM alarm WHERE id = ?').get(alarmDel.id)
    assert(!deleted, '삭제된 알람이 부활함')
  })

  // ── t09: mood 3-way 병합 ──
  log('▶ 09. mood 병합 (리모트가 최신)')
  await runTest(9, 'mood 병합', () => {
    const now = Date.now()
    localDb.prepare('INSERT INTO note_day (id, mood, updated_at) VALUES (?, ?, ?)').run('2027-09-09', '😊', now)
    remoteDb.prepare('INSERT INTO note_day (id, mood, updated_at) VALUES (?, ?, ?)').run('2027-09-09', '🎉', now + 1000)

    mergeFromOneDrive(localDb, remoteDb)
    const local = localDb.prepare('SELECT mood FROM note_day WHERE id = ?').get('2027-09-09')
    assert(local.mood === '🎉', `mood should be 🎉, got ${local.mood}`)
  })

  // ── t10: 체크리스트 JSON 병합 ──
  log('▶ 10. 체크리스트 JSON 병합')
  await runTest(10, '체크리스트 JSON 병합', () => {
    const now = Date.now()
    const id = randomUUID()
    const checklist = JSON.stringify([
      { id: '1', text: '할일 A', done: true },
      { id: '2', text: '할일 B', done: false }
    ])
    localDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run('2027-09-10', now)
    remoteDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run('2027-09-10', now)
    remoteDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (?, ?, 'checklist', ?, '[]', 0, 0, ?, ?)`).run(id, '2027-09-10', checklist, now, now)

    mergeFromOneDrive(localDb, remoteDb)
    const local = localDb.prepare('SELECT content, type FROM note_item WHERE id = ?').get(id)
    assert(local, '체크리스트가 병합되지 않음')
    assert(local.type === 'checklist', `type mismatch: ${local.type}`)
    const parsed = JSON.parse(local.content)
    assert(Array.isArray(parsed) && parsed.length === 2, '체크리스트 파싱 실패')
    assert(parsed[0].done === true, '체크리스트 상태 불일치')
  })

  // ── t11: 동시 추가 (양쪽에 다른 아이템) ──
  log('▶ 11. 동시 추가 (양쪽에 다른 아이템 → 합쳐짐)')
  await runTest(11, '동시 추가 합치기', () => {
    const now = Date.now()
    const localItem = makeItem('2027-09-11', '로컬에서 추가', now)
    const remoteItem = makeItem('2027-09-11', '리모트에서 추가', now)

    localDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run('2027-09-11', now)
    localDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)`).run(localItem)
    remoteDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run('2027-09-11', now)
    remoteDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)`).run(remoteItem)

    mergeFromOneDrive(localDb, remoteDb)
    const count = localDb.prepare("SELECT COUNT(*) as cnt FROM note_item WHERE day_id = '2027-09-11'").get().cnt
    assert(count === 2, `양쪽 아이템이 합쳐져야 함 (count=${count}, expected 2)`)
  })

  // ── t12: 혼합 시나리오 — 추가+수정+삭제 동시 ──
  log('▶ 12. 혼합 시나리오 — 추가+수정+삭제 동시')
  await runTest(12, '혼합 시나리오', () => {
    const now = Date.now()
    const keepId = randomUUID()
    const updateId = randomUUID()
    const deleteId = randomUUID()
    const addId = randomUUID()

    // 로컬 상태: keep(동일), update(오래된), delete(tombstone)
    localDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run('2027-09-12', now)
    localDb.prepare(`INSERT INTO note_item VALUES (?, '2027-09-12', 'text', '유지', '[]', 0, 0, ?, ?)`).run(keepId, now, now)
    localDb.prepare(`INSERT INTO note_item VALUES (?, '2027-09-12', 'text', '수정 전', '[]', 0, 1, ?, ?)`).run(updateId, now, now)
    localDb.prepare('INSERT INTO deleted_items VALUES (?, ?, ?)').run('note_item', deleteId, now + 500)

    // 리모트 상태: keep(동일), update(최신), delete(데이터 있음), add(새로운)
    remoteDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run('2027-09-12', now + 1000)
    remoteDb.prepare(`INSERT INTO note_item VALUES (?, '2027-09-12', 'text', '유지', '[]', 0, 0, ?, ?)`).run(keepId, now, now)
    remoteDb.prepare(`INSERT INTO note_item VALUES (?, '2027-09-12', 'text', '수정 후', '[]', 0, 1, ?, ?)`).run(updateId, now, now + 1000)
    remoteDb.prepare(`INSERT INTO note_item VALUES (?, '2027-09-12', 'text', '삭제됨', '[]', 0, 2, ?, ?)`).run(deleteId, now, now)
    remoteDb.prepare(`INSERT INTO note_item VALUES (?, '2027-09-12', 'text', '새 메모', '[]', 0, 3, ?, ?)`).run(addId, now + 1000, now + 1000)

    mergeFromOneDrive(localDb, remoteDb)

    const keep = localDb.prepare('SELECT content FROM note_item WHERE id = ?').get(keepId)
    assert(keep && keep.content === '유지', 'keep 유지 실패')

    const updated = localDb.prepare('SELECT content FROM note_item WHERE id = ?').get(updateId)
    assert(updated && updated.content === '수정 후', `update 실패: ${updated?.content}`)

    const deleted = localDb.prepare('SELECT * FROM note_item WHERE id = ?').get(deleteId)
    assert(!deleted, '삭제된 메모가 부활함')

    const added = localDb.prepare('SELECT content FROM note_item WHERE id = ?').get(addId)
    assert(added && added.content === '새 메모', '새 메모 추가 실패')
  })

  // ── t13: note_day tombstone ──
  log('▶ 13. note_day tombstone')
  await runTest(13, 'note_day tombstone', () => {
    const now = Date.now()
    localDb.prepare('INSERT INTO deleted_items VALUES (?, ?, ?)').run('note_day', '2027-09-13', now + 500)
    remoteDb.prepare('INSERT INTO note_day (id, mood, updated_at) VALUES (?, ?, ?)').run('2027-09-13', '😢', now)

    mergeFromOneDrive(localDb, remoteDb)
    const local = localDb.prepare('SELECT * FROM note_day WHERE id = ?').get('2027-09-13')
    // note_day는 deleteItem에서 삭제하지 않으므로 존재할 수 있지만, tombstone 때문에 병합되지 않아야 함
    assert(!local, '삭제된 note_day가 부활함')
  })

  // ── t14: 반복 병합 안정성 (3회 연속) ──
  log('▶ 14. 반복 병합 안정성 (3회 연속)')
  await runTest(14, '반복 병합 안정성', () => {
    const now = Date.now()
    const id = randomUUID()
    remoteDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run('2027-09-14', now)
    remoteDb.prepare(`INSERT INTO note_item VALUES (?, '2027-09-14', 'text', '안정성 테스트', '[]', 0, 0, ?, ?)`).run(id, now, now)

    // 3회 반복 병합
    mergeFromOneDrive(localDb, remoteDb)
    mergeFromOneDrive(localDb, remoteDb)
    mergeFromOneDrive(localDb, remoteDb)

    const count = localDb.prepare("SELECT COUNT(*) as cnt FROM note_item WHERE id = ?").get(id).cnt
    assert(count === 1, `반복 병합 후 중복 발생: count=${count}`)
  })

  // ── t15: 최종 정합성 검증 ──
  log('▶ 15. 최종 정합성 — 대량 데이터 + tombstone 혼합')
  await runTest(15, '최종 정합성', () => {
    const now = Date.now()
    const ids = { keep: [], delete: [] }

    // 20개 아이템 생성 (리모트)
    remoteDb.prepare('INSERT INTO note_day (id, updated_at) VALUES (?, ?)').run('2027-09-15', now)
    for (let i = 0; i < 20; i++) {
      const item = makeItem('2027-09-15', `정합성 메모 ${i}`, now + i)
      remoteDb.prepare(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
        VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)`).run(item)
      if (i < 10) {
        ids.keep.push(item.id)
      } else {
        ids.delete.push(item.id)
        // 로컬에서 삭제
        localDb.prepare('INSERT INTO deleted_items VALUES (?, ?, ?)').run('note_item', item.id, now + 1000)
      }
    }

    mergeFromOneDrive(localDb, remoteDb)

    const keepCount = localDb.prepare(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id = '2027-09-15'`).get().cnt
    assert(keepCount === 10, `유지 아이템: ${keepCount}/10`)

    for (const id of ids.delete) {
      const item = localDb.prepare('SELECT * FROM note_item WHERE id = ?').get(id)
      assert(!item, `삭제 아이템 부활: ${id}`)
    }
    for (const id of ids.keep) {
      const item = localDb.prepare('SELECT * FROM note_item WHERE id = ?').get(id)
      assert(item, `유지 아이템 누락: ${id}`)
    }
  })

  // ── 결과 요약 ──
  console.log('\n' + '═'.repeat(60))
  console.log('  📊 결과 요약')
  console.log('═'.repeat(60))
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : '❌'
    log(`  ${icon} ${String(r.num).padStart(2, '0')}. ${r.name} (${r.ms}ms)${r.error ? ' — ' + r.error : ''}`)
  }
  const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1)
  log(`\n  합계: ${passed}/${passed + failed} PASS, ${failed} FAIL (${totalSec}초)`)

  // 정리
  if (localDb) localDb.close()
  if (remoteDb) remoteDb.close()
  rmSync(TEST_DIR, { recursive: true, force: true })

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('테스트 에러:', err)
  process.exit(1)
})
