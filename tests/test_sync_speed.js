/**
 * 동기화 속도 정밀 테스트 — Realtime 전달 지연 측정
 *
 * 측정 항목:
 *   1. 서버→PC INSERT 지연 (30회 반복, 통계)
 *   2. 서버→PC UPDATE 지연 (30회 반복, 통계)
 *   3. 서버→PC DELETE 지연 (30회 반복, 통계)
 *   4. 연속 빠른 INSERT 20개 — 전체 도착 시간
 *   5. 연속 빠른 DELETE 20개 — 전체 반영 시간
 *   6. INSERT→즉시 DELETE (100ms 간격) — 최종 상태 정합성
 *   7. 대량 100개 동시 INSERT — Realtime 수신 완료 시간
 *   8. 1초 간격 INSERT 10개 — 개별 도착 시간 편차
 */
const { createClient } = require('@supabase/supabase-js')
const http = require('http')
const path = require('path')
require('dotenv').config()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const USER_ID = '848a51a4-d26c-4063-8e3a-c73cd548ce82'
const PC_PORT = 19876
const TEST_DAY = '2099-09-15'
const RESULT_FILE = path.join(__dirname, 'test_speed_results.json')

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) }

async function pcRequest(urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PC_PORT,
      path: urlPath, method, timeout: 30000
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(data) } })
    })
    req.on('error', reject)
    req.end()
  })
}

async function pcQuery(sql) { return pcRequest(`/query?sql=${encodeURIComponent(sql)}`) }
async function pcSync() { return pcRequest('/sync', 'POST') }

let passed = 0, failed = 0
const results = {}

function assert(cond, name) {
  if (cond) { passed++; log(`  ✅ ${name}`) }
  else { failed++; log(`  ❌ ${name}`) }
  return cond
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const median = sorted[Math.floor(sorted.length / 2)]
  const p90 = sorted[Math.floor(sorted.length * 0.9)]
  const stddev = Math.sqrt(times.reduce((s, t) => s + (t - avg) ** 2, 0) / times.length)
  return { min, max, avg: +avg.toFixed(0), median, p90, stddev: +stddev.toFixed(0), count: times.length }
}

async function cleanup() {
  await sb.from('note_item').delete().eq('day_id', TEST_DAY).eq('user_id', USER_ID)
  await sb.from('note_day').delete().eq('id', TEST_DAY).eq('user_id', USER_ID)
  await pcQuery(`DELETE FROM note_item WHERE day_id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM note_day WHERE id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE 'speed-%'`)
}

async function ensureDay(now) {
  await sb.from('note_day').upsert({
    id: TEST_DAY, user_id: USER_ID, mood: null,
    summary: null, note_count: 0, has_notes: 0, updated_at: now
  }, { onConflict: 'id,user_id' })
}

/** Realtime으로 PC에 반영될 때까지 폴링, ms 단위 반환. timeout 시 -1 */
async function waitForItem(itemId, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await pcQuery(`SELECT id FROM note_item WHERE id = '${itemId}'`)
    if (r.rows?.length > 0) return Date.now() - start
    await sleep(200)
  }
  return -1
}

/** 아이템이 PC에서 사라질 때까지 대기 */
async function waitForDelete(itemId, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await pcQuery(`SELECT id FROM note_item WHERE id = '${itemId}'`)
    if (!r.rows || r.rows.length === 0) return Date.now() - start
    await sleep(200)
  }
  return -1
}

/** 아이템 content가 변경될 때까지 대기 */
async function waitForUpdate(itemId, expectedContent, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await pcQuery(`SELECT content FROM note_item WHERE id = '${itemId}'`)
    if (r.rows?.[0]?.content === expectedContent) return Date.now() - start
    await sleep(200)
  }
  return -1
}

// ═══════════════════════════════════════════════════════════
async function test1_insertLatency() {
  log('')
  log('▶ 01. 서버→PC INSERT 지연 (30회)')

  const ROUNDS = 30
  const times = []
  const now = Date.now()
  await ensureDay(now)

  for (let i = 0; i < ROUNDS; i++) {
    const id = `speed-ins-${now}-${i}`
    const insertAt = Date.now()
    await sb.from('note_item').insert({
      id, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `INSERT 속도 #${i}`,
      tags: '[]', pinned: 0, order_index: i, created_at: insertAt, updated_at: insertAt
    })

    const ms = await waitForItem(id)
    times.push(ms)
    if (i % 10 === 9) log(`  ${i + 1}/${ROUNDS}: ${ms}ms`)

    // 정리
    await sb.from('note_item').delete().eq('id', id)
    await sleep(500) // 삭제 반영 대기
  }

  const s = stats(times.filter(t => t > 0))
  log(`  INSERT 통계: avg=${s.avg}ms, median=${s.median}ms, p90=${s.p90}ms, min=${s.min}ms, max=${s.max}ms, stddev=${s.stddev}ms`)
  const timeouts = times.filter(t => t < 0).length
  assert(timeouts <= 3, `INSERT 타임아웃: ${timeouts}/${ROUNDS} (허용 ≤3)`)
  assert(s.avg <= 5000, `INSERT 평균: ${s.avg}ms (기준 ≤5000ms)`)
  results['01: INSERT 지연'] = { ...s, timeouts }
}

// ═══════════════════════════════════════════════════════════
async function test2_updateLatency() {
  log('')
  log('▶ 02. 서버→PC UPDATE 지연 (30회)')

  const ROUNDS = 30
  const times = []
  const now = Date.now()
  await ensureDay(now)

  // 기준 아이템 생성
  const id = `speed-upd-${now}`
  await sb.from('note_item').insert({
    id, day_id: TEST_DAY, user_id: USER_ID,
    type: 'text', content: 'UPDATE 기준',
    tags: '[]', pinned: 0, order_index: 0, created_at: now, updated_at: now
  })
  await sleep(2000)

  for (let i = 0; i < ROUNDS; i++) {
    const newContent = `UPDATE #${i} @ ${Date.now()}`
    const updateAt = Date.now()
    await sb.from('note_item').update({
      content: newContent, updated_at: updateAt
    }).eq('id', id).eq('user_id', USER_ID)

    const ms = await waitForUpdate(id, newContent)
    times.push(ms)
    if (i % 10 === 9) log(`  ${i + 1}/${ROUNDS}: ${ms}ms`)
    await sleep(300)
  }

  await sb.from('note_item').delete().eq('id', id)

  const s = stats(times.filter(t => t > 0))
  log(`  UPDATE 통계: avg=${s.avg}ms, median=${s.median}ms, p90=${s.p90}ms, min=${s.min}ms, max=${s.max}ms, stddev=${s.stddev}ms`)
  const timeouts = times.filter(t => t < 0).length
  assert(timeouts <= 3, `UPDATE 타임아웃: ${timeouts}/${ROUNDS} (허용 ≤3)`)
  assert(s.avg <= 5000, `UPDATE 평균: ${s.avg}ms (기준 ≤5000ms)`)
  results['02: UPDATE 지연'] = { ...s, timeouts }
}

// ═══════════════════════════════════════════════════════════
async function test3_deleteLatency() {
  log('')
  log('▶ 03. 서버→PC DELETE 지연 (30회)')

  const ROUNDS = 30
  const times = []
  const now = Date.now()
  await ensureDay(now)

  for (let i = 0; i < ROUNDS; i++) {
    const id = `speed-del-${now}-${i}`
    // 먼저 아이템 생성 후 PC에 반영 대기
    await sb.from('note_item').insert({
      id, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `DELETE 대상 #${i}`,
      tags: '[]', pinned: 0, order_index: i, created_at: now + i, updated_at: now + i
    })
    await waitForItem(id, 10000)
    await sleep(500)

    // DELETE 측정
    await sb.from('note_item').delete().eq('id', id).eq('user_id', USER_ID)
    const ms = await waitForDelete(id)
    times.push(ms)
    if (i % 10 === 9) log(`  ${i + 1}/${ROUNDS}: ${ms}ms`)
    await sleep(300)
  }

  const s = stats(times.filter(t => t > 0))
  log(`  DELETE 통계: avg=${s.avg}ms, median=${s.median}ms, p90=${s.p90}ms, min=${s.min}ms, max=${s.max}ms, stddev=${s.stddev}ms`)
  const timeouts = times.filter(t => t < 0).length
  assert(timeouts <= 3, `DELETE 타임아웃: ${timeouts}/${ROUNDS} (허용 ≤3)`)
  assert(s.avg <= 5000, `DELETE 평균: ${s.avg}ms (기준 ≤5000ms)`)
  results['03: DELETE 지연'] = { ...s, timeouts }
}

// ═══════════════════════════════════════════════════════════
async function test4_burstInsert() {
  log('')
  log('▶ 04. 연속 빠른 INSERT 20개 — 전체 도착 시간')

  const COUNT = 20
  const now = Date.now()
  await ensureDay(now)

  const ids = []
  const startTime = Date.now()

  // 빠르게 연속 INSERT (대기 없이)
  for (let i = 0; i < COUNT; i++) {
    const id = `speed-burst-${now}-${i}`
    ids.push(id)
    await sb.from('note_item').insert({
      id, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `burst #${i}`,
      tags: '[]', pinned: 0, order_index: i, created_at: now + i, updated_at: now + i
    })
  }
  const insertDone = Date.now()
  log(`  ${COUNT}개 INSERT 소요: ${insertDone - startTime}ms`)

  // 전체 도착 대기
  const arrivals = []
  for (const id of ids) {
    const ms = await waitForItem(id, 30000)
    arrivals.push(ms)
  }
  const allDone = Date.now() - startTime

  const arrived = arrivals.filter(t => t > 0).length
  const missed = arrivals.filter(t => t < 0).length
  log(`  도착: ${arrived}/${COUNT}, 미도착: ${missed}, 총 시간: ${allDone}ms`)

  if (arrived > 0) {
    const s = stats(arrivals.filter(t => t > 0))
    log(`  개별 통계: avg=${s.avg}ms, max=${s.max}ms, stddev=${s.stddev}ms`)
    results['04: burst INSERT'] = { ...s, arrived, missed, totalMs: allDone }
  }
  assert(arrived >= COUNT * 0.9, `burst INSERT 도착률: ${arrived}/${COUNT} (≥90%)`)

  // 정리
  for (const id of ids) await sb.from('note_item').delete().eq('id', id)
  await sleep(2000)
}

// ═══════════════════════════════════════════════════════════
async function test5_burstDelete() {
  log('')
  log('▶ 05. 연속 빠른 DELETE 20개 — 전체 반영 시간')

  const COUNT = 20
  const now = Date.now()
  await ensureDay(now)

  // 먼저 20개 생성 + PC 반영 대기
  const ids = []
  for (let i = 0; i < COUNT; i++) {
    const id = `speed-bdel-${now}-${i}`
    ids.push(id)
    await sb.from('note_item').insert({
      id, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `bdel #${i}`,
      tags: '[]', pinned: 0, order_index: i, created_at: now + i, updated_at: now + i
    })
  }
  // fullSync로 확실히 반영
  await pcSync()
  await sleep(2000)

  let pcCnt = (await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE 'speed-bdel-${now}%'`)).rows?.[0]?.cnt || 0
  log(`  PC에 ${pcCnt}/${COUNT}개 준비됨`)

  // 빠르게 연속 DELETE
  const startTime = Date.now()
  for (const id of ids) {
    await sb.from('note_item').delete().eq('id', id).eq('user_id', USER_ID)
  }
  const deleteDone = Date.now()
  log(`  ${COUNT}개 DELETE 소요: ${deleteDone - startTime}ms`)

  // 전체 삭제 반영 대기
  const deletions = []
  for (const id of ids) {
    const ms = await waitForDelete(id, 30000)
    deletions.push(ms)
  }
  const allDone = Date.now() - startTime

  const deleted = deletions.filter(t => t > 0).length
  const missed = deletions.filter(t => t < 0).length
  log(`  반영: ${deleted}/${COUNT}, 미반영: ${missed}, 총 시간: ${allDone}ms`)

  if (deleted > 0) {
    const s = stats(deletions.filter(t => t > 0))
    log(`  개별 통계: avg=${s.avg}ms, max=${s.max}ms, stddev=${s.stddev}ms`)
    results['05: burst DELETE'] = { ...s, deleted, missed, totalMs: allDone }
  }
  assert(deleted >= COUNT * 0.9, `burst DELETE 반영률: ${deleted}/${COUNT} (≥90%)`)
  await sleep(1000)
}

// ═══════════════════════════════════════════════════════════
async function test6_insertDeleteRace() {
  log('')
  log('▶ 06. INSERT→즉시DELETE (100ms 간격) — 최종 정합성')

  const COUNT = 15
  const now = Date.now()
  await ensureDay(now)

  const ids = []
  for (let i = 0; i < COUNT; i++) {
    const id = `speed-race-${now}-${i}`
    ids.push(id)
    await sb.from('note_item').insert({
      id, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `race #${i}`,
      tags: '[]', pinned: 0, order_index: i, created_at: now + i, updated_at: now + i
    })
    await sleep(100)
    await sb.from('note_item').delete().eq('id', id).eq('user_id', USER_ID)
  }

  log(`  ${COUNT}개 INSERT→DELETE 완료`)
  await sleep(10000) // 충분히 대기

  // PC에 아이템이 남아있으면 안 됨
  let remaining = 0
  for (const id of ids) {
    const r = await pcQuery(`SELECT id FROM note_item WHERE id = '${id}'`)
    if (r.rows?.length > 0) remaining++
  }

  log(`  PC 잔여: ${remaining}/${COUNT}개`)
  assert(remaining === 0, `INSERT→DELETE race: PC 잔여 ${remaining}개 (기대: 0)`)

  // fullSync 후 재확인
  await pcSync()
  remaining = 0
  for (const id of ids) {
    const r = await pcQuery(`SELECT id FROM note_item WHERE id = '${id}'`)
    if (r.rows?.length > 0) remaining++
  }
  assert(remaining === 0, `fullSync 후 잔여: ${remaining}개 (기대: 0)`)
  results['06: INSERT→DELETE race'] = { pass: remaining === 0, remaining }
  await sleep(1000)
}

// ═══════════════════════════════════════════════════════════
async function test7_bulk100() {
  log('')
  log('▶ 07. 대량 100개 동시 INSERT — Realtime 수신 시간')

  const COUNT = 100
  const now = Date.now()
  await ensureDay(now)

  const items = []
  for (let i = 0; i < COUNT; i++) {
    items.push({
      id: `speed-bulk-${now}-${i}`, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `bulk #${i}`,
      tags: '[]', pinned: 0, order_index: i, created_at: now + i, updated_at: now + i
    })
  }

  const startTime = Date.now()
  // 50개씩 배치 INSERT
  await sb.from('note_item').insert(items.slice(0, 50))
  await sb.from('note_item').insert(items.slice(50))
  const insertDone = Date.now()
  log(`  100개 INSERT: ${insertDone - startTime}ms`)

  // 전체 도착 대기 (폴링)
  let arrived = 0
  for (let wait = 0; wait < 60; wait++) {
    await sleep(1000)
    const r = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE 'speed-bulk-${now}%'`)
    arrived = r.rows?.[0]?.cnt || 0
    if (arrived >= COUNT) break
    if (wait % 5 === 4) log(`  ${wait + 1}초: ${arrived}/${COUNT}`)
  }
  const totalMs = Date.now() - startTime

  log(`  최종: ${arrived}/${COUNT}개 (${totalMs}ms)`)
  assert(arrived >= COUNT * 0.95, `100개 도착률: ${arrived}/${COUNT} (≥95%)`)
  results['07: bulk 100개'] = { arrived, totalMs, insertMs: insertDone - startTime }

  // 정리
  for (let s = 0; s < items.length; s += 50) {
    const ids = items.slice(s, s + 50).map(i => i.id)
    await sb.from('note_item').delete().in('id', ids)
  }
  await sleep(2000)
}

// ═══════════════════════════════════════════════════════════
async function test8_intervalConsistency() {
  log('')
  log('▶ 08. 1초 간격 INSERT 10개 — 도착 시간 편차')

  const COUNT = 10
  const now = Date.now()
  await ensureDay(now)

  const times = []
  for (let i = 0; i < COUNT; i++) {
    const id = `speed-intv-${now}-${i}`
    const insertAt = Date.now()
    await sb.from('note_item').insert({
      id, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `interval #${i}`,
      tags: '[]', pinned: 0, order_index: i, created_at: insertAt, updated_at: insertAt
    })

    const ms = await waitForItem(id, 15000)
    times.push(ms)
    log(`  #${i}: ${ms}ms`)

    await sb.from('note_item').delete().eq('id', id)
    await sleep(1000) // 1초 간격
  }

  const valid = times.filter(t => t > 0)
  if (valid.length > 0) {
    const s = stats(valid)
    log(`  편차 통계: avg=${s.avg}ms, stddev=${s.stddev}ms, min=${s.min}ms, max=${s.max}ms`)
    log(`  편차율: ${((s.stddev / s.avg) * 100).toFixed(0)}% (stddev/avg)`)
    assert(s.stddev <= s.avg * 2, `편차: stddev=${s.stddev}ms ≤ 2×avg=${s.avg * 2}ms`)
    results['08: 1초간격 편차'] = { ...s, variationPct: +((s.stddev / s.avg) * 100).toFixed(0) }
  }

  const timeouts = times.filter(t => t < 0).length
  assert(timeouts <= 2, `타임아웃: ${timeouts}/${COUNT} (허용 ≤2)`)
  await sleep(1000)
}

// ═══════════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗')
  console.log('║   동기화 속도 정밀 테스트 — Realtime 지연/편차/정합성 측정     ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝\n')

  try {
    const ping = await pcRequest('/ping')
    assert(ping.ok, '테스트 서버 연결 OK')
  } catch {
    console.error('❌ 테스트 서버(포트 19876)에 연결할 수 없습니다')
    process.exit(1)
  }

  // Realtime 구독 확인
  let rtOk = false
  for (let i = 0; i < 15; i++) {
    const status = await pcRequest('/realtime-status')
    if (status.connected) { rtOk = true; break }
    await sleep(1000)
  }
  assert(rtOk, `Realtime 구독 활성`)
  if (!rtOk) {
    log('  ⚠️ Realtime 미연결 — fullSync fallback으로 진행')
  }

  await cleanup()

  await test1_insertLatency()
  await cleanup()
  await test2_updateLatency()
  await cleanup()
  await test3_deleteLatency()
  await cleanup()
  await test4_burstInsert()
  await cleanup()
  await test5_burstDelete()
  await cleanup()
  await test6_insertDeleteRace()
  await cleanup()
  await test7_bulk100()
  await cleanup()
  await test8_intervalConsistency()
  await cleanup()

  // ── 결과 요약 ──
  const total = passed + failed
  console.log('\n╔══════════════════════════════════════════════════════════════════╗')
  console.log('║ 동기화 속도 테스트 결과                                         ║')
  console.log('╠══════════════════════════════════════════════════════════════════╣')
  for (const [name, v] of Object.entries(results)) {
    const avgStr = v.avg !== undefined ? `avg=${v.avg}ms` : ''
    const p90Str = v.p90 !== undefined ? ` p90=${v.p90}ms` : ''
    const sdStr = v.stddev !== undefined ? ` sd=${v.stddev}ms` : ''
    const extra = v.arrived !== undefined ? ` ${v.arrived}개` : ''
    console.log(`║ ${name}: ${avgStr}${p90Str}${sdStr}${extra}`.padEnd(66) + '║')
  }
  console.log('╠══════════════════════════════════════════════════════════════════╣')
  console.log(`║ 합계: ${passed}/${total} 통과`.padEnd(66) + '║')
  console.log('╚══════════════════════════════════════════════════════════════════╝')

  const fs = require('fs')
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ timestamp: new Date().toISOString(), results, passed, total }, null, 2))
  log(`결과 저장: ${RESULT_FILE}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('에러:', err); process.exit(1) })
