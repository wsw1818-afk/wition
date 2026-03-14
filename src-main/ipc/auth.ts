/**
 * 인증 관련 IPC 핸들러
 * - GoTrue 회원가입/로그인/로그아웃/세션 확인
 * - 로그인 정보 기억 (safeStorage)
 * - 자동 로그인, 오프라인 로그인
 */
import { ipcMain, net, safeStorage, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import * as Q from '../db/queries'
import * as Sync from '../sync'

interface AppConfig {
  dataPath: string
  authToken?: string
  authRefreshToken?: string
  authUser?: { id: string; email: string }
  savedEmail?: string
  savedPasswordEnc?: string
  autoLogin?: boolean
  localAccounts?: Array<{ id: string; email: string; passwordEnc: string }>
  [key: string]: unknown
}

interface AuthDeps {
  getDb: () => Database.Database
  setDb: (db: Database.Database) => void
  config: AppConfig
  saveConfig: (cfg: AppConfig) => void
  openDatabase: (userId?: string) => Database.Database
  migrateToUserDb: (userId: string) => void
  setDbOwnerId: (db: Database.Database, userId: string) => void
  saveLocalAccount: (userId: string, email: string, password: string) => void
  verifyLocalPassword: (account: { passwordEnc: string }, password: string) => boolean
  AUTH_URLS: string[]
  AUTH_KEY: string
}

let AUTH_BASE: string
let deps: AuthDeps

async function authFetch(path: string, opts: { method?: string; body?: unknown; token?: string; timeout?: number } = {}) {
  const url = `${AUTH_BASE}/auth/v1${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'apikey': deps.AUTH_KEY || '',
  }
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? 5000)
  try {
    const res = await net.fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) } }
    catch { return { ok: res.ok, status: res.status, data: text } }
  } finally {
    clearTimeout(timer)
  }
}

async function detectAuthBase() {
  for (const base of deps.AUTH_URLS) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const res = await net.fetch(`${base}/auth/v1/`, {
        method: 'GET',
        headers: { 'apikey': deps.AUTH_KEY || '' },
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (res.status >= 200 && res.status < 500) {
        AUTH_BASE = base
        console.log('[auth] 서버 연결:', base, '(status:', res.status + ')')
        return
      }
    } catch { /* 다음 URL 시도 */ }
  }
  console.warn('[auth] 모든 서버 연결 실패, 기본값 사용:', AUTH_BASE)
}

/** 외부에서 사용: autoReLogin */
export async function autoReLogin(d: AuthDeps): Promise<boolean> {
  if (!d.config.savedEmail || !d.config.savedPasswordEnc) return false
  try {
    let password: string
    if (safeStorage.isEncryptionAvailable()) {
      password = safeStorage.decryptString(Buffer.from(d.config.savedPasswordEnc, 'base64'))
    } else {
      password = Buffer.from(d.config.savedPasswordEnc, 'base64').toString()
    }
    const authUrls = [
      AUTH_BASE,
      process.env.VITE_SUPABASE_URL,
      'http://localhost:8000',
      'http://100.122.232.19:8000',
      'http://192.168.45.152:8000',
    ].filter((v, i, a) => v && a.indexOf(v) === i) as string[]
    const authKey = process.env.VITE_SUPABASE_ANON_KEY || ''
    let fetchRes: Response | null = null
    for (const base of authUrls) {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 5000)
        fetchRes = await net.fetch(`${base}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': authKey },
          body: JSON.stringify({ email: d.config.savedEmail, password }),
          signal: ctrl.signal,
        })
        clearTimeout(t)
        if (fetchRes.status > 0) break
      } catch { fetchRes = null }
    }
    if (!fetchRes) return false
    const text = await fetchRes.text()
    let data: Record<string, unknown>
    try { data = JSON.parse(text) } catch { data = {} }
    if (!fetchRes.ok) return false
    const { access_token, refresh_token, user } = data as any
    d.config.authToken = access_token
    d.config.authRefreshToken = refresh_token
    d.config.authUser = { id: user.id, email: user.email }
    d.saveConfig(d.config)
    Sync.setUserId(user.id)
    await Sync.setAuthSession(access_token, refresh_token)
    return true
  } catch {
    return false
  }
}

export function getAuthBase(): string {
  return AUTH_BASE
}

export function registerAuthHandlers(d: AuthDeps): void {
  deps = d
  AUTH_BASE = d.AUTH_URLS[0]

  detectAuthBase()

  // 회원가입
  ipcMain.handle('auth:signup', async (_e, email: string, password: string) => {
    try {
      console.log('[auth:signup] URL:', `${AUTH_BASE}/auth/v1/signup`, 'KEY:', deps.AUTH_KEY?.slice(0, 20) + '...')
      const res = await authFetch('/signup', {
        method: 'POST',
        body: { email, password }
      })
      console.log('[auth:signup] status:', res.status, 'ok:', res.ok, 'data:', JSON.stringify(res.data).slice(0, 200))
      if (!res.ok) return { ok: false, error: res.data?.msg || res.data?.error_description || '회원가입 실패' }
      return { ok: true }
    } catch (err) {
      console.error('[auth:signup] error:', err)
      return { ok: false, error: `서버 연결 실패: ${err}` }
    }
  })

  // 로그인 (다중 기기 세션 허용)
  ipcMain.handle('auth:login', async (_e, email: string, password: string) => {
    try {
      const res = await authFetch('/token?grant_type=password', {
        method: 'POST',
        body: { email, password }
      })
      if (!res.ok) return { ok: false, error: res.data?.msg || res.data?.error_description || '로그인 실패' }

      const token = res.data.access_token
      const refresh = res.data.refresh_token
      const user = res.data.user

      // config에 저장
      deps.config.authToken = token
      deps.config.authRefreshToken = refresh
      deps.config.authUser = { id: user.id, email: user.email }
      deps.saveConfig(deps.config)

      // 사용자별 DB로 전환
      try { deps.getDb()?.close() } catch {}
      deps.migrateToUserDb(user.id)
      const newDb = deps.openDatabase(user.id)
      deps.setDb(newDb)
      deps.setDbOwnerId(newDb, user.id)
      Q.refreshAllSummaries(newDb)

      // 로컬 계정 레지스트리에 저장 (오프라인 로그인용)
      deps.saveLocalAccount(user.id, user.email, password)

      // 동기화에 사용자 ID + GoTrue 세션 전달
      Sync.setUserId(user.id)
      await Sync.setAuthSession(token, refresh)

      return { ok: true, user: { id: user.id, email: user.email } }
    } catch (err) {
      return { ok: false, error: `서버 연결 실패: ${err}` }
    }
  })

  // 로그아웃 (현재 기기만 — 다른 기기 세션 유지)
  ipcMain.handle('auth:logout', async () => {
    try {
      const token = deps.config.authToken
      if (token) {
        await authFetch('/logout?scope=local', { method: 'POST', token })
      }
    } catch { /* 무시 */ }
    deps.config.authToken = undefined
    deps.config.authRefreshToken = undefined
    deps.config.authUser = undefined
    deps.saveConfig(deps.config)
    Sync.setUserId(null)
    await Sync.clearAuthSession()
    // DB를 닫고 빈 임시 DB로 전환 (로그인 화면에서는 DB 불필요)
    try { deps.getDb()?.close() } catch {}
    deps.setDb(deps.openDatabase())  // userId 없이 → wition.db (로그인 전 임시)
    return { ok: true }
  })

  // 현재 세션 확인
  ipcMain.handle('auth:getSession', async () => {
    const token = deps.config.authToken
    const refreshToken = deps.config.authRefreshToken
    const user = deps.config.authUser

    if (!token || !user) {
      Sync.setUserId(null)
      return { authenticated: false }
    }
    try {
      const res = await authFetch('/user', { token })
      if (res.ok) {
        Sync.setUserId(user.id)
        if (refreshToken) await Sync.setAuthSession(token, refreshToken)
        return { authenticated: true, user }
      }
      // 토큰 만료 → refresh 시도
      if (refreshToken) {
        const refresh = await authFetch('/token?grant_type=refresh_token', {
          method: 'POST',
          body: { refresh_token: refreshToken }
        })
        if (refresh.ok) {
          deps.config.authToken = refresh.data.access_token
          deps.config.authRefreshToken = refresh.data.refresh_token
          deps.config.authUser = { id: refresh.data.user.id, email: refresh.data.user.email }
          deps.saveConfig(deps.config)
          Sync.setUserId(refresh.data.user.id)
          await Sync.setAuthSession(refresh.data.access_token, refresh.data.refresh_token)
          return { authenticated: true, user: deps.config.authUser }
        }
      }
      // refresh도 실패 → 로그아웃
      deps.config.authToken = undefined
      deps.config.authRefreshToken = undefined
      deps.config.authUser = undefined
      deps.saveConfig(deps.config)
      Sync.setUserId(null)
      return { authenticated: false, reason: 'session_expired' }
    } catch {
      // 서버 연결 불가 → 오프라인 인증
      Sync.setUserId(user.id)
      return { authenticated: true, user, offline: true }
    }
  })

  // ── 로그인 정보 기억 (safeStorage 암호화) ──
  ipcMain.handle('auth:saveCredentials', (_e, email: string, password: string) => {
    try {
      deps.config.savedEmail = email
      if (safeStorage.isEncryptionAvailable()) {
        deps.config.savedPasswordEnc = safeStorage.encryptString(password).toString('base64')
      } else {
        deps.config.savedPasswordEnc = Buffer.from(password).toString('base64')
      }
      deps.saveConfig(deps.config)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('auth:getCredentials', () => {
    if (!deps.config.savedEmail || !deps.config.savedPasswordEnc) return { ok: false }
    try {
      let password: string
      if (safeStorage.isEncryptionAvailable()) {
        password = safeStorage.decryptString(Buffer.from(deps.config.savedPasswordEnc, 'base64'))
      } else {
        password = Buffer.from(deps.config.savedPasswordEnc, 'base64').toString()
      }
      return { ok: true, email: deps.config.savedEmail, password }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('auth:clearCredentials', () => {
    deps.config.savedEmail = undefined
    deps.config.savedPasswordEnc = undefined
    deps.saveConfig(deps.config)
    return { ok: true }
  })

  // ── 자동 로그인 설정 ──
  ipcMain.handle('auth:getAutoLogin', () => {
    return deps.config.autoLogin ?? false
  })

  ipcMain.handle('auth:setAutoLogin', (_e, enabled: boolean) => {
    deps.config.autoLogin = enabled
    deps.saveConfig(deps.config)
    return { ok: true }
  })

  // ── 오프라인 로그인 ──
  ipcMain.handle('auth:getLocalAccounts', () => {
    return (deps.config.localAccounts || []).map(a => ({ id: a.id, email: a.email }))
  })

  ipcMain.handle('auth:offlineLogin', (_e, userId: string, password: string) => {
    const account = (deps.config.localAccounts || []).find(a => a.id === userId)
    if (!account) return { ok: false, error: '저장된 계정을 찾을 수 없습니다.' }
    if (!deps.verifyLocalPassword(account, password)) return { ok: false, error: '비밀번호가 일치하지 않습니다.' }

    // 사용자별 DB로 전환
    deps.config.authUser = { id: account.id, email: account.email }
    deps.saveConfig(deps.config)
    try { deps.getDb()?.close() } catch {}
    const newDb = deps.openDatabase(account.id)
    deps.setDb(newDb)
    deps.setDbOwnerId(newDb, account.id)
    Q.refreshAllSummaries(newDb)
    Sync.setUserId(account.id)

    return { ok: true, user: { id: account.id, email: account.email } }
  })
}
