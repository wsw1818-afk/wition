/**
 * Headless 테스트 서버 — Electron 없이 순수 Node.js로 실행
 * 기존 테스트(test_*.js)와 100% 호환: /sync, /query, /ping 엔드포인트 동일
 *
 * 사용법: node dist-electron/test-server.js
 * 빌드:   npm run build:test-server
 */
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { config as dotenvConfig } from 'dotenv'
import { initializeSchema } from './db/schema'
import * as Sync from './sync'
import { createClient } from '@supabase/supabase-js'

// .env 로드
dotenvConfig()

const TEST_PORT = parseInt(process.env.TEST_PORT || '19876', 10)

/* ─── 앱 config 로딩 (Electron 없이) ─── */
function getAppDataPath(): string {
  // Windows: %APPDATA%/wition
  const appData = process.env.APPDATA || join(process.env.HOME || '', 'AppData', 'Roaming')
  return join(appData, 'wition')
}

interface AppConfig {
  dataPath: string
  lastSyncAt?: number
  authToken?: string
  authRefreshToken?: string
  authUser?: { id: string; email: string }
}

const CONFIG_FILE = join(getAppDataPath(), 'config.json')

function loadConfig(): AppConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      return { dataPath: join(getAppDataPath(), 'data'), ...raw }
    }
  } catch { /* */ }
  return { dataPath: join(getAppDataPath(), 'data') }
}

function saveConfig(cfg: AppConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
}

let config = loadConfig()

/* ─── DB 초기화 ─── */
function openDatabase(): Database.Database {
  if (!existsSync(config.dataPath)) {
    mkdirSync(config.dataPath, { recursive: true })
  }
  const dbPath = join(config.dataPath, 'wition.db')
  console.log(`[TestServer] DB: ${dbPath}`)
  const database = new Database(dbPath)
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 5000')
  database.pragma('foreign_keys = ON')
  initializeSchema(database)
  return database
}

const db = openDatabase()

/* ─── Sync 초기화 ─── */
const syncLog = (msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(msg)
  try {
    const logPath = join(getAppDataPath(), 'sync.log')
    writeFileSync(logPath, line + '\n', { flag: 'a' })
  } catch { /* */ }
}

Sync.setLogFn(syncLog)

async function initSyncSession(): Promise<void> {
  if (config.authUser?.id) {
    Sync.setUserId(config.authUser.id)
    syncLog(`userId 복원: ${config.authUser.id}`)
  }

  const online = await Sync.initSync()
  syncLog(`initSync: online=${online}, lastSyncAt=${config.lastSyncAt}, userId=${Sync.getUserId()}`)

  if (!online) return

  // 1) 저장된 토큰으로 먼저 시도
  if (config.authToken && config.authRefreshToken) {
    await Sync.setAuthSession(config.authToken, config.authRefreshToken)
    syncLog('Supabase 세션 복원 시도')
  }

  // 2) service_role로 사용자 토큰 생성 (safeStorage 불가 대안)
  //    환경변수: WITION_EMAIL + WITION_PASSWORD (있으면 직접 로그인)
  //    없으면: config.authUser.id가 있고 service_role key가 있으면 admin API로 토큰 생성
  const email = process.env.WITION_EMAIL
  const password = process.env.WITION_PASSWORD
  const sbUrl = process.env.VITE_SUPABASE_URL!
  const sbKey = process.env.VITE_SUPABASE_ANON_KEY!
  const serviceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY

  if (email && password) {
    syncLog(`환경변수 credentials 로그인: ${email}`)
    const sb = createClient(sbUrl, sbKey)
    const { data, error } = await sb.auth.signInWithPassword({ email, password })
    if (data?.session) {
      Sync.setUserId(data.user!.id)
      await Sync.setAuthSession(data.session.access_token, data.session.refresh_token)
      config.authUser = { id: data.user!.id, email }
      config.authToken = data.session.access_token
      config.authRefreshToken = data.session.refresh_token
      saveConfig(config)
      syncLog(`로그인 성공: userId=${data.user!.id}`)
    } else {
      syncLog(`로그인 실패: ${error?.message}`)
    }
  } else if (config.authUser?.id && serviceKey) {
    // admin API로 해당 사용자의 세션 생성
    syncLog(`service_role admin 인증 시도: userId=${config.authUser.id}`)
    try {
      const sbAdmin = createClient(sbUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
      // admin.generateLink는 GoTrue admin API — 사용자 토큰을 직접 생성
      // 대안: service_role key로 모든 테이블 접근 가능하므로,
      // sync에서 auth check를 통과하도록 getUserById로 사용자 확인 후 토큰 발행
      const { data: userData } = await sbAdmin.auth.admin.getUserById(config.authUser.id)
      if (userData?.user) {
        // admin으로 impersonation 토큰 생성 (generateLink)
        const { data: linkData } = await sbAdmin.auth.admin.generateLink({
          type: 'magiclink',
          email: userData.user.email!
        })
        if (linkData?.properties?.hashed_token) {
          // magiclink 토큰으로 verifyOtp
          const sb2 = createClient(sbUrl, sbKey)
          const { data: otpData } = await sb2.auth.verifyOtp({
            token_hash: linkData.properties.hashed_token,
            type: 'magiclink'
          })
          if (otpData?.session) {
            await Sync.setAuthSession(otpData.session.access_token, otpData.session.refresh_token)
            config.authToken = otpData.session.access_token
            config.authRefreshToken = otpData.session.refresh_token
            saveConfig(config)
            syncLog(`admin 인증 성공 (magiclink): userId=${config.authUser.id}`)
          }
        }
      }
    } catch (authErr) {
      syncLog(`admin 인증 실패: ${authErr} — /sync에서 authFailed 반환 가능`)
    }
  }
}

/* ─── HTTP 서버 (기존 main.ts와 동일 인터페이스) ─── */
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Content-Type', 'application/json')
  const url = req.url || '/'

  try {
    if (url === '/sync' && req.method === 'POST') {
      for (let w = 0; w < 20 && Sync.isSyncing(); w++) {
        await new Promise(r => setTimeout(r, 500))
      }
      const { pulled, pushed, cleaned, syncedAt } = await Sync.fullSync(db, config.lastSyncAt)
      if (syncedAt > 0) { config.lastSyncAt = syncedAt; saveConfig(config) }
      res.end(JSON.stringify({ ok: true, pulled, pushed, cleaned }))

    } else if (url.startsWith('/query') && req.method === 'GET') {
      const u = new URL(req.url!, `http://localhost:${TEST_PORT}`)
      const sql = u.searchParams.get('sql')
      if (!sql) { res.end(JSON.stringify({ rows: [] })); return }

      const sqlFirst = sql.trim().split(/\s/)[0].toLowerCase()
      if (['drop', 'alter', 'create'].includes(sqlFirst)) {
        res.end(JSON.stringify({ error: 'forbidden' })); return
      }
      // 테스트 서버는 DDL만 차단, DML은 모두 허용 (테스트 전용 환경)
      if (sqlFirst === 'insert' || sqlFirst === 'update' || sqlFirst === 'delete') {
        const info = db.prepare(sql).run()
        res.end(JSON.stringify({ changes: info.changes }))
      } else {
        const rows = db.prepare(sql).all()
        res.end(JSON.stringify({ rows }))
      }

    } else if (url === '/ping') {
      res.end(JSON.stringify({ ok: true, time: Date.now(), server: 'headless-test' }))

    } else if (url === '/set-offline' && req.method === 'POST') {
      Sync.setOfflineForTest(true)
      res.end(JSON.stringify({ ok: true, offline: true }))

    } else if (url === '/set-online' && req.method === 'POST') {
      Sync.setOfflineForTest(false)
      res.end(JSON.stringify({ ok: true, offline: false }))

    } else if (url === '/shutdown' && req.method === 'POST') {
      res.end(JSON.stringify({ ok: true, msg: 'shutting down' }))
      setTimeout(() => process.exit(0), 100)

    } else {
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    }
  } catch (err) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String(err) }))
  }
})

/* ─── 시작 ─── */
async function main(): Promise<void> {
  await initSyncSession()

  server.listen(TEST_PORT, '127.0.0.1', () => {
    console.log(`\n[TestServer] ✅ http://127.0.0.1:${TEST_PORT} (Headless — Electron 불필요)`)
    console.log(`[TestServer] DB: ${join(config.dataPath, 'wition.db')}`)
    console.log(`[TestServer] User: ${config.authUser?.email ?? '(없음)'}`)
    console.log(`[TestServer] 종료: POST /shutdown 또는 Ctrl+C\n`)
  })

  server.on('error', (err) => {
    console.error(`[TestServer] ❌ 서버 시작 실패: ${err.message}`)
    process.exit(1)
  })
}

// 정상 종료 처리
process.on('SIGINT', () => {
  console.log('\n[TestServer] 종료 중...')
  db.close()
  server.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  db.close()
  server.close()
  process.exit(0)
})

main().catch(err => {
  console.error('[TestServer] 시작 실패:', err)
  process.exit(1)
})
