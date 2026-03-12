/**
 * Wition PC↔모바일 하드코어 동기화 테스트 (확장판)
 * ══════════════════════════════════════════════════════════
 * 오프라인/온라인 전환 + OneDrive 병합 + 크로스 디바이스 + 스트레스
 *
 * 구조:
 *   PC앱 = HTTP 테스트 서버 (localhost:19876) → 로컬 SQLite
 *   모바일 = Supabase REST API (service_role) → 서버 DB
 *   동기화 = PC앱의 fullSync (/sync POST)
 *   오프라인 = /set-offline, /set-online 엔드포인트
 *
 * 테스트 날짜: 2028-01-XX ~ 2028-06-XX (다른 테스트와 비충돌)
 * 실행: Wition 테스트서버 실행 중 → node test_sync_hardcore.js
 */

require('dotenv/config')
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')

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
async function pcSetOffline() {
  await fetch(`${PC}/set-offline`, { method: 'POST' })
}
async function pcSetOnline() {
  await fetch(`${PC}/set-online`, { method: 'POST' })
}

// ── Supabase(=모바일 시뮬레이션) API ──
async function mobInsert(table, row) {
  const { error } = await sb.from(table).upsert({ ...row, user_id: userId })
  if (error) throw new Error(`mobInsert(${table}): ${error.message}`)
}
async function mobUpdate(table, id, patch) {
  const { error } = await sb.from(table).update(patch).eq('id', id)
  if (error) throw new Error(`mobUpdate(${table}): ${error.message}`)
}
async function mobDelete(table, id) {
  const { error } = await sb.from(table).delete().eq('id', id)
  if (error) throw new Error(`mobDelete(${table}): ${error.message}`)
}
async function mobGet(table, filter) {
  let q = sb.from(table).select('*')
  if (filter) for (const [k, v] of Object.entries(filter)) q = q.eq(k, v)
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
function eq(a, b, m) { if (a !== b) throw new Error(m || `expected ${b}, got ${a}`) }

// ── 정리 ──
async function cleanup(prefix) {
  const p = prefix || '2028-'
  for (const t of ['note_item', 'alarm']) await sb.from(t).delete().like('day_id', `${p}%`)
  await sb.from('note_day').delete().like('id', `${p}%`)
  try {
    await pc(`DELETE FROM note_item WHERE day_id LIKE '${p}%'`)
    await pc(`DELETE FROM alarm WHERE day_id LIKE '${p}%'`)
    await pc(`DELETE FROM note_day WHERE id LIKE '${p}%'`)
    await pc(`DELETE FROM deleted_items WHERE item_id LIKE '${p}%' OR item_id IN (SELECT item_id FROM deleted_items)`)
  } catch (e) { /* PC에 deleted_items 테이블 없을 수 있음 */ }
}

// ══════════════════════════════════════════════
//  A. 오프라인 → 온라인 전환 시나리오 (8개)
// ══════════════════════════════════════════════

// A01. PC 오프라인 중 데이터 추가 → 온라인 복귀 → 서버에 push
async function a01() {
  const day = '2028-01-01', t0 = now()
  // PC를 오프라인으로 전환
  await pcSetOffline()
  // 오프라인에서 3개 아이템 추가
  for (let i = 0; i < 3; i++) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${uid()}','${day}','text','오프라인메모${i}','[]',0,${i},${t0+i},${t0+i})`)
  }
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'오프라인메모0',3,1,${t0})`)
  // 오프라인 상태에서 sync 시도 → 실패해야 함 (또는 스킵)
  const offlineResult = await pcSync()
  // 온라인 복귀
  await pcSetOnline()
  await sleep(500)
  // sync → 서버에 데이터 반영
  await pcSync()
  await sleep(500)
  const remote = await mobGet('note_item', { day_id: day })
  ok(remote.length === 3, `오프라인 복귀 후 서버: ${remote.length}/3`)
}

// A02. 오프라인 중 PC 편집 + 서버에서 모바일 편집 → 온라인 복귀 LWW
async function a02() {
  const day = '2028-01-02', id = uid(), t0 = now()
  // 양쪽에 같은 데이터 생성
  await mobInsert('note_item', { id, day_id: day, type: 'text', content: '원본', tags: '[]', pinned: 0, order_index: 0, created_at: t0, updated_at: t0 })
  await mobInsert('note_day', { id: day, mood: null, summary: '원본', note_count: 1, has_notes: 1, updated_at: t0 })
  await pcSync(); await sleep(500)
  // PC를 오프라인으로
  await pcSetOffline()
  // PC 오프라인 편집 (구형 timestamp)
  const pcTs = t0 + 3000
  await pc(`UPDATE note_item SET content='PC오프라인편집', updated_at=${pcTs} WHERE id='${id}'`)
  // 모바일이 서버에서 편집 (최신 timestamp)
  const mobTs = t0 + 10000
  await mobUpdate('note_item', id, { content: '모바일온라인편집', updated_at: mobTs })
  // PC 온라인 복귀 → sync
  await pcSetOnline()
  await sleep(500)
  await pcSync(); await sleep(500)
  // 모바일이 더 최신 → PC 로컬이 모바일 버전으로 갱신되어야 함
  const local = await pc(`SELECT content FROM note_item WHERE id='${id}'`)
  ok(local[0].content === '모바일온라인편집', `LWW 실패: ${local[0].content}`)
}

// A03. 오프라인 중 PC 삭제 → 온라인 복귀 → 서버에서도 삭제 (tombstone)
async function a03() {
  const day = '2028-01-03', id = uid(), t0 = now()
  await mobInsert('note_item', { id, day_id: day, type: 'text', content: '삭제될메모', tags: '[]', pinned: 0, order_index: 0, created_at: t0, updated_at: t0 })
  await mobInsert('note_day', { id: day, mood: null, summary: '삭제될메모', note_count: 1, has_notes: 1, updated_at: t0 })
  await pcSync(); await sleep(500)
  // PC 오프라인
  await pcSetOffline()
  await pc(`DELETE FROM note_item WHERE id='${id}'`)
  await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item','${id}',${now()})`)
  // 온라인 복귀
  await pcSetOnline(); await sleep(500)
  await pcSync(); await sleep(500)
  const remote = await mobGet('note_item', { id })
  ok(remote.length === 0, `tombstone 미반영: 서버에 ${remote.length}개 남음`)
}

// A04. 장기 오프라인(PC) 중 서버 대량 변경 → 온라인 복귀 데이터 정합성
async function a04() {
  const day = '2028-01-04', t0 = now()
  const ids = []
  // 서버에 20개 생성
  for (let i = 0; i < 20; i++) {
    const id = uid()
    ids.push(id)
    await mobInsert('note_item', { id, day_id: day, type: 'text', content: `서버메모${i}`, tags: '[]', pinned: 0, order_index: i, created_at: t0, updated_at: t0 })
  }
  await mobInsert('note_day', { id: day, mood: null, summary: '서버메모0', note_count: 20, has_notes: 1, updated_at: t0 })
  // PC sync (20개 가져옴)
  await pcSync(); await sleep(500)
  // PC 오프라인
  await pcSetOffline()
  // PC 오프라인에서 5개 추가
  for (let i = 0; i < 5; i++) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${uid()}','${day}','text','PC오프라인${i}','[]',0,${20+i},${t0+1000+i},${t0+1000+i})`)
  }
  // 서버에서 10개 수정 + 5개 삭제
  for (let i = 0; i < 10; i++) {
    await mobUpdate('note_item', ids[i], { content: `서버수정${i}`, updated_at: t0 + 50000 })
  }
  for (let i = 15; i < 20; i++) {
    await mobDelete('note_item', ids[i])
  }
  // PC 온라인 복귀
  await pcSetOnline(); await sleep(500)
  await pcSync(); await sleep(1000)
  // 검증: PC 로컬에 서버 수정 10개 반영
  for (let i = 0; i < 10; i++) {
    const local = await pc(`SELECT content FROM note_item WHERE id='${ids[i]}'`)
    ok(local.length === 1 && local[0].content === `서버수정${i}`, `서버수정${i} 미반영`)
  }
  // PC에 추가한 5개는 서버에도 올라감
  const remote = await mobGet('note_item', { day_id: day })
  ok(remote.length >= 15, `서버 최소 15개: ${remote.length}`)
}

// A05. 오프라인 ↔ 온라인 빠른 토글 (3회) → 데이터 손실 없음
async function a05() {
  const day = '2028-01-05', t0 = now()
  const createdIds = []
  for (let round = 0; round < 3; round++) {
    await pcSetOffline()
    const id = uid()
    createdIds.push(id)
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','토글${round}','[]',0,${round},${t0+round*1000},${t0+round*1000})`)
    await pcSetOnline(); await sleep(300)
    await pcSync(); await sleep(300)
  }
  const remote = await mobGet('note_item', { day_id: day })
  ok(remote.length === 3, `토글 후 서버: ${remote.length}/3`)
}

// A06. 오프라인에서 대량 CRUD(50건) → 온라인 복귀 일괄 sync
async function a06() {
  const day = '2028-01-06', t0 = now()
  await pcSetOffline()
  const ids = []
  // 50개 생성
  for (let i = 0; i < 50; i++) {
    const id = uid()
    ids.push(id)
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','배치${String(i).padStart(3,'0')}','[]',0,${i},${t0+i},${t0+i})`)
  }
  // 10개 수정
  for (let i = 0; i < 10; i++) {
    await pc(`UPDATE note_item SET content='수정${i}', updated_at=${t0+100000+i} WHERE id='${ids[i]}'`)
  }
  // 5개 삭제
  for (let i = 45; i < 50; i++) {
    await pc(`DELETE FROM note_item WHERE id='${ids[i]}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item','${ids[i]}',${now()})`)
  }
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'수정0',45,1,${t0})`)
  // 온라인 복귀
  await pcSetOnline(); await sleep(500)
  await pcSync(); await sleep(1500)
  const remote = await mobGet('note_item', { day_id: day })
  ok(remote.length === 45, `배치 sync 후 서버: ${remote.length}/45`)
  // 수정된 10개 검증
  for (let i = 0; i < 10; i++) {
    const r = remote.find(x => x.id === ids[i])
    ok(r && r.content === `수정${i}`, `수정${i} 미반영`)
  }
}

// A07. 모바일이 오프라인 상태로 서버에 못 올린 데이터 → PC가 먼저 sync → 이후 모바일 sync → 최종 일치
async function a07() {
  const day = '2028-01-07', t0 = now()
  // PC에 5개 추가 → sync
  const pcIds = []
  for (let i = 0; i < 5; i++) {
    const id = uid()
    pcIds.push(id)
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','PC메모${i}','[]',0,${i},${t0+i},${t0+i})`)
  }
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'PC메모0',5,1,${t0})`)
  await pcSync(); await sleep(500)
  // 모바일이 서버에 5개 추가 (독립적)
  for (let i = 0; i < 5; i++) {
    await mobInsert('note_item', { id: uid(), day_id: day, type: 'text', content: `모바일메모${i}`, tags: '[]', pinned: 0, order_index: 5 + i, created_at: t0 + 50000 + i, updated_at: t0 + 50000 + i })
  }
  // PC 다시 sync (모바일 데이터 pull)
  await pcSync(); await sleep(500)
  const localCount = await pc(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id='${day}'`)
  ok(localCount[0].cnt === 10, `PC 로컬: ${localCount[0].cnt}/10`)
}

// A08. 오프라인 sync 실패 후 pendingSyncQueue 동작 검증
async function a08() {
  const day = '2028-01-08', t0 = now(), id = uid()
  // 먼저 온라인에서 데이터 생성
  await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','큐테스트','[]',0,0,${t0},${t0})`)
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'큐테스트',1,1,${t0})`)
  // 오프라인에서 수정
  await pcSetOffline()
  await pc(`UPDATE note_item SET content='큐수정', updated_at=${t0+5000} WHERE id='${id}'`)
  // sync 시도 (실패하거나 스킵됨)
  await pcSync()
  // 온라인 복귀
  await pcSetOnline(); await sleep(500)
  // 다시 sync → pending 데이터가 올라가야 함
  await pcSync(); await sleep(500)
  const remote = await mobGet('note_item', { id })
  ok(remote.length === 1, '서버에 존재')
  // 최신 sync로 수정이 반영되었는지 (LWW에 의해)
  // 서버에 원래 없었으므로 push되었을 것
}

// ══════════════════════════════════════════════
//  B. OneDrive 시뮬레이션 (PC 테스트서버 기반) (5개)
// ══════════════════════════════════════════════
// OneDrive는 PC↔PC 파일 동기화이므로 SQLite DB 파일 복사 시뮬레이션
// 테스트서버에서는 직접 SQL로 OneDrive 병합 로직을 시뮬레이션

// B01. PC1 오프라인 작업 → OneDrive(=서버)에 PC2가 올린 데이터 → 온라인 복귀 시 LWW 병합
async function b01() {
  const day = '2028-02-01', t0 = now()
  // "PC2" (모바일로 시뮬레이션)가 서버에 데이터 올림
  const pc2Id = uid()
  await mobInsert('note_item', { id: pc2Id, day_id: day, type: 'text', content: 'PC2작성(OneDrive)', tags: '[]', pinned: 0, order_index: 0, created_at: t0, updated_at: t0 })
  await mobInsert('note_day', { id: day, mood: null, summary: 'PC2작성', note_count: 1, has_notes: 1, updated_at: t0 })
  // PC1 오프라인에서 작업
  await pcSetOffline()
  const pc1Id = uid()
  await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${pc1Id}','${day}','text','PC1오프라인작업','[]',0,1,${t0+1000},${t0+1000})`)
  // 온라인 복귀 → sync
  await pcSetOnline(); await sleep(500)
  await pcSync(); await sleep(500)
  // PC1에 PC2 데이터도 있어야 함
  const local = await pc(`SELECT id FROM note_item WHERE day_id='${day}'`)
  ok(local.length === 2, `PC1 로컬: ${local.length}/2 (양쪽 데이터 병합)`)
  // 서버에도 PC1 데이터 올라감
  const remote = await mobGet('note_item', { day_id: day })
  ok(remote.length === 2, `서버: ${remote.length}/2`)
}

// B02. 동일 아이템 3기기 동시 수정 → OneDrive+Supabase 경유 → LWW 최종 승자
async function b02() {
  const day = '2028-02-02', id = uid(), t0 = now()
  // 공통 원본 생성
  await mobInsert('note_item', { id, day_id: day, type: 'text', content: '원본', tags: '[]', pinned: 0, order_index: 0, created_at: t0, updated_at: t0 })
  await mobInsert('note_day', { id: day, mood: null, summary: '원본', note_count: 1, has_notes: 1, updated_at: t0 })
  await pcSync(); await sleep(500)
  // PC(로컬) 수정 — 가장 최신
  const pcTs = t0 + 30000
  await pc(`UPDATE note_item SET content='PC최신수정', updated_at=${pcTs} WHERE id='${id}'`)
  // "모바일" 수정 — 중간
  await mobUpdate('note_item', id, { content: '모바일수정', updated_at: t0 + 20000 })
  // "PC2"(OneDrive) 수정 — 가장 오래된
  // (서버에서 직접 업데이트, 가장 오래된 timestamp)
  // → 이건 모바일 시뮬로는 안 됨, skip (PC가 최신이므로 sync 후 PC 버전이 우승)
  await pcSync(); await sleep(500)
  const remote = await mobGet('note_item', { id })
  ok(remote[0].content === 'PC최신수정', `LWW 3기기: ${remote[0].content}`)
}

// B03. OneDrive 경유 삭제 전파: PC1 삭제 → 서버 → PC가 sync → 서버에서도 삭제
async function b03() {
  const day = '2028-02-03', id = uid(), t0 = now()
  await mobInsert('note_item', { id, day_id: day, type: 'text', content: '삭제될', tags: '[]', pinned: 0, order_index: 0, created_at: t0, updated_at: t0 })
  await mobInsert('note_day', { id: day, mood: null, summary: '삭제될', note_count: 1, has_notes: 1, updated_at: t0 })
  await pcSync(); await sleep(500)
  // PC에서 삭제 + tombstone
  await pc(`DELETE FROM note_item WHERE id='${id}'`)
  await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item','${id}',${now()})`)
  await pcSync(); await sleep(500)
  const remote = await mobGet('note_item', { id })
  ok(remote.length === 0, `삭제 전파 실패: ${remote.length}`)
}

// B04. OneDrive 병합 + Supabase sync 혼합 — 데이터 일관성
async function b04() {
  const day = '2028-02-04', t0 = now()
  // PC에 10개 추가
  for (let i = 0; i < 10; i++) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${uid()}','${day}','text','PC항목${i}','[]',0,${i},${t0+i},${t0+i})`)
  }
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'PC항목0',10,1,${t0})`)
  await pcSync(); await sleep(500)
  // 모바일이 5개 추가
  for (let i = 0; i < 5; i++) {
    await mobInsert('note_item', { id: uid(), day_id: day, type: 'text', content: `모바일항목${i}`, tags: '[]', pinned: 0, order_index: 10 + i, created_at: t0 + 50000 + i, updated_at: t0 + 50000 + i })
  }
  // PC sync → 모바일 데이터도 pull
  await pcSync(); await sleep(500)
  const localCount = await pc(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id='${day}'`)
  ok(localCount[0].cnt === 15, `혼합 sync: ${localCount[0].cnt}/15`)
  const remote = await mobGet('note_item', { day_id: day })
  ok(remote.length === 15, `서버: ${remote.length}/15`)
}

// B05. OneDrive 가져오기 후 recalcAllDayCounts 정합성
async function b05() {
  const day = '2028-02-05', t0 = now()
  // note_item만 있고 note_day가 없는 상태 (OneDrive에서 불완전하게 가져온 경우)
  for (let i = 0; i < 3; i++) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${uid()}','${day}','text','고아아이템${i}','[]',0,${i},${t0+i},${t0+i})`)
  }
  // note_day 없음 — sync 시 recalcAllDayCounts가 note_day를 생성해야 함
  await pcSync(); await sleep(500)
  const nd = await pc(`SELECT note_count FROM note_day WHERE id='${day}'`)
  ok(nd.length === 1, 'note_day 생성됨')
  ok(nd[0].note_count === 3, `note_count: ${nd[0].note_count}/3`)
}

// ══════════════════════════════════════════════
//  C. 크로스 디바이스 딜레이 + 스트레스 (7개)
// ══════════════════════════════════════════════

// C01. 동시 편집 충돌 LWW (양방향)
async function c01() {
  const day = '2028-03-01', id = uid(), t0 = now()
  await mobInsert('note_item', { id, day_id: day, type: 'text', content: '원본', tags: '[]', pinned: 0, order_index: 0, created_at: t0, updated_at: t0 })
  await mobInsert('note_day', { id: day, mood: null, summary: '원본', note_count: 1, has_notes: 1, updated_at: t0 })
  await pcSync(); await sleep(500)
  // PC가 더 최신
  await pc(`UPDATE note_item SET content='PC편집', updated_at=${t0+10000} WHERE id='${id}'`)
  await mobUpdate('note_item', id, { content: '모바일편집', updated_at: t0 + 5000 })
  await pcSync(); await sleep(500)
  let remote = await mobGet('note_item', { id })
  ok(remote[0].content === 'PC편집', `LWW→PC: ${remote[0].content}`)
  // 이번엔 모바일이 더 최신
  await pc(`UPDATE note_item SET content='PC구형', updated_at=${t0+15000} WHERE id='${id}'`)
  await mobUpdate('note_item', id, { content: '모바일최신', updated_at: t0 + 50000 })
  await pcSync(); await sleep(500)
  const local = await pc(`SELECT content FROM note_item WHERE id='${id}'`)
  ok(local[0].content === '모바일최신', `LWW→모바일: ${local[0].content}`)
}

// C02. 삭제 타이밍 레이스
async function c02() {
  const day = '2028-03-02', id = uid(), t0 = now()
  await mobInsert('note_item', { id, day_id: day, type: 'text', content: '레이스', tags: '[]', pinned: 0, order_index: 0, created_at: t0, updated_at: t0 })
  await mobInsert('note_day', { id: day, mood: null, summary: '레이스', note_count: 1, has_notes: 1, updated_at: t0 })
  await pcSync(); await sleep(500)
  // PC 삭제 + tombstone + 동시에 서버 업데이트
  await pc(`DELETE FROM note_item WHERE id='${id}'`)
  await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item','${id}',${now()})`)
  await mobUpdate('note_item', id, { content: '서버업데이트', updated_at: t0 + 1000 })
  await pcSync(); await sleep(500)
  const remote = await mobGet('note_item', { id })
  ok(remote.length === 0, `tombstone 우선: 서버에 ${remote.length}개 남음`)
}

// C03. 대량 동시 push: PC 100개 + 서버 50개 충돌
async function c03() {
  const day = '2028-03-03', t0 = now(), ids = []
  for (let i = 0; i < 100; i++) {
    const id = uid()
    ids.push(id)
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','PC배치${String(i).padStart(3,'0')}','[]',0,${i},${t0},${t0})`)
  }
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'PC배치000',100,1,${t0})`)
  for (let i = 0; i < 50; i++) {
    await mobInsert('note_item', { id: ids[i], day_id: day, type: 'text', content: `서버수정${String(i).padStart(3,'0')}`, tags: '[]', pinned: 0, order_index: i, created_at: t0, updated_at: t0 + 10000 })
  }
  await pcSync(); await sleep(2000)
  const remote = await mobGet('note_item', { day_id: day })
  ok(remote.length === 100, `대량: ${remote.length}/100`)
  const serverModified = remote.filter(r => r.content.startsWith('서버수정'))
  ok(serverModified.length === 50, `서버 수정 보존: ${serverModified.length}/50`)
}

// C04. fullSync 중 syncing 잠금 동작
async function c04() {
  const day = '2028-03-04', id = uid(), t0 = now()
  await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','잠금','[]',0,0,${t0},${t0})`)
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'잠금',1,1,${t0})`)
  const [r1, r2] = await Promise.all([pcSync(), (async () => { await sleep(50); return pcSync() })()])
  ok(r1 !== undefined, 'sync1 응답 없음')
  ok(r2 !== undefined, 'sync2 응답 없음')
  await sleep(500)
  const remote = await mobGet('note_item', { id })
  ok(remote.length === 1, '동시 sync 후 서버 데이터 없음')
}

// C05. 즉시 push→pull 데이터 반영
async function c05() {
  const day = '2028-03-05', t0 = now(), ids = []
  for (let i = 0; i < 10; i++) {
    const id = uid()
    ids.push(id)
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','빠른${i}','[]',0,${i},${t0+i},${t0+i})`)
  }
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'빠른0',10,1,${t0})`)
  await pcSync()
  for (let i = 0; i < 5; i++) {
    await mobUpdate('note_item', ids[i], { content: `모바일수정${i}`, updated_at: t0 + 100000 })
  }
  await pcSync()
  for (let i = 0; i < 5; i++) {
    const local = await pc(`SELECT content FROM note_item WHERE id='${ids[i]}'`)
    ok(local[0].content === `모바일수정${i}`, `블록${i} 미반영: ${local[0].content}`)
  }
}

// C06. cleanDeleted 보호창 안전성
async function c06() {
  const day = '2028-03-06', t0 = now()
  const oldTime = t0 - 30 * 60 * 1000
  const recentTime = t0 - 3 * 60 * 1000
  for (let i = 0; i < 50; i++) {
    const id = `srv-${day}-${String(i).padStart(3, '0')}`
    await mobInsert('note_item', { id, day_id: day, type: 'text', content: `서버${i}`, tags: '[]', pinned: 0, order_index: i, created_at: oldTime, updated_at: oldTime })
  }
  await mobInsert('note_day', { id: day, mood: null, summary: '서버0', note_count: 50, has_notes: 1, updated_at: oldTime })
  await pcSync(); await sleep(1000)
  // PC에 최근 아이템 10개 추가
  for (let i = 0; i < 10; i++) {
    const id = `pcnew-${day}-${String(i).padStart(3, '0')}`
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','PC최근${i}','[]',0,${50+i},${recentTime},${recentTime})`)
  }
  await pcSync(); await sleep(1000)
  // 최근 10개 보호 확인
  const recentItems = await pc(`SELECT id FROM note_item WHERE id LIKE 'pcnew-${day}-%'`)
  ok(recentItems.length === 10, `최근 아이템 보호: ${recentItems.length}/10`)
}

// C07. note_day 캐시 일관성 (CRUD 후 count 일치)
async function c07() {
  const day = '2028-03-07', t0 = now(), ids = []
  for (let i = 0; i < 5; i++) {
    const id = uid()
    ids.push(id)
    await mobInsert('note_item', { id, day_id: day, type: 'text', content: `캐시${i}`, tags: '[]', pinned: 0, order_index: i, created_at: t0, updated_at: t0 })
  }
  await mobInsert('note_day', { id: day, mood: '📝', summary: '캐시0', note_count: 5, has_notes: 1, updated_at: t0 })
  await pcSync(); await sleep(500)
  let nd = await pc(`SELECT note_count FROM note_day WHERE id='${day}'`)
  ok(nd[0].note_count === 5, `초기: ${nd[0].note_count}`)
  await mobDelete('note_item', ids[3])
  await mobDelete('note_item', ids[4])
  await pcSync(); await sleep(500)
  await pcSync(); await sleep(500) // recalc 반영
  nd = await pc(`SELECT note_count FROM note_day WHERE id='${day}'`)
  const actual = await pc(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id='${day}'`)
  ok(nd[0].note_count === actual[0].cnt, `note_count(${nd[0].note_count}) != 실제(${actual[0].cnt})`)
}

// ══════════════════════════════════════════════
//  D. 혼합 시나리오 (오프라인+OneDrive+서버 복합) (5개)
// ══════════════════════════════════════════════

// D01. PC 오프라인 중 편집 → "OneDrive"로 PC2에 전달 → PC2가 서버 sync → 모바일 pull
async function d01() {
  const day = '2028-04-01', t0 = now()
  // PC에 데이터 생성 후 sync
  const id = uid()
  await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','원본','[]',0,0,${t0},${t0})`)
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'원본',1,1,${t0})`)
  await pcSync(); await sleep(500)
  // PC 오프라인 편집
  await pcSetOffline()
  await pc(`UPDATE note_item SET content='오프라인편집', updated_at=${t0+10000} WHERE id='${id}'`)
  // OneDrive 시뮬: "PC2"가 서버에 다른 데이터 추가
  const pc2Id = uid()
  await mobInsert('note_item', { id: pc2Id, day_id: day, type: 'text', content: 'PC2추가', tags: '[]', pinned: 0, order_index: 1, created_at: t0 + 5000, updated_at: t0 + 5000 })
  // PC 온라인 복귀
  await pcSetOnline(); await sleep(500)
  await pcSync(); await sleep(500)
  // PC에 양쪽 데이터 존재
  const local = await pc(`SELECT id FROM note_item WHERE day_id='${day}'`)
  ok(local.length === 2, `PC 로컬: ${local.length}/2`)
  // 서버에도 편집된 내용 올라감
  const remote = await mobGet('note_item', { id })
  ok(remote[0].content === '오프라인편집', `서버 편집 반영: ${remote[0].content}`)
}

// D02. 모바일 오프라인 + PC 오프라인 → 둘 다 온라인 → 동시 sync
async function d02() {
  const day = '2028-04-02', t0 = now()
  const id = uid()
  // 공통 데이터
  await mobInsert('note_item', { id, day_id: day, type: 'text', content: '공통', tags: '[]', pinned: 0, order_index: 0, created_at: t0, updated_at: t0 })
  await mobInsert('note_day', { id: day, mood: null, summary: '공통', note_count: 1, has_notes: 1, updated_at: t0 })
  await pcSync(); await sleep(500)
  // 양쪽 오프라인 (PC만 테스트서버로 제어 가능)
  await pcSetOffline()
  await pc(`UPDATE note_item SET content='PC오프라인', updated_at=${t0+20000} WHERE id='${id}'`)
  // 모바일은 서버에 직접 올림 (모바일 온라인 가정)
  await mobUpdate('note_item', id, { content: '모바일온라인', updated_at: t0 + 30000 })
  // PC 온라인 복귀
  await pcSetOnline(); await sleep(500)
  await pcSync(); await sleep(500)
  // 모바일이 더 최신 → PC가 모바일 버전 반영
  const local = await pc(`SELECT content FROM note_item WHERE id='${id}'`)
  ok(local[0].content === '모바일온라인', `LWW: ${local[0].content}`)
}

// D03. 삭제+OneDrive+오프라인 복합: PC1 삭제 → PC 오프라인 → 모바일 추가 → PC 온라인
async function d03() {
  const day = '2028-04-03', t0 = now()
  const deleteId = uid(), newId = uid()
  // PC에 1개 생성
  await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${deleteId}','${day}','text','삭제할것','[]',0,0,${t0},${t0})`)
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'삭제할것',1,1,${t0})`)
  await pcSync(); await sleep(500)
  // PC 오프라인 → 삭제
  await pcSetOffline()
  await pc(`DELETE FROM note_item WHERE id='${deleteId}'`)
  await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item','${deleteId}',${now()})`)
  // 모바일이 서버에 새 아이템 추가
  await mobInsert('note_item', { id: newId, day_id: day, type: 'text', content: '모바일새항목', tags: '[]', pinned: 0, order_index: 1, created_at: t0 + 5000, updated_at: t0 + 5000 })
  // PC 온라인 복귀
  await pcSetOnline(); await sleep(500)
  await pcSync(); await sleep(500)
  // 삭제는 반영, 새 항목은 pull
  const remote = await mobGet('note_item', { id: deleteId })
  ok(remote.length === 0, `삭제 반영: ${remote.length}`)
  const localNew = await pc(`SELECT id FROM note_item WHERE id='${newId}'`)
  ok(localNew.length === 1, `새 항목 pull: ${localNew.length}`)
}

// D04. 3기기 릴레이: PC1(오프라인) → 서버 → PC2(sync) → 모바일 전체 흐름
async function d04() {
  const day = '2028-04-04', t0 = now()
  // PC에서 오프라인으로 데이터 작성
  await pcSetOffline()
  const ids = []
  for (let i = 0; i < 5; i++) {
    const id = uid()
    ids.push(id)
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${id}','${day}','text','릴레이${i}','[]',0,${i},${t0+i},${t0+i})`)
  }
  await pc(`INSERT OR REPLACE INTO note_day (id,mood,summary,note_count,has_notes,updated_at) VALUES ('${day}',null,'릴레이0',5,1,${t0})`)
  // 온라인 복귀 → push
  await pcSetOnline(); await sleep(500)
  await pcSync(); await sleep(500)
  // 모바일(서버)에서 확인
  const remote = await mobGet('note_item', { day_id: day })
  ok(remote.length === 5, `3기기 릴레이: 서버 ${remote.length}/5`)
  // 모바일이 수정
  await mobUpdate('note_item', ids[0], { content: '모바일수정', updated_at: t0 + 100000 })
  // PC 다시 sync → 모바일 수정 pull
  await pcSync(); await sleep(500)
  const local = await pc(`SELECT content FROM note_item WHERE id='${ids[0]}'`)
  ok(local[0].content === '모바일수정', `릴레이 역방향: ${local[0].content}`)
}

// D05. 스트레스: 오프라인 중 30건 추가 + 10건 수정 + 5건 삭제 → 온라인 sync → 서버 일치
async function d05() {
  const day = '2028-04-05', t0 = now()
  // 기본 20개 서버 생성
  const baseIds = []
  for (let i = 0; i < 20; i++) {
    const id = uid()
    baseIds.push(id)
    await mobInsert('note_item', { id, day_id: day, type: 'text', content: `기본${i}`, tags: '[]', pinned: 0, order_index: i, created_at: t0, updated_at: t0 })
  }
  await mobInsert('note_day', { id: day, mood: null, summary: '기본0', note_count: 20, has_notes: 1, updated_at: t0 })
  await pcSync(); await sleep(500)
  // PC 오프라인
  await pcSetOffline()
  // 30건 추가
  for (let i = 0; i < 30; i++) {
    await pc(`INSERT INTO note_item (id,day_id,type,content,tags,pinned,order_index,created_at,updated_at) VALUES ('${uid()}','${day}','text','추가${i}','[]',0,${20+i},${t0+1000+i},${t0+1000+i})`)
  }
  // 10건 수정
  for (let i = 0; i < 10; i++) {
    await pc(`UPDATE note_item SET content='오프수정${i}', updated_at=${t0+50000+i} WHERE id='${baseIds[i]}'`)
  }
  // 5건 삭제
  for (let i = 15; i < 20; i++) {
    await pc(`DELETE FROM note_item WHERE id='${baseIds[i]}'`)
    await pc(`INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at) VALUES ('note_item','${baseIds[i]}',${now()})`)
  }
  // 온라인 복귀
  await pcSetOnline(); await sleep(500)
  await pcSync(); await sleep(2000)
  // 검증: 로컬 = 20 - 5 + 30 = 45
  const localCount = await pc(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id='${day}'`)
  ok(localCount[0].cnt === 45, `스트레스 로컬: ${localCount[0].cnt}/45`)
  // 수정 검증
  for (let i = 0; i < 10; i++) {
    const l = await pc(`SELECT content FROM note_item WHERE id='${baseIds[i]}'`)
    ok(l[0].content === `오프수정${i}`, `수정${i} 미반영`)
  }
}

// ══════════════════════════════════════════════
//  메인
// ══════════════════════════════════════════════
async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log('  🔥 Wition 하드코어 동기화 테스트 (오프라인+OneDrive+크로스디바이스)')
  console.log('═'.repeat(60))

  try { await (await fetch(`${PC}/ping`)).json(); console.log(`[${ts()}] PC 연결 OK`) }
  catch (e) { console.error('❌ PC 테스트서버 연결 실패 (localhost:19876)'); process.exit(1) }

  sb = createClient(SB_URL, SB_KEY)
  const { data } = await sb.from('note_item').select('user_id').limit(1)
  userId = data?.[0]?.user_id
  if (!userId) { const { data: d } = await sb.from('note_day').select('user_id').limit(1); userId = d?.[0]?.user_id }
  ok(userId, 'userId 감지 불가')
  console.log(`[${ts()}] Supabase OK, userId: ${userId}`)

  await cleanup()

  // ── A. 오프라인 → 온라인 전환 (8개) ──
  console.log('\n' + '─'.repeat(60))
  console.log('  A. 오프라인 → 온라인 전환 시나리오')
  console.log('─'.repeat(60))

  await test('A01. 오프라인 중 추가 → 온라인 복귀 push', a01)
  await test('A02. 오프라인 PC 편집 + 서버 모바일 편집 → LWW', a02)
  await test('A03. 오프라인 삭제 → 온라인 tombstone 전파', a03)
  await test('A04. 장기 오프라인 → 서버 대량 변경 → 복귀 정합성', a04)
  await test('A05. 오프라인↔온라인 빠른 토글 3회', a05)
  await test('A06. 오프라인 대량 CRUD 50건 → 일괄 sync', a06)
  await test('A07. PC+모바일 독립 추가 → 양방향 sync 일치', a07)
  await test('A08. 오프라인 sync 실패 → 온라인 복구 push', a08)

  await cleanup()

  // ── B. OneDrive 시뮬레이션 (5개) ──
  console.log('\n' + '─'.repeat(60))
  console.log('  B. OneDrive 병합 시뮬레이션')
  console.log('─'.repeat(60))

  await test('B01. PC1 오프라인 + PC2 서버 → 온라인 병합', b01)
  await test('B02. 3기기 동시 수정 → LWW 최종 승자', b02)
  await test('B03. OneDrive 경유 삭제 전파 (tombstone)', b03)
  await test('B04. OneDrive + Supabase 혼합 sync 일관성', b04)
  await test('B05. OneDrive 불완전 가져오기 → recalc 정합성', b05)

  await cleanup()

  // ── C. 크로스 디바이스 딜레이 + 스트레스 (7개) ──
  console.log('\n' + '─'.repeat(60))
  console.log('  C. 크로스 디바이스 딜레이 + 스트레스')
  console.log('─'.repeat(60))

  await test('C01. 동시 편집 충돌 LWW (양방향)', c01)
  await test('C02. 삭제 타이밍 레이스 (tombstone 우선)', c02)
  await test('C03. 대량 동시 push 100개 + 서버 50개', c03)
  await test('C04. fullSync syncing 잠금 동작', c04)
  await test('C05. 즉시 push→pull 반영', c05)
  await test('C06. cleanDeleted 보호창 안전성', c06)
  await test('C07. note_day 캐시 일관성', c07)

  await cleanup()

  // ── D. 혼합 시나리오 (5개) ──
  console.log('\n' + '─'.repeat(60))
  console.log('  D. 오프라인 + OneDrive + 서버 복합')
  console.log('─'.repeat(60))

  await test('D01. PC 오프라인 편집 + PC2 서버 추가 → 병합', d01)
  await test('D02. 모바일+PC 동시 오프라인 → 온라인 LWW', d02)
  await test('D03. 삭제+OneDrive+오프라인 복합 시나리오', d03)
  await test('D04. 3기기 릴레이 (오프라인→서버→모바일)', d04)
  await test('D05. 스트레스: 30추가+10수정+5삭제 → 일괄 sync', d05)

  await cleanup()

  // ── 결과 ──
  console.log('\n' + '═'.repeat(60))
  console.log('  📊 결과')
  console.log('═'.repeat(60))
  const totalMs = R.reduce((s, r) => s + r.ms, 0)
  for (const r of R) console.log(`  ${r.status === 'PASS' ? '✅' : '❌'} ${r.name} (${r.ms}ms)`)
  console.log(`\n  합계: ${pass}/${R.length} PASS, ${fail} FAIL (${(totalMs / 1000).toFixed(1)}초)`)

  fs.writeFileSync('test_sync_results.json',
    JSON.stringify({ date: new Date().toISOString(), pass, fail, total: R.length, results: R }, null, 2))

  // 온라인 상태 복원
  try { await pcSetOnline() } catch {}

  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error('치명적:', e); process.exit(1) })
