/**
 * Wition 실제 동기화 엔진 테스트
 * ══════════════════════════════════════════════════════════════
 * 시뮬레이션이 아닌, 실제 sync.ts 코드를 headless 테스트 서버 경유로 호출
 *
 * 한계 극복:
 *   - 실제 Sync.fullSync() 호출 (시뮬 아님)
 *   - 실제 앱 DB에 INSERT/UPDATE/DELETE 후 /sync → 서버 반영 확인
 *   - 모바일(서버 직접 조작) → /sync → 실제 pull 동작 확인
 *   - 실제 cleanDeletedFromRemote, pushChanges, applyPull 코드 실행
 *
 * 전제조건:
 *   - headless 테스트 서버 실행 중 (localhost:19876)
 *   - 서버에 인증된 사용자 세션 존재
 *   - 로컬 Supabase (localhost:8000) 실행 중
 *   - Electron 앱이 동시 실행 중이어도 테스트 가능 (방어적 타이밍)
 *
 * 실행: node test_real_sync.js
 */

require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const http = require('http')
const { randomUUID } = require('crypto')
const { writeFileSync, readFileSync } = require('fs')
const { join } = require('path')

// ─── 설정 ────────────────────────────────────────────────
const SB_URL = process.env.VITE_SUPABASE_URL || 'http://localhost:8000'
const SRK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const TEST_SERVER = 'http://localhost:19876'

const uid = () => randomUUID()
const ts = () => new Date().toISOString().slice(11, 23)
const epoch = () => Date.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))

let sb // Supabase service_role client
let userId // 테스트 서버에 로그인된 실제 사용자 ID
let passed = 0, failed = 0, skipped = 0
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

// ─── 테스트 서버 (실제 앱 엔진) 헬퍼 ────────────────────
function httpReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, TEST_SERVER)
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search }
    const req = http.request(opts, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(data) }
      })
    })
    req.on('error', reject)
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

// 실제 앱 DB에 SQL 실행 (headless 서버 경유)
async function pc(sql) {
  return httpReq('GET', `/query?sql=${encodeURIComponent(sql)}`)
}

// 실제 Sync.fullSync() 호출
async function pcSync() {
  return httpReq('POST', '/sync')
}

async function pcPing() {
  return httpReq('GET', '/ping').catch(() => null)
}

// ─── Supabase 서버 직접 조작 (모바일 시뮬) ──────────────
async function mobInsert(table, data) {
  const { error } = await sb.from(table).upsert({ ...data, user_id: userId })
  if (error) throw new Error(`mobInsert(${table}): ${error.message}`)
}

async function mobDelete(table, id) {
  await sb.from(table).delete().eq('id', id).eq('user_id', userId)
}

async function mobGet(table, filter = {}) {
  let q = sb.from(table).select('*').eq('user_id', userId)
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v)
  const { data, error } = await q
  if (error) throw new Error(`mobGet(${table}): ${error.message}`)
  return data || []
}

// ═══════════════════════════════════════════════════════
// 메인 테스트 실행
// ═══════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log(' Wition 실제 동기화 엔진 테스트')
  console.log(` 테스트 서버: ${TEST_SERVER}`)
  console.log(` Supabase: ${SB_URL}`)
  console.log('═══════════════════════════════════════════════════════════\n')

  // 1. 테스트 서버 확인
  const ping = await pcPing()
  if (!ping || !ping.ok) {
    console.log('❌ 테스트 서버 연결 실패. 서버를 먼저 시작하세요:')
    console.log('   node run-tests.js (또는) npm test')
    process.exit(1)
  }
  console.log('✅ 테스트 서버 연결 OK')

  // 2. Supabase 확인
  sb = createClient(SB_URL, SRK)
  const { error: connErr } = await sb.from('note_item').select('id', { count: 'exact', head: true })
  if (connErr) {
    console.log(`❌ Supabase 연결 실패: ${connErr.message}`)
    process.exit(1)
  }
  console.log('✅ Supabase 연결 OK')

  // 3. 사용자 ID 확인 (config.json에서 직접 읽기 — 로컬 DB에는 user_id 없음)
  const fs = require('fs')
  const path = require('path')
  const configPath = path.join(process.env.APPDATA || '', 'wition', 'config.json')
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    if (cfg.authUser?.id) userId = cfg.authUser.id
  } catch {}
  if (!userId) {
    const { data: users } = await sb.from('note_item').select('user_id').limit(1)
    if (users?.[0]?.user_id) userId = users[0].user_id
  }
  if (!userId) {
    console.log('❌ 사용자 ID를 찾을 수 없습니다.')
    process.exit(1)
  }
  console.log(`✅ 사용자 ID: ${userId}`)

  // 4. 테스트 전 한 번 sync해서 lastSyncAt 갱신
  await pcSync()
  console.log('✅ 초기 sync 완료')
  console.log('')

  // ═══════ R1. 실제 fullSync 기본 동작 (5개) ═══════
  console.log('── R1. 실제 fullSync 기본 동작 ──')

  await test('R1-01. 로컬 INSERT → /sync → 서버에 push 확인', async () => {
    const id = 'test-' + uid()
    const day = '2099-01-01'
    // 시간을 미래로 설정 (lastSyncAt보다 확실히 큼)
    const futureTime = epoch() + 60000

    await pc(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, updated_at, created_at)
      VALUES ('${id}', '${day}', 'text', 'R1-01 실제엔진테스트', '[]', 0, 0, ${futureTime}, ${futureTime})`)
    await pc(`INSERT OR REPLACE INTO note_day (id, mood, summary, note_count, has_notes, updated_at)
      VALUES ('${day}', NULL, '', 1, 1, ${futureTime})`)

    const result = await pcSync()
    ok(result.ok, `sync 실패: ${JSON.stringify(result)}`)

    // 서버 확인
    const remote = await mobGet('note_item', { id })
    ok(remote.length > 0, `서버에 push 안 됨 (pushed=${result.pushed})`)
    eq(remote[0].content, 'R1-01 실제엔진테스트', '내용 불일치')

    // 정리
    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await mobDelete('note_item', id)
  })

  await test('R1-02. 모바일 INSERT(서버) → /sync → 실제 pull 확인', async () => {
    const id = 'test-' + uid()
    const day = '2099-01-02'
    const now = epoch()

    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: 'R1-02 모바일에서 작성',
      tags: '[]', pinned: 0, order_index: 0, updated_at: now, created_at: now, version: 1
    })
    await mobInsert('note_day', {
      id: day, mood: null, summary: '', note_count: 1, has_notes: 1, updated_at: now
    })

    const result = await pcSync()
    ok(result.ok, 'sync 실패')

    const local = await pc(`SELECT * FROM note_item WHERE id='${id}'`)
    ok(local.rows && local.rows.length > 0, '로컬 DB에 pull 안 됨')
    eq(local.rows[0].content, 'R1-02 모바일에서 작성', '내용 불일치')

    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await mobDelete('note_item', id)
  })

  await test('R1-03. 로컬 DELETE → /sync → 서버에서도 삭제됨', async () => {
    const id = 'test-' + uid()
    const day = '2099-01-03'
    const now = epoch()

    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: 'R1-03 삭제 대상',
      tags: '[]', pinned: 0, order_index: 0, updated_at: now, created_at: now, version: 1
    })
    await pcSync() // pull
    ok((await pc(`SELECT * FROM note_item WHERE id='${id}'`)).rows.length > 0, '로컬에 존재')

    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item', '${id}', ${epoch()})`)
    await pcSync()

    const remote = await mobGet('note_item', { id })
    eq(remote.length, 0, '서버에서 삭제 안 됨')
  })

  await test('R1-04. 모바일 DELETE(서버) → /sync → cleanDeletedFromRemote', async () => {
    const id = 'test-' + uid()
    const day = '2099-01-04'
    const oldTime = epoch() - 20 * 60 * 1000

    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: 'R1-04 모바일이 삭제할 항목',
      tags: '[]', pinned: 0, order_index: 0, updated_at: oldTime, created_at: oldTime, version: 1
    })
    await pcSync()
    ok((await pc(`SELECT * FROM note_item WHERE id='${id}'`)).rows.length > 0, 'pull 후 로컬에 존재')

    await mobDelete('note_item', id)
    const result = await pcSync()
    ok(result.ok, 'sync 실패')

    const after = await pc(`SELECT * FROM note_item WHERE id='${id}'`)
    eq(after.rows.length, 0, 'cleanDeletedFromRemote 실패: 로컬에 여전히 존재')
  })

  await test('R1-05. 양방향: 로컬 추가 + 모바일 추가 → /sync → 병합', async () => {
    const idLocal = 'test-' + uid()
    const idMobile = 'test-' + uid()
    const day = '2099-01-05'
    const futureTime = epoch() + 60000

    // 로컬 추가 (미래 시간으로 push 보장)
    await pc(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, updated_at, created_at)
      VALUES ('${idLocal}', '${day}', 'text', 'R1-05 로컬', '[]', 0, 0, ${futureTime}, ${futureTime})`)

    // 모바일 추가
    await mobInsert('note_item', {
      id: idMobile, day_id: day, type: 'text', content: 'R1-05 모바일',
      tags: '[]', pinned: 0, order_index: 1, updated_at: futureTime + 1, created_at: futureTime + 1, version: 1
    })

    await pcSync()

    // 로컬에 양쪽 모두 존재
    const local1 = await pc(`SELECT * FROM note_item WHERE id='${idLocal}'`)
    const local2 = await pc(`SELECT * FROM note_item WHERE id='${idMobile}'`)
    ok(local1.rows.length > 0, '로컬 항목 유실됨')
    ok(local2.rows.length > 0, '모바일 항목 pull 안 됨')

    // 서버에 로컬 항목이 push됐는지
    const remote1 = await mobGet('note_item', { id: idLocal })
    ok(remote1.length > 0, '로컬→서버 push 안 됨')

    await pc(`DELETE FROM note_item WHERE id='${idLocal}'`)
    await pc(`DELETE FROM note_item WHERE id='${idMobile}'`)
    await mobDelete('note_item', idLocal)
    await mobDelete('note_item', idMobile)
  })

  // ═══════ R2. 실제 LWW 충돌 해결 (5개) ═══════
  console.log('\n── R2. 실제 LWW 충돌 해결 ──')

  await test('R2-01. PC 먼저 + 모바일 나중 → 모바일이 최신', async () => {
    const id = 'test-' + uid()
    const day = '2099-02-01'
    const now = epoch()

    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: 'original',
      tags: '[]', pinned: 0, order_index: 0, updated_at: now, created_at: now, version: 1
    })
    await pcSync()

    // PC 수정 (t+1000)
    await pc(`UPDATE note_item SET content='PC 수정', updated_at=${now + 1000} WHERE id='${id}'`)
    await pcSync()

    // 모바일 수정 (t+2000, 최신)
    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: '모바일 수정 (최신)',
      tags: '[]', pinned: 0, order_index: 0, updated_at: now + 2000, created_at: now, version: 1
    })

    await pcSync()
    const local = await pc(`SELECT content FROM note_item WHERE id='${id}'`)
    eq(local.rows[0].content, '모바일 수정 (최신)', 'LWW 실패: 모바일이 최신이어야 함')

    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await mobDelete('note_item', id)
  })

  await test('R2-02. 모바일 먼저 + PC 나중 → PC가 최신', async () => {
    const id = 'test-' + uid()
    const day = '2099-02-02'
    const now = epoch()

    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: 'original',
      tags: '[]', pinned: 0, order_index: 0, updated_at: now, created_at: now, version: 1
    })
    await pcSync()

    // 모바일 먼저 수정 (t+1000)
    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: '모바일 먼저 수정',
      tags: '[]', pinned: 0, order_index: 0, updated_at: now + 1000, created_at: now, version: 1
    })

    // PC 나중 수정 (t+5000, 최신 — LWW에서 이겨야 함)
    await pc(`UPDATE note_item SET content='PC 나중 수정 (최신)', updated_at=${now + 5000} WHERE id='${id}'`)
    await pcSync()

    // 서버에서 확인 → PC가 최신이므로 PC 내용이어야 함
    const remote = await mobGet('note_item', { id })
    ok(remote.length > 0, '서버에 항목 없음')
    // pushChanges에서 서버에 이미 있는 항목이고 로컬이 더 새로우면 push
    // remote[0].updated_at이 모바일(now+1000)이었는데 PC(now+5000)가 더 크므로 push
    eq(remote[0].content, 'PC 나중 수정 (최신)', 'LWW 실패: PC가 최신이어야 함')

    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await mobDelete('note_item', id)
  })

  await test('R2-03. 삭제 vs 수정 충돌: tombstone 우선', async () => {
    const id = 'test-' + uid()
    const day = '2099-02-03'
    const oldTime = epoch() - 60000

    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: 'original',
      tags: '[]', pinned: 0, order_index: 0, updated_at: oldTime, created_at: oldTime, version: 1
    })
    await pcSync()

    // PC 삭제 + tombstone
    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item', '${id}', ${epoch()})`)

    // 모바일 수정 (최신 시간)
    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: '모바일이 수정',
      tags: '[]', pinned: 0, order_index: 0, updated_at: epoch() + 1000, created_at: oldTime, version: 1
    })

    await pcSync()

    const remote = await mobGet('note_item', { id })
    eq(remote.length, 0, 'tombstone 우선: 서버에서 삭제 안 됨')

    const local = await pc(`SELECT * FROM note_item WHERE id='${id}'`)
    eq(local.rows.length, 0, 'tombstone 우선: 로컬에도 없어야 함')
  })

  await test('R2-04. 다중 필드 수정 → push → 서버 반영', async () => {
    const id = 'test-' + uid()
    const day = '2099-02-04'
    const now = epoch()

    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: 'original',
      tags: '[]', pinned: 0, order_index: 0, updated_at: now, created_at: now, version: 1
    })
    await pcSync()

    // PC에서 다중 필드 수정 (충분히 큰 시간 오프셋으로 push 보장)
    const newTime = epoch() + 60000
    await pc(`UPDATE note_item SET content='수정됨', pinned=1, tags='["중요","업무"]', updated_at=${newTime} WHERE id='${id}'`)
    await pcSync()

    const remote = await mobGet('note_item', { id })
    ok(remote.length > 0, '서버에 항목 없음')
    eq(remote[0].content, '수정됨', 'content push 안 됨')
    eq(remote[0].pinned, 1, 'pinned push 안 됨')
    ok(remote[0].tags.includes('중요'), 'tags push 안 됨')

    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await mobDelete('note_item', id)
  })

  await test('R2-05. mood 변경 → /sync → 서버 반영', async () => {
    const day = '2099-02-05'
    const now = epoch()

    await mobInsert('note_day', { id: day, mood: null, summary: '', note_count: 0, has_notes: 0, updated_at: now })
    await pcSync()

    // PC에서 mood 변경 (큰 시간 오프셋)
    const newTime = epoch() + 60000
    await pc(`UPDATE note_day SET mood='😊', updated_at=${newTime} WHERE id='${day}'`)
    await pcSync()

    const remote = await mobGet('note_day', { id: day })
    ok(remote.length > 0, '서버에 note_day 없음')
    eq(remote[0].mood, '😊', 'mood push 안 됨')

    await pc(`DELETE FROM note_day WHERE id='${day}'`)
    await sb.from('note_day').delete().eq('id', day).eq('user_id', userId)
  })

  // ═══════ R3. 실제 보호 메커니즘 (5개) ═══════
  console.log('\n── R3. 실제 보호 메커니즘 ──')

  await test('R3-01. sync 후 로컬 데이터 보존 확인', async () => {
    const beforeCount = await pc("SELECT COUNT(*) as c FROM note_item")
    const count = beforeCount.rows[0].c

    const result = await pcSync()
    ok(result.ok, 'sync 실패')

    const afterCount = await pc("SELECT COUNT(*) as c FROM note_item")
    eq(afterCount.rows[0].c, count, `sync 후 데이터 수 변화: ${count} → ${afterCount.rows[0].c}`)
  })

  await test('R3-02. syncing 플래그: 동시 호출 → 에러 없음', async () => {
    const [r1, r2] = await Promise.all([pcSync(), pcSync()])
    ok(r1.ok || r2.ok, '둘 다 실패')
    ok(!r1.error && !r2.error, '에러 발생')
  })

  await test('R3-03. tombstone 부활 방지', async () => {
    const id = 'test-' + uid()
    const day = '2099-03-03'
    const now = epoch()

    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: 'tombstone 부활 테스트',
      tags: '[]', pinned: 0, order_index: 0, updated_at: now, created_at: now, version: 1
    })
    await pcSync()

    // PC 삭제 + tombstone
    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item', '${id}', ${epoch()})`)
    await pcSync()

    // 모바일이 같은 ID로 재삽입 (부활 시도)
    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: '부활 시도!',
      tags: '[]', pinned: 0, order_index: 0, updated_at: now + 5000, created_at: now + 5000, version: 1
    })
    await pcSync()

    const local = await pc(`SELECT * FROM note_item WHERE id='${id}'`)
    eq(local.rows.length, 0, 'tombstone에도 불구하고 부활됨')

    await mobDelete('note_item', id)
  })

  await test('R3-04. 최근 생성 항목 → push + 로컬 보호', async () => {
    const id = 'test-' + uid()
    const day = '2099-03-04'
    const futureTime = epoch() + 60000

    // 로컬에 생성 (미래 시간으로 push 보장)
    await pc(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, updated_at, created_at)
      VALUES ('${id}', '${day}', 'text', 'R3-04 방금 생성', '[]', 0, 0, ${futureTime}, ${futureTime})`)

    await pcSync()

    // 로컬에 여전히 존재
    const local = await pc(`SELECT * FROM note_item WHERE id='${id}'`)
    ok(local.rows.length > 0, '최근 항목이 cleanDeletedFromRemote에 의해 삭제됨')

    // 서버에도 push됨 (created_at > lastSyncAt)
    const remote = await mobGet('note_item', { id })
    ok(remote.length > 0, '최근 생성 항목이 서버에 push 안 됨')

    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await mobDelete('note_item', id)
  })

  await test('R3-05. updated_at 무한루프 방지', async () => {
    const id = 'test-' + uid()
    const day = '2099-03-05'
    const futureTime = epoch() + 60000

    await pc(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, updated_at, created_at)
      VALUES ('${id}', '${day}', 'text', 'R3-05 무한루프', '[]', 0, 0, ${futureTime}, ${futureTime})`)

    // 첫 sync: push
    await pcSync()
    const after1 = await pc(`SELECT updated_at FROM note_item WHERE id='${id}'`)
    ok(after1.rows && after1.rows.length > 0, '첫 sync 후 항목 없음')
    const time1 = after1.rows[0].updated_at

    // 두 번째 sync
    await pcSync()
    const after2 = await pc(`SELECT updated_at FROM note_item WHERE id='${id}'`)
    ok(after2.rows && after2.rows.length > 0, '두 번째 sync 후 항목 없음')
    const time2 = after2.rows[0].updated_at

    eq(time2, time1, `updated_at 변경됨: ${time1} → ${time2}`)

    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await mobDelete('note_item', id)
  })

  // ═══════ R4. 실제 대량 동기화 (5개) ═══════
  console.log('\n── R4. 실제 대량 동기화 ──')

  await test('R4-01. 50건 로컬 INSERT → /sync → 서버 push', async () => {
    const ids = []
    const day = '2099-04-01'
    const futureTime = epoch() + 60000

    for (let i = 0; i < 50; i++) {
      const id = 'test-' + uid()
      ids.push(id)
      await pc(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, updated_at, created_at)
        VALUES ('${id}', '${day}', 'text', 'R4-01 batch ${i}', '[]', 0, ${i}, ${futureTime + i}, ${futureTime})`)
    }

    const t0 = Date.now()
    await pcSync()
    const elapsed = Date.now() - t0

    const remote = await mobGet('note_item')
    const testItems = remote.filter(r => r.content && r.content.startsWith('R4-01 batch'))
    ok(testItems.length >= 50, `서버에 ${testItems.length}/50건만 push됨`)
    console.log(`          ⏱️ ${elapsed}ms`)

    for (const id of ids) {
      await pc(`DELETE FROM note_item WHERE id='${id}'`)
      await mobDelete('note_item', id)
    }
  })

  await test('R4-02. 모바일 50건 → /sync → 로컬 50건 pull', async () => {
    const ids = []
    const day = '2099-04-02'
    const now = epoch()

    for (let i = 0; i < 50; i++) {
      const id = 'test-' + uid()
      ids.push(id)
      await mobInsert('note_item', {
        id, day_id: day, type: 'text', content: `R4-02 mob batch ${i}`,
        tags: '[]', pinned: 0, order_index: i, updated_at: now + i, created_at: now, version: 1
      })
    }

    const t0 = Date.now()
    await pcSync()
    const elapsed = Date.now() - t0

    const local = await pc(`SELECT COUNT(*) as c FROM note_item WHERE content LIKE 'R4-02 mob batch%'`)
    ok(local.rows[0].c >= 50, `로컬에 ${local.rows[0].c}/50건만 pull됨`)
    console.log(`          ⏱️ ${elapsed}ms`)

    for (const id of ids) {
      await pc(`DELETE FROM note_item WHERE id='${id}'`)
      await mobDelete('note_item', id)
    }
  })

  await test('R4-03. 혼합 CRUD: INSERT+UPDATE+DELETE → /sync', async () => {
    const ids = []
    const day = '2099-04-03'
    const now = epoch()

    // 30건 서버에 생성 (모바일)
    for (let i = 0; i < 30; i++) {
      const id = 'test-' + uid()
      ids.push(id)
      await mobInsert('note_item', {
        id, day_id: day, type: 'text', content: `R4-03 orig ${i}`,
        tags: '[]', pinned: 0, order_index: i, updated_at: now + i, created_at: now, version: 1
      })
    }
    await pcSync() // pull 30건

    // PC에서 10건 수정 (큰 시간 오프셋)
    const updateTime = epoch() + 60000
    for (let i = 0; i < 10; i++) {
      await pc(`UPDATE note_item SET content='R4-03 PC수정 ${i}', updated_at=${updateTime + i} WHERE id='${ids[i]}'`)
    }

    // PC에서 10건 삭제
    for (let i = 10; i < 20; i++) {
      await pc(`DELETE FROM note_item WHERE id='${ids[i]}'`)
      await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item', '${ids[i]}', ${epoch()})`)
    }

    // PC에서 20건 추가 (미래 시간)
    const newIds = []
    const insertTime = epoch() + 60000
    for (let i = 0; i < 20; i++) {
      const id = 'test-' + uid()
      newIds.push(id)
      await pc(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, updated_at, created_at)
        VALUES ('${id}', '${day}', 'text', 'R4-03 new ${i}', '[]', 0, ${30 + i}, ${insertTime + i}, ${insertTime})`)
    }

    await pcSync()

    // 서버: 수정 10 + 미삭제 10 + 추가 20 = 40
    const remote = await mobGet('note_item')
    const r4Items = remote.filter(r => r.content && r.content.startsWith('R4-03'))
    ok(r4Items.length >= 30, `서버에 ${r4Items.length}건 (최소 30건 기대)`)

    for (const id of [...ids, ...newIds]) {
      await pc(`DELETE FROM note_item WHERE id='${id}'`).catch(() => {})
      await mobDelete('note_item', id)
    }
  })

  await test('R4-04. 3회 연속 /sync → 멱등성', async () => {
    const before = await pc("SELECT COUNT(*) as c FROM note_item")
    const count = before.rows[0].c

    await pcSync()
    await pcSync()
    await pcSync()

    const after = await pc("SELECT COUNT(*) as c FROM note_item")
    eq(after.rows[0].c, count, `멱등성 위반: ${count} → ${after.rows[0].c}`)
  })

  await test('R4-05. recalcAllDayCounts: sync 후 day count 정확', async () => {
    const day = '2099-04-05'
    const futureTime = epoch() + 60000
    const ids = []

    // 이전 테스트 잔여 데이터 정리
    await pc(`DELETE FROM note_item WHERE day_id='${day}'`)
    await pc(`DELETE FROM note_day WHERE id='${day}'`)
    await sb.from('note_item').delete().eq('day_id', day).eq('user_id', userId)
    await sb.from('note_day').delete().eq('id', day).eq('user_id', userId)
    await pcSync() // 정리 동기화

    // note_day 먼저 생성 (recalcAllDayCounts가 업데이트할 대상)
    await pc(`INSERT OR REPLACE INTO note_day (id, mood, summary, note_count, has_notes, updated_at)
      VALUES ('${day}', NULL, '', 0, 0, ${futureTime})`)

    for (let i = 0; i < 5; i++) {
      const id = 'test-' + uid()
      ids.push(id)
      await pc(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, updated_at, created_at)
        VALUES ('${id}', '${day}', 'text', 'R4-05 count ${i}', '[]', 0, ${i}, ${futureTime + i}, ${futureTime})`)
    }

    await pcSync()

    const dayRow = await pc(`SELECT note_count FROM note_day WHERE id='${day}'`)
    ok(dayRow.rows.length > 0, 'note_day 레코드 없음')
    eq(dayRow.rows[0].note_count, 5, `note_count=${dayRow.rows[0].note_count} (expected 5)`)

    for (const id of ids) {
      await pc(`DELETE FROM note_item WHERE id='${id}'`)
      await mobDelete('note_item', id)
    }
    await pc(`DELETE FROM note_day WHERE id='${day}'`)
    const { error } = await sb.from('note_day').delete().eq('id', day).eq('user_id', userId)
    // error 무시 (note_day가 서버에 없을 수 있음)
  })

  // ═══════ R5. 크로스디바이스 현실 시나리오 (5개) ═══════
  console.log('\n── R5. 크로스디바이스 현실 시나리오 ──')

  await test('R5-01. 출퇴근: PC 3건 + 모바일 2건 → 5건 통합', async () => {
    const day = '2099-05-01'
    const futureTime = epoch() + 60000
    const pcIds = [], mobIds = []

    // PC에서 3건 (미래 시간으로 push 보장)
    for (let i = 0; i < 3; i++) {
      const id = 'test-' + uid()
      pcIds.push(id)
      await pc(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, updated_at, created_at)
        VALUES ('${id}', '${day}', 'text', 'R5-01 PC ${i}', '[]', 0, ${i}, ${futureTime + i}, ${futureTime})`)
    }
    await pcSync() // push 3건

    // 모바일에서 2건
    for (let i = 0; i < 2; i++) {
      const id = 'test-' + uid()
      mobIds.push(id)
      await mobInsert('note_item', {
        id, day_id: day, type: 'text', content: `R5-01 모바일 ${i}`,
        tags: '[]', pinned: 0, order_index: 3 + i, updated_at: futureTime + 100 + i, created_at: futureTime + 100, version: 1
      })
    }

    await pcSync() // pull 모바일 2건

    const local = await pc(`SELECT * FROM note_item WHERE day_id='${day}' AND content LIKE 'R5-01%'`)
    ok(local.rows.length >= 5, `${local.rows.length}/5건만 통합됨`)

    for (const id of [...pcIds, ...mobIds]) {
      await pc(`DELETE FROM note_item WHERE id='${id}'`).catch(() => {})
      await mobDelete('note_item', id)
    }
  })

  await test('R5-02. 모바일 삭제 → PC sync → 로컬에서도 삭제', async () => {
    const id = 'test-' + uid()
    const day = '2099-05-02'
    const oldTime = epoch() - 600000

    await mobInsert('note_item', {
      id, day_id: day, type: 'text', content: 'R5-02 삭제 대상',
      tags: '[]', pinned: 0, order_index: 0, updated_at: oldTime, created_at: oldTime, version: 1
    })
    await pcSync()
    ok((await pc(`SELECT * FROM note_item WHERE id='${id}'`)).rows.length > 0, '로컬에 존재해야 함')

    await mobDelete('note_item', id)
    await pcSync()

    const after = await pc(`SELECT * FROM note_item WHERE id='${id}'`)
    eq(after.rows.length, 0, '모바일 삭제 후 로컬에 여전히 존재')
  })

  await test('R5-03. 12종 블록타입 왕복', async () => {
    const day = '2099-05-03'
    const now = epoch()
    const types = ['text', 'heading1', 'heading2', 'heading3', 'bulleted_list', 'numbered_list',
      'checklist', 'quote', 'divider', 'callout', 'code', 'toggle']
    const ids = []

    for (let i = 0; i < types.length; i++) {
      const id = 'test-' + uid()
      ids.push(id)
      const content = types[i] === 'divider' ? '' : `${types[i]} 내용`
      await mobInsert('note_item', {
        id, day_id: day, type: types[i], content,
        tags: '[]', pinned: 0, order_index: i, updated_at: now + i, created_at: now, version: 1
      })
    }

    // PC pull
    await pcSync()

    // PC에서 수정 (큰 시간 오프셋)
    const updateTime = epoch() + 60000
    for (let i = 0; i < ids.length; i++) {
      if (types[i] !== 'divider') {
        await pc(`UPDATE note_item SET content='${types[i]} PC수정', updated_at=${updateTime + i} WHERE id='${ids[i]}'`)
      }
    }

    // PC push
    await pcSync()

    // 서버에서 확인
    let allOk = true
    for (let i = 0; i < ids.length; i++) {
      const remote = await mobGet('note_item', { id: ids[i] })
      if (remote.length === 0) { allOk = false; continue }
      if (types[i] !== 'divider' && !remote[0].content.includes('PC수정')) { allOk = false }
    }
    ok(allOk, '일부 블록 타입 수정이 서버에 반영 안 됨')

    for (const id of ids) {
      await pc(`DELETE FROM note_item WHERE id='${id}'`).catch(() => {})
      await mobDelete('note_item', id)
    }
  })

  await test('R5-04. pinned + tags + order_index 복합 변경', async () => {
    const ids = []
    const day = '2099-05-04'
    const now = epoch()

    for (let i = 0; i < 3; i++) {
      const id = 'test-' + uid()
      ids.push(id)
      await mobInsert('note_item', {
        id, day_id: day, type: 'text', content: `R5-04 item ${i}`,
        tags: '[]', pinned: 0, order_index: i, updated_at: now + i, created_at: now, version: 1
      })
    }
    await pcSync()

    // PC: 순서 역순 + 첫번째 고정 + 태그 (큰 시간 오프셋)
    const updateTime = epoch() + 60000
    await pc(`UPDATE note_item SET order_index=2, pinned=1, tags='["중요"]', updated_at=${updateTime} WHERE id='${ids[0]}'`)
    await pc(`UPDATE note_item SET order_index=1, updated_at=${updateTime + 1} WHERE id='${ids[1]}'`)
    await pc(`UPDATE note_item SET order_index=0, updated_at=${updateTime + 2} WHERE id='${ids[2]}'`)

    await pcSync()

    const r0 = await mobGet('note_item', { id: ids[0] })
    ok(r0.length > 0, '서버에 항목 없음')
    eq(r0[0].pinned, 1, `pinned=${r0[0].pinned} (expected 1)`)
    ok(r0[0].tags.includes('중요'), 'tags 반영 안 됨')

    for (const id of ids) {
      await pc(`DELETE FROM note_item WHERE id='${id}'`).catch(() => {})
      await mobDelete('note_item', id)
    }
  })

  await test('R5-05. 한글+이모지+특수문자 content 왕복', async () => {
    const id = 'test-' + uid()
    const day = '2099-05-05'
    const futureTime = epoch() + 60000
    // SQL-safe content (작은따옴표 제외)
    const content = '한글 テスト 🎉 "quotes" <html> & special `code` backslash'

    await pc(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, updated_at, created_at)
      VALUES ('${id}', '${day}', 'text', '${content}', '[]', 0, 0, ${futureTime}, ${futureTime})`)
    await pcSync()

    const remote = await mobGet('note_item', { id })
    ok(remote.length > 0, '서버에 push 안 됨')
    eq(remote[0].content, content, `content 불일치: "${remote[0].content}"`)

    await pc(`DELETE FROM note_item WHERE id='${id}'`)
    await mobDelete('note_item', id)
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

  const resultFile = join(__dirname, 'test_real_sync_results.json')
  writeFileSync(resultFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    userId,
    passed, failed, skipped,
    total: passed + failed + skipped,
    results,
  }, null, 2))
  console.log(`\n📄 결과 저장: ${resultFile}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('테스트 실행 에러:', e)
  process.exit(1)
})
