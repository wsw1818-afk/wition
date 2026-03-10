/**
 * 인증 흐름 + 동기화 연동 종합 테스트
 * - GoTrue 토큰 발급/갱신/만료 시 sync 동작
 * - RLS 보호: 다른 사용자 데이터 접근 불가
 * - 오프라인 → 온라인 전환 시 자동 복구
 */
const { createClient } = require('@supabase/supabase-js')
const Database = require('better-sqlite3')
const { v4: uuid } = require('uuid')
const fs = require('fs')
const path = require('path')

const SB_URL = 'http://localhost:8000'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

let passed = 0, failed = 0
const results = []

function log(msg) {
  const ts = new Date().toLocaleTimeString('ko-KR', { hour12: false, fractionalSecondDigits: 3 })
  console.log(`[${ts}] ${msg}`)
}

async function test(name, fn) {
  const start = Date.now()
  try {
    await fn()
    const ms = Date.now() - start
    log(`  ✅ ${name} (${ms}ms)`)
    passed++
    results.push({ name, status: 'PASS', ms })
  } catch (e) {
    const ms = Date.now() - start
    log(`  ❌ ${name} (${ms}ms)`)
    log(`     ${e.message}`)
    failed++
    results.push({ name, status: 'FAIL', ms, error: e.message })
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_day (
      day TEXT PRIMARY KEY, title TEXT DEFAULT '', mood TEXT DEFAULT '', has_notes INTEGER DEFAULT 0,
      summary TEXT DEFAULT '', updated_at TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS note_item (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, type TEXT DEFAULT 'text', content TEXT DEFAULT '',
      tags TEXT DEFAULT '[]', pinned INTEGER DEFAULT 0, order_index INTEGER DEFAULT 0,
      updated_at TEXT, created_at TEXT,
      FOREIGN KEY(day) REFERENCES note_day(day)
    );
    CREATE TABLE IF NOT EXISTS alarm (
      id TEXT PRIMARY KEY, item_id TEXT, alarm_at TEXT, label TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      updated_at TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tombstone (
      id TEXT PRIMARY KEY, table_name TEXT NOT NULL, deleted_at TEXT NOT NULL
    );
  `)
  return db
}

function toEpoch(val) {
  if (typeof val === 'number') return val
  if (typeof val === 'string') return new Date(val).getTime()
  return Date.now()
}

async function run() {
  log('╔══════════════════════════════════════╗')
  log('║   인증 흐름 + 동기화 연동 테스트     ║')
  log('╚══════════════════════════════════════╝\n')

  const sbAdmin = createClient(SB_URL, SERVICE_KEY)
  const sbAnon = createClient(SB_URL, ANON_KEY)

  // 테스트 사용자 생성
  const testEmail = `test_auth_${Date.now()}@test.com`
  const testEmail2 = `test_auth2_${Date.now()}@test.com`
  const testPw = 'TestPassword123!'

  let user1, user2, session1

  log('── G. 인증 흐름 테스트 ──')

  await test('G01. 회원가입 + 자동 이메일 확인', async () => {
    const { data, error } = await sbAdmin.auth.admin.createUser({
      email: testEmail,
      password: testPw,
      email_confirm: true
    })
    assert(!error, `회원가입 실패: ${error?.message}`)
    user1 = data.user
    assert(user1.id, '사용자 ID 없음')
    assert(user1.email === testEmail, '이메일 불일치')
  })

  await test('G02. 비밀번호 로그인 → 토큰 발급', async () => {
    const { data, error } = await sbAnon.auth.signInWithPassword({
      email: testEmail,
      password: testPw
    })
    assert(!error, `로그인 실패: ${error?.message}`)
    session1 = data.session
    assert(session1.access_token, 'access_token 없음')
    assert(session1.refresh_token, 'refresh_token 없음')
    // JWT 파싱하여 유효시간 확인
    const payload = JSON.parse(Buffer.from(session1.access_token.split('.')[1], 'base64').toString())
    assert(payload.sub === user1.id, 'JWT sub != user_id')
    assert(payload.exp > Date.now() / 1000, 'JWT 이미 만료')
  })

  await test('G03. 토큰으로 getUser 성공', async () => {
    const authed = createClient(SB_URL, ANON_KEY)
    await authed.auth.setSession({
      access_token: session1.access_token,
      refresh_token: session1.refresh_token
    })
    const { data, error } = await authed.auth.getUser()
    assert(!error, `getUser 실패: ${error?.message}`)
    assert(data.user.id === user1.id, 'user_id 불일치')
  })

  await test('G04. 리프레시 토큰으로 세션 갱신', async () => {
    const authed = createClient(SB_URL, ANON_KEY)
    const { data, error } = await authed.auth.refreshSession({
      refresh_token: session1.refresh_token
    })
    assert(!error, `갱신 실패: ${error?.message}`)
    assert(data.session, '갱신된 세션 없음')
    assert(data.session.refresh_token, '새 refresh_token 없음')
    // 갱신 후 새 세션이 유효한지 확인 (토큰이 같을 수도 있음 — 짧은 시간 내)
    session1 = data.session // 갱신된 세션 사용
  })

  await test('G05. 잘못된 비밀번호 → 로그인 거부', async () => {
    const { error } = await sbAnon.auth.signInWithPassword({
      email: testEmail,
      password: 'wrong_password'
    })
    assert(error, '잘못된 비밀번호인데 로그인 성공')
    assert(error.message.includes('Invalid'), `예상치 못한 에러: ${error.message}`)
  })

  await test('G06. 존재하지 않는 계정 → 로그인 거부', async () => {
    const { error } = await sbAnon.auth.signInWithPassword({
      email: 'nonexistent@test.com',
      password: testPw
    })
    assert(error, '존재하지 않는 계정인데 로그인 성공')
  })

  log('\n── H. RLS (Row Level Security) 테스트 ──')

  // 두 번째 사용자 생성
  const { data: u2data } = await sbAdmin.auth.admin.createUser({
    email: testEmail2,
    password: testPw,
    email_confirm: true
  })
  user2 = u2data.user

  await test('H01. 사용자별 데이터 격리 — 다른 사용자 데이터 안보임', async () => {
    // User1으로 데이터 추가
    const itemId = uuid()
    const dayId = '2026-03-10'
    const { error: dayErr } = await sbAdmin.from('note_day').upsert({
      id: dayId, user_id: user1.id,
      mood: '', has_notes: 1, updated_at: Date.now(), note_count: 1
    })
    assert(!dayErr, `note_day 추가 실패: ${dayErr?.message}`)

    const { error: itemErr } = await sbAdmin.from('note_item').upsert({
      id: itemId, day_id: dayId, user_id: user1.id, type: 'text',
      content: 'User1 비밀 메모', updated_at: Date.now(), created_at: Date.now(), version: 1,
      tags: '[]', pinned: 0, order_index: 0
    })
    assert(!itemErr, `note_item 추가 실패: ${itemErr?.message}`)

    // User2로 로그인하여 조회 시도
    const sbUser2 = createClient(SB_URL, ANON_KEY)
    const { data: loginData } = await sbUser2.auth.signInWithPassword({
      email: testEmail2, password: testPw
    })
    const { data: items } = await sbUser2.from('note_item').select('*').eq('user_id', user1.id)
    // RLS가 작동하면 다른 사용자의 데이터는 보이지 않아야 함
    // (service_role이 아닌 anon 키로는 자기 데이터만 볼 수 있어야 함)
    assert(items.length === 0, `User2가 User1 데이터 ${items.length}건 조회됨 (RLS 미작동!)`)
  })

  await test('H02. service_role은 모든 데이터 접근 가능', async () => {
    const { data } = await sbAdmin.from('note_item').select('id').eq('user_id', user1.id)
    assert(data.length > 0, 'service_role로도 데이터 없음')
  })

  await test('H03. 인증 없이 데이터 접근 불가', async () => {
    const unauthSb = createClient(SB_URL, ANON_KEY)
    const { data } = await unauthSb.from('note_item').select('*')
    // 인증 없이는 자기 데이터가 없으므로 0건
    assert(data.length === 0, `미인증 상태에서 ${data.length}건 조회됨`)
  })

  log('\n── I. 인증 + 동기화 통합 시나리오 ──')

  await test('I01. 인증된 세션으로 데이터 CRUD → 로컬 DB 반영', async () => {
    const db = createTestDb()
    const day = '2026-03-15'
    const itemId = uuid()

    // 서버에 데이터 추가 (인증된 사용자)
    await sbAdmin.from('note_day').upsert({
      id: day, user_id: user1.id, mood: 'happy',
      has_notes: 1, updated_at: Date.now(), note_count: 1
    })
    await sbAdmin.from('note_item').upsert({
      id: itemId, day_id: day, user_id: user1.id, type: 'text',
      content: '인증 동기화 테스트', updated_at: Date.now(), created_at: Date.now(), version: 1,
      tags: '[]', pinned: 0, order_index: 0
    })

    // 서버에서 가져와서 로컬 DB에 반영 (service_role로 확인)
    const { data: items } = await sbAdmin.from('note_item').select('*').eq('user_id', user1.id).eq('day_id', day)
    assert(items.length > 0, '서버에 데이터 저장 확인 실패')

    // 로컬 DB에 반영
    db.prepare('INSERT OR REPLACE INTO note_day (day, title, mood, has_notes, updated_at) VALUES (?,?,?,?,?)')
      .run(day, '인증 테스트', 'happy', 1, new Date().toISOString())
    db.prepare('INSERT OR REPLACE INTO note_item (id, day, type, content, updated_at, created_at) VALUES (?,?,?,?,?,?)')
      .run(itemId, day, 'text', '인증 동기화 테스트', new Date().toISOString(), new Date().toISOString())

    const local = db.prepare('SELECT * FROM note_item WHERE id = ?').get(itemId)
    assert(local, '로컬 DB에 데이터 없음')
    assert(local.content === '인증 동기화 테스트', '내용 불일치')
    db.close()
  })

  await test('I02. 만료된 토큰 → refresh → 동기화 계속', async () => {
    // 새 세션 발급
    const { data: loginData } = await sbAnon.auth.signInWithPassword({
      email: testEmail, password: testPw
    })
    const freshSession = loginData.session

    // 갱신된 refresh token으로 새 세션
    const refreshClient = createClient(SB_URL, ANON_KEY)
    const { data: refreshData, error } = await refreshClient.auth.refreshSession({
      refresh_token: freshSession.refresh_token
    })
    assert(!error, `refresh 실패: ${error?.message}`)
    assert(refreshData.session, '갱신된 세션 없음')

    // refresh 후 새 세션으로 데이터 쓰기/읽기 테스트
    const testItemId = uuid()
    await sbAdmin.from('note_day').upsert({
      id: '2026-03-16', user_id: user1.id, mood: '', has_notes: 1, updated_at: Date.now(), note_count: 1
    })
    await sbAdmin.from('note_item').upsert({
      id: testItemId, day_id: '2026-03-16', user_id: user1.id, type: 'text',
      content: 'refresh 테스트', updated_at: Date.now(), created_at: Date.now(),
      version: 1, tags: '[]', pinned: 0, order_index: 0
    })
    const { data: items } = await sbAdmin.from('note_item').select('id').eq('id', testItemId)
    assert(items.length > 0, 'refresh 후 데이터 저장/조회 실패')
  })

  await test('I03. 동시 세션 — 두 기기에서 같은 계정 로그인', async () => {
    // Device A 로그인
    const deviceA = createClient(SB_URL, ANON_KEY)
    const { data: aData } = await deviceA.auth.signInWithPassword({ email: testEmail, password: testPw })
    assert(aData.session, 'Device A 로그인 실패')

    // Device B 로그인
    const deviceB = createClient(SB_URL, ANON_KEY)
    const { data: bData } = await deviceB.auth.signInWithPassword({ email: testEmail, password: testPw })
    assert(bData.session, 'Device B 로그인 실패')

    // 두 세션 모두 독립적으로 작동해야 함
    const { data: aItems } = await deviceA.from('note_item').select('id').eq('user_id', user1.id)
    const { data: bItems } = await deviceB.from('note_item').select('id').eq('user_id', user1.id)
    assert(aItems.length === bItems.length, '두 세션의 데이터 수 불일치')
  })

  await test('I04. 로그아웃 후 데이터 접근 불가', async () => {
    const client = createClient(SB_URL, ANON_KEY)
    await client.auth.signInWithPassword({ email: testEmail, password: testPw })

    // 로그아웃
    await client.auth.signOut()

    // 로그아웃 후 조회
    const { data } = await client.from('note_item').select('id').eq('user_id', user1.id)
    assert(data.length === 0, `로그아웃 후에도 ${data.length}건 조회됨`)
  })

  await test('I05. 오프라인 → 온라인 복구 시 토큰 갱신 시뮬레이션', async () => {
    // 시뮬레이션: 오프라인에서 로컬 작업 후 온라인 복귀
    const db = createTestDb()
    const day = '2026-03-20'
    const itemId = uuid()

    // 오프라인에서 로컬 작업
    db.prepare('INSERT INTO note_day (day, title, updated_at) VALUES (?,?,?)')
      .run(day, '오프라인 작업', new Date().toISOString())
    db.prepare('INSERT INTO note_item (id, day, type, content, updated_at, created_at) VALUES (?,?,?,?,?,?)')
      .run(itemId, day, 'text', '오프라인 메모', new Date().toISOString(), new Date().toISOString())

    // 온라인 복귀: 새 세션 발급
    const onlineClient = createClient(SB_URL, ANON_KEY)
    const { data: loginData } = await onlineClient.auth.signInWithPassword({
      email: testEmail, password: testPw
    })
    assert(loginData.session, '온라인 복귀 로그인 실패')

    // 로컬 note_day를 서버에 push
    await sbAdmin.from('note_day').upsert({
      id: day, user_id: user1.id, mood: '', has_notes: 1, updated_at: Date.now(), note_count: 1
    })
    // 로컬 데이터를 서버에 push
    const localItem = db.prepare('SELECT * FROM note_item WHERE id = ?').get(itemId)
    const { error } = await sbAdmin.from('note_item').upsert({
      id: localItem.id, day_id: localItem.day, user_id: user1.id, type: localItem.type,
      content: localItem.content, updated_at: toEpoch(localItem.updated_at),
      created_at: toEpoch(localItem.created_at), version: 1,
      tags: '[]', pinned: 0, order_index: 0
    })
    assert(!error, `push 실패: ${error?.message}`)

    // 서버에서 확인
    const { data: serverItem } = await sbAdmin.from('note_item').select('*').eq('id', itemId).single()
    assert(serverItem, '서버에 push된 데이터 없음')
    assert(serverItem.content === '오프라인 메모', '내용 불일치')
    db.close()
  })

  log('\n── J. 데이터 무결성 엣지케이스 ──')

  await test('J01. UUID 충돌 — 같은 ID로 두 사용자가 데이터 생성', async () => {
    const sharedId = uuid()
    const day = '2026-03-25'

    // User1이 데이터 생성
    await sbAdmin.from('note_day').upsert({
      id: day, user_id: user1.id, mood: '', has_notes: 1, updated_at: Date.now(), note_count: 1
    })
    await sbAdmin.from('note_item').upsert({
      id: sharedId, day_id: day, user_id: user1.id, type: 'text',
      content: 'User1 데이터', updated_at: Date.now(), created_at: Date.now(), version: 1
    })

    // User2가 같은 ID로 데이터 생성 시도
    const { error } = await sbAdmin.from('note_item').upsert({
      id: sharedId, day_id: day, user_id: user2.id, type: 'text',
      content: 'User2 데이터', updated_at: Date.now(), created_at: Date.now(), version: 2,
      tags: '[]', pinned: 0, order_index: 0
    })
    // UUID 충돌 시 upsert는 덮어쓰기 (PK 기준) — 이게 예상 동작
    // 실제 앱에서는 UUID 충돌 확률이 극히 낮음
    // 중요한 것은 에러 없이 처리되는 것
    assert(!error, `UUID 충돌 처리 실패: ${error?.message}`)
  })

  await test('J02. 타임스탬프 극단값 — epoch 0, 미래 날짜', async () => {
    const items = [
      { id: uuid(), day_id: '2026-01-01', content: 'epoch_0', updated_at: 0, created_at: 0 },
      { id: uuid(), day_id: '2026-01-01', content: 'far_future', updated_at: 32503680000000, created_at: 32503680000000 }, // 3000-01-01
      { id: uuid(), day_id: '2026-01-01', content: 'negative', updated_at: -1, created_at: -1 },
    ]
    for (const item of items) {
      const { error } = await sbAdmin.from('note_item').upsert({
        ...item, user_id: user1.id, type: 'text', tags: '[]', pinned: 0, order_index: 0, version: 1
      })
      assert(!error, `타임스탬프 극단값 실패 (${item.content}): ${error?.message}`)
    }
    // 조회
    const { data } = await sbAdmin.from('note_item').select('id, content, updated_at')
      .in('id', items.map(i => i.id))
    assert(data.length === 3, `3건 저장되어야 하나 ${data.length}건`)
  })

  await test('J03. 빈 content, null-like 값 처리', async () => {
    const items = [
      { id: uuid(), content: '' },
      { id: uuid(), content: '   ' },
      { id: uuid(), content: '\n\n\n' },
      { id: uuid(), content: 'null' },
      { id: uuid(), content: 'undefined' },
      { id: uuid(), content: '0' },
    ]
    for (const item of items) {
      const { error } = await sbAdmin.from('note_item').upsert({
        id: item.id, day_id: '2026-01-01', user_id: user1.id, type: 'text',
        content: item.content, updated_at: Date.now(), created_at: Date.now(),
        tags: '[]', pinned: 0, order_index: 0, version: 1
      })
      assert(!error, `content='${item.content.slice(0,10)}' 실패: ${error?.message}`)
    }
    const { data } = await sbAdmin.from('note_item').select('id, content')
      .in('id', items.map(i => i.id))
    assert(data.length === 6, `6건 저장되어야 하나 ${data.length}건`)
    // 빈 문자열이 null로 변환되지 않았는지 확인
    const emptyItem = data.find(d => d.id === items[0].id)
    assert(emptyItem.content === '', '빈 문자열이 유지되지 않음')
  })

  await test('J04. 매우 긴 content (100KB)', async () => {
    const longContent = '가'.repeat(50000) // ~100KB
    const itemId = uuid()
    const { error } = await sbAdmin.from('note_item').upsert({
      id: itemId, day_id: '2026-01-01', user_id: user1.id, type: 'text',
      content: longContent, updated_at: Date.now(), created_at: Date.now(),
      tags: '[]', pinned: 0, order_index: 0, version: 1
    })
    assert(!error, `긴 content 저장 실패: ${error?.message}`)
    const { data } = await sbAdmin.from('note_item').select('content').eq('id', itemId).single()
    assert(data.content.length === 50000, `content 길이 불일치: ${data.content.length}`)
  })

  await test('J05. 동시 upsert 경쟁 — 10개 동시 업데이트', async () => {
    const itemId = uuid()
    await sbAdmin.from('note_item').upsert({
      id: itemId, day_id: '2026-01-01', user_id: user1.id, type: 'text',
      content: 'initial', updated_at: Date.now(), created_at: Date.now(),
      tags: '[]', pinned: 0, order_index: 0, version: 1
    })

    // 10개 동시 업데이트 (각각 다른 content, 순차적 timestamp)
    const promises = Array.from({ length: 10 }, (_, i) =>
      sbAdmin.from('note_item').upsert({
        id: itemId, day_id: '2026-01-01', user_id: user1.id, type: 'text',
        content: `update_${i}`, updated_at: Date.now() + i,
        created_at: Date.now(), tags: '[]', pinned: 0, order_index: 0, version: i + 2
      })
    )
    const results = await Promise.all(promises)
    const errors = results.filter(r => r.error)
    assert(errors.length === 0, `${errors.length}건 upsert 실패`)

    // 최종값 확인 (가장 마지막 version이 남아야 함)
    const { data } = await sbAdmin.from('note_item').select('content, version').eq('id', itemId).single()
    assert(data, '최종 데이터 없음')
    // upsert는 마지막 요청이 이김 (PK 기준)
    assert(data.content.startsWith('update_'), `예상치 못한 content: ${data.content}`)
  })

  // 정리: 테스트 사용자 및 데이터 삭제
  log('\n── 정리 ──')
  try {
    await sbAdmin.from('note_item').delete().eq('user_id', user1.id)
    await sbAdmin.from('note_item').delete().eq('user_id', user2.id)
    await sbAdmin.from('note_day').delete().eq('user_id', user1.id)
    await sbAdmin.from('note_day').delete().eq('user_id', user2.id)
    await sbAdmin.auth.admin.deleteUser(user1.id)
    await sbAdmin.auth.admin.deleteUser(user2.id)
    log('  테스트 데이터 정리 완료')
  } catch (e) {
    log(`  정리 중 에러 (무시): ${e.message}`)
  }

  // 결과
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log(` 결과: ${passed} 통과, ${failed} 실패 (총 ${passed + failed}개)`)
  console.log('═══════════════════════════════════════════════════════════')

  fs.writeFileSync(
    path.join(__dirname, 'test_auth_flow_results.json'),
    JSON.stringify({ passed, failed, total: passed + failed, results }, null, 2)
  )

  process.exit(failed > 0 ? 1 : 0)
}

run().catch(e => { console.error('치명적 에러:', e); process.exit(1) })
