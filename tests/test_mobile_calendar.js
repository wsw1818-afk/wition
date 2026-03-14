/**
 * 모바일 달력 메모 표시 테스트
 * - headless 서버를 통해 fullSync 후 note_day가 올바르게 생성되는지 검증
 * - note_day.summary와 note_count가 달력 셀에서 표시 가능한 상태인지 확인
 */
const http = require('http');
const BASE = 'http://localhost:19876';
const SB = 'http://localhost:8000';
const SRK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

let pass = 0, fail = 0;

function test(name, fn) {
  return fn().then(() => { pass++; console.log(`  ✅ ${name}`); })
    .catch(e => { fail++; console.log(`  ❌ ${name}: ${e.message}`); });
}

function query(sql) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/query?sql=${encodeURIComponent(sql)}`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

function syncPost() {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/sync`, { method: 'POST' }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

function sbFetch(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${SB}/rest/v1/${path}`, {
      headers: { 'apikey': SRK, 'Authorization': 'Bearer ' + SRK }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  console.log('\n📅 모바일 달력 메모 표시 테스트\n');

  // 1. 서버 연결 확인
  await test('서버 연결 확인', async () => {
    const res = await query('SELECT 1 as ok');
    if (!res.rows || res.rows.length === 0) throw new Error('서버 응답 없음');
  });

  // 2. Supabase 서버의 note_item 확인
  let serverItems, serverDays;
  await test('Supabase note_item 조회', async () => {
    serverItems = await sbFetch('note_item?select=id,day_id,content,type&order=day_id.desc');
    if (!Array.isArray(serverItems)) throw new Error('배열이 아님');
    console.log(`    → 서버 note_item: ${serverItems.length}건`);
  });

  await test('Supabase note_day 조회', async () => {
    serverDays = await sbFetch('note_day?select=*&order=id.desc');
    if (!Array.isArray(serverDays)) throw new Error('배열이 아님');
    console.log(`    → 서버 note_day: ${serverDays.length}건`);
  });

  // 3. fullSync 실행
  await test('fullSync 실행', async () => {
    const result = await syncPost();
    console.log(`    → pulled=${result.pulled}, pushed=${result.pushed}`);
  });

  // 4. 로컬 note_day 확인
  await test('로컬 note_day 확인 (sync 후)', async () => {
    const res = await query('SELECT * FROM note_day ORDER BY id DESC');
    console.log(`    → 로컬 note_day: ${res.rows.length}건`);

    const withContent = res.rows.filter(r => r.note_count > 0 || r.mood);
    console.log(`    → 메모/무드 있는 날: ${withContent.length}건`);
    withContent.forEach(d => {
      console.log(`      ${d.id}: count=${d.note_count}, summary="${d.summary}", mood=${d.mood}`);
    });
  });

  // 5. 로컬 note_item 확인
  await test('로컬 note_item 확인', async () => {
    const res = await query('SELECT day_id, COUNT(*) as cnt FROM note_item GROUP BY day_id ORDER BY day_id DESC');
    console.log(`    → 로컬 note_item 날짜별:`);
    res.rows.forEach(r => console.log(`      ${r.day_id}: ${r.cnt}건`));
  });

  // 6. note_day vs note_item 정합성
  await test('note_day ↔ note_item 정합성', async () => {
    const dayRes = await query('SELECT id, note_count FROM note_day WHERE note_count > 0');
    const itemRes = await query('SELECT day_id, COUNT(*) as cnt FROM note_item GROUP BY day_id');

    const itemMap = {};
    itemRes.rows.forEach(r => { itemMap[r.day_id] = r.cnt; });

    let mismatches = 0;
    for (const d of dayRes.rows) {
      const actual = itemMap[d.id] || 0;
      if (d.note_count != actual) {
        console.log(`    ⚠️ ${d.id}: note_day.count=${d.note_count}, actual items=${actual}`);
        mismatches++;
      }
    }

    // note_item은 있는데 note_day가 없는 경우
    const dayIds = new Set(dayRes.rows.map(d => d.id));
    for (const [dayId, cnt] of Object.entries(itemMap)) {
      if (!dayIds.has(dayId)) {
        console.log(`    ⚠️ ${dayId}: note_day 없음, actual items=${cnt}`);
        mismatches++;
      }
    }

    if (mismatches > 0) throw new Error(`정합성 불일치 ${mismatches}건`);
  });

  // 7. 현재 월 달력 렌더링 시뮬레이션
  await test('달력 렌더링 시뮬레이션 (2026-03)', async () => {
    const res = await query("SELECT * FROM note_day WHERE id LIKE '2026-03%' ORDER BY id");
    const dayMap = {};
    res.rows.forEach(r => { dayMap[r.id] = r; });

    let displayed = 0;
    for (let d = 1; d <= 31; d++) {
      const dateStr = `2026-03-${String(d).padStart(2, '0')}`;
      const nd = dayMap[dateStr];
      if (nd) {
        const hasNotes = nd.note_count > 0;
        if (nd.mood) {
          console.log(`    ${dateStr}: 🎭 ${nd.mood}`);
          displayed++;
        } else if (hasNotes) {
          const label = nd.summary || `메모 ${nd.note_count}개`;
          console.log(`    ${dateStr}: 📝 "${label}"`);
          displayed++;
        }
      }
    }
    console.log(`    → 표시되는 날: ${displayed}건`);
    if (displayed === 0) throw new Error('표시 가능한 날이 0건 — 달력이 비어보임');
  });

  // 8. 서버에는 있지만 로컬에 없는 note_item 확인
  await test('서버 vs 로컬 note_item 비교', async () => {
    const localRes = await query('SELECT id FROM note_item');
    const localIds = new Set(localRes.rows.map(r => r.id));

    let missing = 0;
    for (const si of serverItems) {
      if (!localIds.has(si.id)) {
        console.log(`    ⚠️ 서버에만 존재: ${si.id} (${si.day_id}, ${si.type})`);
        missing++;
      }
    }
    if (missing > 0) throw new Error(`서버에만 있는 item ${missing}건 — 동기화 누락`);
  });

  console.log(`\n결과: ${pass} passed, ${fail} failed (총 ${pass + fail})\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
