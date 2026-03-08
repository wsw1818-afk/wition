import { useEffect, useRef } from 'react'
import dayjs from 'dayjs'
import 'dayjs/locale/ko'
import { useSearchStore } from '../../stores/searchStore'
import { useCalendarStore } from '../../stores/calendarStore'
import { parseChecklist, parseTags, parseCallout, parseCodeBlock, parseToggle } from '../../types'

dayjs.locale('ko')

export function SearchPanel() {
  const { isOpen, query, results, loading, close, search } = useSearchStore()
  const { selectDate } = useCalendarStore()
  const inputRef = useRef<HTMLInputElement>(null)

  // 패널 열릴 때 입력 필드 포커스
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // ESC 키로 닫기
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        close()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, close])

  if (!isOpen) return null

  // 검색 결과 클릭 시 해당 날짜로 이동
  function handleResultClick(dayId: string) {
    selectDate(dayId)
    close()
  }

  // 내용 미리보기 생성
  function getPreview(item: { type: string; content: string }): string {
    switch (item.type) {
      case 'checklist': {
        const items = parseChecklist(item.content)
        return items.map(i => i.text).join(', ').slice(0, 60) || '(빈 체크리스트)'
      }
      case 'callout':
        return parseCallout(item.content).text.slice(0, 60) || '(빈 콜아웃)'
      case 'code':
        return parseCodeBlock(item.content).code.slice(0, 60) || '(빈 코드)'
      case 'toggle':
        return parseToggle(item.content).title.slice(0, 60) || '(빈 토글)'
      case 'divider':
        return '───────'
      default:
        return item.content.slice(0, 60)
    }
  }

  const BLOCK_LABELS: Record<string, string> = {
    checklist: '체크리스트', heading1: 'H1', heading2: 'H2', heading3: 'H3',
    bulleted_list: '목록', numbered_list: '번호목록', quote: '인용',
    divider: '구분선', callout: '콜아웃', code: '코드', toggle: '토글'
  }

  return (
    <div className="absolute inset-0 z-50 bg-white dark:bg-gray-900">
      {/* 헤더 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => search(e.target.value)}
          placeholder="검색어를 입력하세요..."
          className="flex-1 text-sm bg-transparent outline-none text-gray-800 dark:text-gray-200 placeholder-gray-400"
        />
        <button
          onClick={close}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 검색 결과 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">
            검색 중...
          </div>
        ) : query.trim() && results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
            <svg className="w-12 h-12 mb-3 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            "{query}"에 대한 검색 결과가 없습니다
          </div>
        ) : results.length > 0 ? (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {results.map((item) => (
              <button
                key={item.id}
                onClick={() => handleResultClick(item.day_id)}
                className="w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-gray-400">
                    {dayjs(item.day_id).format('YYYY년 M월 D일')}
                  </span>
                  {item.type !== 'text' && BLOCK_LABELS[item.type] && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-100 dark:bg-accent-500/20 text-accent-600 dark:text-accent-400">
                      {BLOCK_LABELS[item.type]}
                    </span>
                  )}
                  {item.pinned === 1 && (
                    <span className="text-accent-500">📌</span>
                  )}
                </div>
                <p className="text-sm text-gray-700 dark:text-gray-300 line-clamp-2">
                  {getPreview(item)}
                </p>
                {/* 태그 표시 */}
                {parseTags(item.tags).length > 0 && (
                  <div className="flex gap-1 mt-1.5">
                    {parseTags(item.tags).map((tag, i) => (
                      <span
                        key={i}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
            <svg className="w-12 h-12 mb-3 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            메모와 체크리스트를 검색하세요
          </div>
        )}
      </div>
    </div>
  )
}
