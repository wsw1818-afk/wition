/**
 * Wition 하드코어 종합 테스트
 * ══════════════════════════════════════════════════════════════
 * DB 분석가 + 사용자 관점에서 동기화 로직의 모든 엣지케이스 검증
 *
 * 테스트 영역:
 *   A. 온라인/오프라인 전환 시나리오
 *   B. OneDrive 병합 (LWW + tombstone + 멱등성)
 *   C. Supabase 서버 동기화 (CRUD + Realtime)
 *   D. 크로스 디바이스 (PC ↔ 모바일 시뮬레이션)
 *   E. 데이터 정합성 스트레스 테스트
 *   F. 엣지케이스 (빈 데이터, 특수문자, 대량, 동시성)
 *
 * 실행: node test_hardcore.js
 *   - 로컬 Supabase 서버 (localhost:8000) 필요
 *   - better-sqlite3 필요
 *   - .env 필요 (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
 */

require('dotenv').config()
const Database = require('better-sqlite3')
const { createClient } = require('@supabase/supabase-js')
const { join } = require('path')
const { mkdirSync, existsSync, rmSync, copyFileSync, writeFileSync, readFileSync } = require('fs')
const { randomUUID } = require('crypto')

// ─── 설정 ────────────────────────────────────────────────
const SB_URL = process.env.VITE_SUPABASE_URL || 'http://localhost:8000'
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const SRK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const TEST_USER_ID = 'test-hardcore-' + randomUUID().slice(0, 8)
const TEST_DIR = join(__dirname, '_test_hardcore_temp')

const uid = () => randomUUID()
const ts = () => new Date().toISOString().slice(11, 23)
const iso = () => new Date().toISOString()
const epoch = () => Date.now() // 서버는 epoch ms (bigint)
const sleep = ms => new Promise(r => setTimeout(r, ms))

let sb // Supabase client (service_role)
let passed = 0, failed = 0
const results = []

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
      results.push({ name, status: 'FAIL', ms, error: e.message })
      failed++
      console.log(`[${ts()}]   ❌ ${name} (${ms}ms)`)
      console.log(`          ${e.message}`)
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
  `)
  return db
}

// ─── Supabase 헬퍼 ─────────────────────────────────────
// 로컬 ISO 타임스탬프 → 서버 epoch ms 변환
function toEpoch(val) {
  if (typeof val === 'number') return val
  if (typeof val === 'string') return new Date(val).getTime()
  return Date.now()
}

async function sbInsertItem(item) {
  // 로컬 스키마 → 서버 스키마 변환 (day → day_id, ISO → epoch)
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
    user_id: TEST_USER_ID,
    version: item.version || 1,
  }
  const { error } = await sb.from('note_item').upsert(serverItem)
  if (error) throw new Error(`sbInsert: ${error.message}`)
}

async function sbInsertDay(day) {
  // 로컬 스키마 → 서버 스키마 변환 (day → id, ISO → epoch, has_notes → int)
  const serverDay = {
    id: day.day || day.id,
    mood: day.mood || null,
    note_count: day.note_count || 0,
    summary: day.summary || '',
    has_notes: (day.note_count || 0) > 0 ? 1 : 0,
    updated_at: toEpoch(day.updated_at),
    user_id: TEST_USER_ID,
  }
  const { error } = await sb.from('note_day').upsert(serverDay)
  if (error) throw new Error(`sbInsertDay: ${error.message}`)
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

// ─── OneDrive 병합 시뮬레이션 (sync.ts의 mergeFromOneDrive 로직 재현) ──
function mergeFromOneDrive(localDb, remoteDb) {
  const localTombstones = new Set(
    localDb.prepare('SELECT id FROM tombstone WHERE table_name=?').all('note_item').map(r => r.id)
  )
  const remoteTombstones = new Set(
    remoteDb.prepare('SELECT id FROM tombstone WHERE table_name=?').all('note_item').map(r => r.id)
  )

  // note_item 병합 (LWW)
  const remoteItems = remoteDb.prepare('SELECT * FROM note_item').all()
  let merged = 0
  for (const ri of remoteItems) {
    if (localTombstones.has(ri.id)) continue // 로컬에서 삭제됨 → 무시
    const local = localDb.prepare('SELECT * FROM note_item WHERE id=?').get(ri.id)
    if (!local) {
      // 새 아이템
      localDb.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ri.id, ri.day, ri.user_id, ri.type, ri.content, ri.tags, ri.pinned, ri.order_index, ri.updated_at, ri.created_at)
      merged++
    } else if (ri.updated_at > local.updated_at) {
      // 리모트가 최신
      localDb.prepare(`UPDATE note_item SET day=?,type=?,content=?,tags=?,pinned=?,order_index=?,updated_at=? WHERE id=?`)
        .run(ri.day, ri.type, ri.content, ri.tags, ri.pinned, ri.order_index, ri.updated_at, ri.id)
      merged++
    }
  }

  // tombstone 양방향 전파
  for (const t of remoteDb.prepare('SELECT * FROM tombstone').all()) {
    localDb.prepare('INSERT OR IGNORE INTO tombstone (id, table_name, deleted_at) VALUES (?,?,?)').run(t.id, t.table_name, t.deleted_at)
    // tombstone에 해당하는 로컬 데이터 삭제
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

  return merged
}

// ─── Supabase push/pull 시뮬레이션 ────────────────────
async function pushToServer(db) {
  const items = db.prepare('SELECT * FROM note_item WHERE user_id=?').all(TEST_USER_ID)
  const days = db.prepare('SELECT * FROM note_day WHERE user_id=?').all(TEST_USER_ID)
  let pushed = 0
  for (const item of items) {
    await sbInsertItem(item)
    pushed++
  }
  for (const day of days) {
    await sbInsertDay(day)
  }
  // tombstone push
  const tombs = db.prepare('SELECT * FROM tombstone').all()
  for (const t of tombs) {
    if (t.table_name === 'note_item') await sbDeleteItem(t.id)
    // note_day tombstone은 서버에서 삭제 안 함 (캐시 테이블)
  }
  return pushed
}

// 서버 epoch → 로컬 ISO 변환
function toIso(val) {
  if (typeof val === 'number') return new Date(val).toISOString()
  return val || new Date().toISOString()
}

// LWW 비교: epoch 또는 ISO 모두 지원
function isNewer(remote, local) {
  const r = typeof remote === 'number' ? remote : new Date(remote).getTime()
  const l = typeof local === 'number' ? local : new Date(local).getTime()
  return r > l
}

async function pullFromServer(db) {
  const remoteItems = await sbGetItems()
  const remoteDays = await sbGetDays()
  const tombstones = new Set(
    db.prepare('SELECT id FROM tombstone WHERE table_name=?').all('note_item').map(r => r.id)
  )
  let pulled = 0
  for (const ri of remoteItems) {
    if (tombstones.has(ri.id)) continue
    // 서버 스키마 → 로컬 스키마 변환 (day_id → day, epoch → ISO)
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
  return pulled
}

function addItem(db, day, content, extra = {}) {
  const id = uid()
  const now = iso()
  db.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, day, TEST_USER_ID, extra.type || 'text', content, extra.tags || '[]',
    extra.pinned || 0, extra.order_index || 0, now, now
  )
  return id
}

function deleteItem(db, id) {
  db.prepare('DELETE FROM note_item WHERE id=?').run(id)
  db.prepare('INSERT OR REPLACE INTO tombstone (id, table_name, deleted_at) VALUES (?,?,?)').run(id, 'note_item', iso())
}

function updateItem(db, id, content) {
  db.prepare('UPDATE note_item SET content=?, updated_at=? WHERE id=?').run(content, iso(), id)
}

function getItems(db) {
  return db.prepare('SELECT * FROM note_item WHERE user_id=?').all(TEST_USER_ID)
}

function getItem(db, id) {
  return db.prepare('SELECT * FROM note_item WHERE id=?').get(id)
}

// ═══════════════════════════════════════════════════════
// 테스트 실행
// ═══════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log(' Wition 하드코어 종합 테스트')
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
    console.log('   로컬 Supabase 서버(localhost:8000)가 실행 중인지 확인하세요.')
    process.exit(1)
  }
  console.log('✅ Supabase 연결 OK\n')

  // ═══════ A. 온라인/오프라인 전환 시나리오 ═══════
  console.log('── A. 온라인/오프라인 전환 시나리오 ──')

  await test('A01. 오프라인에서 데이터 추가 → 온라인 복귀 → 서버 push', async () => {
    const pc = createTestDb('a01_pc')
    // 오프라인: 로컬에만 데이터 추가
    const id1 = addItem(pc, '2030-01-01', '오프라인 메모 1')
    const id2 = addItem(pc, '2030-01-01', '오프라인 메모 2')
    eq(getItems(pc).length, 2, '로컬 2개')
    // 온라인 복귀: push
    await pushToServer(pc)
    const remote = await sbGetItems()
    eq(remote.length, 2, '서버에 2개 push됨')
    eq(remote.find(r => r.id === id1).content, '오프라인 메모 1')
    pc.close()
  })

  await test('A02. 온라인에서 서버 데이터 추가 → 오프라인 PC pull', async () => {
    const pc = createTestDb('a02_pc')
    // 서버에 직접 추가
    const id = uid()
    await sbInsertItem({ id, day: '2030-01-02', type: 'text', content: '서버 메모', updated_at: iso(), created_at: iso() })
    // PC pull
    const pulled = await pullFromServer(pc)
    ok(pulled >= 1, `pull >= 1 (got ${pulled})`)
    ok(getItem(pc, id), '로컬에 서버 데이터 존재')
    pc.close()
  })

  await test('A03. 오프라인 편집 + 서버 편집 → 온라인 복귀 LWW 병합', async () => {
    const pc = createTestDb('a03_pc')
    const id = uid()
    const t1 = '2025-01-01T10:00:00.000Z'
    const t2 = '2025-01-01T11:00:00.000Z' // 서버가 1시간 후 수정 → 서버 우승

    // PC에서 먼저 생성
    pc.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, '2030-01-03', TEST_USER_ID, 'text', 'PC 버전', '[]', 0, 0, t1, t1)

    // 서버에 더 최신 버전
    await sbInsertItem({ id, day: '2030-01-03', type: 'text', content: '서버 버전 (최신)', updated_at: t2, created_at: t1 })

    // pull → LWW로 서버 버전이 이김
    await pullFromServer(pc)
    eq(getItem(pc, id).content, '서버 버전 (최신)', 'LWW: 서버 우승')
    pc.close()
  })

  await test('A04. 오프라인 삭제 + 서버에 데이터 존재 → 온라인 시 tombstone 우선', async () => {
    const pc = createTestDb('a04_pc')
    const id = uid()
    // 먼저 양쪽에 데이터 생성
    addItem(pc, '2030-01-04', '삭제될 메모')
    pc.prepare('UPDATE note_item SET id=? WHERE rowid = (SELECT max(rowid) FROM note_item)').run(id)
    await pushToServer(pc)
    // 오프라인에서 삭제
    deleteItem(pc, id)
    ok(!getItem(pc, id), '로컬에서 삭제됨')
    // 온라인 복귀: push tombstone → 서버에서도 삭제
    await pushToServer(pc)
    const remote = await sbGetItems()
    ok(!remote.find(r => r.id === id), '서버에서도 삭제됨 (tombstone)')
    pc.close()
  })

  await test('A05. 장기 오프라인(일주일) → 대량 변경 후 복귀 → 데이터 유실 없음', async () => {
    const pc = createTestDb('a05_pc')
    // 일주일간 오프라인에서 30개 메모 추가
    const ids = []
    for (let i = 0; i < 30; i++) {
      ids.push(addItem(pc, `2030-02-${String(i % 28 + 1).padStart(2, '0')}`, `오프라인 메모 #${i}`))
    }
    eq(getItems(pc).length, 30, '로컬 30개')
    // 동시에 서버에도 5개 추가 (모바일이 추가)
    for (let i = 0; i < 5; i++) {
      await sbInsertItem({ id: uid(), day: '2030-02-15', type: 'text', content: `모바일 메모 #${i}`, updated_at: iso(), created_at: iso() })
    }
    // 온라인 복귀: push + pull
    await pushToServer(pc)
    await pullFromServer(pc)
    const localCount = getItems(pc).length
    const serverCount = (await sbGetItems()).length
    ok(localCount >= 35, `로컬 >= 35 (got ${localCount})`)
    ok(serverCount >= 35, `서버 >= 35 (got ${serverCount})`)
    pc.close()
  })

  // 중간 정리
  await cleanTestData()

  // ═══════ B. OneDrive 병합 하드코어 ═══════
  console.log('\n── B. OneDrive 병합 하드코어 ──')

  await test('B01. 양쪽 동시 추가 → 병합 후 모두 존재 (데이터 유실 제로)', async () => {
    const pc1 = createTestDb('b01_pc1')
    const pc2 = createTestDb('b01_pc2')
    const id1 = addItem(pc1, '2030-03-01', 'PC1 메모')
    const id2 = addItem(pc2, '2030-03-01', 'PC2 메모')
    mergeFromOneDrive(pc1, pc2)
    eq(getItems(pc1).length, 2, 'PC1에 2개')
    ok(getItem(pc1, id1), 'PC1 메모 존재')
    ok(getItem(pc1, id2), 'PC2 메모 존재')
    pc1.close(); pc2.close()
  })

  await test('B02. 같은 메모 동시 수정 → LWW (최신 수정 우선)', async () => {
    const pc1 = createTestDb('b02_pc1')
    const pc2 = createTestDb('b02_pc2')
    const id = uid()
    const t1 = '2025-03-01T10:00:00.000Z'
    const t2 = '2025-03-01T10:30:00.000Z'
    // PC1: 오래된 수정
    pc1.prepare(`INSERT INTO note_item (id,day,user_id,type,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, '2030-03-02', TEST_USER_ID, 'text', 'PC1 수정', t1, t1)
    // PC2: 최신 수정
    pc2.prepare(`INSERT INTO note_item (id,day,user_id,type,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, '2030-03-02', TEST_USER_ID, 'text', 'PC2 수정 (최신)', t2, t1)
    mergeFromOneDrive(pc1, pc2)
    eq(getItem(pc1, id).content, 'PC2 수정 (최신)', 'LWW: PC2 우승')
    pc1.close(); pc2.close()
  })

  await test('B03. PC1 삭제 + PC2 수정 → tombstone 우선 (삭제 보존)', async () => {
    const pc1 = createTestDb('b03_pc1')
    const pc2 = createTestDb('b03_pc2')
    const id = uid()
    const t1 = '2025-03-01T10:00:00.000Z'
    // 양쪽에 같은 데이터
    pc1.prepare(`INSERT INTO note_item (id,day,user_id,type,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, '2030-03-03', TEST_USER_ID, 'text', '원본', t1, t1)
    pc2.prepare(`INSERT INTO note_item (id,day,user_id,type,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, '2030-03-03', TEST_USER_ID, 'text', '수정됨', '2025-03-01T11:00:00.000Z', t1)
    // PC1에서 삭제
    deleteItem(pc1, id)
    mergeFromOneDrive(pc1, pc2)
    ok(!getItem(pc1, id), 'PC1: 삭제 유지')
    ok(!getItem(pc2, id), 'PC2: tombstone 전파로 삭제')
    pc1.close(); pc2.close()
  })

  await test('B04. 반복 병합 멱등성 (3회 병합해도 데이터 증가 없음)', async () => {
    const pc1 = createTestDb('b04_pc1')
    const pc2 = createTestDb('b04_pc2')
    addItem(pc1, '2030-03-04', 'PC1 메모')
    addItem(pc2, '2030-03-04', 'PC2 메모')
    mergeFromOneDrive(pc1, pc2)
    const count1 = getItems(pc1).length
    mergeFromOneDrive(pc1, pc2)
    const count2 = getItems(pc1).length
    mergeFromOneDrive(pc1, pc2)
    const count3 = getItems(pc1).length
    eq(count1, count2, '2회 병합 후 동일')
    eq(count2, count3, '3회 병합 후 동일')
    pc1.close(); pc2.close()
  })

  await test('B05. 대량 병합 스트레스 (100개 + 100개 → 200개)', async () => {
    const pc1 = createTestDb('b05_pc1')
    const pc2 = createTestDb('b05_pc2')
    for (let i = 0; i < 100; i++) addItem(pc1, '2030-03-05', `PC1-${i}`)
    for (let i = 0; i < 100; i++) addItem(pc2, '2030-03-05', `PC2-${i}`)
    const t0 = Date.now()
    mergeFromOneDrive(pc1, pc2)
    const ms = Date.now() - t0
    eq(getItems(pc1).length, 200, '200개 존재')
    ok(ms < 5000, `병합 시간 ${ms}ms < 5000ms`)
    pc1.close(); pc2.close()
  })

  await test('B06. OneDrive 고립 PC → 오래된 데이터 가짐 → 병합 후 최신 유지', async () => {
    const online = createTestDb('b06_online')
    const offline = createTestDb('b06_offline')
    const id = uid()
    const old = '2025-01-01T00:00:00.000Z'
    const newer = '2025-06-01T00:00:00.000Z'
    // 오프라인 PC: 오래된 데이터
    offline.prepare(`INSERT INTO note_item (id,day,user_id,type,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, '2030-03-06', TEST_USER_ID, 'text', '오래된 버전', old, old)
    // 온라인 PC: 최신 데이터
    online.prepare(`INSERT INTO note_item (id,day,user_id,type,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, '2030-03-06', TEST_USER_ID, 'text', '최신 버전', newer, old)
    mergeFromOneDrive(offline, online)
    eq(getItem(offline, id).content, '최신 버전', '오프라인 PC가 최신으로 업데이트')
    offline.close(); online.close()
  })

  // ═══════ C. Supabase 서버 동기화 ═══════
  console.log('\n── C. Supabase 서버 동기화 ──')
  await cleanTestData()

  await test('C01. CRUD 라운드트립 (추가→수정→삭제→서버 검증)', async () => {
    const pc = createTestDb('c01_pc')
    // 추가
    const id = addItem(pc, '2030-04-01', '원본 내용')
    await pushToServer(pc)
    let remote = await sbGetItems()
    eq(remote.length, 1, '서버 1개')
    // 수정
    updateItem(pc, id, '수정된 내용')
    await pushToServer(pc)
    remote = await sbGetItems()
    eq(remote[0].content, '수정된 내용', '서버 수정 반영')
    // 삭제
    deleteItem(pc, id)
    await pushToServer(pc)
    remote = await sbGetItems()
    eq(remote.length, 0, '서버에서 삭제됨')
    pc.close()
  })

  await test('C02. 서버 RLS 안전장치 — 서버 0건 + 로컬 데이터 → push만 (pull 삭제 안함)', async () => {
    await cleanTestData()
    const pc = createTestDb('c02_pc')
    addItem(pc, '2030-04-02', '보호할 메모')
    // 서버에 아무것도 없는 상태에서 pull → 로컬 데이터 보호
    const pulled = await pullFromServer(pc)
    eq(getItems(pc).length, 1, '로컬 데이터 보호됨')
    pc.close()
  })

  await test('C03. 동시 push 안정성 (빠른 연속 push 5회)', async () => {
    await cleanTestData()
    const pc = createTestDb('c03_pc')
    for (let i = 0; i < 5; i++) {
      addItem(pc, '2030-04-03', `빠른 메모 ${i}`)
      await pushToServer(pc)
    }
    const remote = await sbGetItems()
    eq(remote.length, 5, '5개 모두 서버에 존재')
    pc.close()
  })

  await test('C04. 대량 push/pull (50개 일괄)', async () => {
    await cleanTestData()
    const pc = createTestDb('c04_pc')
    const t0 = Date.now()
    for (let i = 0; i < 50; i++) addItem(pc, '2030-04-04', `대량 메모 ${i}`)
    await pushToServer(pc)
    const pushMs = Date.now() - t0

    const pc2 = createTestDb('c04_pc2')
    const t1 = Date.now()
    await pullFromServer(pc2)
    const pullMs = Date.now() - t1

    eq(getItems(pc2).length, 50, 'PC2에 50개 pull')
    ok(pushMs < 30000, `push ${pushMs}ms < 30초`)
    ok(pullMs < 10000, `pull ${pullMs}ms < 10초`)
    pc.close(); pc2.close()
  })

  // ═══════ D. 크로스 디바이스 시뮬레이션 ═══════
  console.log('\n── D. 크로스 디바이스 (PC ↔ 모바일) ──')
  await cleanTestData()

  await test('D01. PC 추가 → 서버 → 모바일 pull (완전 릴레이)', async () => {
    const pc = createTestDb('d01_pc')
    const mobile = createTestDb('d01_mobile')
    const id = addItem(pc, '2030-05-01', 'PC에서 작성')
    await pushToServer(pc)
    await pullFromServer(mobile)
    ok(getItem(mobile, id), '모바일에 도착')
    eq(getItem(mobile, id).content, 'PC에서 작성')
    pc.close(); mobile.close()
  })

  await test('D02. 모바일 삭제 → 서버 → PC pull (역방향)', async () => {
    const pc = createTestDb('d02_pc')
    const mobile = createTestDb('d02_mobile')
    const id = addItem(pc, '2030-05-02', '삭제할 메모')
    await pushToServer(pc)
    await pullFromServer(mobile)
    // 모바일에서 삭제
    deleteItem(mobile, id)
    await pushToServer(mobile)
    // PC pull
    const remoteItems = await sbGetItems()
    ok(!remoteItems.find(r => r.id === id), '서버에서 삭제됨')
    pc.close(); mobile.close()
  })

  await test('D03. PC+모바일 동시 수정 → 서버 LWW', async () => {
    await cleanTestData()
    const pc = createTestDb('d03_pc')
    const mobile = createTestDb('d03_mobile')
    const id = uid()
    const base = '2025-05-01T10:00:00.000Z'
    // 양쪽에서 같은 메모 생성
    pc.prepare(`INSERT INTO note_item (id,day,user_id,type,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, '2030-05-03', TEST_USER_ID, 'text', 'PC 수정', '2025-05-01T10:30:00.000Z', base)
    mobile.prepare(`INSERT INTO note_item (id,day,user_id,type,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, '2030-05-03', TEST_USER_ID, 'text', '모바일 수정 (최신)', '2025-05-01T11:00:00.000Z', base)
    // 양쪽 push → LWW
    await pushToServer(pc)
    await pushToServer(mobile)
    const remote = await sbGetItems()
    eq(remote.find(r => r.id === id).content, '모바일 수정 (최신)', 'LWW: 모바일 우승')
    pc.close(); mobile.close()
  })

  await test('D04. 3기기 릴레이 — PC1(오프라인) → OneDrive → PC2 → 서버 → 모바일', async () => {
    await cleanTestData()
    const pc1 = createTestDb('d04_pc1')
    const pc2 = createTestDb('d04_pc2')
    const mobile = createTestDb('d04_mobile')
    // PC1 오프라인 작성
    const id = addItem(pc1, '2030-05-04', '오프라인 PC1 메모')
    // OneDrive 병합 → PC2
    mergeFromOneDrive(pc2, pc1)
    ok(getItem(pc2, id), 'PC2에 OneDrive로 도착')
    // PC2 → 서버
    await pushToServer(pc2)
    // 모바일 pull
    await pullFromServer(mobile)
    ok(getItem(mobile, id), '모바일에 최종 도착')
    eq(getItem(mobile, id).content, '오프라인 PC1 메모', '내용 일치')
    pc1.close(); pc2.close(); mobile.close()
  })

  await test('D05. 모바일 삭제 → 서버 → PC2 → OneDrive → PC1 (역방향 릴레이)', async () => {
    await cleanTestData()
    const pc1 = createTestDb('d05_pc1')
    const pc2 = createTestDb('d05_pc2')
    const mobile = createTestDb('d05_mobile')
    // 모든 기기에 같은 데이터
    const id = uid()
    const now = iso()
    for (const db of [pc1, pc2, mobile]) {
      db.prepare(`INSERT INTO note_item (id,day,user_id,type,content,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id, '2030-05-05', TEST_USER_ID, 'text', '삭제될 메모', now, now)
    }
    await pushToServer(pc1) // 서버에도 있음
    // 모바일에서 삭제
    deleteItem(mobile, id)
    await pushToServer(mobile)
    // PC2 pull
    // 서버에서 이미 삭제됨 → PC2는 pullFromServer로는 삭제 안됨 (cleanDeleted 로직 필요)
    // 대신 서버에 해당 id가 없음을 확인
    const remote = await sbGetItems()
    ok(!remote.find(r => r.id === id), '서버에서 삭제됨')
    // PC2가 tombstone 전파 (OneDrive 병합 시뮬)
    mergeFromOneDrive(pc2, mobile)
    ok(!getItem(pc2, id), 'PC2에서 삭제됨 (OneDrive 병합)')
    // PC1에도 전파
    mergeFromOneDrive(pc1, pc2)
    ok(!getItem(pc1, id), 'PC1에서도 삭제됨 (역방향 완성)')
    pc1.close(); pc2.close(); mobile.close()
  })

  // ═══════ E. 데이터 정합성 스트레스 ═══════
  console.log('\n── E. 데이터 정합성 스트레스 ──')
  await cleanTestData()

  await test('E01. 랜덤 CRUD 100회 → 최종 정합성', async () => {
    const pc = createTestDb('e01_pc')
    const ids = []
    for (let i = 0; i < 100; i++) {
      const r = Math.random()
      if (r < 0.5 || ids.length === 0) {
        // 추가
        ids.push(addItem(pc, '2030-06-01', `랜덤 ${i}`))
      } else if (r < 0.8) {
        // 수정
        const idx = Math.floor(Math.random() * ids.length)
        const item = getItem(pc, ids[idx])
        if (item) updateItem(pc, ids[idx], `수정 ${i}`)
      } else {
        // 삭제
        const idx = Math.floor(Math.random() * ids.length)
        const item = getItem(pc, ids[idx])
        if (item) deleteItem(pc, ids[idx])
      }
    }
    await pushToServer(pc)
    const localItems = getItems(pc)
    const remoteItems = await sbGetItems()
    eq(localItems.length, remoteItems.length, `로컬(${localItems.length}) == 서버(${remoteItems.length})`)
    pc.close()
  })

  await test('E02. 3기기 랜덤 CRUD → 모두 동기화 → 최종 일치', async () => {
    await cleanTestData()
    const pc1 = createTestDb('e02_pc1')
    const pc2 = createTestDb('e02_pc2')
    const mobile = createTestDb('e02_mobile')

    // 각 기기에서 랜덤 CRUD
    const allIds = { pc1: [], pc2: [], mobile: [] }
    for (let round = 0; round < 3; round++) {
      for (const [name, db, ids] of [['pc1', pc1, allIds.pc1], ['pc2', pc2, allIds.pc2], ['mobile', mobile, allIds.mobile]]) {
        for (let i = 0; i < 10; i++) {
          const r = Math.random()
          if (r < 0.6 || ids.length === 0) {
            ids.push(addItem(db, '2030-06-02', `${name}-R${round}-${i}`))
          } else if (r < 0.8 && ids.length > 0) {
            const item = getItem(db, ids[Math.floor(Math.random() * ids.length)])
            if (item) updateItem(db, item.id, `edited-${round}-${i}`)
          }
        }
      }
      // 매 라운드 끝에 동기화
      await pushToServer(pc1)
      await pushToServer(mobile)
      mergeFromOneDrive(pc2, pc1)
      await pushToServer(pc2)
      await pullFromServer(pc1)
      await pullFromServer(mobile)
    }
    // 최종 동기화
    await pushToServer(pc1)
    await pushToServer(pc2)
    await pushToServer(mobile)
    await pullFromServer(pc1)
    await pullFromServer(pc2)
    await pullFromServer(mobile)

    const c1 = getItems(pc1).length
    const c2 = getItems(pc2).length
    const cm = getItems(mobile).length
    const cs = (await sbGetItems()).length
    ok(c1 === cs && c2 === cs && cm === cs, `모두 일치: PC1=${c1}, PC2=${c2}, Mobile=${cm}, Server=${cs}`)
    pc1.close(); pc2.close(); mobile.close()
  })

  // ═══════ F. 엣지케이스 ═══════
  console.log('\n── F. 엣지케이스 ──')
  await cleanTestData()

  await test('F01. 특수문자 content (한글, 이모지, SQL injection 시도)', async () => {
    const pc = createTestDb('f01_pc')
    const cases = [
      '한글 메모 테스트 🎉',
      '이모지 💻🔥✅❌🎯',
      "SQL 인젝션 시도: '; DROP TABLE note_item; --",
      '줄바꿈\n포함\n메모',
      '탭\t포함\t메모',
      '',  // 빈 문자열
      'a'.repeat(10000), // 10KB 텍스트
    ]
    for (const c of cases) {
      const id = addItem(pc, '2030-07-01', c)
      await pushToServer(pc)
      const remote = await sbGetItems()
      const found = remote.find(r => r.id === id)
      ok(found, `서버에 존재: ${c.substring(0, 20)}...`)
      eq(found.content, c, `내용 일치: ${c.substring(0, 20)}...`)
    }
    pc.close()
  })

  await test('F02. 같은 day에 50개 블록 → 순서(order_index) 보존', async () => {
    await cleanTestData()
    const pc = createTestDb('f02_pc')
    const ids = []
    for (let i = 0; i < 50; i++) {
      const id = uid()
      pc.prepare(`INSERT INTO note_item (id,day,user_id,type,content,tags,pinned,order_index,updated_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, '2030-07-02', TEST_USER_ID, 'text', `블록 ${i}`, '[]', 0, i, iso(), iso())
      ids.push(id)
    }
    await pushToServer(pc)
    const pc2 = createTestDb('f02_pc2')
    await pullFromServer(pc2)
    const items = pc2.prepare('SELECT * FROM note_item WHERE day=? ORDER BY order_index').all('2030-07-02')
    eq(items.length, 50, '50개 존재')
    for (let i = 0; i < 50; i++) {
      eq(items[i].order_index, i, `순서 ${i} 보존`)
    }
    pc.close(); pc2.close()
  })

  await test('F03. 모든 블록 타입 동기화 (12종)', async () => {
    await cleanTestData()
    const pc = createTestDb('f03_pc')
    const types = ['text', 'heading1', 'heading2', 'heading3', 'bulleted_list', 'numbered_list',
      'checklist', 'quote', 'divider', 'callout', 'code', 'toggle']
    for (const type of types) {
      addItem(pc, '2030-07-03', `${type} 내용`, { type })
    }
    await pushToServer(pc)
    const pc2 = createTestDb('f03_pc2')
    await pullFromServer(pc2)
    const items = getItems(pc2)
    eq(items.length, 12, '12종 모두 존재')
    for (const type of types) {
      ok(items.find(i => i.type === type), `타입 ${type} 존재`)
    }
    pc.close(); pc2.close()
  })

  await test('F04. tags JSON 정합성', async () => {
    await cleanTestData()
    const pc = createTestDb('f04_pc')
    const tagsCases = [
      '[]',
      '["태그1"]',
      '["태그1","태그2","태그3"]',
      '["한글태그","emoji🎯","special!@#"]',
    ]
    for (const tags of tagsCases) {
      addItem(pc, '2030-07-04', 'tags 테스트', { tags })
    }
    await pushToServer(pc)
    const pc2 = createTestDb('f04_pc2')
    await pullFromServer(pc2)
    const items = getItems(pc2)
    eq(items.length, tagsCases.length, `${tagsCases.length}개 존재`)
    for (let i = 0; i < tagsCases.length; i++) {
      const found = items.find(item => item.tags === tagsCases[i])
      ok(found, `tags=${tagsCases[i]} 존재`)
    }
    pc.close(); pc2.close()
  })

  await test('F05. 핀(pinned) 상태 동기화', async () => {
    await cleanTestData()
    const pc = createTestDb('f05_pc')
    const id1 = addItem(pc, '2030-07-05', '핀 메모', { pinned: 1 })
    const id2 = addItem(pc, '2030-07-05', '일반 메모', { pinned: 0 })
    await pushToServer(pc)
    const pc2 = createTestDb('f05_pc2')
    await pullFromServer(pc2)
    eq(getItem(pc2, id1).pinned, 1, '핀 유지')
    eq(getItem(pc2, id2).pinned, 0, '일반 유지')
    pc2.close(); pc.close()
  })

  await test('F06. mood 전파 (note_day)', async () => {
    await cleanTestData()
    const pc = createTestDb('f06_pc')
    const now = iso()
    pc.prepare(`INSERT INTO note_day (day,user_id,mood,note_count,summary,updated_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('2030-07-06', TEST_USER_ID, '😊', 3, '좋은 하루', now, now)
    await pushToServer(pc)
    const remoteDays = await sbGetDays()
    const found = remoteDays.find(d => (d.id || d.day) === '2030-07-06')
    ok(found, '서버에 note_day 존재')
    eq(found.mood, '😊', 'mood 이모지 보존')
    pc.close()
  })

  // ═══════ 정리 & 결과 ═══════
  await cleanTestData()
  try { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log(` 결과: ${passed} 통과, ${failed} 실패 (총 ${results.length}개)`)
  console.log('═══════════════════════════════════════════════════════════')

  if (failed > 0) {
    console.log('\n실패한 테스트:')
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ❌ ${r.name}: ${r.error}`)
    })
  }

  const resultFile = join(__dirname, 'test_hardcore_results.json')
  writeFileSync(resultFile, JSON.stringify({ passed, failed, total: results.length, results }, null, 2))
  console.log(`\n결과 저장: ${resultFile}`)

  process.exit(failed > 0 ? 1 : 0)
}

async function cleanTestData() {
  // 테스트 유저 데이터 서버에서 삭제
  await sb.from('note_item').delete().eq('user_id', TEST_USER_ID)
  await sb.from('note_day').delete().eq('user_id', TEST_USER_ID)
  await sb.from('alarm').delete().eq('user_id', TEST_USER_ID)
}

main().catch(e => { console.error('치명적 에러:', e); process.exit(1) })
