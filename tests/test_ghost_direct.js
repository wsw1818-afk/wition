/**
 * 잔상 버그 양방향 직접 재현 테스트
 * Supabase에는 deleted_at 컬럼 없음 — 삭제는 물리 DELETE
 */
require('dotenv/config')
const { createClient } = require('@supabase/supabase-js')
const http = require('http')

const SB_URL = process.env.VITE_SUPABASE_URL || 'http://localhost:8000'
const SB_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
if (!SB_KEY) { console.error('❌ VITE_SUPABASE_SERVICE_ROLE_KEY 필요'); process.exit(1) }
const sb = createClient(SB_URL, SB_KEY)
const PC = 'http://localhost:19876'
const UID = '848a51a4-d26c-4063-8e3a-c73cd548ce82'
const DAY = '2026-03-25'

function query(sql) {
  return new Promise((r, j) => http.get(`${PC}/query?sql=${encodeURIComponent(sql)}`, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => r(JSON.parse(d)))
  }).on('error', j))
}
function post(path, body) {
  return new Promise((r, j) => {
    const d = JSON.stringify(body)
    const req = http.request(`${PC}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, res => {
      let dd = ''; res.on('data', c => dd += c); res.on('end', () => r(JSON.parse(dd)))
    })
    req.on('error', j); req.write(d); req.end()
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0, failed = 0
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); passed++ }
  else { console.log(`  ❌ ${label}`); failed++ }
}

async function cleanup() {
  await sb.from('note_item').delete().like('id', 'gd-%')
  await sb.from('note_day').delete().eq('id', DAY)
  await query(`DELETE FROM note_item WHERE id LIKE 'gd-%'`)
  await query(`DELETE FROM note_day WHERE id = '${DAY}'`)
  await query(`DELETE FROM deleted_items WHERE item_id LIKE 'gd-%'`)
}

async function testA() {
  console.log('\n═══ A: 모바일 메모 추가 → PC pull 확인 ═══')
  await cleanup()
  const now = Date.now()

  // 모바일: 3개 메모 추가
  await sb.from('note_day').upsert({ id: DAY, mood: null, summary: 'test', note_count: 3, has_notes: 1, user_id: UID, updated_at: now })
  for (let i = 1; i <= 3; i++) {
    const { error } = await sb.from('note_item').upsert({ id: `gd-a${i}`, day_id: DAY, type: 'text', content: `memo${i}`, tags: '', pinned: 0, order_index: i, user_id: UID, created_at: now, updated_at: now })
    if (error) console.log('  insert err:', error.message)
  }

  // 서버 확인
  const { data: sbItems } = await sb.from('note_item').select('id').like('id', 'gd-a%')
  ok('서버에 3개 삽입', sbItems?.length === 3)

  // PC pull
  await post('/sync', { action: 'fullSync' })
  const pc = await query(`SELECT id FROM note_item WHERE id LIKE 'gd-a%'`)
  ok('PC에 3개 pull', pc.rows?.length === 3)
}

async function testB() {
  console.log('\n═══ B: 모바일 전체 삭제 → PC 잔상 확인 ═══')
  // A 이후 상태: 서버+PC에 3개 메모

  // 모바일: 메모 3개 물리 삭제 + note_day 삭제
  for (let i = 1; i <= 3; i++) {
    await sb.from('note_item').delete().eq('id', `gd-a${i}`).eq('user_id', UID)
  }
  await sb.from('note_day').delete().eq('id', DAY).eq('user_id', UID)

  // 서버 확인
  const { data: sbItems } = await sb.from('note_item').select('id').like('id', 'gd-a%')
  const { data: sbDay } = await sb.from('note_day').select('id').eq('id', DAY)
  ok('서버에서 메모 삭제됨', !sbItems || sbItems.length === 0)
  ok('서버에서 note_day 삭제됨', !sbDay || sbDay.length === 0)

  // PC fullSync
  await post('/sync', { action: 'fullSync' })
  await sleep(1000)

  // PC 잔상 확인
  const pcItems = await query(`SELECT id FROM note_item WHERE id LIKE 'gd-a%'`)
  const pcDay = await query(`SELECT * FROM note_day WHERE id = '${DAY}'`)
  console.log('  PC items:', pcItems.rows?.length || 0)
  console.log('  PC day:', JSON.stringify(pcDay.rows))

  ok('PC note_item 잔상 없음', !pcItems.rows || pcItems.rows.length === 0)
  ok('PC note_day 잔상 없음', !pcDay.rows || pcDay.rows.length === 0)
}

async function testC() {
  console.log('\n═══ C: PC 메모 추가 → 모바일(서버)에서 삭제 → PC pull ═══')
  await cleanup()
  const now = Date.now()

  // PC: 5개 메모 삽입 (로컬 + push)
  await sb.from('note_day').upsert({ id: DAY, mood: null, summary: 'pc', note_count: 5, has_notes: 1, user_id: UID, updated_at: now })
  for (let i = 1; i <= 5; i++) {
    await sb.from('note_item').upsert({ id: `gd-c${i}`, day_id: DAY, type: 'text', content: `pc-memo${i}`, tags: '', pinned: 0, order_index: i, user_id: UID, created_at: now, updated_at: now })
  }
  // PC pull
  await post('/sync', { action: 'fullSync' })

  // 모바일: 하나씩 삭제 (마지막은 note_day도 삭제)
  for (let i = 1; i <= 5; i++) {
    await sb.from('note_item').delete().eq('id', `gd-c${i}`).eq('user_id', UID)
    await sleep(50)
  }
  await sb.from('note_day').delete().eq('id', DAY).eq('user_id', UID)

  // PC fullSync
  await post('/sync', { action: 'fullSync' })
  await sleep(1000)

  const pcItems = await query(`SELECT id FROM note_item WHERE id LIKE 'gd-c%'`)
  const pcDay = await query(`SELECT * FROM note_day WHERE id = '${DAY}'`)
  ok('PC note_item 잔상 없음 (5개 삭제)', !pcItems.rows || pcItems.rows.length === 0)
  ok('PC note_day 잔상 없음', !pcDay.rows || pcDay.rows.length === 0)
}

async function testD() {
  console.log('\n═══ D: 대량 50개 삭제 → PC 잔상 확인 ═══')
  await cleanup()
  const now = Date.now()

  // 50개 메모 삽입
  await sb.from('note_day').upsert({ id: DAY, mood: null, summary: 'bulk', note_count: 50, has_notes: 1, user_id: UID, updated_at: now })
  const items = []
  for (let i = 1; i <= 50; i++) {
    items.push({ id: `gd-d${i}`, day_id: DAY, type: 'text', content: `bulk${i}`, tags: '', pinned: 0, order_index: i, user_id: UID, created_at: now, updated_at: now })
  }
  // 배치 upsert
  for (let i = 0; i < items.length; i += 20) {
    await sb.from('note_item').upsert(items.slice(i, i + 20))
  }

  // PC pull
  await post('/sync', { action: 'fullSync' })
  const pcBefore = await query(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE 'gd-d%'`)
  ok('PC에 50개 pull', pcBefore.rows?.[0]?.cnt === 50)

  // 모바일: 전체 삭제
  await sb.from('note_item').delete().like('id', 'gd-d%').eq('user_id', UID)
  await sb.from('note_day').delete().eq('id', DAY).eq('user_id', UID)

  // PC fullSync
  await post('/sync', { action: 'fullSync' })
  await sleep(1500)

  const pcItems = await query(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE 'gd-d%'`)
  const pcDay = await query(`SELECT * FROM note_day WHERE id = '${DAY}'`)
  ok('PC 50개 잔상 없음', pcItems.rows?.[0]?.cnt === 0)
  ok('PC note_day 잔상 없음', !pcDay.rows || pcDay.rows.length === 0)
}

async function testE() {
  console.log('\n═══ E: PC에서 삭제 → 서버 잔상 확인 ═══')
  await cleanup()
  const now = Date.now()

  // 양쪽에 메모 3개
  await sb.from('note_day').upsert({ id: DAY, mood: null, summary: 'e', note_count: 3, has_notes: 1, user_id: UID, updated_at: now })
  for (let i = 1; i <= 3; i++) {
    await sb.from('note_item').upsert({ id: `gd-e${i}`, day_id: DAY, type: 'text', content: `e${i}`, tags: '', pinned: 0, order_index: i, user_id: UID, created_at: now, updated_at: now })
  }
  await post('/sync', { action: 'fullSync' })

  // PC에서 삭제 (tombstone + note_day 삭제)
  const del = Date.now()
  for (let i = 1; i <= 3; i++) {
    // PC 앱에서 삭제 시: note_item DELETE + tombstone 등록 + updateDayCount
    await query(`DELETE FROM note_item WHERE id = 'gd-e${i}'`)
    await query(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item', 'gd-e${i}', ${del})`)
  }
  await query(`DELETE FROM note_day WHERE id = '${DAY}'`)

  // PC push (tombstone → 서버 삭제)
  await post('/sync', { action: 'fullSync' })
  await sleep(1500)

  // 서버 확인
  const { data: sbItems } = await sb.from('note_item').select('id').like('id', 'gd-e%')
  const { data: sbDay } = await sb.from('note_day').select('*').eq('id', DAY)
  ok('서버 note_item 잔상 없음', !sbItems || sbItems.length === 0)

  // note_day: fixRemoteDayCounts가 count=0이면 삭제하므로
  const dayGhost = sbDay && sbDay.length > 0 && (sbDay[0].note_count > 0)
  ok('서버 note_day 잔상 없음', !dayGhost)
  if (sbDay?.length > 0) console.log('  서버 note_day:', JSON.stringify(sbDay))
}

async function testF() {
  console.log('\n═══ F: Realtime으로 삭제 감지 → PC 잔상 확인 ═══')
  await cleanup()
  const now = Date.now()

  // 메모 2개 삽입 + PC pull
  await sb.from('note_day').upsert({ id: DAY, mood: null, summary: 'rt', note_count: 2, has_notes: 1, user_id: UID, updated_at: now })
  for (let i = 1; i <= 2; i++) {
    await sb.from('note_item').upsert({ id: `gd-f${i}`, day_id: DAY, type: 'text', content: `rt${i}`, tags: '', pinned: 0, order_index: i, user_id: UID, created_at: now, updated_at: now })
  }
  await post('/sync', { action: 'fullSync' })

  // 모바일 삭제 (Realtime DELETE 이벤트 발생)
  for (let i = 1; i <= 2; i++) {
    await sb.from('note_item').delete().eq('id', `gd-f${i}`).eq('user_id', UID)
    await sleep(200)
  }
  await sb.from('note_day').delete().eq('id', DAY).eq('user_id', UID)

  // Realtime + quickPull 대기
  await sleep(5000)

  const pcItems = await query(`SELECT id FROM note_item WHERE id LIKE 'gd-f%'`)
  const pcDay = await query(`SELECT * FROM note_day WHERE id = '${DAY}'`)
  ok('Realtime 후 PC note_item 잔상 없음', !pcItems.rows || pcItems.rows.length === 0)
  ok('Realtime 후 PC note_day 잔상 없음', !pcDay.rows || pcDay.rows.length === 0)
  if (pcDay.rows?.length > 0) console.log('  PC day:', JSON.stringify(pcDay.rows))
}

async function main() {
  console.log('잔상 버그 양방향 직접 테스트')
  console.log(`PC: ${PC}, Supabase: ${SB_URL}`)

  await testA()
  await testB()
  await testC()
  await testD()
  await testE()
  await testF()

  await cleanup()

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`결과: ${passed} 통과, ${failed} 실패 (총 ${passed + failed}개)`)
  console.log('═'.repeat(50))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
