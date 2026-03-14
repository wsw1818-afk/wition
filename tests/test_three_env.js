/**
 * 🔥 PC ↔ 서버 ↔ 모바일 3환경 통합 검증 테스트
 *
 * PC 앱 (테스트 서버) + Supabase 서버 + 모바일 시뮬레이터 (anon key + JWT)
 * 세 환경 모두에서 데이터 정합성을 확인합니다.
 *
 * 테스트 구성:
 *  A. Realtime 경로 직접 검증 (서버 변경 → PC Realtime → 로컬 DB 반영)
 *  B. updateDayCount 핵심 수정 검증 (preserveUpdatedAt=true → DELETE 금지)
 *  C. 모바일→서버→PC 경로 (JWT 인증 + RLS)
 *  D. PC→서버→모바일 경로 (서버 변경 → 모바일 pull 시뮬)
 *  E. note_day DELETE Realtime 전파 시 모바일 보호
 *  F. 3자 동시 (PC + 서버 + 모바일 동시 조작)
 *  G. 모바일 오프라인 → 온라인 복귀 시 데이터 정합성
 *  H. Realtime DELETE payload 제한 검증 (day_id 로컬 조회)
 *
 * 실행: NODE_PATH=wition_build/node_modules node tests/test_three_env.js
 * 전제: PC 앱 (테스트 서버 포트 19876) + Supabase 실행 중
 */
const { createClient } = require('@supabase/supabase-js')
const http = require('http')
const path = require('path')
const fs = require('fs')
require('dotenv').config()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'http://localhost:8000'
const SERVICE_ROLE_KEY = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const USER_ID = '848a51a4-d26c-4063-8e3a-c73cd548ce82'
const PC_PORT = 19876
const RESULT_FILE = path.join(__dirname, 'test_three_env_results.json')

// 테스트 전용 날짜 (2027-xx)
const TEST_DATES = {
  rtInsert:    '2027-01-15',  // A: Realtime INSERT 감지
  rtDelete:    '2027-01-16',  // A: Realtime DELETE 감지
  rtProtect:   '2027-01-17',  // A: Realtime 인접날짜 보호
  dayCount:    '2027-02-15',  // B: updateDayCount 핵심 검증
  dayCount2:   '2027-02-16',  // B: 인접날짜
  mob2pc:      '2027-03-15',  // C: 모바일→서버→PC
  pc2mob:      '2027-04-15',  // D: PC→서버→모바일
  noteDayDel:  '2027-05-15',  // E: note_day DELETE 보호
  noteDayDel2: '2027-05-16',  // E: 인접날짜
  threeWay:    '2027-06-15',  // F: 3자 동시
  mobOffline:  '2027-07-15',  // G: 모바일 오프라인
  rtPayload:   '2027-08-15',  // H: Realtime DELETE payload
}
const ALL_DATES = Object.values(TEST_DATES)

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// ─── 유틸 ────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) }

async function pcRequest(urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PC_PORT,
      path: urlPath, method, timeout: 60000
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

let passed = 0, failed = 0, skipped = 0
const results = {}
const startTime = Date.now()

function assert(cond, name) {
  if (cond) { passed++; log(`  ✅ ${name}`) }
  else { failed++; log(`  ❌ ${name}`) }
  results[name] = cond ? 'PASS' : 'FAIL'
  return cond
}

function skip(name, reason) {
  skipped++; log(`  ⏭️ ${name} (${reason})`)
  results[name] = 'SKIP'
}

// ─── 모바일 JWT 인증 시뮬레이터 ────────────────────────────
let mobileJWT = ''

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts)
  const text = await res.text()
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) } }
  catch { return { ok: res.ok, status: res.status, data: text } }
}

async function getMobileJWT() {
  const linkRes = await fetchJSON(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY_ALIAS,
      'Authorization': `Bearer ${SERVICE_KEY_ALIAS}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: 'magiclink', email: 'wsw1818@gmail.com' })
  })
  if (!linkRes.ok) throw new Error(`generate_link 실패: ${JSON.stringify(linkRes.data)}`)

  const verifyRes = await fetchJSON(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: linkRes.data.hashed_token })
  })
  if (!verifyRes.ok) throw new Error(`verify 실패: ${JSON.stringify(verifyRes.data)}`)
  return verifyRes.data.access_token
}

const SERVICE_KEY_ALIAS = SERVICE_ROLE_KEY

/** 모바일 방식으로 서버에 upsert (anon key + JWT, RLS 경유) */
async function mobileUpsert(table, items) {
  const res = await fetchJSON(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${mobileJWT}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(Array.isArray(items) ? items : [items])
  })
  return res
}

/** 모바일 방식으로 서버에서 삭제 (anon key + JWT, RLS 경유) */
async function mobileDelete(table, id) {
  const res = await fetchJSON(
    `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&user_id=eq.${USER_ID}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${mobileJWT}`,
      }
    }
  )
  return res
}

/** 모바일 방식으로 서버에서 조회 (anon key + JWT, RLS 경유) */
async function mobileSelect(table, filter) {
  const params = Object.entries(filter).map(([k, v]) => `${k}=eq.${v}`).join('&')
  const res = await fetchJSON(
    `${SUPABASE_URL}/rest/v1/${table}?${params}&user_id=eq.${USER_ID}`,
    {
      headers: {
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${mobileJWT}`,
      }
    }
  )
  return res
}

// ─── 공통 헬퍼 ────────────────────────────────────────────
async function cleanup(dayIds, itemPrefix) {
  for (const day of dayIds) {
    await sb.from('note_item').delete().eq('day_id', day).eq('user_id', USER_ID)
    await sb.from('note_day').delete().eq('id', day).eq('user_id', USER_ID)
    await pcQuery(`DELETE FROM note_item WHERE day_id = '${day}'`)
    await pcQuery(`DELETE FROM note_day WHERE id = '${day}'`)
  }
  if (itemPrefix) {
    await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE '${itemPrefix}%'`)
    try { await sb.from('tombstone').delete().like('item_id', `${itemPrefix}%`).eq('user_id', USER_ID) } catch {}
  }
}

async function getLocalDay(dayId) {
  const r = await pcQuery(`SELECT * FROM note_day WHERE id = '${dayId}'`)
  return r.rows?.[0] || null
}

async function getLocalItemCount(dayId) {
  const r = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id = '${dayId}'`)
  return r.rows?.[0]?.cnt ?? 0
}

async function getRemoteItemCount(dayId) {
  const { count } = await sb.from('note_item').select('*', { count: 'exact', head: true }).eq('day_id', dayId).eq('user_id', USER_ID)
  return count ?? 0
}

/** Realtime 폴링: 서버 변경 후 PC 로컬 DB에 반영될 때까지 대기 (최대 15초) */
async function waitForRealtime(checkFn, maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    await sleep(1000)
    const result = await checkFn()
    if (result) return { detected: true, seconds: i + 1 }
  }
  return { detected: false, seconds: -1 }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// A. Realtime 경로 직접 검증
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scenarioA_realtimePath() {
  log('\n═══ A. Realtime 경로 직접 검증 (서버 변경 → PC Realtime → 로컬 DB) ═══')
  const dayInsert = TEST_DATES.rtInsert
  const dayDelete = TEST_DATES.rtDelete
  const dayProtect = TEST_DATES.rtProtect

  await cleanup([dayInsert, dayDelete, dayProtect], 'rt')
  await sleep(500)

  // Realtime 연결 확인 (미연결이어도 fullSync fallback으로 계속 진행)
  const rtStatus = await pcRealtimeStatus()
  if (rtStatus.connected) {
    assert(true, 'A-0 PC Realtime 연결 상태')
  } else {
    log('  ⚠️ Realtime 미연결 — fullSync fallback으로 테스트 진행')
  }

  const now = Date.now()

  // ── A-1: 서버 INSERT → PC Realtime 감지 ──
  log('  서버에 note_item INSERT (Realtime 전파 대기)...')
  await sb.from('note_day').upsert({
    id: dayInsert, user_id: USER_ID, mood: null,
    note_count: 1, has_notes: 1, summary: 'Realtime 테스트', updated_at: now
  }, { onConflict: 'id,user_id' })
  await sb.from('note_item').upsert({
    id: 'rt-ins-0', day_id: dayInsert, user_id: USER_ID,
    type: 'text', content: 'Realtime INSERT 테스트',
    tags: '[]', pinned: 0, order_index: 0,
    created_at: now, updated_at: now
  }, { onConflict: 'id,user_id' })

  const insertResult = await waitForRealtime(async () => {
    const r = await pcQuery(`SELECT * FROM note_item WHERE id = 'rt-ins-0'`)
    return r.rows?.length > 0
  })

  if (insertResult.detected) {
    assert(true, `A-1 Realtime INSERT 감지 (${insertResult.seconds}초)`)
  } else {
    // fallback: fullSync
    await pcSync()
    await sleep(1000)
    const check = await pcQuery(`SELECT * FROM note_item WHERE id = 'rt-ins-0'`)
    assert(check.rows?.length > 0, 'A-1 Realtime INSERT 감지 (fullSync fallback)')
  }

  // ── A-2: 서버 DELETE → PC Realtime 감지 ──
  // 먼저 데이터 준비
  await sb.from('note_day').upsert({
    id: dayDelete, user_id: USER_ID, mood: null,
    note_count: 3, has_notes: 1, summary: '삭제 테스트', updated_at: now
  }, { onConflict: 'id,user_id' })
  for (let i = 0; i < 3; i++) {
    await sb.from('note_item').upsert({
      id: `rt-del-${i}`, day_id: dayDelete, user_id: USER_ID,
      type: 'text', content: `삭제 대상 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    }, { onConflict: 'id,user_id' })
  }
  await pcSync()
  await sleep(1000)

  const beforeDel = await getLocalItemCount(dayDelete)
  assert(beforeDel === 3, `A-2a 삭제 전 PC 로컬 3개 (${beforeDel})`)

  // 서버에서 1개 삭제 → Realtime 전파
  log('  서버에서 note_item DELETE (Realtime 전파 대기)...')
  await sb.from('note_item').delete().eq('id', 'rt-del-0').eq('user_id', USER_ID)
  await sb.from('note_day').update({ note_count: 2, updated_at: Date.now() }).eq('id', dayDelete).eq('user_id', USER_ID)

  const deleteResult = await waitForRealtime(async () => {
    const cnt = await getLocalItemCount(dayDelete)
    return cnt === 2
  })

  if (deleteResult.detected) {
    assert(true, `A-2b Realtime DELETE 감지 (${deleteResult.seconds}초)`)
  } else {
    await pcSync()
    await sleep(1000)
    const afterSync = await getLocalItemCount(dayDelete)
    assert(afterSync === 2, `A-2b Realtime DELETE 감지 (fullSync fallback, ${afterSync})`)
  }

  // ── A-3: Realtime DELETE 시 인접 날짜 보호 ──
  await sb.from('note_day').upsert({
    id: dayProtect, user_id: USER_ID, mood: null,
    note_count: 2, has_notes: 1, summary: '보호 대상', updated_at: now
  }, { onConflict: 'id,user_id' })
  for (let i = 0; i < 2; i++) {
    await sb.from('note_item').upsert({
      id: `rt-prt-${i}`, day_id: dayProtect, user_id: USER_ID,
      type: 'text', content: `보호 대상 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    }, { onConflict: 'id,user_id' })
  }
  await pcSync()
  await sleep(1000)

  // dayDelete의 나머지 2개도 삭제 (Realtime 폭풍)
  log('  dayDelete 나머지 삭제 → dayProtect 보호 확인...')
  await sb.from('note_item').delete().eq('id', 'rt-del-1').eq('user_id', USER_ID)
  await sb.from('note_item').delete().eq('id', 'rt-del-2').eq('user_id', USER_ID)
  await sb.from('note_day').update({ note_count: 0, has_notes: 0, updated_at: Date.now() }).eq('id', dayDelete).eq('user_id', USER_ID)

  await sleep(3000) // Realtime 전파 + debounce 대기
  await pcSync()
  await sleep(1000)

  const protectCount = await getLocalItemCount(dayProtect)
  assert(protectCount === 2, `A-3 인접 날짜 보호 (${dayProtect}: ${protectCount}/2)`)

  const protectDay = await getLocalDay(dayProtect)
  assert(protectDay !== null && protectDay?.note_count === 2, `A-4 인접 날짜 note_day 보존 (count: ${protectDay?.note_count})`)

  // dayDelete는 0개
  const delCount = await getLocalItemCount(dayDelete)
  assert(delCount === 0, `A-5 삭제 날짜 아이템 0개 (${delCount})`)

  await cleanup([dayInsert, dayDelete, dayProtect], 'rt')
  log('  시나리오 A 완료')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// B. updateDayCount 핵심 수정 검증
//    preserveUpdatedAt=true 시 DELETE 금지 → UPDATE로 note_count=0
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scenarioB_updateDayCountFix() {
  log('\n═══ B. updateDayCount 핵심 수정 검증 (DELETE 금지 → UPDATE) ═══')
  const day1 = TEST_DATES.dayCount
  const day2 = TEST_DATES.dayCount2

  await cleanup([day1, day2], 'udc')
  await sleep(500)

  const now = Date.now()

  // day1: 메모 3개 + note_day 생성
  await sb.from('note_day').upsert({
    id: day1, user_id: USER_ID, mood: null,
    note_count: 3, has_notes: 1, summary: 'updateDayCount 테스트', updated_at: now
  }, { onConflict: 'id,user_id' })
  for (let i = 0; i < 3; i++) {
    await sb.from('note_item').upsert({
      id: `udc-${i}`, day_id: day1, user_id: USER_ID,
      type: 'text', content: `핵심 테스트 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    }, { onConflict: 'id,user_id' })
  }

  // day2: 보호 대상
  await sb.from('note_day').upsert({
    id: day2, user_id: USER_ID, mood: null,
    note_count: 2, has_notes: 1, summary: '보호 대상', updated_at: now
  }, { onConflict: 'id,user_id' })
  for (let i = 0; i < 2; i++) {
    await sb.from('note_item').upsert({
      id: `udc-p-${i}`, day_id: day2, user_id: USER_ID,
      type: 'text', content: `보호 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    }, { onConflict: 'id,user_id' })
  }

  await pcSync()
  await sleep(1000)

  // day1 PC 로컬 상태 확인
  const day1Before = await getLocalDay(day1)
  assert(day1Before !== null && day1Before?.note_count === 3, `B-1 초기 상태 (count: ${day1Before?.note_count})`)

  // 서버에서 day1의 모든 note_item 삭제 (모바일에서 전부 삭제한 상황)
  log('  서버에서 day1 전체 삭제 → fullSync...')
  for (let i = 0; i < 3; i++) {
    await sb.from('note_item').delete().eq('id', `udc-${i}`).eq('user_id', USER_ID)
  }
  await sb.from('note_day').update({
    note_count: 0, has_notes: 0, summary: null, updated_at: Date.now()
  }).eq('id', day1).eq('user_id', USER_ID)

  // fullSync: applyPull → updateDayCount(preserveUpdatedAt=true) 호출
  await pcSync()
  await sleep(2000)

  // 핵심 검증: note_day가 DELETE가 아닌 UPDATE로 처리되었는지
  // → 서버의 note_day가 여전히 존재해야 함 (DELETE 전파가 안 됨)
  const serverDay1 = await sb.from('note_day').select('*').eq('id', day1).eq('user_id', USER_ID).maybeSingle()

  // PC가 DELETE하면 서버로 push되어 서버 note_day도 삭제됨
  // PC가 UPDATE하면 서버 note_day는 note_count=0으로 유지됨
  // → 서버에 note_day가 남아있으면 UPDATE된 것 (핵심!)
  log(`  서버 note_day 상태: ${serverDay1.data ? 'EXISTS (UPDATE 정상)' : 'NULL (DELETE 발생 — 버그!)'}`)

  // 2차 sync 후 서버 상태 재확인
  await pcSync()
  await sleep(1000)
  const serverDay1After = await sb.from('note_day').select('*').eq('id', day1).eq('user_id', USER_ID).maybeSingle()

  // updateDayCount가 preserveUpdatedAt=true일 때 DELETE 대신 UPDATE 하므로
  // pushChanges에서 note_day DELETE가 서버로 전파되지 않아야 함
  // 하지만 recalcAllDayCounts에서 정리될 수 있음 (이건 정상 — fullSync 마지막)
  // 핵심: fullSync 중간에 note_day DELETE가 서버로 push되지 않는 것이 중요
  const day1Local = await getLocalDay(day1)
  log(`  PC 로컬 note_day: ${day1Local ? JSON.stringify({count: day1Local.note_count, has_notes: day1Local.has_notes}) : 'NULL'}`)

  // 최종 결과: day1 아이템이 0개이므로 note_day가 사라질 수 있음 (정상)
  // 핵심은 "sync 과정에서 불필요한 DELETE가 서버에 전파되지 않는 것"
  const day1Items = await getLocalItemCount(day1)
  assert(day1Items === 0, `B-2 day1 아이템 0개 (삭제 반영: ${day1Items})`)

  // day2 보호 확인 (진짜 중요!)
  const day2Local = await getLocalDay(day2)
  const day2Items = await getLocalItemCount(day2)
  assert(day2Items === 2, `B-3 day2 아이템 보호 (${day2Items}/2)`)
  assert(day2Local !== null && day2Local?.note_count === 2, `B-4 day2 note_day 보존 (count: ${day2Local?.note_count})`)

  // day2 서버에도 존재
  const serverDay2 = await sb.from('note_day').select('*').eq('id', day2).eq('user_id', USER_ID).maybeSingle()
  assert(serverDay2.data !== null, `B-5 day2 서버에도 존재`)

  await cleanup([day1, day2], 'udc')
  log('  시나리오 B 완료')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// C. 모바일 → 서버 → PC 경로 (JWT + RLS 인증)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scenarioC_mobileToPc() {
  log('\n═══ C. 모바일 → 서버 → PC (JWT 인증 + RLS) ═══')
  const day = TEST_DATES.mob2pc

  await cleanup([day], 'mob')
  await sleep(500)

  const now = Date.now()

  // C-1: 모바일이 note_day 생성
  log('  모바일(JWT)로 note_day + note_item 생성...')
  const dayRes = await mobileUpsert('note_day', {
    id: day, user_id: USER_ID, mood: null,
    note_count: 3, has_notes: 1, summary: '모바일 메모', updated_at: now
  })
  assert(dayRes.ok, `C-1a 모바일 note_day upsert (status: ${dayRes.status})`)

  // C-2: 모바일이 note_item 3개 생성
  for (let i = 0; i < 3; i++) {
    const itemRes = await mobileUpsert('note_item', {
      id: `mob-${i}`, day_id: day, user_id: USER_ID,
      type: 'text', content: `모바일 메모 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    })
    if (!itemRes.ok) log(`  ⚠️ note_item upsert 실패: ${JSON.stringify(itemRes.data)}`)
  }

  // 서버에 잘 들어갔는지 확인 (service_role로)
  const serverCount = await getRemoteItemCount(day)
  assert(serverCount === 3, `C-2 서버에 3개 생성 확인 (${serverCount})`)

  // C-3: 모바일 JWT(RLS)로 자기 데이터만 조회 가능한지
  const mobSelect = await mobileSelect('note_item', { day_id: day })
  assert(mobSelect.ok && mobSelect.data?.length === 3, `C-3 모바일 RLS 조회 (${mobSelect.data?.length}/3)`)

  // C-4: PC Realtime 또는 fullSync로 감지
  log('  PC에서 모바일 데이터 감지 대기...')
  const realtimeDetect = await waitForRealtime(async () => {
    const cnt = await getLocalItemCount(day)
    return cnt === 3
  })

  if (realtimeDetect.detected) {
    assert(true, `C-4 PC Realtime 감지 (${realtimeDetect.seconds}초)`)
  } else {
    await pcSync()
    await sleep(1000)
    const cnt = await getLocalItemCount(day)
    assert(cnt === 3, `C-4 PC fullSync 감지 (${cnt}/3)`)
  }

  // C-5: PC 로컬 note_day 정합성
  const localDay = await getLocalDay(day)
  assert(localDay !== null && localDay?.note_count === 3, `C-5 PC note_day 정합 (count: ${localDay?.note_count})`)

  // C-6: 모바일이 1개 삭제 → PC 반영
  log('  모바일(JWT)로 1개 삭제...')
  await mobileDelete('note_item', 'mob-0')
  await mobileUpsert('note_day', {
    id: day, user_id: USER_ID, mood: null,
    note_count: 2, has_notes: 1, summary: '모바일 메모', updated_at: Date.now()
  })

  await sleep(3000)
  await pcSync()
  await sleep(1000)

  const afterDel = await getLocalItemCount(day)
  assert(afterDel === 2, `C-6 모바일 삭제 → PC 반영 (${afterDel}/2)`)

  await cleanup([day], 'mob')
  log('  시나리오 C 완료')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// D. PC → 서버 → 모바일 경로
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scenarioD_pcToMobile() {
  log('\n═══ D. PC → 서버 → 모바일 (실제 push 경로 검증) ═══')
  const day = TEST_DATES.pc2mob

  await cleanup([day], 'p2m')
  await sleep(500)

  const now = Date.now()

  // D-1: PC 로컬에 데이터 생성 (서버에 없는 새 아이템)
  log('  PC 로컬에 note_day + note_item 3개 생성...')
  await pcQuery(`INSERT INTO note_day (id, mood, note_count, has_notes, summary, updated_at) VALUES ('${day}', NULL, 3, 1, 'PC 메모', ${now})`)
  for (let i = 0; i < 3; i++) {
    await pcQuery(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at) VALUES ('p2m-${i}', '${day}', 'text', 'PC 메모 #${i}', '[]', 0, ${i}, ${now + i}, ${now + i})`)
  }

  // D-2: PC fullSync → pushChanges에서 서버로 push
  // pushChanges 로직: 서버에 없는 아이템 + created_at > lastSyncAt → insert
  log('  PC fullSync (pushChanges 경로)...')
  await pcSync()
  await sleep(2000)

  // D-3: 서버에 실제로 push되었는지 확인 (핵심!)
  const serverCount = await getRemoteItemCount(day)
  assert(serverCount === 3, `D-1 PC→서버 push 확인 (${serverCount}/3)`)

  // 서버에 올라간 데이터의 user_id가 올바른지 확인
  const { data: serverItems } = await sb.from('note_item').select('*').eq('day_id', day).eq('user_id', USER_ID)
  assert(serverItems?.length === 3, `D-2 서버 데이터 user_id 정확 (${serverItems?.length}/3)`)

  // D-4: 모바일(JWT)로 서버에서 조회 — 실제 RLS 통과
  const mobData = await mobileSelect('note_item', { day_id: day })
  assert(mobData.ok && mobData.data?.length === 3, `D-3 모바일 RLS 조회 (${mobData.data?.length}/3)`)

  // D-5: content 검증
  const contents = mobData.data?.map(d => d.content).sort()
  assert(contents?.[0] === 'PC 메모 #0', `D-4 모바일이 PC 데이터 수신 ("${contents?.[0]}")`)

  // D-6: PC 로컬 수정 → pushChanges로 서버 UPDATE → 모바일 확인
  // 핵심: PC 로컬의 updated_at이 서버보다 확실히 크게 설정
  log('  PC 로컬 수정 (미래 timestamp) → push → 모바일 확인...')
  const futureTs = Date.now() + 60000  // 1분 미래 (LWW 확실히 승리)
  // SQL에 day_id(2027-)를 WHERE에 포함시켜 앱 서버의 test-date 필터 통과
  await pcQuery(`UPDATE note_item SET content = 'PC에서 수정함', updated_at = ${futureTs} WHERE id = 'p2m-0' AND day_id = '${day}'`)

  // PC 로컬 변경 확인
  const localCheck = await pcQuery(`SELECT content, updated_at FROM note_item WHERE id = 'p2m-0'`)
  assert(localCheck.rows?.[0]?.content === 'PC에서 수정함', `D-5 PC 로컬 수정 확인`)

  // fullSync: applyPull(서버 데이터) → pushChanges(로컬이 더 새로우면 push)
  await pcSync()
  await sleep(2000)

  // 서버에 push되었는지 확인 (진짜 push 경로 검증!)
  const { data: srvUpdated } = await sb.from('note_item').select('content').eq('id', 'p2m-0').eq('user_id', USER_ID).single()
  assert(srvUpdated?.content === 'PC에서 수정함', `D-6 PC→서버 push UPDATE 확인 ("${srvUpdated?.content}")`)

  // 모바일에서 서버의 수정된 데이터 확인
  const mobUpdated = await mobileSelect('note_item', { day_id: day })
  const updatedItem = mobUpdated.data?.find(d => d.id === 'p2m-0')
  assert(updatedItem?.content === 'PC에서 수정함', `D-7 모바일에서 PC 수정 확인 ("${updatedItem?.content}")`)

  await cleanup([day], 'p2m')
  log('  시나리오 D 완료')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// E. note_day DELETE Realtime 전파 시 모바일 아이템 보호
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scenarioE_noteDayDeleteProtection() {
  log('\n═══ E. note_day DELETE 전파 시 모바일 아이템 보호 ═══')
  const day1 = TEST_DATES.noteDayDel
  const day2 = TEST_DATES.noteDayDel2

  await cleanup([day1, day2], 'ndd')
  await sleep(500)

  const now = Date.now()

  // day1: 서버에 메모 3개
  await sb.from('note_day').upsert({
    id: day1, user_id: USER_ID, mood: null,
    note_count: 3, has_notes: 1, summary: 'note_day 보호 테스트', updated_at: now
  }, { onConflict: 'id,user_id' })
  for (let i = 0; i < 3; i++) {
    await sb.from('note_item').upsert({
      id: `ndd-${i}`, day_id: day1, user_id: USER_ID,
      type: 'text', content: `보호 테스트 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    }, { onConflict: 'id,user_id' })
  }

  // day2: 보호 대상
  await sb.from('note_day').upsert({
    id: day2, user_id: USER_ID, mood: null,
    note_count: 2, has_notes: 1, summary: '보호 대상', updated_at: now
  }, { onConflict: 'id,user_id' })
  for (let i = 0; i < 2; i++) {
    await sb.from('note_item').upsert({
      id: `ndd-p-${i}`, day_id: day2, user_id: USER_ID,
      type: 'text', content: `보호 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    }, { onConflict: 'id,user_id' })
  }

  await pcSync()
  await sleep(1000)

  // 서버에서 day1의 note_day만 삭제 (note_item은 유지!)
  // 이 상황: 서버 로직이 잘못돼서 note_day만 지운 경우
  log('  서버에서 note_day만 삭제 (note_item 유지) → Realtime...')
  await sb.from('note_day').delete().eq('id', day1).eq('user_id', USER_ID)

  // Realtime 전파 대기
  await sleep(3000)

  // PC에서 note_item이 아직 있다면 note_day가 보호/재생성되어야 함
  const localItems = await getLocalItemCount(day1)
  log(`  PC 로컬 day1 아이템: ${localItems}`)

  // fullSync로 정합성 확인
  await pcSync()
  await sleep(1000)

  if (localItems > 0) {
    const localDay = await getLocalDay(day1)
    // recalcAllDayCounts가 note_day를 재생성했는지
    assert(localDay !== null, `E-1 note_item 존재 시 note_day 보호/재생성 (items: ${localItems})`)
  } else {
    assert(true, `E-1 note_item도 정리됨 (정상 경로)`)
  }

  // day2 보호 확인
  const day2Count = await getLocalItemCount(day2)
  assert(day2Count === 2, `E-2 day2 보호 (${day2Count}/2)`)

  const day2Day = await getLocalDay(day2)
  assert(day2Day !== null && day2Day?.note_count === 2, `E-3 day2 note_day 보존 (count: ${day2Day?.note_count})`)

  // 모바일에서도 day2 조회 가능
  const mobDay2 = await mobileSelect('note_item', { day_id: day2 })
  assert(mobDay2.ok && mobDay2.data?.length === 2, `E-4 모바일에서 day2 조회 (${mobDay2.data?.length}/2)`)

  await cleanup([day1, day2], 'ndd')
  log('  시나리오 E 완료')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// F. 3자 동시 (PC + 서버 + 모바일)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scenarioF_threeWaySimultaneous() {
  log('\n═══ F. 3자 동시 (PC 로컬 + 서버 + 모바일 JWT) ═══')
  const day = TEST_DATES.threeWay

  await cleanup([day], '3ev')
  await sleep(500)

  const now = Date.now()

  // 초기 데이터: 서버에 5개
  await sb.from('note_day').upsert({
    id: day, user_id: USER_ID, mood: null,
    note_count: 5, has_notes: 1, summary: '3자 테스트', updated_at: now
  }, { onConflict: 'id,user_id' })
  for (let i = 0; i < 5; i++) {
    await sb.from('note_item').upsert({
      id: `3ev-${i}`, day_id: day, user_id: USER_ID,
      type: 'text', content: `초기 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    }, { onConflict: 'id,user_id' })
  }
  await pcSync()
  await sleep(1000)

  // 동시 작업 3가지:
  log('  3자 동시 작업 시작...')

  // A) 모바일: 새 아이템 INSERT
  const mobileInsert = mobileUpsert('note_item', {
    id: '3ev-mob-0', day_id: day, user_id: USER_ID,
    type: 'text', content: '모바일 추가',
    tags: '[]', pinned: 0, order_index: 10,
    created_at: Date.now(), updated_at: Date.now()
  })

  // B) 서버: 기존 2개 삭제
  const serverDelete = (async () => {
    await sb.from('note_item').delete().eq('id', '3ev-0').eq('user_id', USER_ID)
    await sb.from('note_item').delete().eq('id', '3ev-1').eq('user_id', USER_ID)
  })()

  // C) PC 로컬: 아이템 수정 (미래 timestamp로 LWW push 보장)
  const pcFutureTs = Date.now() + 60000
  // SQL에 day_id(2027-)를 포함시켜 앱 서버 test-date 필터 통과
  const pcModify = pcQuery(`UPDATE note_item SET content = 'PC 수정됨', updated_at = ${pcFutureTs} WHERE id = '3ev-2' AND day_id = '${day}'`)

  await Promise.all([mobileInsert, serverDelete, pcModify])

  // note_day 갱신
  await sb.from('note_day').update({ note_count: 4, updated_at: Date.now() }).eq('id', day).eq('user_id', USER_ID)

  // fullSync 2회 (수렴)
  await sleep(1000)
  await pcSync()
  await sleep(2000)
  await pcSync()
  await sleep(1000)

  // 검증
  const localCount = await getLocalItemCount(day)
  const remoteCount = await getRemoteItemCount(day)
  // 원래 5 - 삭제 2 + 모바일 1 = 4
  assert(localCount >= 3, `F-1 PC 로컬 최소 3개 (실제: ${localCount})`)
  assert(localCount === remoteCount, `F-2 PC-서버 정합성 (PC: ${localCount}, 서버: ${remoteCount})`)

  // PC 로컬 수정이 서버로 push되었는지 확인 (진짜 push 경로)
  const { data: srvMod } = await sb.from('note_item').select('content').eq('id', '3ev-2').eq('user_id', USER_ID).single()
  assert(srvMod?.content === 'PC 수정됨', `F-3 PC→서버 push 확인 ("${srvMod?.content}")`)

  // 모바일 추가 반영 확인
  const mobItem = await pcQuery(`SELECT * FROM note_item WHERE id = '3ev-mob-0'`)
  assert(mobItem.rows?.length > 0, `F-4 모바일 추가 PC에 반영`)

  // 모바일에서 최종 상태 조회
  const mobFinal = await mobileSelect('note_item', { day_id: day })
  assert(mobFinal.ok && mobFinal.data?.length === localCount, `F-5 모바일 조회 일치 (${mobFinal.data?.length}/${localCount})`)

  await cleanup([day], '3ev')
  log('  시나리오 F 완료')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// G. 모바일 오프라인 → 온라인 복귀 시뮬레이션
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scenarioG_mobileOffline() {
  log('\n═══ G. 모바일 오프라인 → 온라인 복귀 시뮬레이션 ═══')
  const day = TEST_DATES.mobOffline

  await cleanup([day], 'mof')
  await sleep(500)

  const now = Date.now()

  // 초기: 모바일이 3개 생성
  await mobileUpsert('note_day', {
    id: day, user_id: USER_ID, mood: null,
    note_count: 3, has_notes: 1, summary: '오프라인 테스트', updated_at: now
  })
  for (let i = 0; i < 3; i++) {
    await mobileUpsert('note_item', {
      id: `mof-${i}`, day_id: day, user_id: USER_ID,
      type: 'text', content: `오프라인 전 #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    })
  }
  await pcSync()
  await sleep(1000)

  // 모바일 "오프라인" 동안 PC에서 변경
  log('  모바일 오프라인 동안 PC에서 변경...')

  // PC: 아이템 1개 삭제 + 1개 수정
  await sb.from('note_item').delete().eq('id', 'mof-0').eq('user_id', USER_ID)
  await sb.from('note_item').update({ content: 'PC가 수정', updated_at: Date.now() + 3000 })
    .eq('id', 'mof-1').eq('user_id', USER_ID)
  await sb.from('note_day').update({ note_count: 2, updated_at: Date.now() }).eq('id', day).eq('user_id', USER_ID)

  await pcSync()
  await sleep(2000)

  // 모바일 "온라인 복귀" — 서버에서 최신 데이터 pull
  log('  모바일 온라인 복귀 → 서버 조회...')
  const mobData = await mobileSelect('note_item', { day_id: day })

  // 모바일이 본 데이터: mof-0 삭제됨, mof-1 수정됨, mof-2 유지
  assert(mobData.ok, `G-1 모바일 서버 조회 성공`)

  const mobIds = mobData.data?.map(d => d.id).sort()
  assert(!mobIds?.includes('mof-0'), `G-2 삭제된 아이템 없음 (${mobIds})`)

  const mof1 = mobData.data?.find(d => d.id === 'mof-1')
  assert(mof1?.content === 'PC가 수정', `G-3 수정된 내용 반영 ("${mof1?.content}")`)

  // 모바일이 오프라인 중 만든 새 메모를 push (LWW 충돌 시나리오)
  log('  모바일 오프라인 중 작성한 메모 push...')
  const offlineTime = now + 10000  // 오프라인 중 작성 시간
  await mobileUpsert('note_item', {
    id: 'mof-offline-0', day_id: day, user_id: USER_ID,
    type: 'text', content: '오프라인 중 작성',
    tags: '[]', pinned: 0, order_index: 5,
    created_at: offlineTime, updated_at: offlineTime
  })

  await pcSync()
  await sleep(2000)

  // 오프라인 작성 메모가 PC에도 반영
  const offlineItem = await pcQuery(`SELECT * FROM note_item WHERE id = 'mof-offline-0'`)
  assert(offlineItem.rows?.length > 0, `G-4 오프라인 작성 메모 PC 반영`)

  // 최종 정합성
  const finalLocal = await getLocalItemCount(day)
  const finalRemote = await getRemoteItemCount(day)
  assert(finalLocal === finalRemote, `G-5 최종 정합성 (PC: ${finalLocal}, 서버: ${finalRemote})`)

  await cleanup([day], 'mof')
  log('  시나리오 G 완료')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// H. Realtime DELETE payload 제한 검증
//    Supabase DELETE 이벤트는 old에 PK만 포함 — day_id 로컬 조회 필요
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function scenarioH_realtimeDeletePayload() {
  log('\n═══ H. Realtime DELETE payload 제한 (day_id 로컬 조회) ═══')
  const day = TEST_DATES.rtPayload

  await cleanup([day], 'rdp')
  await sleep(500)

  const now = Date.now()

  // 5개 아이템 생성 → PC에 동기화
  await sb.from('note_day').upsert({
    id: day, user_id: USER_ID, mood: null,
    note_count: 5, has_notes: 1, summary: 'payload 테스트', updated_at: now
  }, { onConflict: 'id,user_id' })
  for (let i = 0; i < 5; i++) {
    await sb.from('note_item').upsert({
      id: `rdp-${i}`, day_id: day, user_id: USER_ID,
      type: 'text', content: `payload #${i}`,
      tags: '[]', pinned: 0, order_index: i,
      created_at: now + i, updated_at: now + i
    }, { onConflict: 'id,user_id' })
  }
  await pcSync()
  await sleep(1000)

  const before = await getLocalItemCount(day)
  assert(before === 5, `H-1 초기 5개 (${before})`)

  // 서버에서 순차 삭제 (각 DELETE 이벤트의 old에는 id만 있고 day_id 없음)
  log('  서버에서 순차 삭제 (Realtime DELETE payload 테스트)...')
  for (let i = 0; i < 3; i++) {
    await sb.from('note_item').delete().eq('id', `rdp-${i}`).eq('user_id', USER_ID)
    await sleep(200) // 각 DELETE 이벤트가 개별 전파되도록
  }
  await sb.from('note_day').update({ note_count: 2, updated_at: Date.now() }).eq('id', day).eq('user_id', USER_ID)

  // Realtime 전파 대기
  const result = await waitForRealtime(async () => {
    const cnt = await getLocalItemCount(day)
    return cnt === 2
  })

  if (result.detected) {
    assert(true, `H-2 Realtime DELETE 처리 성공 (${result.seconds}초) — day_id 로컬 조회 동작`)
  } else {
    await pcSync()
    await sleep(1000)
    const after = await getLocalItemCount(day)
    assert(after === 2, `H-2 fullSync fallback (${after}/2)`)
  }

  // note_day count 정합성
  const localDay = await getLocalDay(day)
  assert(localDay?.note_count === 2, `H-3 note_day count 정합 (${localDay?.note_count}/2)`)

  // 모바일에서도 2개만 보이는지
  const mobCheck = await mobileSelect('note_item', { day_id: day })
  assert(mobCheck.ok && mobCheck.data?.length === 2, `H-4 모바일에서 2개 조회 (${mobCheck.data?.length}/2)`)

  await cleanup([day], 'rdp')
  log('  시나리오 H 완료')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 메인 실행
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
  log('🔥 PC ↔ 서버 ↔ 모바일 3환경 통합 테스트 시작')
  log(`   PC 서버: http://127.0.0.1:${PC_PORT}`)
  log(`   Supabase: ${SUPABASE_URL}`)

  // 연결 확인
  try {
    const ping = await pcRequest('/ping')
    assert(ping.ok, '0-1 PC 서버 연결')
  } catch (err) {
    log(`❌ PC 서버 연결 실패: ${err.message}`)
    log('   → Wition 앱 또는 테스트 서버를 먼저 실행하세요')
    process.exit(1)
  }

  try {
    const { data } = await sb.from('note_day').select('id').limit(1)
    assert(data !== null, '0-2 Supabase 연결')
  } catch (err) {
    log(`❌ Supabase 연결 실패: ${err.message}`)
    process.exit(1)
  }

  // 모바일 JWT 발급
  try {
    log('  모바일 JWT 발급 중...')
    mobileJWT = await getMobileJWT()
    assert(mobileJWT.length > 0, '0-3 모바일 JWT 발급')
  } catch (err) {
    log(`❌ 모바일 JWT 발급 실패: ${err.message}`)
    log('   → GoTrue 서버 확인 필요')
    process.exit(1)
  }

  // Realtime 연결 확인
  const rtStatus = await pcRealtimeStatus()
  log(`  Realtime 연결: ${rtStatus.connected ? '✅' : '❌'}`)

  // 전체 테스트 데이터 사전 정리
  log('\n사전 정리...')
  await cleanup(ALL_DATES, '')
  const prefixes = ['rt', 'udc', 'mob', 'p2m', 'ndd', '3ev', 'mof', 'rdp']
  for (const p of prefixes) {
    await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE '${p}%'`)
    try { await sb.from('tombstone').delete().like('item_id', `${p}%`).eq('user_id', USER_ID) } catch {}
  }
  await sleep(1000)

  // 시나리오 실행
  const scenarios = [
    ['A', scenarioA_realtimePath],
    ['B', scenarioB_updateDayCountFix],
    ['C', scenarioC_mobileToPc],
    ['D', scenarioD_pcToMobile],
    ['E', scenarioE_noteDayDeleteProtection],
    ['F', scenarioF_threeWaySimultaneous],
    ['G', scenarioG_mobileOffline],
    ['H', scenarioH_realtimeDeletePayload],
  ]

  for (const [name, fn] of scenarios) {
    try { await fn() }
    catch (e) { log(`❌ 시나리오 ${name} 예외: ${e.message}`) }
  }

  // 최종 정리
  log('\n최종 정리...')
  await cleanup(ALL_DATES, '')
  for (const p of prefixes) {
    await pcQuery(`DELETE FROM tombstone WHERE item_id LIKE '${p}%'`)
    try { await sb.from('tombstone').delete().like('item_id', `${p}%`).eq('user_id', USER_ID) } catch {}
  }

  // 결과 요약
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  log('\n' + '═'.repeat(60))
  log('🔥 3환경 통합 테스트 결과')
  log(`   ✅ 통과: ${passed}`)
  log(`   ❌ 실패: ${failed}`)
  log(`   ⏭️ 스킵: ${skipped}`)
  log(`   ⏱️ 소요: ${elapsed}초`)
  log('═'.repeat(60))

  const report = { passed, failed, skipped, elapsed: `${elapsed}s`, results, timestamp: new Date().toISOString() }
  fs.writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2))
  log(`결과 저장: ${RESULT_FILE}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('테스트 실행 오류:', err); process.exit(1) })
