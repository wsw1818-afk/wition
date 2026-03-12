/**
 * Wition 동기화 자동 테스트 v4 — Headless 테스트 서버 기반
 *
 * 앱 실행 불필요: headless 서버(포트 19876)의 /sync, /query, /realtime-status 사용
 * run-tests.js에서 자동 서버 시작/종료 가능
 */
const { createClient } = require('@supabase/supabase-js')
const http = require('http')
const path = require('path')
require('dotenv').config()

// ─── 설정 ────────────────────────────────────────────────
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const USER_ID = '848a51a4-d26c-4063-8e3a-c73cd548ce82'
const PC_PORT = 19876
const TEST_DAY = '2099-12-25'
const RESULT_FILE = path.join(__dirname, 'test_sync_results.json')

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// ─── 유틸 ────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) }

/** PC 테스트 서버에 요청 */
async function pcRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PC_PORT,
      path, method, timeout: 15000
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
async function pcRealtimeStatus() { return pcRequest('/realtime-status') }

let passed = 0, failed = 0
const results = {}

function assert(cond, name) {
  if (cond) { passed++; log(`  ✅ ${name}`) }
  else { failed++; log(`  ❌ ${name}`) }
  return cond
}

// ─── 테스트 ──────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║   Wition 동기화 자동 테스트 v4 (Headless 서버 기반)    ║')
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  // 서버 연결 확인
  try {
    const ping = await pcRequest('/ping')
    assert(ping.ok, `테스트 서버 연결 OK (${ping.server})`)
  } catch {
    console.error('❌ 테스트 서버(포트 19876)에 연결할 수 없습니다')
    process.exit(1)
  }

  // 테스트 데이터 정리
  await sb.from('note_item').delete().eq('day_id', TEST_DAY).eq('user_id', USER_ID)
  await sb.from('note_day').delete().eq('id', TEST_DAY).eq('user_id', USER_ID)
  await pcQuery(`DELETE FROM note_item WHERE day_id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM note_day WHERE id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE 'sync-auto-%'`)

  const now = Date.now()

  // ══════════════════════════════════════════════════════
  log('')
  log('▶ 01. Realtime 구독 상태 확인')
  let rtConnected = false
  for (let i = 0; i < 10; i++) {
    const rtStatus = await pcRealtimeStatus()
    if (rtStatus.connected === true) { rtConnected = true; break }
    await sleep(1000)
  }
  assert(rtConnected, `Realtime 구독 활성: ${rtConnected}`)
  results['Realtime 구독'] = { pass: rtConnected }

  // ══════════════════════════════════════════════════════
  log('')
  log('▶ 02. 서버→PC 추가: Realtime으로 감지')
  const addId = `sync-auto-add-${now}`
  await sb.from('note_day').upsert({
    id: TEST_DAY, user_id: USER_ID, mood: null,
    summary: null, note_count: 1, has_notes: 1, updated_at: now
  }, { onConflict: 'id,user_id' })
  await sb.from('note_item').insert({
    id: addId, day_id: TEST_DAY, user_id: USER_ID,
    type: 'text', content: 'Realtime 추가 테스트',
    tags: '[]', pinned: 0, order_index: 0, created_at: now, updated_at: now
  })

  // Realtime이 감지하면 로컬 DB에 바로 반영됨 — 폴링으로 확인
  let addDetected = false
  let addSec = 0
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    addSec = i + 1
    const check = await pcQuery(`SELECT * FROM note_item WHERE id = '${addId}'`)
    if (check.rows?.length > 0) { addDetected = true; break }
  }
  if (!addDetected) {
    // Realtime 미감지 → fullSync로 fallback
    log('  ⚠️ Realtime 미감지, fullSync 시도...')
    await pcSync()
    const check2 = await pcQuery(`SELECT * FROM note_item WHERE id = '${addId}'`)
    addDetected = check2.rows?.length > 0
    addSec = -1 // fullSync fallback
  }
  assert(addDetected, `서버→PC 추가 감지 (${addSec > 0 ? addSec + '초 Realtime' : 'fullSync fallback'})`)
  results['서버→PC 추가'] = { pass: addDetected, sec: addSec }

  // ══════════════════════════════════════════════════════
  log('')
  log('▶ 03. 서버→PC 수정: Realtime으로 감지')
  const updatedContent = 'Realtime 수정 테스트 ' + Date.now()
  await sb.from('note_item').update({
    content: updatedContent, updated_at: Date.now()
  }).eq('id', addId).eq('user_id', USER_ID)

  let editDetected = false
  let editSec = 0
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    editSec = i + 1
    const check = await pcQuery(`SELECT content FROM note_item WHERE id = '${addId}'`)
    if (check.rows?.[0]?.content === updatedContent) { editDetected = true; break }
  }
  if (!editDetected) {
    log('  ⚠️ Realtime 미감지, fullSync 시도...')
    await pcSync()
    const check2 = await pcQuery(`SELECT content FROM note_item WHERE id = '${addId}'`)
    editDetected = check2.rows?.[0]?.content === updatedContent
    editSec = -1
  }
  assert(editDetected, `서버→PC 수정 감지 (${editSec > 0 ? editSec + '초 Realtime' : 'fullSync fallback'})`)
  results['서버→PC 수정'] = { pass: editDetected, sec: editSec }

  // ══════════════════════════════════════════════════════
  log('')
  log('▶ 04. 서버→PC 삭제: Realtime으로 감지')
  await sb.from('note_item').delete().eq('id', addId)

  let delDetected = false
  let delSec = 0
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    delSec = i + 1
    const check = await pcQuery(`SELECT * FROM note_item WHERE id = '${addId}'`)
    if (check.rows?.length === 0) { delDetected = true; break }
  }
  if (!delDetected) {
    log('  ⚠️ Realtime 미감지, fullSync 시도...')
    await pcSync()
    const check2 = await pcQuery(`SELECT * FROM note_item WHERE id = '${addId}'`)
    delDetected = check2.rows?.length === 0
    delSec = -1
  }
  assert(delDetected, `서버→PC 삭제 감지 (${delSec > 0 ? delSec + '초 Realtime' : 'fullSync fallback'})`)
  results['서버→PC 삭제'] = { pass: delDetected, sec: delSec }

  // ══════════════════════════════════════════════════════
  log('')
  log('▶ 05. 배치 5개 추가 → PC 반영')
  const batchIds = []
  for (let i = 0; i < 5; i++) {
    const bId = `sync-auto-batch-${now}-${i}`
    batchIds.push(bId)
    await sb.from('note_item').insert({
      id: bId, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `배치 ${i}`,
      tags: '[]', pinned: 0, order_index: i, created_at: now, updated_at: now
    })
  }

  let batchDetected = false
  let batchSec = 0
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    batchSec = i + 1
    const check = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE 'sync-auto-batch-${now}%'`)
    if (check.rows?.[0]?.cnt >= 5) { batchDetected = true; break }
  }
  if (!batchDetected) {
    await pcSync()
    const check2 = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE 'sync-auto-batch-${now}%'`)
    batchDetected = check2.rows?.[0]?.cnt >= 5
    batchSec = -1
  }
  assert(batchDetected, `배치 5개 반영 (${batchSec > 0 ? batchSec + '초 Realtime' : 'fullSync fallback'})`)
  results['배치 추가'] = { pass: batchDetected, sec: batchSec }

  // ══════════════════════════════════════════════════════
  log('')
  log('▶ 06. Realtime 속도 측정 (3회)')
  const rtTimes = []
  for (let i = 0; i < 3; i++) {
    const rtId = `sync-auto-rt-${now}-${i}`
    const rtNow = Date.now()
    await sb.from('note_item').insert({
      id: rtId, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `RT 속도 ${i}`,
      tags: '[]', pinned: 0, order_index: 0, created_at: rtNow, updated_at: rtNow
    })

    let sec = -1
    for (let j = 0; j < 15; j++) {
      await sleep(1000)
      const check = await pcQuery(`SELECT * FROM note_item WHERE id = '${rtId}'`)
      if (check.rows?.length > 0) { sec = j + 1; break }
    }
    rtTimes.push(sec > 0 ? sec : 15)
    log(`  시도 ${i+1}: ${sec > 0 ? `✅ ${sec}초` : '❌ 15초 초과'}`)

    await sb.from('note_item').delete().eq('id', rtId)
    await sleep(2000)
  }
  const avg = rtTimes.reduce((a,b) => a+b, 0) / rtTimes.length
  log(`  평균: ${avg.toFixed(1)}초`)
  assert(avg <= 12, `Realtime 평균 속도 ${avg.toFixed(1)}초 (기준: ≤12초)`)
  results['Realtime 속도'] = { pass: avg <= 12, avgSec: avg, times: rtTimes }

  // ══════════════════════════════════════════════════════
  log('')
  log('▶ 07. 데이터 정합성 (서버 vs PC)')
  await pcSync() // 최종 sync
  const { data: serverItems } = await sb.from('note_item').select('id').eq('user_id', USER_ID).not('id', 'like', 'sync-auto-%')
  const pcItems = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id NOT LIKE 'sync-auto-%'`)
  const serverCnt = (serverItems || []).length
  const pcCnt = pcItems.rows?.[0]?.cnt || 0
  const diff = Math.abs(serverCnt - pcCnt)
  assert(diff <= 3, `정합성: 서버 ${serverCnt}개, PC ${pcCnt}개 (차이 ${diff}, 허용 ≤3)`)
  results['데이터 정합성'] = { pass: diff <= 3, server: serverCnt, pc: pcCnt, diff }

  // ══════════════════════════════════════════════════════
  log('')
  log('▶ 08. 핑퐁 안정성 (10초 모니터링)')
  const beforeSync = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item`)
  const beforeCnt = beforeSync.rows?.[0]?.cnt || 0
  await sleep(10000)
  // 3회 sync 후 아이템 수가 크게 변하지 않으면 안정
  await pcSync()
  const afterSync = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item`)
  const afterCnt = afterSync.rows?.[0]?.cnt || 0
  const pingpongDiff = Math.abs(afterCnt - beforeCnt)
  assert(pingpongDiff <= 3, `핑퐁 안정: 변동 ${pingpongDiff}개 (허용 ≤3)`)
  results['핑퐁 안정성'] = { pass: pingpongDiff <= 3, before: beforeCnt, after: afterCnt }

  // ══════════════════════════════════════════════════════
  // 정리
  log('')
  log('▶ 정리...')
  for (const bId of batchIds) await sb.from('note_item').delete().eq('id', bId)
  await sb.from('note_item').delete().eq('day_id', TEST_DAY).eq('user_id', USER_ID)
  await sb.from('note_day').delete().eq('id', TEST_DAY).eq('user_id', USER_ID)
  await pcQuery(`DELETE FROM note_item WHERE day_id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM note_day WHERE id = '${TEST_DAY}'`)
  await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE 'sync-auto-%'`)
  await pcSync()

  // ── 결과 요약 ──
  const total = passed + failed
  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║ 테스트 결과                                            ║')
  console.log('╠══════════════════════════════════════════════════════════╣')
  for (const [name, v] of Object.entries(results)) {
    const icon = v.pass ? '✅' : '❌'
    const detail = v.sec ? `(${v.sec > 0 ? v.sec + '초' : 'fullSync'})` : v.avgSec ? `(${v.avgSec.toFixed(1)}초)` : ''
    console.log(`║ ${icon} ${name} ${detail}`.padEnd(58) + '║')
  }
  console.log('╠══════════════════════════════════════════════════════════╣')
  console.log(`║ 합계: ${passed}/${total} 통과`.padEnd(58) + '║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  const fs = require('fs')
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ timestamp: new Date().toISOString(), results, passed, total }, null, 2))
  log(`결과 저장: ${RESULT_FILE}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('에러:', err); process.exit(1) })
