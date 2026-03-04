import { useEffect, useState } from 'react'
import { TitleBar } from './components/common/TitleBar'
import { CalendarView } from './components/Calendar/CalendarView'
import { DayDetailView } from './components/DayDetail/DayDetailView'
import { SearchPanel } from './components/Search/SearchPanel'
import { useCalendarStore } from './stores/calendarStore'

export default function App() {
  const selectedDate = useCalendarStore((s) => s.selectedDate)
  const [darkMode, setDarkMode] = useState(false)
  const [dataPath, setDataPath] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  // 초기 다크모드 감지 + 저장 경로 로드
  useEffect(() => {
    window.api.isDarkMode().then((isDark) => {
      setDarkMode(isDark)
      document.documentElement.classList.toggle('dark', isDark)
    })
    window.api.getDataPath().then(setDataPath)
  }, [])

  function toggleDark() {
    setDarkMode((prev) => {
      const next = !prev
      document.documentElement.classList.toggle('dark', next)
      return next
    })
  }

  async function handleChangeDataPath() {
    const newPath = await window.api.changeDataPath()
    if (newPath) setDataPath(newPath)
  }

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-gray-900">
      <TitleBar />

      <div className="flex-1 flex overflow-hidden relative">
        {/* 검색 패널 (오버레이) */}
        <SearchPanel />

        {/* 좌측: 달력 (항상 표시) */}
        <div
          className={`flex-shrink-0 border-r border-gray-100 dark:border-gray-800 transition-all duration-200
            ${selectedDate ? 'w-[420px]' : 'w-full max-w-3xl mx-auto'}`}
        >
          <CalendarView />

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
              <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 space-y-1.5">
                <p className="text-[11px] text-gray-400 dark:text-gray-500">저장 경로</p>
                <p className="text-[11px] text-gray-600 dark:text-gray-300 break-all leading-relaxed">{dataPath}</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleChangeDataPath}
                    className="text-[11px] px-2 py-1 rounded border border-gray-200 dark:border-gray-700
                               text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    경로 변경
                  </button>
                  <button
                    onClick={() => window.api.openDataFolder()}
                    className="text-[11px] px-2 py-1 rounded border border-gray-200 dark:border-gray-700
                               text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    폴더 열기
                  </button>
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
