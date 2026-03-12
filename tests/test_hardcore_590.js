/**
 * 하드코어 테스트 — 590개 메모 대량 입력 → 전체 삭제 → 잔상 검증
 *
 * 목적: 모바일 메모 삭제 후 PC 달력 잔상 버그가 수정되었는지 확인
 * 시나리오:
 *   1) 590개 메모를 서버에 INSERT (모바일에서 생성한 것처럼)
 *   2) PC에 fullSync로 반영
 *   3) 590개 메모를 서버에서 DELETE + note_day 정리 (모바일 삭제 시뮬레이션)
 *   4) PC Realtime/fullSync 후 잔상(note_day) 없는지 확인
 */
const { createClient } = require('@supabase/supabase-js')
const http = require('http')
const path = require('path')
require('dotenv').config()

// ─── 설정 ────────────────────────────────────────────────
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const USER_ID = '848a51a4-d26c-4063-8e3a-c73cd548ce82'
const PC_PORT = 19876
const ITEM_COUNT = 590
const RESULT_FILE = path.join(__dirname, 'test_hardcore_results.json')

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// ─── 유틸 ────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) }

async function pcRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PC_PORT,
      path, method, timeout: 30000
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

// ─── 테스트 날짜들 (20일에 걸쳐 분산) ──────────────────
function getTestDays() {
  const days = []
  for (let d = 1; d <= 20; d++) {
    days.push(`2099-11-${String(d).padStart(2, '0')}`)
  }
  return days
}

// ─── 메인 ────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log(`║   하드코어 테스트 — ${ITEM_COUNT}개 메모 대량 입력/삭제/잔상 검증    ║`)
  console.log('╚══════════════════════════════════════════════════════════════╝\n')

  // 서버 연결 확인
  try {
    const ping = await pcRequest('/ping')
    assert(ping.ok, `테스트 서버 연결 OK`)
  } catch {
    console.error('❌ 테스트 서버(포트 19876)에 연결할 수 없습니다')
    process.exit(1)
  }

  const testDays = getTestDays()
  const now = Date.now()
  const prefix = `hc590-${now}`

  // ═══════════════════════════════════════════════════════
  // 0. 정리 (이전 테스트 잔여 데이터)
  log('▶ 00. 사전 정리')
  for (const day of testDays) {
    await sb.from('note_item').delete().eq('day_id', day).eq('user_id', USER_ID)
    await sb.from('note_day').delete().eq('id', day).eq('user_id', USER_ID)
    await pcQuery(`DELETE FROM note_item WHERE day_id = '${day}'`)
    await pcQuery(`DELETE FROM note_day WHERE id = '${day}'`)
  }
  await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE '${prefix}%'`)
  log('  정리 완료')

  // ═══════════════════════════════════════════════════════
  log('')
  log(`▶ 01. 서버에 ${ITEM_COUNT}개 메모 INSERT (20일에 분산)`)
  const t1 = Date.now()

  // note_day 먼저 생성
  for (const day of testDays) {
    await sb.from('note_day').upsert({
      id: day, user_id: USER_ID, mood: null,
      summary: null, note_count: 0, has_notes: 0, updated_at: now
    }, { onConflict: 'id,user_id' })
  }

  // note_item 590개 생성 (배치 50개씩)
  const allItems = []
  for (let i = 0; i < ITEM_COUNT; i++) {
    const dayIdx = i % testDays.length
    allItems.push({
      id: `${prefix}-${i}`,
      day_id: testDays[dayIdx],
      user_id: USER_ID,
      type: 'text',
      content: `하드코어 테스트 메모 #${i} — ${new Date().toISOString()}`,
      tags: '[]',
      pinned: 0,
      order_index: Math.floor(i / testDays.length),
      created_at: now + i,
      updated_at: now + i
    })
  }

  // 50개씩 배치 insert
  const BATCH = 50
  for (let start = 0; start < allItems.length; start += BATCH) {
    const batch = allItems.slice(start, start + BATCH)
    const { error } = await sb.from('note_item').insert(batch)
    if (error) {
      log(`  ❌ 배치 INSERT 실패 (${start}~): ${error.message}`)
      process.exit(1)
    }
    if ((start / BATCH) % 4 === 0) {
      process.stdout.write(`  ${start + batch.length}/${ITEM_COUNT}...\r`)
    }
  }

  // note_day count 업데이트
  for (const day of testDays) {
    const items = allItems.filter(i => i.day_id === day)
    const summary = items[0]?.content?.slice(0, 80) ?? null
    await sb.from('note_day').update({
      note_count: items.length,
      has_notes: 1,
      summary,
      updated_at: Date.now()
    }).eq('id', day).eq('user_id', USER_ID)
  }

  const insertTime = ((Date.now() - t1) / 1000).toFixed(1)
  assert(true, `${ITEM_COUNT}개 INSERT 완료 (${insertTime}초)`)
  results['대량 INSERT'] = { pass: true, count: ITEM_COUNT, sec: insertTime }

  // ═══════════════════════════════════════════════════════
  log('')
  log('▶ 02. PC fullSync로 590개 반영')
  const t2 = Date.now()
  await pcSync()
  // Realtime도 동시에 들어올 수 있으므로 잠시 대기
  await sleep(3000)
  await pcSync()

  const pcCount = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE '${prefix}%'`)
  const pcCnt = pcCount.rows?.[0]?.cnt || 0
  const pullTime = ((Date.now() - t2) / 1000).toFixed(1)
  assert(pcCnt >= ITEM_COUNT * 0.95, `PC에 ${pcCnt}/${ITEM_COUNT}개 반영 (${pullTime}초)`)
  results['PC 반영'] = { pass: pcCnt >= ITEM_COUNT * 0.95, count: pcCnt, sec: pullTime }

  // note_day 확인
  const pcDays = await pcQuery(`SELECT id, note_count, has_notes FROM note_day WHERE id LIKE '2099-11-%'`)
  const daysBefore = pcDays.rows?.length || 0
  const totalNotes = pcDays.rows?.reduce((s, d) => s + (d.note_count || 0), 0) || 0
  log(`  PC note_day: ${daysBefore}일, 총 note_count: ${totalNotes}`)
  assert(daysBefore === 20, `PC에 20일 모두 note_day 존재`)

  // ═══════════════════════════════════════════════════════
  log('')
  log(`▶ 03. 서버에서 ${ITEM_COUNT}개 전체 DELETE (모바일 삭제 시뮬레이션)`)
  const t3 = Date.now()

  // note_item 삭제 (배치)
  for (let start = 0; start < allItems.length; start += BATCH) {
    const batch = allItems.slice(start, start + BATCH)
    const ids = batch.map(i => i.id)
    const { error } = await sb.from('note_item').delete().in('id', ids).eq('user_id', USER_ID)
    if (error) log(`  ⚠️ 배치 DELETE 실패: ${error.message}`)
    if ((start / BATCH) % 4 === 0) {
      process.stdout.write(`  삭제 ${start + batch.length}/${ITEM_COUNT}...\r`)
    }
  }

  // 모바일 syncNoteDay 시뮬레이션: note_count=0 & !mood → 서버 note_day DELETE
  for (const day of testDays) {
    await sb.from('note_day').delete().eq('id', day).eq('user_id', USER_ID)
  }

  const deleteTime = ((Date.now() - t3) / 1000).toFixed(1)
  log(`  서버 DELETE 완료 (${deleteTime}초)`)
  results['서버 DELETE'] = { pass: true, sec: deleteTime }

  // 서버 확인
  const serverCheck = await sb.from('note_item').select('id').eq('user_id', USER_ID).like('id', `${prefix}%`)
  const serverRemain = (serverCheck.data || []).length
  assert(serverRemain === 0, `서버 note_item 잔여: ${serverRemain}개 (기대: 0)`)

  const serverDayCheck = await sb.from('note_day').select('id').eq('user_id', USER_ID).like('id', '2099-11-%')
  const serverDayRemain = (serverDayCheck.data || []).length
  assert(serverDayRemain === 0, `서버 note_day 잔여: ${serverDayRemain}개 (기대: 0)`)

  // ═══════════════════════════════════════════════════════
  log('')
  log('▶ 04. PC Realtime 수신 대기 (15초)')
  await sleep(15000)

  // Realtime으로 자동 삭제되었는지 확인
  const pcCountAfterRT = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE '${prefix}%'`)
  const pcCntAfterRT = pcCountAfterRT.rows?.[0]?.cnt || 0
  log(`  Realtime 후 PC note_item 잔여: ${pcCntAfterRT}개`)

  const pcDaysAfterRT = await pcQuery(`SELECT id, note_count, has_notes, mood FROM note_day WHERE id LIKE '2099-11-%'`)
  const daysAfterRT = pcDaysAfterRT.rows?.length || 0
  log(`  Realtime 후 PC note_day 잔여: ${daysAfterRT}일`)
  results['Realtime 삭제'] = { itemsRemain: pcCntAfterRT, daysRemain: daysAfterRT }

  // ═══════════════════════════════════════════════════════
  log('')
  log('▶ 05. fullSync 강제 실행 후 잔상 확인')
  await pcSync()
  await sleep(1000)

  const pcCountFinal = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE '${prefix}%'`)
  const pcCntFinal = pcCountFinal.rows?.[0]?.cnt || 0
  assert(pcCntFinal === 0, `fullSync 후 PC note_item 잔여: ${pcCntFinal}개 (기대: 0)`)

  const pcDaysFinal = await pcQuery(`SELECT id, note_count, has_notes, mood FROM note_day WHERE id LIKE '2099-11-%'`)
  const daysFinal = pcDaysFinal.rows || []
  const ghostDays = daysFinal.filter(d => d.note_count === 0 && !d.mood)
  const realDays = daysFinal.filter(d => d.note_count > 0 || d.mood)

  log(`  fullSync 후 note_day: 총 ${daysFinal.length}일 (잔상=${ghostDays.length}, 실제=${realDays.length})`)
  if (ghostDays.length > 0) {
    log(`  잔상 날짜: ${ghostDays.map(d => d.id).join(', ')}`)
  }

  assert(ghostDays.length === 0, `잔상 note_day 없음 (발견: ${ghostDays.length}개) ← 핵심 검증!`)
  assert(realDays.length === 0, `실제 note_day도 없음 (발견: ${realDays.length}개)`)
  results['잔상 검증'] = { pass: ghostDays.length === 0, ghostDays: ghostDays.length, realDays: realDays.length }

  // ═══════════════════════════════════════════════════════
  log('')
  log('▶ 06. 2차 대량 테스트 — 입력 직후 즉시 삭제 (race condition)')
  const prefix2 = `hc590-race-${Date.now()}`
  const raceDays = ['2099-12-01', '2099-12-02', '2099-12-03']
  const raceNow = Date.now()

  // 빠르게 100개 INSERT
  const raceItems = []
  for (let i = 0; i < 100; i++) {
    raceItems.push({
      id: `${prefix2}-${i}`,
      day_id: raceDays[i % raceDays.length],
      user_id: USER_ID,
      type: 'text',
      content: `Race condition 테스트 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: raceNow + i, updated_at: raceNow + i
    })
  }

  for (const day of raceDays) {
    await sb.from('note_day').upsert({
      id: day, user_id: USER_ID, mood: null, summary: null,
      note_count: 0, has_notes: 0, updated_at: raceNow
    }, { onConflict: 'id,user_id' })
  }

  await sb.from('note_item').insert(raceItems)
  log(`  100개 INSERT 완료`)

  // 즉시 삭제 (1초도 안 기다림)
  for (const item of raceItems) {
    await sb.from('note_item').delete().eq('id', item.id)
  }
  for (const day of raceDays) {
    await sb.from('note_day').delete().eq('id', day).eq('user_id', USER_ID)
  }
  log(`  즉시 100개 DELETE + note_day DELETE 완료`)

  // 5초 대기 후 확인
  await sleep(5000)
  await pcSync()
  await sleep(1000)

  const raceCountFinal = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE '${prefix2}%'`)
  const raceCntFinal = raceCountFinal.rows?.[0]?.cnt || 0
  assert(raceCntFinal === 0, `Race condition: note_item 잔여 ${raceCntFinal}개 (기대: 0)`)

  const raceDaysFinal = await pcQuery(`SELECT id, note_count, has_notes FROM note_day WHERE id LIKE '2099-12-%'`)
  const raceGhosts = (raceDaysFinal.rows || []).filter(d => d.note_count === 0 && !d.mood)
  assert(raceGhosts.length === 0, `Race condition: 잔상 note_day ${raceGhosts.length}개 (기대: 0)`)
  results['Race condition'] = { pass: raceCntFinal === 0 && raceGhosts.length === 0, items: raceCntFinal, ghosts: raceGhosts.length }

  // ═══════════════════════════════════════════════════════
  // 정리
  log('')
  log('▶ 정리...')
  for (const day of [...testDays, ...raceDays]) {
    await sb.from('note_item').delete().eq('day_id', day).eq('user_id', USER_ID)
    await sb.from('note_day').delete().eq('id', day).eq('user_id', USER_ID)
    await pcQuery(`DELETE FROM note_item WHERE day_id = '${day}'`)
    await pcQuery(`DELETE FROM note_day WHERE id = '${day}'`)
  }
  await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE '${prefix}%'`)
  await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE '${prefix2}%'`)
  await pcSync()

  // ── 결과 요약 ──
  const total = passed + failed
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║ 하드코어 테스트 결과                                        ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  for (const [name, v] of Object.entries(results)) {
    const icon = v.pass !== false ? '✅' : '❌'
    console.log(`║ ${icon} ${name}: ${JSON.stringify(v)}`.padEnd(62) + '║')
  }
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║ 합계: ${passed}/${total} 통과`.padEnd(62) + '║')
  console.log('╚══════════════════════════════════════════════════════════════╝')

  const fs = require('fs')
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ timestamp: new Date().toISOString(), results, passed, total }, null, 2))
  log(`결과 저장: ${RESULT_FILE}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('에러:', err); process.exit(1) })
