/**
 * loadMonth race condition 테스트
 *
 * Zustand 스토어 없이, loadMonth의 _loadSeq 패턴만 순수 JS로 검증한다.
 * 서버 불필요 — `node tests/test_loadmonth_race.js`로 직접 실행 가능.
 */

const results = []
let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    results.push({ name, status: 'PASS' })
    passed++
  } catch (err) {
    results.push({ name, status: 'FAIL', error: err.message })
    failed++
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed')
}

// ── loadMonth 시뮬레이터 (실제 calendarStore 로직 복제) ──

function createStore() {
  let _loadSeq = 0
  let state = { dayMap: {}, loading: false, currentMonth: '' }

  return {
    getState: () => ({ ...state }),

    // 실제 loadMonth와 동일한 패턴
    loadMonth: async (yearMonth, mockFetchFn) => {
      const seq = ++_loadSeq
      state = { ...state, loading: true, currentMonth: yearMonth }

      try {
        const rows = await mockFetchFn(yearMonth)
        // stale 응답 무시 — 핵심 로직
        if (seq !== _loadSeq) return 'stale'
        const map = {}
        for (const r of rows) map[r.id] = r
        state = { ...state, dayMap: map }
        return 'applied'
      } finally {
        if (seq === _loadSeq) state = { ...state, loading: false }
      }
    },

    // race condition 없는 버전 (비교용)
    loadMonthNoGuard: async (yearMonth, mockFetchFn) => {
      state = { ...state, loading: true, currentMonth: yearMonth }
      try {
        const rows = await mockFetchFn(yearMonth)
        const map = {}
        for (const r of rows) map[r.id] = r
        state = { ...state, dayMap: map }
        return 'applied'
      } finally {
        state = { ...state, loading: false }
      }
    },

    getSeq: () => _loadSeq,
  }
}

// 지연 모킹 함수
function delay(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function mockFetch(yearMonth, delayMs, rows) {
  return async () => {
    await delay(delayMs)
    return rows
  }
}

// ── 테스트 케이스 ──

// 비동기 테스트는 아래에서 별도 실행
async function runAsyncTests() {
  // Test 1: 단일 호출 정상
  {
    const store = createStore()
    const result = await store.loadMonth('2026-03', mockFetch('2026-03', 10, [
      { id: '2026-03-01', note_count: 3 },
      { id: '2026-03-13', note_count: 1 },
    ]))
    assert(result === 'applied', `Expected 'applied', got '${result}'`)
    assert(Object.keys(store.getState().dayMap).length === 2, 'Should have 2 entries')
    assert(store.getState().loading === false, 'Should not be loading')
    results.push({ name: '1. 단일 호출 — 정상 적용', status: 'PASS' })
    passed++
  }

  // Test 2: 연속 2회 호출 — 느린 첫 번째가 무시되어야 함
  {
    const store = createStore()

    // 첫 번째: 느림 (200ms), 데이터 1건
    const p1 = store.loadMonth('2026-03', mockFetch('2026-03', 200, [
      { id: '2026-03-01', note_count: 1 },
    ]))

    // 두 번째: 빠름 (50ms), 데이터 3건 — 이게 최종 반영되어야 함
    const p2 = store.loadMonth('2026-03', mockFetch('2026-03', 50, [
      { id: '2026-03-01', note_count: 3 },
      { id: '2026-03-13', note_count: 2 },
      { id: '2026-03-25', note_count: 1 },
    ]))

    const [r1, r2] = await Promise.all([p1, p2])

    assert(r1 === 'stale', `First call should be stale, got '${r1}'`)
    assert(r2 === 'applied', `Second call should be applied, got '${r2}'`)
    assert(Object.keys(store.getState().dayMap).length === 3,
      `Should have 3 entries (from 2nd call), got ${Object.keys(store.getState().dayMap).length}`)
    results.push({ name: '2. 연속 2회 — 느린 첫 번째 무시', status: 'PASS' })
    passed++
  }

  // Test 3: 연속 5회 호출 — 마지막만 반영
  {
    const store = createStore()
    const promises = []

    for (let i = 0; i < 5; i++) {
      const delayMs = (5 - i) * 50 // 첫 번째가 가장 느림
      promises.push(store.loadMonth('2026-03', mockFetch('2026-03', delayMs, [
        { id: `2026-03-${String(i + 1).padStart(2, '0')}`, note_count: i + 1 },
      ])))
    }

    const results2 = await Promise.all(promises)
    const applied = results2.filter(r => r === 'applied')
    const stale = results2.filter(r => r === 'stale')

    assert(applied.length === 1, `Exactly 1 should be applied, got ${applied.length}`)
    assert(stale.length === 4, `4 should be stale, got ${stale.length}`)
    assert(Object.keys(store.getState().dayMap).length === 1, 'Only last result in dayMap')
    results.push({ name: '3. 연속 5회 — 마지막만 반영', status: 'PASS' })
    passed++
  }

  // Test 4: guard 없는 버전은 race condition 발생
  {
    const store = createStore()

    // guard 없는 버전으로 동일 시나리오
    const p1 = store.loadMonthNoGuard('2026-03', mockFetch('2026-03', 200, [
      { id: '2026-03-01', note_count: 1 }, // 오래된 데이터
    ]))

    const p2 = store.loadMonthNoGuard('2026-03', mockFetch('2026-03', 50, [
      { id: '2026-03-01', note_count: 3 },
      { id: '2026-03-13', note_count: 2 },
    ]))

    await Promise.all([p1, p2])

    // guard 없으면: 느린 p1이 나중에 완료되어 덮어씌움 → 1건만 남음 (버그!)
    const count = Object.keys(store.getState().dayMap).length
    assert(count === 1, `Without guard: slow request overwrites → ${count} entry (bug demonstrated)`)
    results.push({ name: '4. guard 없는 버전 — race condition 발생 확인', status: 'PASS' })
    passed++
  }

  // Test 5: 월 전환 중 동기화 이벤트 — stale 무시
  {
    const store = createStore()

    // 사용자가 3월 보는 중 sync-refresh로 loadMonth('2026-03') 호출됨
    const syncCall = store.loadMonth('2026-03', mockFetch('2026-03', 150, [
      { id: '2026-03-01', note_count: 5 },
    ]))

    // 50ms 후 사용자가 4월로 이동
    await delay(30)
    const userCall = store.loadMonth('2026-04', mockFetch('2026-04', 50, [
      { id: '2026-04-01', note_count: 2 },
    ]))

    const [r1, r2] = await Promise.all([syncCall, userCall])

    assert(r1 === 'stale', `Sync call for March should be stale, got '${r1}'`)
    assert(r2 === 'applied', `User call for April should be applied, got '${r2}'`)
    assert(store.getState().currentMonth === '2026-04', 'Should show April')
    assert(store.getState().dayMap['2026-04-01']?.note_count === 2, 'April data intact')
    assert(!store.getState().dayMap['2026-03-01'], 'March data should not be in dayMap')
    results.push({ name: '5. 월 전환 중 동기화 — stale 무시', status: 'PASS' })
    passed++
  }

  // Test 6: 동기화 이벤트 연속 3회 (sync-done + sync-refresh + CalendarView useEffect)
  {
    const store = createStore()

    const p1 = store.loadMonth('2026-03', mockFetch('2026-03', 100, [
      { id: '2026-03-01', note_count: 1 },
    ]))
    const p2 = store.loadMonth('2026-03', mockFetch('2026-03', 80, [
      { id: '2026-03-01', note_count: 2 },
    ]))
    const p3 = store.loadMonth('2026-03', mockFetch('2026-03', 30, [
      { id: '2026-03-01', note_count: 3 },
      { id: '2026-03-13', note_count: 1 },
    ]))

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])

    assert(r1 === 'stale', 'First sync should be stale')
    assert(r2 === 'stale', 'Second sync should be stale')
    assert(r3 === 'applied', 'Third (latest) should be applied')
    assert(store.getState().dayMap['2026-03-01']?.note_count === 3, 'Latest data preserved')
    assert(Object.keys(store.getState().dayMap).length === 2, 'All items from latest call')
    results.push({ name: '6. 동기화 연속 3회 — 마지막만 반영', status: 'PASS' })
    passed++
  }

  // Test 7: loading 상태 정확성
  {
    const store = createStore()

    const p1 = store.loadMonth('2026-03', mockFetch('2026-03', 100, []))
    assert(store.getState().loading === true, 'Should be loading during fetch')

    await p1
    assert(store.getState().loading === false, 'Should not be loading after completion')
    results.push({ name: '7. loading 상태 정확성', status: 'PASS' })
    passed++
  }

  // Test 8: stale 응답은 loading을 false로 만들지 않음
  {
    const store = createStore()

    const p1 = store.loadMonth('2026-03', mockFetch('2026-03', 200, []))
    const p2 = store.loadMonth('2026-03', mockFetch('2026-03', 300, [
      { id: '2026-03-01', note_count: 1 },
    ]))

    // p1 완료 시점 (200ms) — p2 아직 진행중이므로 loading=true 유지되어야 함
    await p1
    assert(store.getState().loading === true, 'Stale completion should NOT reset loading')

    await p2
    assert(store.getState().loading === false, 'Final completion resets loading')
    results.push({ name: '8. stale 완료 시 loading 유지', status: 'PASS' })
    passed++
  }
}

// ── 실행 ──
async function main() {
  console.log('\n🧪 loadMonth race condition 테스트\n')

  await runAsyncTests()

  console.log('─'.repeat(60))
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : '❌'
    console.log(`${icon} ${r.name}`)
    if (r.error) console.log(`   → ${r.error}`)
  }
  console.log('─'.repeat(60))
  console.log(`\n결과: ${passed} passed, ${failed} failed / ${passed + failed} total\n`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('테스트 실행 오류:', err)
  process.exit(1)
})
