import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { TitleBar } from './components/common/TitleBar'
import { CalendarView } from './components/Calendar/CalendarView'
import { DayDetailView } from './components/DayDetail/DayDetailView'
import { SearchPanel } from './components/Search/SearchPanel'
import { HelpPanel } from './components/common/HelpPanel'
import { LoginScreen } from './components/auth/LoginScreen'
import { useCalendarStore } from './stores/calendarStore'
import { useDayStore } from './stores/dayStore'
import { useSearchStore } from './stores/searchStore'
import type { AuthUser } from './types'

export default function App() {
  const [authChecking, setAuthChecking] = useState(true)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)

  // 앱 시작 시: 자동 로그인 설정이 켜져있으면 세션 확인, 아니면 로그인 화면
  useEffect(() => {
    window.api.authGetAutoLogin().then(async (autoLogin) => {
      if (autoLogin) {
        try {
          const session = await window.api.authGetSession()
          if (session.authenticated && session.user) {
            setAuthUser(session.user)
          }
        } catch { /* 세션 확인 실패 → 로그인 화면 */ }
      }
      setAuthChecking(false)
    }).catch(() => setAuthChecking(false))
  }, [])

  // 로그인 전 로딩 화면
  if (authChecking) {
    return (
      <div className="flex items-center justify-center h-screen bg-white dark:bg-gray-900">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-300 dark:text-gray-600 mb-2">Wition</h1>
          <p className="text-xs text-gray-400">로딩 중...</p>
        </div>
      </div>
    )
  }

  // 로그인 안 됐으면 로그인 화면
  if (!authUser) {
    return <LoginScreen onLogin={(user) => setAuthUser(user)} />
  }

  return <MainApp authUser={authUser} onLogout={() => setAuthUser(null)} />
}

function MainApp({ authUser, onLogout }: { authUser: AuthUser; onLogout: () => void }) {
  const selectedDate = useCalendarStore((s) => s.selectedDate)
  const goToToday = useCalendarStore((s) => s.goToToday)
  const loadMonth = useCalendarStore((s) => s.loadMonth)
  const currentMonth = useCalendarStore((s) => s.currentMonth)
  const [darkMode, setDarkMode] = useState(false)
  const [dataPath, setDataPath] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [closeToTray, setCloseToTray] = useState(false)
  const [autoBackup, setAutoBackup] = useState(true)
  const [backupPath, setBackupPath] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const [calendarWidth, setCalendarWidth] = useState(420)
  const calendarWidthRef = useRef(420)
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const [syncStatus, setSyncStatus] = useState<'offline' | 'online' | 'syncing' | 'error'>('offline')
  const [onedrivePath, setOnedrivePath] = useState('')
  const [onedriveEnabled, setOnedriveEnabled] = useState(false)
  const [initialSyncDone, setInitialSyncDone] = useState(false)

  const selectDate = useCalendarStore((s) => s.selectDate)

  // 앱 내부 알람 팝업
  const [alarmPopup, setAlarmPopup] = useState<{ id: string; day_id: string; time: string; label: string; repeat: string } | null>(null)

  // 알람 발동 이벤트 수신
  useEffect(() => {
    const unsub = window.api.onAlarmFire((alarm) => {
      setAlarmPopup(alarm)
      // 소리 재생
      try {
        const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgkKqrk2A2MF2Pp6iVYjk2YJKoqJNfNTNfl6enn180NmGVqaeTXjQzYJimppNfNjZhl6eml140NWCVpqaTXzU2YZeoqJNeNDRgl6aml180NmGXp6eUXjQ0YJamppdgNzZhl6enlF40NGCXpqeXYDc2YZenp5ReNDRgl6anl2A3NmGXp6eUXjQ0YA==')
        audio.volume = 0.5
        audio.play().catch(() => {})
      } catch {}
    })
    return unsub
  }, [])

  // 알람 알림 클릭 → 해당 날짜로 이동
  useEffect(() => {
    const unsub = window.api.onAlarmNavigate((dayId: string) => {
      const [y, m] = dayId.split('-')
      const month = `${y}-${m}`
      loadMonth(month)
      selectDate(dayId)
    })
    return unsub
  }, [loadMonth, selectDate])

  // 동기화 상태 리스너
  useEffect(() => {
    window.api.getSyncStatus().then((s: { online: boolean; reachable: boolean }) => {
      const status = s.online && s.reachable ? 'online' : 'offline'
      setSyncStatus(status)
      // 오프라인이면 sync를 기다릴 필요 없음
      if (status === 'offline') setInitialSyncDone(true)
    })
    const unsub = window.api.onSyncStatus((status: string) => {
      setSyncStatus(status as 'offline' | 'online' | 'syncing' | 'error')
    })
    return unsub
  }, [])

  // 첫 sync 완료 대기 (최대 8초 → 타임아웃 시 그냥 표시)
  useEffect(() => {
    const timer = setTimeout(() => setInitialSyncDone(true), 8000)
    return () => clearTimeout(timer)
  }, [])

  // 동기화 완료 시 달력 + 현재 날짜 데이터 새로고침
  // 방법1: preload IPC (기존)
  useEffect(() => {
    const unsub = window.api.onSyncDone(() => {
      const dayId = useDayStore.getState().dayId
      console.log('[sync:done IPC] 수신 — dayId:', dayId)
      if (!initialSyncDone) setInitialSyncDone(true)
      loadMonth(currentMonth)
      if (dayId) useDayStore.getState().load(dayId)
    })
    return unsub
  }, [currentMonth, loadMonth, initialSyncDone])

  // 방법2: executeJavaScript → window 이벤트 (IPC 우회, 확실한 방법)
  useEffect(() => {
    // 현재 dayId를 window에 노출 (디버그용)
    const state = useDayStore.getState()
    ;(window as any).__dayStore_dayId = state.dayId || 'none'
  })

  useEffect(() => {
    const handler = () => {
      const dayId = useDayStore.getState().dayId
      console.log('[sync-refresh] window 이벤트 수신 — dayId:', dayId)
      ;(window as any).__syncRefreshCount = ((window as any).__syncRefreshCount || 0) + 1
      loadMonth(currentMonth)
      if (dayId) {
        useDayStore.getState().load(dayId).then(() => {
          console.log('[sync-refresh] load 완료 — items:', useDayStore.getState().items.length)
        })
      }
    }
    window.addEventListener('sync-refresh', handler)
    return () => window.removeEventListener('sync-refresh', handler)
  }, [currentMonth, loadMonth])

  // 초기 다크모드 감지 + 저장 경로 로드
  useEffect(() => {
    window.api.isDarkMode().then((isDark) => {
      setDarkMode(isDark)
      document.documentElement.classList.toggle('dark', isDark)
    })
    window.api.getDataPath().then(setDataPath)
    window.api.getAutoLaunch().then(setAutoLaunch)
    window.api.getCloseToTray().then(setCloseToTray)
    window.api.getBackupConfig().then((cfg) => {
      setAutoBackup(cfg.autoBackup)
      setBackupPath(cfg.backupPath)
    })
    window.api.getCalendarWidth().then((w) => {
      setCalendarWidth(w)
      calendarWidthRef.current = w
    })
    window.api.onedriveGetConfig().then((cfg) => {
      setOnedriveEnabled(cfg.enabled)
      setOnedrivePath(cfg.path)
    })
  }, [])

  const toggleDark = useCallback(() => {
    setDarkMode((prev) => {
      const next = !prev
      document.documentElement.classList.toggle('dark', next)
      // 영속화: next가 true면 'dark', false면 'light'
      window.api.setDarkMode(next ? 'dark' : 'light')
      return next
    })
  }, [])

  // 구분선 드래그 핸들러
  const dividerRef = useRef<HTMLDivElement>(null)
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = calendarWidthRef.current
    const maxW = window.innerWidth - 300 // 메모장 최소 300px 보장

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const w = Math.min(Math.max(startW + delta, 180), maxW)
      calendarWidthRef.current = w
      setCalendarWidth(w)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const line = dividerRef.current?.querySelector('.absolute.inset-y-0.left-1\\/2') as HTMLElement | null
      if (line) { line.style.width = ''; line.style.background = '' }
      window.api.setCalendarWidth(calendarWidthRef.current)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const line = dividerRef.current?.querySelector('.absolute.inset-y-0.left-1\\/2') as HTMLElement | null
    if (line) { line.style.width = '4px'; line.style.background = 'rgb(99,102,241)' }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // 전역 키보드 단축키
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        useSearchStore.getState().toggle()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault()
        goToToday()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault()
        toggleDark()
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [goToToday, toggleDark])

  async function handleChangeDataPath() {
    const newPath = await window.api.changeDataPath()
    if (newPath) {
      setDataPath(newPath)
      // 경로 변경 후 달력 새로고침 (#13)
      await loadMonth(currentMonth)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-900">
      <TitleBar />

      {/* 첫 동기화 완료 전 로딩 오버레이 */}
      {!initialSyncDone && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm">
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400">동기화 중...</p>
          </div>
        </div>
      )}

      {/* 알람 팝업 */}
      {alarmPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-in fade-in">
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4 border border-gray-200 dark:border-gray-700">
            <div className="text-center">
              <div className="text-4xl mb-3">🔔</div>
              <p className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-1">알람</p>
              <p className="text-2xl font-mono text-blue-600 dark:text-blue-400 mb-2">{alarmPopup.time}</p>
              <p className="text-base text-gray-600 dark:text-gray-300 mb-4">
                {alarmPopup.label || '알람 시간입니다!'}
              </p>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={() => {
                    const [y, m] = alarmPopup.day_id.split('-')
                    loadMonth(`${y}-${m}`)
                    selectDate(alarmPopup.day_id)
                    setAlarmPopup(null)
                  }}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors"
                >
                  해당 날짜 보기
                </button>
                <button
                  onClick={() => setAlarmPopup(null)}
                  className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
                >
                  확인
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 도움말 패널 (오버레이) */}
      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}

      <div className="flex-1 flex overflow-hidden relative">
        {/* 검색 패널 (오버레이) */}
        <SearchPanel />

        {/* 좌측: 달력 (항상 표시) */}
        <div
          className={`flex-shrink-0 flex flex-col border-r border-gray-100 dark:border-gray-800
            ${selectedDate ? '' : 'w-full'}`}
          style={selectedDate ? { width: calendarWidth } : undefined}
        >
          <div className="flex-1 min-h-0 overflow-y-auto">
            <CalendarView />
          </div>

          {/* 하단: 설정 */}
          <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800">
            <div className="flex items-center justify-between">
              <button
                onClick={toggleDark}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                {darkMode ? '☀️ 라이트 모드' : '🌙 다크 모드'}
              </button>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowHelp(true)}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  ? 도움말
                </button>
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  ⚙ 설정
                </button>
              </div>
            </div>

            {showSettings && (
              <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 space-y-2.5">
                {/* 저장 경로 */}
                <div className="space-y-1">
                  <p className="text-[11px] text-gray-400 dark:text-gray-500">저장 경로</p>
                  <p className="text-[11px] text-gray-600 dark:text-gray-300 break-all leading-relaxed">{dataPath}</p>
                  <div className="flex gap-2">
                    <SettingsBtn onClick={handleChangeDataPath}>경로 변경</SettingsBtn>
                    <SettingsBtn onClick={() => window.api.openDataFolder()}>폴더 열기</SettingsBtn>
                  </div>
                </div>

                {/* 자동실행 */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoLaunch}
                    onChange={(e) => {
                      setAutoLaunch(e.target.checked)
                      window.api.setAutoLaunch(e.target.checked)
                    }}
                    className="w-3.5 h-3.5 accent-accent-500"
                  />
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">Windows 시작 시 자동 실행</span>
                </label>

                {/* 닫기 시 트레이로 최소화 */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={closeToTray}
                    onChange={(e) => {
                      setCloseToTray(e.target.checked)
                      window.api.setCloseToTray(e.target.checked)
                    }}
                    className="w-3.5 h-3.5 accent-accent-500"
                  />
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">닫기 시 트레이로 최소화</span>
                </label>

                {/* 데이터 내보내기/가져오기 */}
                <div className="flex gap-2">
                  <SettingsBtn onClick={async () => {
                    const path = await window.api.exportData()
                    if (path) alert(`내보내기 완료: ${path}`)
                  }}>내보내기</SettingsBtn>
                  <SettingsBtn onClick={async () => {
                    const ok = await window.api.importData()
                    if (ok) {
                      await loadMonth(currentMonth)
                      alert('가져오기 완료!')
                    }
                  }}>가져오기</SettingsBtn>
                </div>

                {/* 자동 백업 */}
                <div className="space-y-1 pt-1 border-t border-gray-100 dark:border-gray-800">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoBackup}
                      onChange={(e) => {
                        setAutoBackup(e.target.checked)
                        window.api.setBackupConfig({ autoBackup: e.target.checked })
                      }}
                      className="w-3.5 h-3.5 accent-accent-500"
                    />
                    <span className="text-[11px] text-gray-500 dark:text-gray-400">자동 백업 (30분마다)</span>
                  </label>
                  <p className="text-[11px] text-gray-600 dark:text-gray-300 break-all leading-relaxed">{backupPath}</p>
                  <div className="flex gap-2">
                    <SettingsBtn onClick={async () => {
                      const newPath = await window.api.changeBackupPath()
                      if (newPath) setBackupPath(newPath)
                    }}>백업 경로 변경</SettingsBtn>
                    <SettingsBtn onClick={async () => {
                      await window.api.runBackupNow()
                      alert('백업 완료!')
                    }}>지금 백업</SettingsBtn>
                  </div>
                </div>

                {/* 클라우드 동기화 */}
                <div className="space-y-1 pt-1 border-t border-gray-100 dark:border-gray-800">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${
                      syncStatus === 'online' ? 'bg-green-400' :
                      syncStatus === 'syncing' ? 'bg-blue-400 animate-pulse' :
                      syncStatus === 'error' ? 'bg-red-400' :
                      'bg-gray-400'
                    }`} />
                    <span className="text-[11px] text-gray-500 dark:text-gray-400">
                      {syncStatus === 'online' ? '동기화 연결됨' :
                       syncStatus === 'syncing' ? '동기화 중...' :
                       syncStatus === 'error' ? '동기화 오류' :
                       '오프라인 (OneDrive 모드)'}
                    </span>
                  </div>
                  <SettingsBtn onClick={async () => {
                    setSyncStatus('syncing')
                    const res = await window.api.syncNow()
                    if (res.ok) {
                      setSyncStatus('online')
                      await loadMonth(currentMonth)
                    } else {
                      setSyncStatus(syncStatus === 'online' ? 'online' : 'offline')
                    }
                  }}>지금 동기화</SettingsBtn>
                </div>

                {/* OneDrive DB 동기화 */}
                <div className="space-y-1 pt-1 border-t border-gray-100 dark:border-gray-800">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={onedriveEnabled}
                      onChange={async (e) => {
                        const enabled = e.target.checked
                        if (enabled && !onedrivePath) {
                          const res = await window.api.onedriveSetPath()
                          if (res.ok && res.path) {
                            setOnedrivePath(res.path)
                            setOnedriveEnabled(true)
                          }
                        } else {
                          await window.api.onedriveSetEnabled(enabled)
                          setOnedriveEnabled(enabled)
                        }
                      }}
                      className="w-3.5 h-3.5 accent-accent-500"
                    />
                    <span className="text-[11px] text-gray-500 dark:text-gray-400">OneDrive DB 동기화</span>
                  </label>
                  {onedrivePath && (
                    <p className="text-[11px] text-gray-600 dark:text-gray-300 break-all leading-relaxed">{onedrivePath}</p>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    <SettingsBtn onClick={async () => {
                      const res = await window.api.onedriveSetPath()
                      if (res.ok && res.path) {
                        setOnedrivePath(res.path)
                        setOnedriveEnabled(true)
                      }
                    }}>폴더 변경</SettingsBtn>
                    <SettingsBtn onClick={async () => {
                      const res = await window.api.onedriveExport()
                      alert(res.ok ? 'OneDrive로 내보내기 완료!' : `실패: ${res.error}`)
                    }}>지금 내보내기</SettingsBtn>
                    <SettingsBtn onClick={async () => {
                      if (!confirm('OneDrive의 DB로 현재 데이터를 덮어씁니다. 계속하시겠습니까?')) return
                      const res = await window.api.onedriveImport()
                      if (res.ok) {
                        await loadMonth(currentMonth)
                        alert('OneDrive에서 가져오기 완료!')
                      } else {
                        alert(`실패: ${res.error}`)
                      }
                    }}>가져오기</SettingsBtn>
                  </div>
                </div>

                {/* 계정 */}
                <div className="space-y-1 pt-1 border-t border-gray-100 dark:border-gray-800">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-400 dark:text-gray-500">계정:</span>
                    <span className="text-[11px] text-gray-600 dark:text-gray-300">{authUser.email}</span>
                  </div>
                  <SettingsBtn onClick={async () => {
                    await window.api.authLogout()
                    onLogout()
                  }}>로그아웃</SettingsBtn>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 구분선 (드래그로 너비 조절) */}
        {selectedDate && (
          <div
            ref={dividerRef}
            onMouseDown={handleDividerMouseDown}
            className="flex-shrink-0 cursor-col-resize group relative"
            style={{ width: 6 }}
          >
            {/* 실제 보이는 선 */}
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[2px]
                            bg-gray-200 dark:bg-gray-700
                            group-hover:w-[4px] group-hover:bg-accent-400
                            transition-all duration-150" />
            {/* 넓은 히트 영역 (투명) */}
            <div className="absolute inset-y-0 -left-3 -right-3" />
          </div>
        )}

        {/* 우측: 날짜 상세 (선택 시 슬라이드 인) */}
        {selectedDate && (
          <div className="flex-1 min-w-0">
            <DayDetailView />
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] px-2 py-1 rounded border border-gray-200 dark:border-gray-700
                 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
    >
      {children}
    </button>
  )
}
