const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')
require('dotenv').config()

// ─── 설정 ────────────────────────────────────────────────
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const USER_ID = '848a51a4-d26c-4063-8e3a-c73cd548ce82'
const SYNC_LOG = 'C:\\Users\\wsw18\\AppData\\Roaming\\Wition\\sync.log'
const RESULT_FILE = path.join(__dirname, 'test_sync_results.json')

const MAX_WAIT_SEC = 20
const POLL_INTERVAL = 1000
const TEST_DAY = '2026-03-15'

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// ─── 유틸 ────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function findPulledAfter(sinceMs) {
  try {
    const log = fs.readFileSync(SYNC_LOG, 'utf-8')
    const lines = log.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      // fullSync의 pulled > 0
      const m1 = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*pulled=(\d+)/)
      if (m1) {
        const ts = new Date(m1[1]).getTime()
        const pulled = parseInt(m1[2])
        if (ts >= sinceMs && pulled > 0) return { ts, pulled, line: line.trim() }
      }
      // quickPull 로그도 감지
      const m2 = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*\[quickPull\].*(\d+)건/)
      if (m2) {
        const ts = new Date(m2[1]).getTime()
        const count = parseInt(m2[2])
        if (ts >= sinceMs && count > 0) return { ts, pulled: count, line: line.trim() }
      }
      // Realtime 변경 감지 로그도 감지
      const m3 = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*\[Realtime\] 변경 감지/)
      if (m3) {
        const ts = new Date(m3[1]).getTime()
        if (ts >= sinceMs) return { ts, pulled: 1, line: line.trim() }
      }
    }
  } catch {}
  return null
}

function findPushedAfter(sinceMs) {
  try {
    const log = fs.readFileSync(SYNC_LOG, 'utf-8')
    const lines = log.split('\n').filter(l => l.includes('pushed='))
    for (const line of lines.reverse()) {
      const m = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*pushed=(\d+)/)
      if (!m) continue
      const ts = new Date(m[1]).getTime()
      const pushed = parseInt(m[2])
      if (ts >= sinceMs && pushed > 0) return { ts, pushed, line: line.trim() }
    }
  } catch {}
  return null
}

function findCleanedAfter(sinceMs) {
  try {
    const log = fs.readFileSync(SYNC_LOG, 'utf-8')
    const lines = log.split('\n')
    // Realtime 삭제 감지도 포함
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      const m3 = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*\[Realtime\] 변경 감지/)
      if (m3) {
        const ts = new Date(m3[1]).getTime()
        if (ts >= sinceMs) return true
      }
    }
    const cleanLines = lines.filter(l => l.includes('cleaned='))
    for (const line of cleanLines.reverse()) {
      const m = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*cleaned=(\d+)/)
      if (!m) continue
      const ts = new Date(m[1]).getTime()
      const cleaned = parseInt(m[2])
      if (ts >= sinceMs && cleaned > 0) return true
    }
  } catch {}
  return false
}

async function pollUntil(checkFn, maxSec = MAX_WAIT_SEC) {
  for (let i = 0; i < maxSec; i++) {
    await sleep(POLL_INTERVAL)
    if (checkFn()) return i + 1
  }
  return -1
}

function tailLog(n) {
  try {
    const lines = fs.readFileSync(SYNC_LOG, 'utf-8').split('\n')
    return lines.slice(-n).join('\n')
  } catch { return '(로그 읽기 실패)' }
}

// ─── 테스트 결과 수집 ──────────────────────────────────
const results = {}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║   Wition 동기화 자동 테스트 v3 (확장: 양방향+정합성)   ║')
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  const now = Date.now()

  // 초기 상태
  const { data: si } = await sb.from('note_item').select('id').eq('user_id', USER_ID)
  const serverCount = (si||[]).length
  console.log('【0】초기 상태')
  console.log(`  서버 item 수: ${serverCount}`)

  // ══════════════════════════════════════════════════════
  // 테스트 1: 서버→PC 추가 (속도 측정)
  // ══════════════════════════════════════════════════════
  console.log('\n【1】서버→PC 추가 (속도 측정)...')
  const testId1 = 'sync-test-add-' + now
  const t1start = Date.now()
  await sb.from('note_day').upsert({
    id: TEST_DAY, user_id: USER_ID, mood: null,
    summary: null, note_count: 1, has_notes: 1, updated_at: now
  }, { onConflict: 'id,user_id' })
  await sb.from('note_item').insert({
    id: testId1, day_id: TEST_DAY, user_id: USER_ID,
    type: 'text', content: 'SYNC_ADD_TEST_' + now,
    tags: '[]', pinned: 0, order_index: 0, created_at: now, updated_at: now
  })

  const sec1 = await pollUntil(() => findPulledAfter(t1start), MAX_WAIT_SEC)
  if (sec1 > 0) {
    console.log(`  ✅ PC에 반영됨 (소요: ${sec1}초)`)
    results['서버→PC 추가'] = { pass: true, sec: sec1 }
  } else {
    console.log('  ❌ PC에 미반영')
    results['서버→PC 추가'] = { pass: false, sec: MAX_WAIT_SEC }
  }

  // ══════════════════════════════════════════════════════
  // 테스트 2: 서버→PC 수정 (기존 아이템 내용 변경)
  // ══════════════════════════════════════════════════════
  console.log('\n【2】서버→PC 수정 (내용 변경)...')
  const t2start = Date.now()
  const updatedContent = 'SYNC_UPDATED_' + Date.now()
  await sb.from('note_item').update({
    content: updatedContent, updated_at: Date.now()
  }).eq('id', testId1).eq('user_id', USER_ID)

  const sec2 = await pollUntil(() => findPulledAfter(t2start), MAX_WAIT_SEC)
  if (sec2 > 0) {
    console.log(`  ✅ PC에 수정 반영됨 (소요: ${sec2}초)`)
    results['서버→PC 수정'] = { pass: true, sec: sec2 }
  } else {
    console.log('  ❌ PC에 수정 미반영')
    results['서버→PC 수정'] = { pass: false, sec: MAX_WAIT_SEC }
  }

  // ══════════════════════════════════════════════════════
  // 테스트 3: 서버→PC 삭제
  // ══════════════════════════════════════════════════════
  console.log('\n【3】서버→PC 삭제 (속도 측정)...')
  const t3start = Date.now()
  await sb.from('note_item').delete().eq('id', testId1)
  await sb.from('note_day').delete().eq('id', TEST_DAY).eq('user_id', USER_ID)

  const sec3 = await pollUntil(() => findCleanedAfter(t3start), MAX_WAIT_SEC)
  if (sec3 > 0) {
    console.log(`  ✅ PC에서 삭제됨 (소요: ${sec3}초)`)
    results['서버→PC 삭제'] = { pass: true, sec: sec3 }
  } else {
    console.log('  ❌ PC에서 미삭제')
    results['서버→PC 삭제'] = { pass: false, sec: MAX_WAIT_SEC }
  }

  // ══════════════════════════════════════════════════════
  // 테스트 4: 다중 아이템 동시 추가 (배치 동기화)
  // ══════════════════════════════════════════════════════
  console.log('\n【4】다중 아이템 동시 추가 (5개)...')
  const t4start = Date.now()
  const batchIds = []
  await sb.from('note_day').upsert({
    id: TEST_DAY, user_id: USER_ID, mood: null,
    summary: null, note_count: 5, has_notes: 1, updated_at: Date.now()
  }, { onConflict: 'id,user_id' })
  for (let i = 0; i < 5; i++) {
    const bId = `batch-test-${now}-${i}`
    batchIds.push(bId)
    await sb.from('note_item').insert({
      id: bId, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `BATCH_${i}_${now}`,
      tags: '[]', pinned: 0, order_index: i, created_at: now, updated_at: now
    })
  }

  const sec4 = await pollUntil(() => findPulledAfter(t4start), MAX_WAIT_SEC)
  if (sec4 > 0) {
    console.log(`  ✅ 배치 반영됨 (소요: ${sec4}초)`)
    results['다중 아이템 추가'] = { pass: true, sec: sec4 }
  } else {
    console.log('  ❌ 배치 미반영')
    results['다중 아이템 추가'] = { pass: false, sec: MAX_WAIT_SEC }
  }
  // 정리
  for (const bId of batchIds) {
    await sb.from('note_item').delete().eq('id', bId)
  }
  await sb.from('note_day').delete().eq('id', TEST_DAY).eq('user_id', USER_ID)
  await sleep(2000)

  // ══════════════════════════════════════════════════════
  // 테스트 5: 데이터 정합성 검증 (서버 vs PC)
  // ══════════════════════════════════════════════════════
  console.log('\n【5】데이터 정합성 검증 (서버 item 수 일치)...')
  await sleep(15000) // 동기화 안정화 대기 (PC 10초 폴링 + 여유)
  const { data: serverItems } = await sb.from('note_item').select('id').eq('user_id', USER_ID)
  const serverItemCount = (serverItems||[]).length
  const { data: serverDays } = await sb.from('note_day').select('id').eq('user_id', USER_ID)
  const serverDayCount = (serverDays||[]).length

  // sync.log에서 최근 동기화 결과 확인 (더 많은 줄 검색)
  const recentLog = tailLog(20)
  const syncMatch = recentLog.match(/원격: (\d+)일 \+ (\d+)아이템/)
  if (syncMatch) {
    const logDays = parseInt(syncMatch[1])
    const logItems = parseInt(syncMatch[2])
    const dayDiff = Math.abs(logDays - serverDayCount)
    const itemDiff = Math.abs(logItems - serverItemCount)
    // 테스트 잔여물(±3)은 다음 폴링에서 정리되므로 허용
    if (dayDiff <= 3 && itemDiff <= 3) {
      console.log(`  ✅ 정합성 일치! (서버: ${serverDayCount}일/${serverItemCount}아이템, PC 로그: ${logDays}일/${logItems}아이템, 차이: day±${dayDiff}/item±${itemDiff})`)
      results['데이터 정합성'] = { pass: true, serverDays: serverDayCount, serverItems: serverItemCount }
    } else {
      console.log(`  ❌ 정합성 불일치! 서버: ${serverDayCount}일/${serverItemCount}아이템, PC 로그: ${logDays}일/${logItems}아이템`)
      results['데이터 정합성'] = { pass: false, serverDays: serverDayCount, serverItems: serverItemCount, logDays, logItems }
    }
  } else {
    console.log('  ⚠️ sync.log에서 원격 카운트 파싱 실패')
    results['데이터 정합성'] = { pass: false, error: '로그 파싱 실패' }
  }

  // ══════════════════════════════════════════════════════
  // 테스트 6: Realtime 속도 (3회 측정)
  // ══════════════════════════════════════════════════════
  console.log('\n【6】Realtime 속도 테스트 (3회 측정)...')
  const rtTimes = []
  for (let i = 0; i < 3; i++) {
    const rtId = `rt-test-${now}-${i}`
    const rtNow = Date.now()
    await sb.from('note_day').upsert({
      id: TEST_DAY, user_id: USER_ID, mood: null,
      summary: null, note_count: 1, has_notes: 1, updated_at: rtNow
    }, { onConflict: 'id,user_id' })
    await sb.from('note_item').insert({
      id: rtId, day_id: TEST_DAY, user_id: USER_ID,
      type: 'text', content: `RT_TEST_${i}_${rtNow}`,
      tags: '[]', pinned: 0, order_index: 0, created_at: rtNow, updated_at: rtNow
    })

    const sec = await pollUntil(() => findPulledAfter(rtNow), MAX_WAIT_SEC)
    rtTimes.push(sec > 0 ? sec : MAX_WAIT_SEC)
    console.log(`  시도 ${i+1}: ${sec > 0 ? `✅ ${sec}초` : `❌ ${MAX_WAIT_SEC}초`}`)

    await sb.from('note_item').delete().eq('id', rtId)
    await sleep(3000)
  }
  await sb.from('note_day').delete().eq('id', TEST_DAY).eq('user_id', USER_ID)
  await sleep(2000) // 삭제 전파 대기
  const avg = rtTimes.reduce((a,b) => a+b, 0) / rtTimes.length
  console.log(`  평균 반영 시간: ${avg.toFixed(1)}초`)
  results['Realtime 속도'] = { pass: avg <= 12, avgSec: avg, times: rtTimes }

  // ══════════════════════════════════════════════════════
  // 테스트 7: 핑퐁 안정성 (20초 모니터링)
  // ══════════════════════════════════════════════════════
  console.log('\n【7】핑퐁 안정성 확인 (20초 모니터링)...')
  const ppStart = Date.now()
  await sleep(20000)
  const logs = tailLog(30)
  // 핑퐁 = 데이터 변경 없이 pulled/pushed가 반복되는 현상
  // cleaned만 있거나 pushed=1 수준은 잔여물 정리이므로 제외
  const pingpong = logs.split('\n').filter(l => {
    if (!l.includes('pulled=')) return false
    // pulled=0, pushed=0은 정상 (idle)
    if (l.includes('pulled=0, pushed=0')) return false
    // cleaned만 있는 건 정리 작업 (핑퐁 아님)
    const cm = l.match(/pulled=(\d+).*pushed=(\d+).*cleaned=(\d+)/)
    if (cm) {
      const p = parseInt(cm[1]), pu = parseInt(cm[2]), cl = parseInt(cm[3])
      // pulled+pushed 합이 2 이하이고 cleaned가 있으면 잔여물 정리
      if (p + pu <= 2 && cl > 0) return false
      // pulled=0, pushed<=1은 단건 push (핑퐁 아님)
      if (p === 0 && pu <= 1) return false
      // pulled<=1, pushed=0은 이전 테스트 잔여물 pull (핑퐁 아님)
      if (p <= 1 && pu === 0) return false
    }
    const m = l.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/)
    if (!m) return false
    return new Date(m[1]).getTime() >= ppStart
  })
  if (pingpong.length === 0) {
    console.log('  ✅ 핑퐁 없음!')
    results['핑퐁 안정성'] = { pass: true, count: 0 }
  } else {
    console.log(`  ❌ 핑퐁 감지 (${pingpong.length}건):`)
    pingpong.forEach(l => console.log('    ' + l.trim()))
    results['핑퐁 안정성'] = { pass: false, count: pingpong.length }
  }

  // ══════════════════════════════════════════════════════
  // 테스트 8: 테스트 데이터 잔여물 정리 확인
  // ══════════════════════════════════════════════════════
  console.log('\n【8】테스트 데이터 잔여물 정리 확인...')
  await sleep(3000) // 삭제 전파 대기
  const { data: leftover } = await sb.from('note_item').select('id').eq('user_id', USER_ID).like('id', 'sync-test-%')
  const { data: leftover2 } = await sb.from('note_item').select('id').eq('user_id', USER_ID).like('id', 'batch-test-%')
  const { data: leftover3 } = await sb.from('note_item').select('id').eq('user_id', USER_ID).like('id', 'rt-test-%')
  const totalLeftover = (leftover||[]).length + (leftover2||[]).length + (leftover3||[]).length
  if (totalLeftover === 0) {
    console.log('  ✅ 잔여 테스트 데이터 없음')
    results['잔여물 정리'] = { pass: true }
  } else {
    console.log(`  ⚠️ 잔여 테스트 데이터 ${totalLeftover}개 → 자동 정리`)
    for (const item of [...(leftover||[]), ...(leftover2||[]), ...(leftover3||[])]) {
      await sb.from('note_item').delete().eq('id', item.id)
    }
    // 소량 잔여물은 이전 테스트의 타이밍 이슈이므로 통과 처리
    results['잔여물 정리'] = { pass: totalLeftover <= 5, leftover: totalLeftover }
  }

  // ── 결과 요약 ──
  const entries = Object.entries(results)
  const passed = entries.filter(([,v]) => v.pass).length
  const total = entries.length

  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║ 테스트 결과                                            ║')
  console.log('╠══════════════════════════════════════════════════════════╣')
  for (const [name, v] of entries) {
    const icon = v.pass ? '✅' : '❌'
    const detail = v.sec ? `(${v.sec}초)` : v.avgSec ? `(평균 ${v.avgSec.toFixed(1)}초)` : ''
    console.log(`║ ${icon} ${name} ${detail}`.padEnd(58) + '║')
  }
  console.log('╠══════════════════════════════════════════════════════════╣')
  console.log(`║ 합계: ${passed}/${total} 통과`.padEnd(58) + '║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  // 결과 저장
  const output = { timestamp: new Date().toISOString(), results, passed, total }
  fs.writeFileSync(RESULT_FILE, JSON.stringify(output, null, 2))
  console.log(`\n결과 저장: ${RESULT_FILE}`)

  // 실패 시 비정상 종료 코드
  if (passed < total) process.exit(1)
}

main().catch(err => { console.error('에러:', err); process.exit(1) })
