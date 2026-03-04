import { useEffect, useState, useCallback } from 'react'
import { TitleBar } from './components/common/TitleBar'
import { CalendarView } from './components/Calendar/CalendarView'
import { DayDetailView } from './components/DayDetail/DayDetailView'
import { SearchPanel } from './components/Search/SearchPanel'
import { useCalendarStore } from './stores/calendarStore'
import { useSearchStore } from './stores/searchStore'

export default function App() {
  const selectedDate = useCalendarStore((s) => s.selectedDate)
  const goToToday = useCalendarStore((s) => s.goToToday)
  const loadMonth = useCalendarStore((s) => s.loadMonth)
  const currentMonth = useCalendarStore((s) => s.currentMonth)
  const [darkMode, setDarkMode] = useState(false)
  const [dataPath, setDataPath] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [autoBackup, setAutoBackup] = useState(true)
  const [backupPath, setBackupPath] = useState('')

  // 초기 다크모드 감지 + 저장 경로 로드
  useEffect(() => {
    window.api.isDarkMode().then((isDark) => {
      setDarkMode(isDark)
      document.documentElement.classList.toggle('dark', isDark)
    })
    window.api.getDataPath().then(setDataPath)
    window.api.getAutoLaunch().then(setAutoLaunch)
    window.api.getBackupConfig().then((cfg) => {
      setAutoBackup(cfg.autoBackup)
      setBackupPath(cfg.backupPath)
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

      <div className="flex-1 flex overflow-hidden relative">
        {/* 검색 패널 (오버레이) */}
        <SearchPanel />

        {/* 좌측: 달력 (항상 표시) */}
        <div
          className={`flex-shrink-0 flex flex-col border-r border-gray-100 dark:border-gray-800 transition-all duration-200
            ${selectedDate ? 'w-[420px]' : 'w-full'}`}
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
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                ⚙ 설정
              </button>
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
              </div>
            )}
          </div>
        </div>

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
