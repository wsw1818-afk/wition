/**
 * 달력 잔상 버그 정밀 테스트 — 4가지 시나리오
 *
 * A. 하나씩 삭제하다 마지막 1개 (핵심 버그 재현)
 * B. syncNoteDay 실패 시뮬레이션 (서버 note_day 잔존)
 * C. Realtime 이벤트 순서 역전
 * D. 대량 590개 + 마지막 10개 하나씩 삭제
 */
const { createClient } = require('@supabase/supabase-js')
const http = require('http')
const path = require('path')
require('dotenv').config()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const USER_ID = '848a51a4-d26c-4063-8e3a-c73cd548ce82'
const PC_PORT = 19876
const RESULT_FILE = path.join(__dirname, 'test_ghost_results.json')

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// ─── 유틸 ────────────────────────────────────────────────
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

/** 서버+PC 양쪽 정리 */
async function cleanup(dayIds, itemPrefix) {
  for (const day of dayIds) {
    await sb.from('note_item').delete().eq('day_id', day).eq('user_id', USER_ID)
    await sb.from('note_day').delete().eq('id', day).eq('user_id', USER_ID)
    await pcQuery(`DELETE FROM note_item WHERE day_id = '${day}'`)
    await pcQuery(`DELETE FROM note_day WHERE id = '${day}'`)
  }
  if (itemPrefix) {
    await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE '${itemPrefix}%'`)
  }
}

/** 서버에 note_day + note_items 생성 */
async function createItems(dayId, prefix, count, now) {
  await sb.from('note_day').upsert({
    id: dayId, user_id: USER_ID, mood: null,
    summary: `테스트 메모 #0`, note_count: count, has_notes: 1, updated_at: now
  }, { onConflict: 'id,user_id' })

  const items = []
  for (let i = 0; i < count; i++) {
    items.push({
      id: `${prefix}-${i}`, day_id: dayId, user_id: USER_ID,
      type: 'text', content: `테스트 메모 #${i}`,
      tags: '[]', pinned: 0, order_index: i, created_at: now + i, updated_at: now + i
    })
  }
  const { error } = await sb.from('note_item').insert(items)
  if (error) throw new Error(`INSERT 실패: ${error.message}`)
  return items
}

/** PC note_day 잔상 확인 */
async function checkGhost(dayId) {
  const r = await pcQuery(`SELECT id, note_count, has_notes, mood FROM note_day WHERE id = '${dayId}'`)
  if (!r.rows || r.rows.length === 0) return { exists: false, ghost: false }
  const day = r.rows[0]
  const isGhost = day.note_count === 0 && !day.mood
  return { exists: true, ghost: isGhost, ...day }
}

/** PC note_item 수 확인 */
async function pcItemCount(prefix) {
  const r = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE id LIKE '${prefix}%'`)
  return r.rows?.[0]?.cnt || 0
}

// ═══════════════════════════════════════════════════════════
async function testA() {
  log('')
  log('═══════════════════════════════════════════════════')
  log('▶ 테스트 A: 하나씩 삭제하다 마지막 1개 (핵심 버그)')
  log('═══════════════════════════════════════════════════')

  const DAY = '2099-10-01'
  const PREFIX = `ghost-a-${Date.now()}`
  const now = Date.now()

  await cleanup([DAY], PREFIX)
  const items = await createItems(DAY, PREFIX, 5, now)
  await pcSync()
  await sleep(2000)

  let pcCnt = await pcItemCount(PREFIX)
  assert(pcCnt === 5, `A-준비: PC에 5개 존재 (${pcCnt})`)

  // 하나씩 삭제 (5 → 4 → 3 → 2 → 1)
  for (let i = 0; i < 4; i++) {
    const item = items[i]
    const remaining = 5 - i - 1

    // 모바일 삭제 시뮬레이션: note_item DELETE + note_day UPDATE
    await sb.from('note_item').delete().eq('id', item.id).eq('user_id', USER_ID)
    await sb.from('note_day').update({
      note_count: remaining, has_notes: remaining > 0 ? 1 : 0,
      summary: remaining > 0 ? `테스트 메모 #${i + 1}` : null,
      updated_at: Date.now()
    }).eq('id', DAY).eq('user_id', USER_ID)

    await sleep(3000) // Realtime 수신 대기

    pcCnt = await pcItemCount(PREFIX)
    log(`  삭제 ${i + 1}/5: PC에 ${pcCnt}개 (기대: ${remaining})`)
  }

  // ★ 마지막 1개 삭제 — 여기가 핵심!
  log('  ★ 마지막 메모 삭제...')
  const lastItem = items[4]

  // 모바일: note_item DELETE
  await sb.from('note_item').delete().eq('id', lastItem.id).eq('user_id', USER_ID)
  // 모바일: syncNoteDay → note_count=0, !mood → note_day DELETE
  await sb.from('note_day').delete().eq('id', DAY).eq('user_id', USER_ID)

  // Realtime 수신 대기
  await sleep(5000)

  // 잔상 확인 (Realtime만으로)
  let ghost = await checkGhost(DAY)
  const rtResult = !ghost.exists || !ghost.ghost
  assert(!ghost.ghost, `A-Realtime: 잔상 없음 (exists=${ghost.exists}, ghost=${ghost.ghost})`)

  // fullSync 후 재확인
  await pcSync()
  await sleep(1000)
  ghost = await checkGhost(DAY)
  assert(!ghost.ghost, `A-fullSync: 잔상 없음 (exists=${ghost.exists}, ghost=${ghost.ghost})`)

  pcCnt = await pcItemCount(PREFIX)
  assert(pcCnt === 0, `A-최종: PC note_item 0개 (${pcCnt})`)

  await cleanup([DAY], PREFIX)
  results['A: 하나씩 삭제'] = { pass: !ghost.ghost && pcCnt === 0, rtClean: rtResult }
}

// ═══════════════════════════════════════════════════════════
async function testB() {
  log('')
  log('═══════════════════════════════════════════════════')
  log('▶ 테스트 B: syncNoteDay 실패 시뮬레이션')
  log('  (서버 note_day가 note_count>0 으로 남아있는 경우)')
  log('═══════════════════════════════════════════════════')

  const DAY = '2099-10-02'
  const PREFIX = `ghost-b-${Date.now()}`
  const now = Date.now()

  await cleanup([DAY], PREFIX)
  await createItems(DAY, PREFIX, 3, now)
  await pcSync()
  await sleep(2000)

  let pcCnt = await pcItemCount(PREFIX)
  assert(pcCnt === 3, `B-준비: PC에 3개 존재 (${pcCnt})`)

  // note_item만 삭제, note_day는 서버에 그대로 둠 (syncNoteDay 실패)
  for (let i = 0; i < 3; i++) {
    await sb.from('note_item').delete().eq('id', `${PREFIX}-${i}`).eq('user_id', USER_ID)
  }
  // 의도적으로 note_day를 삭제하지 않음! (stale note_day 시뮬레이션)
  // note_count도 3 그대로 남아있음

  log('  서버: note_item 3개 삭제, note_day는 의도적으로 유지 (stale)')

  // Realtime으로 note_item DELETE는 감지됨
  await sleep(5000)

  // Realtime 후 확인
  pcCnt = await pcItemCount(PREFIX)
  log(`  Realtime 후 PC note_item: ${pcCnt}개`)

  let ghost = await checkGhost(DAY)
  log(`  Realtime 후 note_day: exists=${ghost.exists}, note_count=${ghost.note_count}, ghost=${ghost.ghost}`)

  // fullSync 실행 (recalcAllDayCounts가 stale note_day를 잡아내야 함)
  await pcSync()
  await sleep(1000)

  ghost = await checkGhost(DAY)
  pcCnt = await pcItemCount(PREFIX)
  log(`  fullSync 후 note_day: exists=${ghost.exists}, ghost=${ghost.ghost}`)
  assert(!ghost.ghost, `B-fullSync: 잔상 없음 (exists=${ghost.exists}, ghost=${ghost.ghost})`)
  assert(pcCnt === 0, `B-최종: PC note_item 0개 (${pcCnt})`)

  // 서버 note_day도 정리 (push가 올바르게 처리했는지)
  await cleanup([DAY], PREFIX)
  results['B: syncNoteDay 실패'] = { pass: !ghost.ghost && pcCnt === 0 }
}

// ═══════════════════════════════════════════════════════════
async function testC() {
  log('')
  log('═══════════════════════════════════════════════════')
  log('▶ 테스트 C: Realtime 이벤트 순서 역전 시뮬레이션')
  log('  (note_day UPDATE가 note_item DELETE보다 먼저 도착)')
  log('═══════════════════════════════════════════════════')

  const DAY = '2099-10-03'
  const PREFIX = `ghost-c-${Date.now()}`
  const now = Date.now()

  await cleanup([DAY], PREFIX)
  await createItems(DAY, PREFIX, 1, now)
  await pcSync()
  await sleep(2000)

  let pcCnt = await pcItemCount(PREFIX)
  assert(pcCnt === 1, `C-준비: PC에 1개 존재 (${pcCnt})`)

  // 순서 역전 시뮬레이션:
  // 1) 먼저 note_day를 note_count=0으로 UPDATE (실제로는 DELETE 후 도착해야 하지만 역전)
  log('  순서 역전: note_day UPDATE(count=0) 먼저...')
  await sb.from('note_day').update({
    note_count: 0, has_notes: 0, summary: null, updated_at: Date.now()
  }).eq('id', DAY).eq('user_id', USER_ID)

  await sleep(2000) // Realtime이 이것을 먼저 받음

  // 2) 그 다음 note_item DELETE
  log('  순서 역전: note_item DELETE 후...')
  await sb.from('note_item').delete().eq('id', `${PREFIX}-0`).eq('user_id', USER_ID)

  await sleep(2000)

  // 3) 마지막으로 note_day DELETE (모바일의 syncNoteDay)
  await sb.from('note_day').delete().eq('id', DAY).eq('user_id', USER_ID)

  await sleep(5000)

  // 잔상 확인
  let ghost = await checkGhost(DAY)
  log(`  Realtime 후: exists=${ghost.exists}, ghost=${ghost.ghost}`)
  assert(!ghost.ghost, `C-Realtime: 순서 역전 후 잔상 없음 (exists=${ghost.exists}, ghost=${ghost.ghost})`)

  // fullSync 확인
  await pcSync()
  await sleep(1000)
  ghost = await checkGhost(DAY)
  pcCnt = await pcItemCount(PREFIX)
  assert(!ghost.ghost, `C-fullSync: 잔상 없음 (exists=${ghost.exists}, ghost=${ghost.ghost})`)
  assert(pcCnt === 0, `C-최종: PC note_item 0개 (${pcCnt})`)

  await cleanup([DAY], PREFIX)
  results['C: 순서 역전'] = { pass: !ghost.ghost && pcCnt === 0 }
}

// ═══════════════════════════════════════════════════════════
async function testD() {
  log('')
  log('═══════════════════════════════════════════════════')
  log('▶ 테스트 D: 대량 590개 + 마지막 10개 하나씩 삭제')
  log('═══════════════════════════════════════════════════')

  const DAYS = []
  for (let d = 1; d <= 20; d++) DAYS.push(`2099-11-${String(d).padStart(2, '0')}`)
  const PREFIX = `ghost-d-${Date.now()}`
  const now = Date.now()
  const TOTAL = 590

  await cleanup(DAYS, PREFIX)

  // note_day 생성
  for (const day of DAYS) {
    await sb.from('note_day').upsert({
      id: day, user_id: USER_ID, mood: null,
      summary: null, note_count: 0, has_notes: 0, updated_at: now
    }, { onConflict: 'id,user_id' })
  }

  // 590개 INSERT (배치)
  const allItems = []
  for (let i = 0; i < TOTAL; i++) {
    allItems.push({
      id: `${PREFIX}-${i}`, day_id: DAYS[i % DAYS.length], user_id: USER_ID,
      type: 'text', content: `대량 테스트 #${i}`,
      tags: '[]', pinned: 0, order_index: Math.floor(i / DAYS.length),
      created_at: now + i, updated_at: now + i
    })
  }
  for (let s = 0; s < allItems.length; s += 50) {
    await sb.from('note_item').insert(allItems.slice(s, s + 50))
  }

  // note_day count 업데이트
  for (const day of DAYS) {
    const cnt = allItems.filter(i => i.day_id === day).length
    await sb.from('note_day').update({
      note_count: cnt, has_notes: 1,
      summary: `대량 테스트 #0`, updated_at: Date.now()
    }).eq('id', day).eq('user_id', USER_ID)
  }

  log(`  ${TOTAL}개 INSERT 완료`)
  await pcSync()
  await sleep(3000)
  await pcSync()

  let pcCnt = await pcItemCount(PREFIX)
  assert(pcCnt >= TOTAL * 0.95, `D-준비: PC에 ${pcCnt}/${TOTAL}개 반영`)

  // 580개 일괄 삭제
  const bulkItems = allItems.slice(0, 580)
  for (let s = 0; s < bulkItems.length; s += 50) {
    const ids = bulkItems.slice(s, s + 50).map(i => i.id)
    await sb.from('note_item').delete().in('id', ids).eq('user_id', USER_ID)
  }
  log(`  580개 일괄 삭제 완료, 10개 남음`)

  // note_day count 업데이트 (남은 아이템 기준)
  for (const day of DAYS) {
    const remaining = allItems.filter(i => i.day_id === day && parseInt(i.id.split('-').pop()) >= 580)
    if (remaining.length > 0) {
      await sb.from('note_day').update({
        note_count: remaining.length, has_notes: 1, updated_at: Date.now()
      }).eq('id', day).eq('user_id', USER_ID)
    } else {
      // 아이템 없는 날 → note_day 삭제
      await sb.from('note_day').delete().eq('id', day).eq('user_id', USER_ID)
    }
  }

  await sleep(5000)

  // ★ 마지막 10개 하나씩 삭제
  log('  ★ 마지막 10개 하나씩 삭제...')
  const lastItems = allItems.slice(580)
  for (let i = 0; i < lastItems.length; i++) {
    const item = lastItems[i]
    await sb.from('note_item').delete().eq('id', item.id).eq('user_id', USER_ID)

    // 해당 day의 남은 아이템 수 확인
    const { data: remaining } = await sb.from('note_item')
      .select('id').eq('day_id', item.day_id).eq('user_id', USER_ID)
      .like('id', `${PREFIX}%`)
    const cnt = (remaining || []).length

    if (cnt === 0) {
      // 마지막 아이템 → note_day DELETE
      await sb.from('note_day').delete().eq('id', item.day_id).eq('user_id', USER_ID)
    } else {
      await sb.from('note_day').update({
        note_count: cnt, has_notes: 1, updated_at: Date.now()
      }).eq('id', item.day_id).eq('user_id', USER_ID)
    }

    if (i % 3 === 0) log(`  개별 삭제 ${i + 1}/10 (day=${item.day_id}, 남음=${cnt})`)
    await sleep(1000)
  }

  await sleep(5000)

  // Realtime 확인
  pcCnt = await pcItemCount(PREFIX)
  log(`  Realtime 후 PC note_item: ${pcCnt}개`)

  const pcDaysRT = await pcQuery(`SELECT id, note_count, has_notes, mood FROM note_day WHERE id LIKE '2099-11-%'`)
  const ghostsRT = (pcDaysRT.rows || []).filter(d => (d.note_count === 0 || d.note_count === '0') && !d.mood)
  log(`  Realtime 후 잔상 note_day: ${ghostsRT.length}개`)
  if (ghostsRT.length > 0) log(`  잔상: ${ghostsRT.map(d => d.id).join(', ')}`)

  // fullSync
  await pcSync()
  await sleep(1000)

  pcCnt = await pcItemCount(PREFIX)
  const pcDaysFinal = await pcQuery(`SELECT id, note_count, has_notes, mood FROM note_day WHERE id LIKE '2099-11-%'`)
  const ghostsFinal = (pcDaysFinal.rows || []).filter(d => (d.note_count === 0 || d.note_count === '0') && !d.mood)

  assert(pcCnt === 0, `D-최종: PC note_item 0개 (${pcCnt})`)
  assert(ghostsFinal.length === 0, `D-최종: 잔상 note_day 0개 (${ghostsFinal.length})`)

  await cleanup(DAYS, PREFIX)
  results['D: 590개+개별삭제'] = { pass: pcCnt === 0 && ghostsFinal.length === 0, ghosts: ghostsFinal.length, rtGhosts: ghostsRT.length }
}

// ═══════════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║   달력 잔상 버그 정밀 테스트 (4가지 시나리오)               ║')
  console.log('╚══════════════════════════════════════════════════════════════╝\n')

  try {
    const ping = await pcRequest('/ping')
    assert(ping.ok, '테스트 서버 연결 OK')
  } catch {
    console.error('❌ 테스트 서버(포트 19876)에 연결할 수 없습니다')
    process.exit(1)
  }

  await testA()
  await testB()
  await testC()
  await testD()

  // ── 결과 요약 ──
  const total = passed + failed
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║ 잔상 버그 정밀 테스트 결과                                  ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  for (const [name, v] of Object.entries(results)) {
    const icon = v.pass ? '✅' : '❌'
    console.log(`║ ${icon} ${name}`.padEnd(62) + '║')
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
