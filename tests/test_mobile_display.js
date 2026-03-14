/**
 * 모바일 달력 메모 표시 종합 테스트
 *
 * 시나리오:
 * 1. 로컬 DB를 완전히 비운다 (앱 첫 설치 시뮬레이션)
 * 2. fullSync 실행
 * 3. note_day 테이블에 데이터가 들어왔는지 확인
 * 4. loadMonth 쿼리 결과 검증
 * 5. 달력 셀 렌더링 로직 시뮬레이션
 */
const http = require('http');
const BASE = 'http://localhost:19876';

let pass = 0, fail = 0, total = 0;

function test(name, fn) {
  total++;
  return fn().then(() => { pass++; console.log(`  ✅ ${name}`); })
    .catch(e => { fail++; console.log(`  ❌ ${name}: ${e.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function query(sql) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/query?sql=${encodeURIComponent(sql)}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('JSON parse: ' + d)); } });
    });
    req.on('error', reject); req.end();
  });
}

function syncPost() {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/sync`, { method: 'POST' }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('JSON parse: ' + d)); } });
    });
    req.on('error', reject); req.end();
  });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('\n📱 모바일 달력 메모 표시 종합 테스트\n');

  // ==============================
  // Phase 1: 빈 DB 시뮬레이션
  // ==============================
  console.log('--- Phase 1: 빈 DB 상태에서 시작 ---');

  await test('1-1. 로컬 note_day 전체 삭제', async () => {
    await query('DELETE FROM note_day');
    const res = await query('SELECT COUNT(*) as cnt FROM note_day');
    assert(res.rows[0].cnt === 0, 'note_day가 비어있지 않음');
  });

  await test('1-2. 로컬 note_item 전체 삭제', async () => {
    await query('DELETE FROM note_item');
    const res = await query('SELECT COUNT(*) as cnt FROM note_item');
    assert(res.rows[0].cnt === 0, 'note_item이 비어있지 않음');
  });

  await test('1-3. 빈 상태 확인', async () => {
    const dayRes = await query('SELECT COUNT(*) as cnt FROM note_day');
    const itemRes = await query('SELECT COUNT(*) as cnt FROM note_item');
    assert(dayRes.rows[0].cnt === 0, 'note_day not empty');
    assert(itemRes.rows[0].cnt === 0, 'note_item not empty');
    console.log('    → note_day: 0건, note_item: 0건');
  });

  // ==============================
  // Phase 2: fullSync 실행 (모바일 앱 시작 시뮬레이션)
  // ==============================
  console.log('\n--- Phase 2: fullSync 실행 ---');

  let syncResult;
  await test('2-1. fullSync 실행', async () => {
    syncResult = await syncPost();
    console.log(`    → pulled=${syncResult.pulled}, pushed=${syncResult.pushed}`);
    assert(syncResult.pulled > 0, `pulled=0 → 서버에서 데이터를 받지 못함`);
  });

  await test('2-2. note_item 동기화 확인', async () => {
    const res = await query('SELECT COUNT(*) as cnt FROM note_item');
    console.log(`    → 동기화 후 note_item: ${res.rows[0].cnt}건`);
    assert(res.rows[0].cnt > 0, 'note_item이 비어있음 → 동기화 실패');
  });

  await test('2-3. note_day 동기화 확인', async () => {
    const res = await query('SELECT COUNT(*) as cnt FROM note_day');
    console.log(`    → 동기화 후 note_day: ${res.rows[0].cnt}건`);
    assert(res.rows[0].cnt > 0, 'note_day가 비어있음 → 동기화 실패');
  });

  await test('2-4. note_day에 메모가 있는 날 존재 확인', async () => {
    const res = await query('SELECT * FROM note_day WHERE note_count > 0 ORDER BY id');
    console.log(`    → note_count > 0인 날: ${res.rows.length}건`);
    res.rows.forEach(d => console.log(`      ${d.id}: count=${d.note_count}, summary="${d.summary}"`));
    assert(res.rows.length > 0, 'note_count > 0인 날이 없음 → 달력에 메모 안 보임');
  });

  // ==============================
  // Phase 3: loadMonth 쿼리 시뮬레이션
  // ==============================
  console.log('\n--- Phase 3: loadMonth 쿼리 시뮬레이션 ---');

  // 데이터가 있는 월 찾기
  const allDays = await query('SELECT * FROM note_day WHERE note_count > 0 ORDER BY id DESC');
  const targetMonth = allDays.rows.length > 0 ? allDays.rows[0].id.slice(0, 7) : '2026-03';

  await test(`3-1. getNoteDays("${targetMonth}") 쿼리`, async () => {
    const res = await query(`SELECT * FROM note_day WHERE id LIKE '${targetMonth}%' ORDER BY id`);
    console.log(`    → ${targetMonth} 월 note_day: ${res.rows.length}건`);

    // dayMap 구성 (calendarStore.loadMonth 로직 재현)
    const dayMap = {};
    res.rows.forEach(r => { dayMap[r.id] = r; });

    const dayMapKeys = Object.keys(dayMap);
    console.log(`    → dayMap 키: ${dayMapKeys.length}건`);
    assert(dayMapKeys.length > 0, `${targetMonth} 월에 note_day가 없음`);
  });

  await test(`3-2. 달력 셀 렌더링 시뮬레이션 (${targetMonth})`, async () => {
    const res = await query(`SELECT * FROM note_day WHERE id LIKE '${targetMonth}%' ORDER BY id`);
    const dayMap = {};
    res.rows.forEach(r => { dayMap[r.id] = r; });

    // CalendarScreen 렌더링 로직 재현
    let displayedCells = [];
    const year = parseInt(targetMonth.split('-')[0]);
    const month = parseInt(targetMonth.split('-')[1]);
    const daysInMonth = new Date(year, month, 0).getDate();

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${targetMonth}-${String(d).padStart(2, '0')}`;
      const noteDay = dayMap[dateStr];
      const hasNotes = noteDay && noteDay.note_count > 0;

      if (noteDay && noteDay.mood) {
        displayedCells.push({ date: dateStr, type: 'mood', value: noteDay.mood });
      } else if (hasNotes) {
        // summary 클리닝 (CalendarScreen 로직 재현)
        let label = noteDay.summary;
        if (label) {
          label = label
            .replace(/\[file:.+?\]/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            .replace(/`(.+?)`/g, '$1')
            .replace(/📎[^\n]*/g, '')
            .trim();
        }
        if (!label) label = `메모 ${noteDay.note_count}개`;
        displayedCells.push({ date: dateStr, type: 'note', value: label });
      }
    }

    console.log(`    → 표시되는 셀: ${displayedCells.length}건`);
    displayedCells.forEach(c => {
      const icon = c.type === 'mood' ? '🎭' : '📝';
      console.log(`      ${c.date}: ${icon} "${c.value}"`);
    });

    assert(displayedCells.length > 0, '표시되는 셀이 0건 → 달력이 비어보임');
  });

  // ==============================
  // Phase 4: note_day ↔ note_item 정합성
  // ==============================
  console.log('\n--- Phase 4: 정합성 검증 ---');

  await test('4-1. note_day.note_count == 실제 note_item 수', async () => {
    const dayRes = await query('SELECT id, note_count FROM note_day');
    const itemRes = await query('SELECT day_id, COUNT(*) as cnt FROM note_item GROUP BY day_id');

    const itemMap = {};
    itemRes.rows.forEach(r => { itemMap[r.day_id] = r.cnt; });

    let mismatches = 0;
    for (const d of dayRes.rows) {
      const actual = itemMap[d.id] || 0;
      if (d.note_count != actual) {
        console.log(`    ⚠️ ${d.id}: day.count=${d.note_count}, actual=${actual}`);
        mismatches++;
      }
    }

    // note_item만 있고 note_day 없는 경우
    const dayIds = new Set(dayRes.rows.map(d => d.id));
    for (const [dayId, cnt] of Object.entries(itemMap)) {
      if (!dayIds.has(dayId)) {
        console.log(`    ⚠️ ${dayId}: note_day 없음 (items=${cnt})`);
        mismatches++;
      }
    }

    assert(mismatches === 0, `정합성 불일치 ${mismatches}건`);
  });

  await test('4-2. summary가 null인데 note_count > 0인 날 확인', async () => {
    const res = await query("SELECT id, note_count, summary FROM note_day WHERE note_count > 0 AND (summary IS NULL OR summary = '')");
    if (res.rows.length > 0) {
      console.log(`    ⚠️ summary 누락: ${res.rows.length}건`);
      res.rows.forEach(d => console.log(`      ${d.id}: count=${d.note_count}`));
      // 이건 경고만, 실패는 아님 (fallback으로 "메모 N개" 표시)
    } else {
      console.log('    → 모든 메모 날짜에 summary 있음');
    }
  });

  // ==============================
  // Phase 5: 다시 fullSync (중복 실행 안전성)
  // ==============================
  console.log('\n--- Phase 5: 중복 fullSync 안전성 ---');

  await test('5-1. 두 번째 fullSync 실행', async () => {
    const before = await query('SELECT COUNT(*) as cnt FROM note_day WHERE note_count > 0');
    const result = await syncPost();
    const after = await query('SELECT COUNT(*) as cnt FROM note_day WHERE note_count > 0');

    console.log(`    → pulled=${result.pulled}, pushed=${result.pushed}`);
    console.log(`    → 메모 있는 날: ${before.rows[0].cnt} → ${after.rows[0].cnt}`);
    assert(after.rows[0].cnt >= before.rows[0].cnt, '두 번째 sync 후 메모 수 감소');
  });

  // ==============================
  // Phase 6: 새 메모 추가 후 달력 반영 확인
  // ==============================
  console.log('\n--- Phase 6: 새 메모 추가 후 달력 반영 ---');

  const testDayId = '2026-03-13';
  const testItemId = `test-mobile-display-${Date.now()}`;

  await test('6-1. 테스트 메모 추가', async () => {
    const now = Date.now();
    await query(`INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at) VALUES ('${testItemId}', '${testDayId}', 'text', '테스트 메모 내용', '[]', 0, 0, ${now}, ${now})`);
    const res = await query(`SELECT COUNT(*) as cnt FROM note_item WHERE day_id = '${testDayId}'`);
    assert(res.rows[0].cnt > 0, '메모 추가 실패');
  });

  await test('6-2. refreshDayCache 시뮬레이션 (note_day 갱신)', async () => {
    // 모바일 queries.ts의 refreshDayCache 로직 재현
    const stat = await query(`SELECT COUNT(*) AS cnt, (SELECT content FROM note_item WHERE day_id = '${testDayId}' ORDER BY order_index ASC LIMIT 1) AS first_content FROM note_item WHERE day_id = '${testDayId}'`);

    const count = stat.rows[0].cnt;
    let summary = stat.rows[0].first_content;
    if (summary) {
      summary = summary.replace(/\[file:.+?\]/g, '').replace(/\n/g, ' ').trim().slice(0, 80);
    }
    const now = Date.now();

    await query(`INSERT INTO note_day (id, note_count, has_notes, summary, updated_at) VALUES ('${testDayId}', ${count}, 1, '${summary}', ${now}) ON CONFLICT(id) DO UPDATE SET note_count = ${count}, has_notes = 1, summary = '${summary}', updated_at = ${now}`);

    const dayRes = await query(`SELECT * FROM note_day WHERE id = '${testDayId}'`);
    console.log(`    → ${testDayId}: count=${dayRes.rows[0].note_count}, summary="${dayRes.rows[0].summary}"`);
    assert(dayRes.rows[0].note_count > 0, 'note_day 갱신 실패');
    assert(dayRes.rows[0].summary, 'summary가 null');
  });

  await test('6-3. loadMonth 후 새 메모 표시 확인', async () => {
    const res = await query("SELECT * FROM note_day WHERE id LIKE '2026-03%' ORDER BY id");
    const dayMap = {};
    res.rows.forEach(r => { dayMap[r.id] = r; });

    const noteDay = dayMap[testDayId];
    assert(noteDay, `${testDayId}가 dayMap에 없음`);
    assert(noteDay.note_count > 0, 'note_count가 0');
    assert(noteDay.summary, 'summary가 없음');
    console.log(`    → ${testDayId} 달력에 표시됨: "${noteDay.summary}"`);
  });

  // 정리: 테스트 메모 삭제
  await query(`DELETE FROM note_item WHERE id = '${testItemId}'`);
  await query(`DELETE FROM note_day WHERE id = '${testDayId}' AND mood IS NULL AND note_count <= 1`);

  // ==============================
  // 결과
  // ==============================
  console.log(`\n${'='.repeat(50)}`);
  console.log(`결과: ${pass} passed, ${fail} failed (총 ${total})`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
