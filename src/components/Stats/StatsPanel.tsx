import { useEffect, useState } from 'react'
import dayjs from 'dayjs'

interface Props {
  onClose: () => void
}

interface DayStat { day: string; count: number }
interface MoodStat { mood: string; count: number }
interface TagStat { tag: string; count: number }

export function StatsPanel({ onClose }: Props) {
  const [yearMonth, setYearMonth] = useState(dayjs().format('YYYY-MM'))
  const [dailyStats, setDailyStats] = useState<DayStat[]>([])
  const [moodStats, setMoodStats] = useState<MoodStat[]>([])
  const [tagStats, setTagStats] = useState<TagStat[]>([])

  useEffect(() => {
    window.api.getMonthlyStats(yearMonth).then(setDailyStats)
    window.api.getMoodStats(yearMonth).then(setMoodStats)
  }, [yearMonth])

  useEffect(() => {
    window.api.getTagStats().then(setTagStats)
  }, [])

  const maxCount = Math.max(1, ...dailyStats.map(d => d.count))
  const daysInMonth = dayjs(yearMonth + '-01').daysInMonth()

  const goPrevMonth = () => setYearMonth(dayjs(yearMonth + '-01').subtract(1, 'month').format('YYYY-MM'))
  const goNextMonth = () => setYearMonth(dayjs(yearMonth + '-01').add(1, 'month').format('YYYY-MM'))

  const monthLabel = dayjs(yearMonth + '-01').format('YYYY년 M월')

  // dailyStats를 day 기준 맵으로 변환
  const dayCountMap: Record<string, number> = {}
  for (const d of dailyStats) {
    dayCountMap[d.day] = d.count
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto border border-gray-200 dark:border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">통계</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* 월별 메모 작성 빈도 */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">월별 메모 작성 빈도</h3>
              <div className="flex items-center gap-1">
                <button onClick={goPrevMonth} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><polyline points="15 18 9 12 15 6" /></svg>
                </button>
                <span className="text-xs text-gray-500 dark:text-gray-400 min-w-[80px] text-center">{monthLabel}</span>
                <button onClick={goNextMonth} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><polyline points="9 6 15 12 9 18" /></svg>
                </button>
              </div>
            </div>

            {/* CSS 막대 그래프 */}
            <div className="flex items-end gap-[2px] h-[100px]">
              {Array.from({ length: daysInMonth }, (_, i) => {
                const day = String(i + 1).padStart(2, '0')
                const dateStr = `${yearMonth}-${day}`
                const count = dayCountMap[dateStr] ?? 0
                const height = count > 0 ? Math.max(8, (count / maxCount) * 100) : 0

                return (
                  <div key={dateStr} className="flex-1 flex flex-col items-center justify-end" title={`${i + 1}일: ${count}개`}>
                    <div
                      className="w-full rounded-t-sm bg-accent-400 dark:bg-accent-500 transition-all duration-200"
                      style={{ height: `${height}%`, minWidth: 4 }}
                    />
                  </div>
                )
              })}
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[9px] text-gray-400">1일</span>
              <span className="text-[9px] text-gray-400">{daysInMonth}일</span>
            </div>
          </section>

          {/* 기분 추이 */}
          {moodStats.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">기분 추이</h3>
              <div className="flex flex-wrap gap-3">
                {moodStats.map((ms) => (
                  <div key={ms.mood} className="flex items-center gap-1.5 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-1.5">
                    <span className="text-lg">{ms.mood}</span>
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300">{ms.count}회</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 태그별 분포 */}
          {tagStats.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">태그 분포 (상위 10개)</h3>
              <div className="space-y-1.5">
                {tagStats.map((ts) => {
                  const maxTag = Math.max(1, tagStats[0]?.count ?? 1)
                  const width = Math.max(8, (ts.count / maxTag) * 100)
                  return (
                    <div key={ts.tag} className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 dark:text-gray-400 w-20 truncate text-right">#{ts.tag}</span>
                      <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-400 dark:bg-blue-500 rounded-full transition-all duration-300"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-400 w-6 text-right">{ts.count}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
