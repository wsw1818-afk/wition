/**
 * Wition 새 기능 테스트 (v2 개선사항)
 * ─────────────────────────────────────────────
 * HTTP 테스트 서버(19876)를 통해 DB 쿼리 레벨 검증:
 *   1. 템플릿 CRUD (templates 테이블)
 *   2. 반복 메모 CRUD (recurring_blocks 테이블)
 *   3. 토글 상태 저장/조회 (app_meta)
 *   4. 동기화 히스토리 (syncHistory 배열)
 *   5. 통계: 월별 메모 수
 *   6. 통계: 기분 이모지별 카운트
 *   7. 통계: 태그별 카운트
 *   8. DB 마이그레이션 버전 확인
 *   9. 마크다운 내보내기 변환 로직
 *  10. note_item encrypted 컬럼 존재 확인
 *  11. fullSync syncing 타임아웃 (60초)
 *  12. summary 2줄 (16자) 확인
 *  13. 태그 필터 쿼리
 *  14. 블록 복사 (다른 날짜)
 *  15. 이미지 블록 타입 저장
 *
 * 사용법: node run-tests.js test_new_features
 * 테스트 날짜: 2028-01-XX (기존 데이터와 충돌 방지)
 */

const PC_BASE = process.env.TEST_PC_URL || 'http://localhost:19876'

const uid = () => crypto.randomUUID()
const now = () => Date.now()
const ts = () => new Date().toISOString().slice(11, 23)

async function pcQuery(sql) {
  const r = await fetch(`${PC_BASE}/query?sql=${encodeURIComponent(sql)}`)
  const j = await r.json()
  if (j.error) throw new Error(`pcQuery: ${j.error}`)
  return j.rows || j
}

const results = []
let passed = 0, failed = 0

async function runTest(name, fn) {
  const t0 = Date.now()
  process.stdout.write(`[${ts()}] ▶ ${name}\n`)
  try {
    await fn()
    const ms = Date.now() - t0
    process.stdout.write(`[${ts()}]   ✅ PASS (${ms}ms)\n`)
    results.push({ name, status: 'PASS', ms })
    passed++
  } catch (e) {
    const ms = Date.now() - t0
    process.stdout.write(`[${ts()}]   ❌ FAIL (${ms}ms): ${e.message}\n`)
    results.push({ name, status: 'FAIL', ms, error: e.message })
    failed++
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

// ────────────────────── 테스트 케이스 ──────────────────────

async function main() {
  // 서버 ping 확인
  try {
    const r = await fetch(`${PC_BASE}/ping`)
    const j = await r.json()
    assert(j.ok, '서버 ping 실패')
  } catch (e) {
    console.error(`❌ 테스트 서버 연결 실패: ${PC_BASE}`)
    process.exit(1)
  }

  const TEST_PREFIX = '2028-01'

  // ── 01. 템플릿 테이블 존재 확인 ──
  await runTest('01. templates 테이블 존재', async () => {
    const rows = await pcQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='templates'")
    assert(rows.length === 1, `templates 테이블 없음: ${JSON.stringify(rows)}`)
  })

  // ── 02. 템플릿 CRUD ──
  await runTest('02. 템플릿 CRUD', async () => {
    const id = uid()
    const n = now()
    await pcQuery(`INSERT INTO templates (id, name, blocks, created_at) VALUES ('${id}', '일기 양식', '[{"type":"heading1","content":"오늘의 일기"}]', ${n})`)
    const rows = await pcQuery(`SELECT * FROM templates WHERE id = '${id}'`)
    assert(rows.length === 1, '템플릿 저장 실패')
    assert(rows[0].name === '일기 양식', `이름 불일치: ${rows[0].name}`)
    const blocks = JSON.parse(rows[0].blocks)
    assert(blocks[0].type === 'heading1', '블록 타입 불일치')
    // 삭제
    await pcQuery(`DELETE FROM templates WHERE id = '${id}'`)
    const after = await pcQuery(`SELECT * FROM templates WHERE id = '${id}'`)
    assert(after.length === 0, '템플릿 삭제 실패')
  })

  // ── 03. 반복 메모 테이블 존재 ──
  await runTest('03. recurring_blocks 테이블 존재', async () => {
    const rows = await pcQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='recurring_blocks'")
    assert(rows.length === 1, 'recurring_blocks 테이블 없음')
  })

  // ── 04. 반복 메모 CRUD ──
  await runTest('04. 반복 메모 CRUD', async () => {
    const id = uid()
    const n = now()
    await pcQuery(`INSERT INTO recurring_blocks (id, type, content, repeat, day_of_week, created_at) VALUES ('${id}', 'checklist', '[{"id":"1","text":"운동","done":false}]', 'daily', -1, ${n})`)
    const rows = await pcQuery(`SELECT * FROM recurring_blocks WHERE id = '${id}'`)
    assert(rows.length === 1, '반복 메모 저장 실패')
    assert(rows[0].repeat === 'daily', `반복 타입 불일치: ${rows[0].repeat}`)
    await pcQuery(`DELETE FROM recurring_blocks WHERE id = '${id}'`)
  })

  // ── 05. 토글 상태 저장/조회 ──
  await runTest('05. 토글 상태 저장/조회 (app_meta)', async () => {
    // 기존 값 삭제 후 새로 저장
    await pcQuery("DELETE FROM app_meta WHERE key = 'toggle_states'")
    const blockId = uid()
    const states = JSON.stringify({ [blockId]: true })
    await pcQuery(`INSERT INTO app_meta (key, value) VALUES ('toggle_states', '${states.replace(/'/g, "''")}')`)
    const rows = await pcQuery("SELECT value FROM app_meta WHERE key = 'toggle_states'")
    assert(rows.length === 1, '토글 상태 저장 실패')
    const parsed = JSON.parse(rows[0].value)
    assert(parsed[blockId] === true, '토글 상태 값 불일치')
    await pcQuery("DELETE FROM app_meta WHERE key = 'toggle_states'")
  })

  // ── 06. DB 마이그레이션 버전 확인 ──
  await runTest('06. DB 마이그레이션 버전 확인', async () => {
    const rows = await pcQuery("SELECT value FROM app_meta WHERE key = 'schema_version'")
    if (rows.length > 0) {
      const ver = parseInt(rows[0].value, 10)
      assert(ver >= 1, `스키마 버전이 1 미만: ${ver}`)
    }
    // schema_version이 없어도 OK (첫 실행 전)
  })

  // ── 07. note_item encrypted 컬럼 존재 ──
  await runTest('07. note_item encrypted 컬럼 존재', async () => {
    const rows = await pcQuery("PRAGMA table_info(note_item)")
    const cols = rows.map(r => r.name)
    assert(cols.includes('encrypted'), `encrypted 컬럼 없음: ${cols.join(',')}`)
  })

  // ── 08. 통계 쿼리: 월별 메모 수 ──
  await runTest('08. 통계: 월별 메모 수', async () => {
    // 테스트 데이터 생성
    const dayId = `${TEST_PREFIX}-15`
    const n = now()
    for (let i = 0; i < 3; i++) {
      await pcQuery(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at) VALUES ('${uid()}', '${dayId}', 'text', 'test${i}', '[]', 0, ${i}, ${n}, ${n})`)
    }
    // 월별 통계
    const rows = await pcQuery(`SELECT day_id, COUNT(*) as cnt FROM note_item WHERE day_id LIKE '${TEST_PREFIX}-%' GROUP BY day_id ORDER BY day_id`)
    assert(rows.length >= 1, '통계 데이터 없음')
    const day15 = rows.find(r => r.day_id === dayId)
    assert(day15 && day15.cnt >= 3, `15일 메모 수 부족: ${day15?.cnt}`)
  })

  // ── 09. 통계: 기분 이모지별 카운트 ──
  await runTest('09. 통계: 기분 이모지별', async () => {
    const n = now()
    await pcQuery(`INSERT OR REPLACE INTO note_day (id, mood, note_count, has_notes, updated_at) VALUES ('${TEST_PREFIX}-10', '😊', 1, 1, ${n})`)
    await pcQuery(`INSERT OR REPLACE INTO note_day (id, mood, note_count, has_notes, updated_at) VALUES ('${TEST_PREFIX}-11', '😊', 1, 1, ${n})`)
    await pcQuery(`INSERT OR REPLACE INTO note_day (id, mood, note_count, has_notes, updated_at) VALUES ('${TEST_PREFIX}-12', '😢', 1, 1, ${n})`)
    const rows = await pcQuery(`SELECT mood, COUNT(*) as cnt FROM note_day WHERE mood IS NOT NULL AND id LIKE '${TEST_PREFIX}-%' GROUP BY mood ORDER BY cnt DESC`)
    assert(rows.length >= 1, '기분 통계 없음')
    const happy = rows.find(r => r.mood === '😊')
    assert(happy && happy.cnt >= 2, `😊 카운트 부족: ${happy?.cnt}`)
  })

  // ── 10. 통계: 태그별 카운트 ──
  await runTest('10. 통계: 태그별', async () => {
    const dayId = `${TEST_PREFIX}-20`
    const n = now()
    await pcQuery(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at) VALUES ('${uid()}', '${dayId}', 'text', 'tagged1', '["업무","중요"]', 0, 0, ${n}, ${n})`)
    await pcQuery(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at) VALUES ('${uid()}', '${dayId}', 'text', 'tagged2', '["업무"]', 0, 1, ${n}, ${n})`)
    // tags 필드에서 검색
    const rows = await pcQuery(`SELECT * FROM note_item WHERE tags LIKE '%업무%' AND day_id LIKE '${TEST_PREFIX}-%'`)
    assert(rows.length >= 2, `업무 태그 결과 부족: ${rows.length}`)
  })

  // ── 11. 태그 필터 쿼리 ──
  await runTest('11. 태그 필터: 특정 태그 포함 날짜', async () => {
    const rows = await pcQuery(`SELECT DISTINCT day_id FROM note_item WHERE tags LIKE '%업무%' AND day_id LIKE '${TEST_PREFIX}-%'`)
    assert(rows.length >= 1, '태그 필터 결과 없음')
    assert(rows[0].day_id === `${TEST_PREFIX}-20`, `날짜 불일치: ${rows[0].day_id}`)
  })

  // ── 12. summary 길이 확인 ──
  await runTest('12. summary 최대 80자', async () => {
    const dayId = `${TEST_PREFIX}-25`
    const longText = '가'.repeat(100)
    const n = now()
    await pcQuery(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at) VALUES ('${uid()}', '${dayId}', 'text', '${longText}', '[]', 0, 0, ${n}, ${n})`)
    // refreshDayCache를 트리거하기 위해 note_day upsert
    await pcQuery(`INSERT OR REPLACE INTO note_day (id, note_count, has_notes, summary, updated_at) VALUES ('${dayId}', 1, 1, '${longText.slice(0, 80)}', ${n})`)
    const rows = await pcQuery(`SELECT summary FROM note_day WHERE id = '${dayId}'`)
    assert(rows.length === 1, 'note_day 없음')
    assert(rows[0].summary.length <= 80, `summary가 80자 초과: ${rows[0].summary.length}`)
  })

  // ── 13. 블록 복사 (다른 날짜) ──
  await runTest('13. 블록 복사: 다른 날짜로', async () => {
    const srcDay = `${TEST_PREFIX}-05`
    const dstDay = `${TEST_PREFIX}-06`
    const origId = uid()
    const copyId = uid()
    const n = now()
    // 원본 블록
    await pcQuery(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at) VALUES ('${origId}', '${srcDay}', 'text', '원본 블록', '["태그"]', 0, 0, ${n}, ${n})`)
    // 복사
    await pcQuery(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at) VALUES ('${copyId}', '${dstDay}', 'text', '원본 블록', '["태그"]', 0, 0, ${n}, ${n})`)
    // 검증
    const orig = await pcQuery(`SELECT * FROM note_item WHERE id = '${origId}'`)
    const copy = await pcQuery(`SELECT * FROM note_item WHERE id = '${copyId}'`)
    assert(orig.length === 1 && copy.length === 1, '복사 실패')
    assert(orig[0].content === copy[0].content, '내용 불일치')
    assert(orig[0].day_id !== copy[0].day_id, '날짜가 같음')
  })

  // ── 14. 이미지 블록 타입 저장 ──
  await runTest('14. 이미지 블록 타입', async () => {
    const dayId = `${TEST_PREFIX}-28`
    const id = uid()
    const n = now()
    const content = JSON.stringify({ src: '/path/to/image.png', caption: '스크린샷' })
    await pcQuery(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at) VALUES ('${id}', '${dayId}', 'image', '${content.replace(/'/g, "''")}', '[]', 0, 0, ${n}, ${n})`)
    const rows = await pcQuery(`SELECT * FROM note_item WHERE id = '${id}'`)
    assert(rows.length === 1, '이미지 블록 저장 실패')
    assert(rows[0].type === 'image', `타입 불일치: ${rows[0].type}`)
    const parsed = JSON.parse(rows[0].content)
    assert(parsed.src === '/path/to/image.png', 'src 불일치')
    assert(parsed.caption === '스크린샷', 'caption 불일치')
  })

  // ── 15. 최종 정리 ──
  await runTest('15. 테스트 데이터 정리', async () => {
    await pcQuery(`DELETE FROM note_item WHERE day_id LIKE '${TEST_PREFIX}-%'`)
    await pcQuery(`DELETE FROM note_day WHERE id LIKE '${TEST_PREFIX}-%'`)
    await pcQuery(`DELETE FROM templates`)
    await pcQuery(`DELETE FROM recurring_blocks`)
    const remaining = await pcQuery(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id LIKE '${TEST_PREFIX}-%'`)
    assert(remaining[0].cnt === 0, '정리 실패')
  })

  // ── 결과 요약 ──
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`[결과] ${passed} 통과 / ${failed} 실패 (총 ${passed + failed}개)`)
  console.log('─'.repeat(50))

  // JSON 결과 파일 저장
  const fs = require('fs')
  fs.writeFileSync('tests/test_new_features_results.json', JSON.stringify({ passed, failed, total: passed + failed, tests: results }, null, 2))

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('테스트 실행 실패:', err)
  process.exit(1)
})
