/**
 * 테스트 래퍼 — Headless 테스트 서버 자동 시작/종료 + 테스트 실행
 *
 * 사용법:
 *   node run-tests.js                     # 모든 테스트 실행
 *   node run-tests.js test_cross_device   # 특정 테스트만
 *   node run-tests.js test_sync_auto test_db_features  # 여러 테스트
 */
const { spawn, execSync } = require('child_process')
const http = require('http')
const path = require('path')

const TEST_PORT = 19876
// wition_build/node_modules를 공유 (dotenv, @supabase 등)
const EXTRA_NODE_PATH = path.resolve(__dirname, 'wition_build', 'node_modules')
const ALL_TESTS = [
  'tests/test_delete_resurrection.js',
  'tests/test_cross_device.js',
  'tests/test_three_way.js',
  'tests/test_mobile_to_pc.js',
  'tests/test_db_features.js',
  'tests/test_sync_auto.js',
  'tests/test_ghost_fix.js',
  'tests/test_sync_speed.js',
]

function ping() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: TEST_PORT, path: '/ping', timeout: 2000 }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve(json)  // { ok, time, server? }
        } catch { resolve({ ok: true }) }
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

function shutdown() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: TEST_PORT, path: '/shutdown', method: 'POST', timeout: 3000 }, (res) => {
      res.on('data', () => {})
      res.on('end', () => resolve(true))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function runTest(file) {
  return new Promise((resolve) => {
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`▶ ${file}`)
    console.log('═'.repeat(60))
    const child = spawn('node', [file], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, TEST_PC_URL: `http://localhost:${TEST_PORT}`, NODE_PATH: EXTRA_NODE_PATH }
    })
    child.on('close', (code) => resolve(code))
    child.on('error', (err) => { console.error(err); resolve(1) })
  })
}

async function main() {
  // 실행할 테스트 결정
  const args = process.argv.slice(2)
  let tests = ALL_TESTS
  if (args.length > 0) {
    tests = args.map(a => {
      const name = a.endsWith('.js') ? a : `${a}.js`
      return name.startsWith('tests/') ? name : `tests/${name}`
    })
  }

  // 1) 이미 서버가 떠있는지 확인
  let pingResult = await ping()
  let serverAlreadyRunning = !!pingResult
  let serverProc = null

  if (serverAlreadyRunning) {
    if (pingResult && pingResult.server === 'headless-test') {
      console.log(`[Runner] 포트 ${TEST_PORT}에 Headless 테스트 서버 감지 ✅`)
    } else {
      console.error(`\n❌ 포트 ${TEST_PORT}에 Wition 앱 서버가 실행 중입니다!`)
      console.error('   앱 서버의 SQL 필터 때문에 테스트가 실패합니다.')
      console.error('   해결: Wition 앱을 닫고 다시 실행하세요.\n')
      process.exit(1)
    }
  } else {
    // 2) 테스트 서버 빌드 + 시작
    console.log('[Runner] 테스트 서버 빌드 중...')
    try {
      execSync('node build-test-server.js', { stdio: 'pipe', env: { ...process.env, NODE_PATH: EXTRA_NODE_PATH } })
    } catch (err) {
      console.error('[Runner] 빌드 실패:', err.stderr?.toString())
      process.exit(1)
    }

    console.log('[Runner] Headless 테스트 서버 시작 중...')
    serverProc = spawn('node', ['dist-electron/test-server.js'], {
      stdio: 'pipe',
      env: { ...process.env, TEST_PORT: String(TEST_PORT), NODE_PATH: EXTRA_NODE_PATH }
    })
    serverProc.stdout.on('data', d => process.stdout.write(`[Server] ${d}`))
    serverProc.stderr.on('data', d => process.stderr.write(`[Server] ${d}`))

    // 서버 준비 대기 (최대 15초)
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      if (await ping()) break
    }

    if (!await ping()) {
      console.error('[Runner] 테스트 서버 시작 실패')
      serverProc.kill()
      process.exit(1)
    }
    console.log('[Runner] 테스트 서버 준비 완료\n')
  }

  // 3) 테스트 실행
  let passed = 0, failed = 0
  for (const test of tests) {
    const code = await runTest(test)
    if (code === 0) passed++
    else failed++
  }

  // 4) 결과 요약
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`[Runner] 결과: ${passed} 통과, ${failed} 실패 (총 ${tests.length}개)`)
  console.log('═'.repeat(60))

  // 5) 테스트 서버 종료 (우리가 시작한 경우만)
  if (serverProc) {
    console.log('[Runner] 테스트 서버 종료 중...')
    await shutdown()
    await sleep(500)
    serverProc.kill()
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('[Runner] 에러:', err)
  process.exit(1)
})
