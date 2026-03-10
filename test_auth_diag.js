/**
 * 로그인/인증 문제 종합 진단 스크립트
 */
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')

const SUPABASE_URL = 'http://localhost:8000'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

const configPath = 'C:/Users/wsw18/AppData/Roaming/wition/config.json'

async function diagnose() {
  console.log('╔══════════════════════════════════════╗')
  console.log('║   Wition 인증 진단 테스트            ║')
  console.log('╚══════════════════════════════════════╝\n')

  // 1. Config 확인
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    console.log('=== 1. Config 상태 ===')
    console.log('  authUser:', JSON.stringify(config.authUser))
    console.log('  authToken 존재:', config.authToken ? 'YES' : 'NO')
    console.log('  authRefreshToken 존재:', config.authRefreshToken ? 'YES' : 'NO')
    if (config.authToken) {
      const payload = JSON.parse(Buffer.from(config.authToken.split('.')[1], 'base64').toString())
      const expDate = new Date(payload.exp * 1000)
      const expired = Date.now() > payload.exp * 1000
      console.log('  토큰 만료 시각:', expDate.toISOString())
      console.log('  토큰 상태:', expired ? '❌ 만료됨' : '✅ 유효')
      console.log('  토큰 user_id (sub):', payload.sub)
    }
  } catch (e) {
    console.log('Config 읽기 실패:', e.message)
    return
  }

  // 2. 서버 연결
  console.log('\n=== 2. 서버 연결 테스트 ===')
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/', {
      method: 'HEAD',
      headers: { 'apikey': ANON_KEY },
      signal: AbortSignal.timeout(3000)
    })
    console.log('  REST API:', res.status === 200 ? '✅ 정상' : `⚠️ 상태 ${res.status}`)
  } catch (e) {
    console.log('  REST API: ❌ 연결 실패 -', e.message)
    console.log('\n  ⚠️ Supabase 서버가 실행 중이지 않습니다!')
    console.log('  → docker compose up -d 또는 supabase start 실행 필요')
    return
  }

  // 3. GoTrue 상태
  console.log('\n=== 3. GoTrue (인증 서비스) 상태 ===')
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/', {
      headers: { 'apikey': ANON_KEY }
    })
    const data = await res.json().catch(() => null)
    console.log('  GoTrue 상태:', res.status)
    if (data) console.log('  응답:', JSON.stringify(data).slice(0, 100))
  } catch (e) {
    console.log('  GoTrue: ❌ 연결 실패')
  }

  const sb = createClient(SUPABASE_URL, ANON_KEY)

  // 4. 리프레시 토큰 갱신
  if (config.authRefreshToken) {
    console.log('\n=== 4. 리프레시 토큰 갱신 시도 ===')
    try {
      const { data, error } = await sb.auth.refreshSession({
        refresh_token: config.authRefreshToken
      })
      if (error) {
        console.log('  갱신 결과: ❌ 실패 -', error.message)
        console.log('  → 리프레시 토큰도 만료됨. 재로그인 필요.')
      } else if (data.session) {
        console.log('  갱신 결과: ✅ 성공!')
        const newPayload = JSON.parse(Buffer.from(data.session.access_token.split('.')[1], 'base64').toString())
        console.log('  새 토큰 만료:', new Date(newPayload.exp * 1000).toISOString())
        console.log('  user_id:', data.user.id)
        console.log('  email:', data.user.email)

        // config.json 업데이트
        config.authToken = data.session.access_token
        config.authRefreshToken = data.session.refresh_token
        config.authUser = { id: data.user.id, email: data.user.email }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
        console.log('  ✅ config.json 업데이트 완료')
      }
    } catch (e) {
      console.log('  갱신 예외:', e.message)
    }
  } else {
    console.log('\n=== 4. 리프레시 토큰 없음 → 재로그인 필요 ===')
  }

  // 5. 사용자 목록 (service_role)
  console.log('\n=== 5. 등록된 사용자 목록 (admin) ===')
  const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`
      }
    })
    const data = await res.json()
    if (data.users && data.users.length > 0) {
      data.users.forEach((u, i) => {
        console.log(`  [${i + 1}] id: ${u.id}, email: ${u.email}, confirmed: ${u.email_confirmed_at ? 'YES' : 'NO'}`)
      })
    } else {
      console.log('  등록된 사용자 없음')
    }
  } catch (e) {
    console.log('  사용자 목록 조회 실패:', e.message)
  }

  // 6. Supabase JS 클라이언트로 getUser 테스트
  if (config.authToken) {
    console.log('\n=== 6. getUser 테스트 (현재 토큰) ===')
    try {
      // 세션 설정
      await sb.auth.setSession({
        access_token: config.authToken,
        refresh_token: config.authRefreshToken || ''
      })
      const { data, error } = await sb.auth.getUser()
      if (error) {
        console.log('  getUser: ❌', error.message)
      } else {
        console.log('  getUser: ✅ user_id =', data.user.id, 'email =', data.user.email)
      }
    } catch (e) {
      console.log('  getUser 예외:', e.message)
    }
  }

  // 7. RLS 데이터 조회 테스트
  console.log('\n=== 7. RLS 데이터 조회 테스트 ===')
  try {
    if (config.authToken) {
      await sb.auth.setSession({
        access_token: config.authToken,
        refresh_token: config.authRefreshToken || ''
      })
    }
    const userId = config.authUser?.id
    if (userId) {
      const { data, error } = await sb.from('note_item').select('id').eq('user_id', userId).limit(5)
      if (error) {
        console.log('  RLS 조회: ❌', error.message)
      } else {
        console.log('  RLS 조회: ✅', data.length, '건 (user_id=' + userId + ')')
      }
    } else {
      console.log('  RLS 조회: ⚠️ user_id 없음')
    }
  } catch (e) {
    console.log('  RLS 조회 예외:', e.message)
  }

  // 8. 앱 auth:getSession 시뮬레이션
  console.log('\n=== 8. auth:getSession 시뮬레이션 ===')
  const token = config.authToken
  const refreshToken = config.authRefreshToken
  const user = config.authUser

  if (!token || !user) {
    console.log('  결과: ❌ authenticated=false (토큰 또는 user 없음)')
    console.log('  → 앱에서 로그인 화면이 표시됩니다.')
  } else {
    try {
      const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
        headers: {
          'apikey': ANON_KEY,
          'Authorization': `Bearer ${token}`
        }
      })
      if (res.ok) {
        console.log('  결과: ✅ authenticated=true (토큰 유효)')
        console.log('  → 앱에서 정상 로그인됩니다.')
      } else {
        console.log('  토큰 검증 실패 (상태:', res.status, ') → refresh 시도')
        if (refreshToken) {
          const refreshRes = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken })
          })
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json()
            config.authToken = refreshData.access_token
            config.authRefreshToken = refreshData.refresh_token
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
            console.log('  결과: ✅ refresh 성공 → config.json 업데이트')
            console.log('  → 앱 재시작하면 정상 로그인됩니다.')
          } else {
            const errData = await refreshRes.json().catch(() => ({}))
            console.log('  결과: ❌ refresh도 실패 -', errData.error_description || errData.msg || refreshRes.status)
            console.log('  → 앱에서 로그인 화면이 표시됩니다. 비밀번호 재입력 필요.')
          }
        } else {
          console.log('  결과: ❌ refreshToken 없음 → 재로그인 필요')
        }
      }
    } catch (e) {
      console.log('  결과: ⚠️ 서버 연결 실패 → 오프라인 모드 (authenticated=true, offline=true)')
      console.log('  → 로컬 데이터는 사용 가능, 동기화 불가')
    }
  }

  console.log('\n╔══════════════════════════════════════╗')
  console.log('║   진단 완료                          ║')
  console.log('╚══════════════════════════════════════╝')
}

diagnose().catch(console.error)
