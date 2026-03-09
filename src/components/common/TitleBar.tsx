import { useSearchStore } from '../../stores/searchStore'

/** frameless 윈도우용 커스텀 타이틀바 */
export function TitleBar() {
  const { toggle: toggleSearch } = useSearchStore()

  return (
    <div
      className="titlebar-drag flex items-center justify-between h-9 px-3 bg-white dark:bg-gray-900
                 border-b border-gray-100 dark:border-gray-800 select-none"
    >
      <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 tracking-wide">
        Wition
      </span>

      <div className="titlebar-no-drag flex gap-0.5">
        {/* 검색 버튼 */}
        <button
          onClick={toggleSearch}
          className="w-8 h-6 flex items-center justify-center rounded hover:bg-gray-100
                     dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
          aria-label="검색"
          title="검색 (Ctrl+K)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </button>
        <button
          onClick={() => window.api.minimize()}
          className="w-8 h-6 flex items-center justify-center rounded hover:bg-gray-100
                     dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
          aria-label="최소화"
        >
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
        </button>
        <button
          onClick={() => window.api.maximize()}
          className="w-8 h-6 flex items-center justify-center rounded hover:bg-gray-100
                     dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
          aria-label="최대화"
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="0.5" y="0.5" width="8" height="8" rx="1" />
          </svg>
        </button>
        <button
          onClick={() => window.api.close()}
          className="w-8 h-6 flex items-center justify-center rounded hover:bg-red-500
                     hover:text-white text-gray-500 dark:text-gray-400 transition-colors"
          aria-label="닫기"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.3">
            <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      </div>
    </div>
  )
}
