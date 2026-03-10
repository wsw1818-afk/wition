/**
 * 삭제 메모 부활 버그 전용 테스트
 * ══════════════════════════════════
 * 메모를 대량 삭제할 때 삭제된 메모가 다시 나타나는 현상 검증
 *
 * 테스트 날짜: 2027-07-XX (다른 테스트와 비충돌)
 * 실행: node test_delete_resurrection.js
 *       (Wition.exe 실행 중 또는 headless test-server 실행 중)
 */

require('dotenv/config')
const { createClient } = require('@supabase/supabase-js')

const SB_URL = process.env.VITE_SUPABASE_URL
const SB_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
const PC = process.env.TEST_PC_URL || 'http://localhost:19876'

let sb, userId
const sleep = ms => new Promise(r => setTimeout(r, ms))
const uid = () => crypto.randomUUID()
const now = () => Date.now()
const ts = () => new Date().toISOString().slice(11, 23)

// ── PC 앱 API ──
async function pc(sql) {
  const r = await fetch(`${PC}/query?sql=${encodeURIComponent(sql)}`)
  const j = await r.json()
  if (j.error) throw new Error(`pc: ${j.error}`)
  return j.rows || j
}
async function pcSync() {
  const r = await fetch(`${PC}/sync`, { method: 'POST' })
  return r.json()
}

// ── 서버 API (모바일 시뮬레이션) ──
async function mobInsert(table, row) {
  const { error } = await sb.from(table).upsert({ ...row, user_id: userId })
  if (error) throw new Error(`mobInsert(${table}): ${error.message}`)
}
async function mobDelete(table, id) {
  const { error } = await sb.from(table).delete().eq('id', id)
  if (error) throw new Error(`mobDelete(${table}): ${error.message}`)
}
async function mobGet(table, filter) {
  let q = sb.from(table).select('*')
  if (filter) for (const [k,v] of Object.entries(filter)) q = q.eq(k, v)
  const { data, error } = await q
  if (error) throw new Error(`mobGet(${table}): ${error.message}`)
  return data || []
}

// ── 테스트 프레임워크 ──
const R = []
let pass = 0, fail = 0

async function test(name, fn) {
  const t0 = Date.now()
  process.stdout.write(`[${ts()}] ▶ ${name}\n`)
  try {
    await fn()
    const ms = Date.now() - t0
    process.stdout.write(`[${ts()}]   ✅ PASS (${ms}ms)\n`)
    R.push({ name, status: 'PASS', ms }); pass++
  } catch (e) {
    const ms = Date.now() - t0
    process.stdout.write(`[${ts()}]   ❌ FAIL: ${e.message} (${ms}ms)\n`)
    R.push({ name, status: 'FAIL', ms, error: e.message }); fail++
  }
}
function ok(c, m) { if (!c) throw new Error(m) }

// ── 정리 ──
async function cleanup() {
  // 로컬 2027-07-XX 데이터 삭제
  await pc("DELETE FROM note_item WHERE day_id LIKE '2027-07-%'")
  await pc("DELETE FROM note_day WHERE id LIKE '2027-07-%'")
  await pc("DELETE FROM alarm WHERE day_id LIKE '2027-07-%'")
  await pc("DELETE FROM deleted_items WHERE item_id LIKE '2027-07-%' OR item_id IN (SELECT id FROM note_item WHERE day_id LIKE '2027-07-%')")
  // 서버 2027-07-XX 데이터 삭제
  await sb.from('note_item').delete().like('day_id', '2027-07-%')
  await sb.from('note_day').delete().like('id', '2027-07-%')
  await sb.from('alarm').delete().like('day_id', '2027-07-%')
}

// ────────────────────────────────────────────────────────────────
// 테스트 케이스
// ────────────────────────────────────────────────────────────────

/** t01: 단건 삭제 후 sync — 서버에서 사라져야 함 */
async function t01() {
  const day = '2027-07-01'
  const itemId = uid()
  const t0 = now()

  // PC에서 아이템 생성 → sync
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}','','',1,1,${t0})`)
  await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${itemId}','${day}','text','test01','[]',0,0,${t0},${t0})`)
  await pcSync()
  await sleep(300)

  // 서버에 있는지 확인
  const before = await mobGet('note_item', { id: itemId })
  ok(before.length === 1, `서버에 아이템 없음: ${before.length}`)

  // PC에서 삭제 + tombstone
  await pc(`DELETE FROM note_item WHERE id='${itemId}'`)
  await pc(`INSERT OR REPLACE INTO deleted_items (table_name,item_id,deleted_at) VALUES ('note_item','${itemId}',${now()})`)
  await pcSync()
  await sleep(300)

  // 서버에서 삭제 확인
  const after = await mobGet('note_item', { id: itemId })
  ok(after.length === 0, `서버에 아이템 남아있음: ${after.length}`)

  // 다시 sync해도 부활하면 안 됨
  await pcSync()
  await sleep(300)
  const afterSync = await mobGet('note_item', { id: itemId })
  ok(afterSync.length === 0, `2차 sync 후 부활: ${afterSync.length}`)
}

/** t02: 10개 연속 삭제 후 sync — 모두 서버에서 사라져야 함 */
async function t02() {
  const day = '2027-07-02'
  const t0 = now()
  const items = Array.from({ length: 10 }, (_, i) => ({ id: uid(), idx: i }))

  // 10개 생성
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}','','',10,1,${t0})`)
  for (const item of items) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${item.id}','${day}','text','item-${item.idx}','[]',0,${item.idx},${t0},${t0})`)
  }
  await pcSync()
  await sleep(500)

  const serverBefore = await mobGet('note_item', { day_id: day })
  ok(serverBefore.length === 10, `생성 후 서버 ${serverBefore.length}/10`)

  // 10개 모두 삭제
  for (const item of items) {
    await pc(`DELETE FROM note_item WHERE id='${item.id}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name,item_id,deleted_at) VALUES ('note_item','${item.id}',${now()})`)
  }
  await pcSync()
  await sleep(500)

  const serverAfter = await mobGet('note_item', { day_id: day })
  ok(serverAfter.length === 0, `삭제 후 서버 잔여: ${serverAfter.length}/0`)

  // 2차 sync — 부활 확인
  await pcSync()
  await sleep(300)
  const serverAfter2 = await mobGet('note_item', { day_id: day })
  ok(serverAfter2.length === 0, `2차 sync 후 부활: ${serverAfter2.length}/0`)
}

/** t03: 50개 대량 삭제 — 삭제 안정성 */
async function t03() {
  const day = '2027-07-03'
  const t0 = now()
  const count = 50
  const items = Array.from({ length: count }, (_, i) => ({ id: uid(), idx: i }))

  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}','','',${count},1,${t0})`)
  for (const item of items) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${item.id}','${day}','text','bulk-${item.idx}','[]',0,${item.idx},${t0},${t0})`)
  }
  await pcSync()
  await sleep(1000)

  const serverBefore = await mobGet('note_item', { day_id: day })
  ok(serverBefore.length === count, `생성: ${serverBefore.length}/${count}`)

  // 전부 삭제
  for (const item of items) {
    await pc(`DELETE FROM note_item WHERE id='${item.id}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name,item_id,deleted_at) VALUES ('note_item','${item.id}',${now()})`)
  }
  await pcSync()
  await sleep(1000)

  const serverAfter = await mobGet('note_item', { day_id: day })
  ok(serverAfter.length === 0, `50개 삭제 후 잔여: ${serverAfter.length}`)

  // 3차 sync
  await pcSync()
  await sleep(300)
  const final = await mobGet('note_item', { day_id: day })
  ok(final.length === 0, `3차 sync 부활: ${final.length}`)
}

/** t04: 삭제→생성→sync — 새 아이템만 남아야 함 */
async function t04() {
  const day = '2027-07-04'
  const t0 = now()
  const oldId = uid()
  const newId = uid()

  // 이전 아이템 생성 → sync
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}','','',1,1,${t0})`)
  await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${oldId}','${day}','text','old','[]',0,0,${t0},${t0})`)
  await pcSync()
  await sleep(300)

  // 삭제 후 새 아이템 생성
  await pc(`DELETE FROM note_item WHERE id='${oldId}'`)
  await pc(`INSERT OR REPLACE INTO deleted_items (table_name,item_id,deleted_at) VALUES ('note_item','${oldId}',${now()})`)
  const t1 = now()
  await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${newId}','${day}','text','new','[]',0,0,${t1},${t1})`)
  await pcSync()
  await sleep(500)

  const serverItems = await mobGet('note_item', { day_id: day })
  ok(serverItems.length === 1, `서버 아이템 수: ${serverItems.length} (예상 1)`)
  ok(serverItems[0].id === newId, `서버에 남은 아이템이 newId가 아님: ${serverItems[0].id}`)
}

/** t05: 모바일 삭제 → PC sync → 로컬에서도 사라져야 함 */
async function t05() {
  const day = '2027-07-05'
  const t0 = now()
  const itemId = uid()

  // 서버에 직접 생성 (모바일)
  await mobInsert('note_day', { id: day, mood: '', summary: '', note_count: 1, has_notes: 1, updated_at: t0 })
  await mobInsert('note_item', { id: itemId, day_id: day, type: 'text', content: 'mobile-item', tags: '[]', pinned: 0, order_index: 0, created_at: t0, updated_at: t0 })

  // PC sync → pull
  await pcSync()
  await sleep(300)

  const localBefore = await pc(`SELECT COUNT(*) as cnt FROM note_item WHERE id='${itemId}'`)
  ok(localBefore[0].cnt === 1, `로컬에 pull 안 됨: ${localBefore[0].cnt}`)

  // 모바일에서 삭제
  await mobDelete('note_item', itemId)

  // PC sync → clean
  await pcSync()
  await sleep(500)

  const localAfter = await pc(`SELECT COUNT(*) as cnt FROM note_item WHERE id='${itemId}'`)
  ok(localAfter[0].cnt === 0, `모바일 삭제 후 로컬 잔여: ${localAfter[0].cnt}`)

  // 재sync → 부활 방지 확인
  await pcSync()
  await sleep(300)
  const serverCheck = await mobGet('note_item', { id: itemId })
  ok(serverCheck.length === 0, `서버에 부활: ${serverCheck.length}`)
}

/** t06: 빠른 연속 삭제 (1개씩 삭제+sync 반복) */
async function t06() {
  const day = '2027-07-06'
  const t0 = now()
  const items = Array.from({ length: 5 }, (_, i) => ({ id: uid(), idx: i }))

  // 5개 생성
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}','','',5,1,${t0})`)
  for (const item of items) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${item.id}','${day}','text','rapid-${item.idx}','[]',0,${item.idx},${t0},${t0})`)
  }
  await pcSync()
  await sleep(500)

  // 1개씩 삭제 + sync 반복
  for (let i = 0; i < items.length; i++) {
    await pc(`DELETE FROM note_item WHERE id='${items[i].id}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name,item_id,deleted_at) VALUES ('note_item','${items[i].id}',${now()})`)
    await pcSync()
    await sleep(200)
  }

  await sleep(500)
  const serverFinal = await mobGet('note_item', { day_id: day })
  ok(serverFinal.length === 0, `빠른 연속 삭제 후 잔여: ${serverFinal.length}`)
}

/** t07: 삭제 중 background sync 레이스 — fullSync가 삭제 중간에 끼어들어도 부활 안 됨 */
async function t07() {
  const day = '2027-07-07'
  const t0 = now()
  const items = Array.from({ length: 20 }, (_, i) => ({ id: uid(), idx: i }))

  // 20개 생성 → sync
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}','','',20,1,${t0})`)
  for (const item of items) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${item.id}','${day}','text','race-${item.idx}','[]',0,${item.idx},${t0},${t0})`)
  }
  await pcSync()
  await sleep(500)

  // 10개 삭제 (tombstone 없이 — 앱의 IPC deleteNoteItem은 tombstone 추가하지만 직접 SQL은 안 함)
  // 실제 앱 동작을 시뮬레이션: deleteNoteItem은 tombstone 추가함
  for (let i = 0; i < 10; i++) {
    await pc(`DELETE FROM note_item WHERE id='${items[i].id}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name,item_id,deleted_at) VALUES ('note_item','${items[i].id}',${now()})`)
  }

  // sync 2번 연속 (background sync 레이스 시뮬레이션)
  const [s1, s2] = await Promise.all([pcSync(), sleep(100).then(() => pcSync())])

  await sleep(500)
  const local = await pc(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id='${day}'`)
  ok(local[0].cnt === 10, `로컬 잔여: ${local[0].cnt}/10`)

  const server = await mobGet('note_item', { day_id: day })
  ok(server.length === 10, `서버 잔여: ${server.length}/10`)
}

/** t08: tombstone 만료 후에도 부활 안 됨 — tombstone clearance 후 안전성 */
async function t08() {
  const day = '2027-07-08'
  const t0 = now()
  const itemId = uid()

  // 생성 → sync
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}','','',1,1,${t0})`)
  await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${itemId}','${day}','text','tombstone-test','[]',0,0,${t0},${t0})`)
  await pcSync()
  await sleep(300)

  // 삭제 + tombstone
  await pc(`DELETE FROM note_item WHERE id='${itemId}'`)
  await pc(`INSERT OR REPLACE INTO deleted_items (table_name,item_id,deleted_at) VALUES ('note_item','${itemId}',${now()})`)
  await pcSync()
  await sleep(300)

  // tombstone 강제 만료 (deleted_at을 과거로 설정)
  await pc(`UPDATE deleted_items SET deleted_at=${t0 - 120000} WHERE item_id='${itemId}'`)

  // sync — tombstone이 정리되어도 서버에 없으므로 부활 안 됨
  await pcSync()
  await sleep(300)

  const server = await mobGet('note_item', { id: itemId })
  ok(server.length === 0, `tombstone 만료 후 부활: ${server.length}`)

  const local = await pc(`SELECT COUNT(*) as cnt FROM note_item WHERE id='${itemId}'`)
  ok(local[0].cnt === 0, `tombstone 만료 후 로컬 부활: ${local[0].cnt}`)
}

/** t09: 100개 대량 삭제 + 3회 sync — 최종 정합성 */
async function t09() {
  const day = '2027-07-09'
  const t0 = now()
  const count = 100
  const items = Array.from({ length: count }, (_, i) => ({ id: uid(), idx: i }))

  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}','','',${count},1,${t0})`)
  for (const item of items) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${item.id}','${day}','text','mass-${item.idx}','[]',0,${item.idx},${t0},${t0})`)
  }
  await pcSync()
  await sleep(1500)

  const serverBefore = await mobGet('note_item', { day_id: day })
  ok(serverBefore.length === count, `100개 생성: ${serverBefore.length}/${count}`)

  // 100개 전부 삭제
  for (const item of items) {
    await pc(`DELETE FROM note_item WHERE id='${item.id}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name,item_id,deleted_at) VALUES ('note_item','${item.id}',${now()})`)
  }

  // 3회 sync
  for (let i = 0; i < 3; i++) {
    await pcSync()
    await sleep(500)
  }

  const serverAfter = await mobGet('note_item', { day_id: day })
  ok(serverAfter.length === 0, `100개 삭제 후 잔여: ${serverAfter.length}`)

  const localAfter = await pc(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id='${day}'`)
  ok(localAfter[0].cnt === 0, `로컬 잔여: ${localAfter[0].cnt}`)
}

/** t10: 삭제+수정 혼합 — 일부 삭제, 일부 수정 후 sync */
async function t10() {
  const day = '2027-07-10'
  const t0 = now()
  const items = Array.from({ length: 10 }, (_, i) => ({ id: uid(), idx: i }))

  // 10개 생성
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}','','',10,1,${t0})`)
  for (const item of items) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${item.id}','${day}','text','mixed-${item.idx}','[]',0,${item.idx},${t0},${t0})`)
  }
  await pcSync()
  await sleep(500)

  // 홀수 인덱스 삭제, 짝수 인덱스 수정
  const t1 = now()
  for (let i = 0; i < items.length; i++) {
    if (i % 2 === 1) {
      await pc(`DELETE FROM note_item WHERE id='${items[i].id}'`)
      await pc(`INSERT OR REPLACE INTO deleted_items (table_name,item_id,deleted_at) VALUES ('note_item','${items[i].id}',${t1})`)
    } else {
      await pc(`UPDATE note_item SET content='updated-${i}', updated_at=${t1} WHERE id='${items[i].id}'`)
    }
  }
  await pcSync()
  await sleep(500)

  const server = await mobGet('note_item', { day_id: day })
  ok(server.length === 5, `서버 잔여: ${server.length}/5 (짝수만)`)

  // 수정된 내용 확인
  for (const s of server) {
    ok(s.content.startsWith('updated-'), `내용 미반영: ${s.content}`)
  }
}

// ────────────────────────────────────────────────────────────────
// 메인
// ────────────────────────────────────────────────────────────────

async function main() {
  // ping 확인
  try {
    const r = await fetch(`${PC}/ping`)
    const j = await r.json()
    if (!j.ok) throw new Error('ping failed')
  } catch {
    console.error(`❌ 서버 응답 없음: ${PC}/ping`)
    console.error('   Wition.exe 또는 headless test-server를 실행하세요')
    process.exit(1)
  }

  sb = createClient(SB_URL, SB_KEY)
  const { data } = await sb.from('note_item').select('user_id').limit(1)
  userId = data?.[0]?.user_id
  if (!userId) { const { data: d } = await sb.from('note_day').select('user_id').limit(1); userId = d?.[0]?.user_id }
  ok(userId, 'userId 감지 불가')
  console.log(`[${ts()}] Supabase OK, userId: ${userId}`)

  await cleanup()

  console.log('═'.repeat(60))
  console.log('  🗑️  삭제 메모 부활 버그 테스트')
  console.log('═'.repeat(60))

  await test('01. 단건 삭제 + 2차 sync 부활 방지', t01)
  await test('02. 10개 연속 삭제 + 부활 방지', t02)
  await test('03. 50개 대량 삭제 안정성', t03)
  await test('04. 삭제→생성→sync (새 아이템만 남기)', t04)
  await test('05. 모바일 삭제 → PC sync → 로컬+서버 정리', t05)
  await test('06. 빠른 연속 (1개씩 삭제+sync 반복)', t06)
  await test('07. 삭제 중 background sync 레이스', t07)
  await test('08. tombstone 만료 후 부활 안전성', t08)
  await test('09. 100개 대량 삭제 + 3회 sync 정합성', t09)
  await test('10. 삭제+수정 혼합 (5삭제+5수정)', t10)

  await cleanup()

  console.log('\n' + '═'.repeat(60))
  console.log('  📊 결과')
  console.log('═'.repeat(60))
  const ms = R.reduce((s, r) => s + r.ms, 0)
  for (const r of R) console.log(`[${ts()}]   ${r.status === 'PASS' ? '✅' : '❌'} ${r.name} (${r.ms}ms)`)
  console.log(`[${ts()}]\n  합계: ${pass}/${R.length} PASS, ${fail} FAIL (${(ms / 1000).toFixed(1)}초)`)

  require('fs').writeFileSync('test_delete_resurrection_results.json',
    JSON.stringify({ date: new Date().toISOString(), pass, fail, total: R.length, results: R }, null, 2))

  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error('치명적:', e); process.exit(1) })
