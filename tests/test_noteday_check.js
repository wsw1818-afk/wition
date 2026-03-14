// note_day vs note_item 정합성 검증
const http = require('http');
const SRK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const UID = '848a51a4-d26c-4063-8e3a-c73cd548ce82';

function doFetch(path) {
  return new Promise((resolve, reject) => {
    const req = http.request('http://localhost:8000/rest/v1/' + path, {
      headers: { 'apikey': SRK, 'Authorization': 'Bearer ' + SRK }
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  const items = await doFetch(`note_item?select=id,day_id,content,type&user_id=eq.${UID}&order=day_id.desc`);
  console.log('서버 note_item 총:', items.length, '건');

  const grouped = {};
  items.forEach(i => { grouped[i.day_id] = (grouped[i.day_id] || 0) + 1; });

  const days = await doFetch(`note_day?select=id,note_count,summary,mood&user_id=eq.${UID}`);
  const dayMap = {};
  days.forEach(d => { dayMap[d.id] = d; });

  console.log('서버 note_day 총:', days.length, '건');
  console.log('');

  // 불일치 검사
  console.log('=== note_item이 있는데 note_day에 count가 맞지 않는 경우 ===');
  let mismatch = 0;
  for (const [dayId, cnt] of Object.entries(grouped)) {
    const nd = dayMap[dayId];
    if (nd === undefined) {
      console.log('  NO note_day:', dayId, '(item:', cnt, '건)');
      mismatch++;
    } else if (nd.note_count != cnt) {
      console.log('  MISMATCH:', dayId, 'day.count=', nd.note_count, 'actual=', cnt, 'summary:', nd.summary);
      mismatch++;
    }
  }
  if (mismatch === 0) console.log('  모두 정합 OK');

  console.log('');
  console.log('=== 현재 월(2026-03) note_item 목록 ===');
  const marItems = items.filter(i => i.day_id.startsWith('2026-03'));
  if (marItems.length === 0) {
    console.log('  (없음)');
  } else {
    marItems.forEach(i => console.log(' ', i.day_id, i.type, JSON.stringify(i.content).slice(0, 60)));
  }

  console.log('');
  console.log('=== 현재 월(2026-03) note_day에서 표시 가능한 날 ===');
  const marDays = days.filter(d => d.id.startsWith('2026-03') && (d.note_count > 0 || d.mood));
  if (marDays.length === 0) {
    console.log('  (없음)');
  } else {
    marDays.forEach(d => console.log(' ', d.id, 'count:', d.note_count, 'summary:', d.summary, 'mood:', d.mood));
  }

  // 모바일 앱에서 보는 현재 월 시뮬레이션
  console.log('');
  console.log('=== 모바일 앱 loadMonth("2026-03") 시뮬레이션 ===');
  const likePat = '2026-03%';
  const allMarDays = days.filter(d => d.id.startsWith('2026-03'));
  console.log('  getNoteDays 결과:', allMarDays.length, '건');
  const dayMapSim = {};
  allMarDays.forEach(d => { dayMapSim[d.id] = d; });

  for (let day = 1; day <= 31; day++) {
    const dateStr = `2026-03-${String(day).padStart(2, '0')}`;
    const nd = dayMapSim[dateStr];
    if (nd) {
      const hasNotes = nd.note_count > 0;
      const display = nd.mood ? `mood:${nd.mood}` : hasNotes ? `summary:"${nd.summary}"` : '(빈 날)';
      console.log(' ', dateStr, display);
    }
  }
})();
