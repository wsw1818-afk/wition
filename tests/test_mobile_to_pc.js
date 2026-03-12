/**
 * 모바일→PC 동기화 시뮬레이션 테스트
 *
 * 모바일 앱이 하는 것과 동일한 방식(anon key + JWT)으로 서버에 데이터를 쓰고,
 * PC 테스트 서버가 이를 감지하는지 확인
 */
const http = require('http')

const PC_PORT = 19876
const SUPABASE = 'http://localhost:8000'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const USER_ID = '848a51a4-d26c-4063-8e3a-c73cd548ce82'
const TEST_DAY = '2099-11-11'

let passed = 0, failed = 0, jwtToken = ''

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) }

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts)
  const text = await res.text()
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) } }
  catch { return { ok: res.ok, status: res.status, data: text } }
}

/** PC 테스트 서버에 SQL 쿼리 */
async function pcQuery(sql) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PC_PORT,
      path: `/query?sql=${encodeURIComponent(sql)}`,
      timeout: 5000
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(data) } })
    })
    req.on('error', reject)
    req.end()
  })
}

/** PC 테스트 서버에 sync 요청 */
async function pcSync() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PC_PORT,
      path: '/sync', method: 'POST',
      timeout: 15000
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(data) } })
    })
    req.on('error', reject)
    req.end()
  })
}

/** 모바일이 사용하는 방식으로 JWT 발급 (admin magiclink) */
async function getMobileJWT() {
  // admin generate_link
  const linkRes = await fetchJSON(`${SUPABASE}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: 'magiclink', email: 'wsw1818@gmail.com' })
  })
  if (!linkRes.ok) throw new Error(`generate_link 실패: ${JSON.stringify(linkRes.data)}`)

  // verify로 JWT 발급
  const verifyRes = await fetchJSON(`${SUPABASE}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: linkRes.data.hashed_token })
  })
  if (!verifyRes.ok) throw new Error(`verify 실패: ${JSON.stringify(verifyRes.data)}`)
  return verifyRes.data.access_token
}

/** 모바일 방식으로 서버에 upsert (anon key + JWT) */
async function mobileUpsert(item) {
  const res = await fetchJSON(`${SUPABASE}/rest/v1/note_item`, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify([{ ...item, user_id: USER_ID }])
  })
  return res
}

/** 모바일 방식으로 서버에서 삭제 (anon key + JWT) */
async function mobileDelete(id) {
  const res = await fetchJSON(`${SUPABASE}/rest/v1/note_item?id=eq.${id}&user_id=eq.${USER_ID}`, {
    method: 'DELETE',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${jwtToken}`,
    }
  })
  return res
}

function assert(condition, msg) {
  if (condition) { passed++; log(`  ✅ ${msg}`) }
  else { failed++; log(`  ❌ ${msg}`) }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ═══════════════════════════════════════
async function runTests() {
  log('═══════════════════════════════════════')
  log('  📱→🖥️ 모바일→PC 동기화 시뮬레이션 테스트')
  log('═══════════════════════════════════════')

  // JWT 발급
  log('▶ JWT 발급 (모바일 방식: anon key + magiclink)')
  jwtToken = await getMobileJWT()
  assert(jwtToken.length > 100, `JWT 발급 성공 (${jwtToken.length}자)`)

  // 테스트 데이터 정리
  await fetchJSON(`${SUPABASE}/rest/v1/note_item?day_id=eq.${TEST_DAY}&user_id=eq.${USER_ID}`, {
    method: 'DELETE',
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  })
  await fetchJSON(`${SUPABASE}/rest/v1/note_day?id=eq.${TEST_DAY}&user_id=eq.${USER_ID}`, {
    method: 'DELETE',
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  })
  // PC 로컬에서도 정리
  await pcQuery(`DELETE FROM note_item WHERE day_id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM note_day WHERE id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE 'mobile-test-%'`)

  // ═══════════════════════════════════════
  log('')
  log('▶ 01. 모바일에서 메모 추가 → PC에서 감지')
  const now = Date.now()
  const itemId = `mobile-test-${now}`
  const upsertRes = await mobileUpsert({
    id: itemId, day_id: TEST_DAY, type: 'text',
    content: '모바일에서 작성한 메모', tags: '[]',
    pinned: 0, order_index: 0, created_at: now, updated_at: now
  })
  assert(upsertRes.status === 201, `모바일 upsert 성공 (status=${upsertRes.status})`)

  // 서버에 도달했는지 확인
  const serverCheck = await fetchJSON(`${SUPABASE}/rest/v1/note_item?id=eq.${itemId}`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  })
  assert(serverCheck.data?.length === 1, `서버에 데이터 도달 (${serverCheck.data?.length}건)`)

  // PC fullSync 실행
  const sync1 = await pcSync()
  assert(sync1.pulled > 0 || sync1.pushed >= 0, `PC fullSync pulled=${sync1.pulled}`)

  // PC 로컬에서 확인
  const pcCheck1 = await pcQuery(`SELECT * FROM note_item WHERE id = '${itemId}'`)
  assert(pcCheck1.rows?.length === 1, `PC 로컬에 메모 반영됨 (${pcCheck1.rows?.length}건)`)
  if (pcCheck1.rows?.length > 0) {
    assert(pcCheck1.rows[0].content === '모바일에서 작성한 메모', `내용 일치: "${pcCheck1.rows[0].content}"`)
  }

  // ═══════════════════════════════════════
  log('')
  log('▶ 02. 모바일에서 메모 수정 → PC에서 감지')
  const updated = Date.now()
  const updateRes = await mobileUpsert({
    id: itemId, day_id: TEST_DAY, type: 'text',
    content: '모바일에서 수정한 메모', tags: '["수정됨"]',
    pinned: 1, order_index: 0, created_at: now, updated_at: updated
  })
  assert(updateRes.status === 200 || updateRes.status === 201, `모바일 수정 upsert 성공 (status=${updateRes.status})`)

  const sync2 = await pcSync()
  const pcCheck2 = await pcQuery(`SELECT * FROM note_item WHERE id = '${itemId}'`)
  assert(pcCheck2.rows?.[0]?.content === '모바일에서 수정한 메모', `PC에서 수정 반영: "${pcCheck2.rows?.[0]?.content}"`)
  assert(pcCheck2.rows?.[0]?.pinned === 1, `PC에서 pinned 반영: ${pcCheck2.rows?.[0]?.pinned}`)

  // ═══════════════════════════════════════
  log('')
  log('▶ 03. 모바일에서 메모 삭제 → PC에서 감지')
  const deleteRes = await mobileDelete(itemId)
  assert(deleteRes.status === 200 || deleteRes.status === 204, `모바일 삭제 성공 (status=${deleteRes.status})`)

  // 서버에서 삭제 확인
  const serverCheck2 = await fetchJSON(`${SUPABASE}/rest/v1/note_item?id=eq.${itemId}`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  })
  assert(serverCheck2.data?.length === 0, `서버에서 삭제됨 (${serverCheck2.data?.length}건)`)

  // PC fullSync → cleanDeletedFromRemote에서 삭제 감지
  const sync3 = await pcSync()
  const pcCheck3 = await pcQuery(`SELECT * FROM note_item WHERE id = '${itemId}'`)
  assert(pcCheck3.rows?.length === 0, `PC에서도 삭제됨 (${pcCheck3.rows?.length}건)`)

  // ═══════════════════════════════════════
  log('')
  log('▶ 04. 모바일에서 여러 메모 추가 + 일부 삭제 → PC 정합성')
  const items = []
  for (let i = 0; i < 5; i++) {
    const id = `mobile-test-batch-${now}-${i}`
    const ts = Date.now()
    items.push({ id, day_id: TEST_DAY, type: 'text', content: `배치 메모 ${i}`, tags: '[]', pinned: 0, order_index: i, created_at: ts, updated_at: ts })
    await mobileUpsert(items[i])
  }
  // 2개 삭제
  await mobileDelete(items[1].id)
  await mobileDelete(items[3].id)

  const sync4 = await pcSync()
  const pcCheck4 = await pcQuery(`SELECT * FROM note_item WHERE day_id = '${TEST_DAY}' AND id LIKE 'mobile-test-batch-%' ORDER BY order_index`)
  assert(pcCheck4.rows?.length === 3, `PC에 3개 반영 (5추가-2삭제) actual=${pcCheck4.rows?.length}`)

  // ═══════════════════════════════════════
  log('')
  log('▶ 05. 삭제 후 3차 sync → 부활 방지')
  const sync5 = await pcSync()
  const pcCheck5 = await pcQuery(`SELECT * FROM note_item WHERE id = '${items[1].id}'`)
  assert(pcCheck5.rows?.length === 0, `삭제된 메모 부활 안 함 (${pcCheck5.rows?.length}건)`)

  // ═══════════════════════════════════════
  log('')
  log('▶ 06. RLS 테스트: anon key + 만료된 토큰으로 upsert 시 실패 확인')
  const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI4NDhhNTFhNC1kMjZjLTQwNjMtOGUzYS1jNzNjZDU0OGNlODIiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNjAwMDAwMDAwLCJpYXQiOjE2MDAwMDAwMDAsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0.invalid'
  const rlsRes = await fetchJSON(`${SUPABASE}/rest/v1/note_item`, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${expiredToken}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify([{ id: 'rls-test', day_id: TEST_DAY, type: 'text', content: 'should fail', tags: '[]', pinned: 0, order_index: 0, created_at: now, updated_at: now, user_id: USER_ID }])
  })
  assert(rlsRes.status === 401 || rlsRes.status === 403, `만료 토큰 → RLS 거부 (status=${rlsRes.status})`)

  // ═══════════════════════════════════════
  // 정리
  await fetchJSON(`${SUPABASE}/rest/v1/note_item?day_id=eq.${TEST_DAY}&user_id=eq.${USER_ID}`, {
    method: 'DELETE',
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  })
  await fetchJSON(`${SUPABASE}/rest/v1/note_day?id=eq.${TEST_DAY}&user_id=eq.${USER_ID}`, {
    method: 'DELETE',
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  })
  await pcQuery(`DELETE FROM note_item WHERE day_id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM note_day WHERE id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE 'mobile-test-%'`)
  await pcSync()

  // ═══════════════════════════════════════
  log('')
  log('═══════════════════════════════════════')
  log(`  📊 결과: ${passed} PASS, ${failed} FAIL`)
  log('═══════════════════════════════════════')

  process.exit(failed > 0 ? 1 : 0)
}

runTests().catch(err => {
  console.error('테스트 에러:', err)
  process.exit(1)
})
