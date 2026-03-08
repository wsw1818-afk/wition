/**
 * 한국 공휴일 계산 (양력 고정 + 음력 변환 + 대체 공휴일)
 * 음력→양력 변환: 2020~2050 범위의 룩업 테이블 사용
 */

interface Holiday {
  date: string    // YYYY-MM-DD
  name: string
  isSubstitute?: boolean
}

// ── 양력 고정 공휴일 ──
const SOLAR_HOLIDAYS: Array<{ month: number; day: number; name: string }> = [
  { month: 1, day: 1, name: '신정' },
  { month: 3, day: 1, name: '삼일절' },
  { month: 5, day: 5, name: '어린이날' },
  { month: 6, day: 6, name: '현충일' },
  { month: 8, day: 15, name: '광복절' },
  { month: 10, day: 3, name: '개천절' },
  { month: 10, day: 9, name: '한글날' },
  { month: 12, day: 25, name: '크리스마스' },
]

// ── 음력 공휴일 (음력 날짜) ──
// 설날: 1/1 (전날, 당일, 다음날 = 12/30 or 12/29, 1/1, 1/2)
// 부처님오신날: 4/8
// 추석: 8/14, 8/15, 8/16

// ── 음력→양력 변환 테이블 (2020~2050) ──
// 각 연도별 주요 음력 날짜의 양력 변환값
// 형식: { 설날(1/1), 부처님오신날(4/8), 추석(8/15) }
const LUNAR_TABLE: Record<number, { seollal: string; buddha: string; chuseok: string }> = {
  2020: { seollal: '2020-01-25', buddha: '2020-04-30', chuseok: '2020-10-01' },
  2021: { seollal: '2021-02-12', buddha: '2021-05-19', chuseok: '2021-09-21' },
  2022: { seollal: '2022-02-01', buddha: '2022-05-08', chuseok: '2022-09-10' },
  2023: { seollal: '2023-01-22', buddha: '2023-05-27', chuseok: '2023-09-29' },
  2024: { seollal: '2024-02-10', buddha: '2024-05-15', chuseok: '2024-09-17' },
  2025: { seollal: '2025-01-29', buddha: '2025-05-05', chuseok: '2025-10-06' },
  2026: { seollal: '2026-02-17', buddha: '2026-05-24', chuseok: '2026-09-25' },
  2027: { seollal: '2027-02-07', buddha: '2027-05-13', chuseok: '2027-09-15' },
  2028: { seollal: '2028-01-27', buddha: '2028-05-02', chuseok: '2028-10-03' },
  2029: { seollal: '2029-02-13', buddha: '2029-05-20', chuseok: '2029-09-22' },
  2030: { seollal: '2030-02-03', buddha: '2030-05-09', chuseok: '2030-09-12' },
  2031: { seollal: '2031-01-23', buddha: '2031-05-28', chuseok: '2031-10-01' },
  2032: { seollal: '2032-02-11', buddha: '2032-05-16', chuseok: '2032-09-19' },
  2033: { seollal: '2033-01-31', buddha: '2033-05-06', chuseok: '2033-09-08' },
  2034: { seollal: '2034-02-19', buddha: '2034-05-25', chuseok: '2034-09-27' },
  2035: { seollal: '2035-02-08', buddha: '2035-05-15', chuseok: '2035-09-16' },
  2036: { seollal: '2036-01-28', buddha: '2036-05-03', chuseok: '2036-10-04' },
  2037: { seollal: '2037-02-15', buddha: '2037-05-22', chuseok: '2037-09-24' },
  2038: { seollal: '2038-02-04', buddha: '2038-05-11', chuseok: '2038-09-13' },
  2039: { seollal: '2039-01-24', buddha: '2039-04-30', chuseok: '2039-10-02' },
  2040: { seollal: '2040-02-12', buddha: '2040-05-18', chuseok: '2040-09-21' },
  2041: { seollal: '2041-02-01', buddha: '2041-05-07', chuseok: '2041-09-10' },
  2042: { seollal: '2042-01-22', buddha: '2042-05-26', chuseok: '2042-09-29' },
  2043: { seollal: '2043-02-10', buddha: '2043-05-16', chuseok: '2043-09-19' },
  2044: { seollal: '2044-01-30', buddha: '2044-05-04', chuseok: '2044-09-07' },
  2045: { seollal: '2045-02-17', buddha: '2045-05-24', chuseok: '2045-09-26' },
  2046: { seollal: '2046-02-06', buddha: '2046-05-13', chuseok: '2046-09-15' },
  2047: { seollal: '2047-01-26', buddha: '2047-05-02', chuseok: '2047-10-04' },
  2048: { seollal: '2048-02-14', buddha: '2048-05-20', chuseok: '2048-09-22' },
  2049: { seollal: '2049-02-02', buddha: '2049-05-09', chuseok: '2049-09-11' },
  2050: { seollal: '2050-01-23', buddha: '2050-05-28', chuseok: '2050-09-30' },
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function getDayOfWeek(dateStr: string): number {
  return new Date(dateStr).getDay() // 0=일, 6=토
}

/**
 * 대체 공휴일 적용
 * - 설날/추석 연휴가 일요일과 겹치면 다음 평일이 대체 공휴일
 * - 어린이날이 토/일/다른 공휴일과 겹치면 다음 평일이 대체 공휴일
 * - 2021년부터 삼일절, 광복절, 개천절, 한글날도 대체 공휴일 적용
 */
function applySubstituteHolidays(holidays: Holiday[], year: number): Holiday[] {
  const dateSet = new Set(holidays.map(h => h.date))
  const result = [...holidays]

  for (const h of holidays) {
    if (h.isSubstitute) continue
    const dow = getDayOfWeek(h.date)

    // 설날/추석 연휴: 일요일 겹치면 연휴 다음 날
    if (h.name === '설날' || h.name === '설날 연휴' || h.name === '추석' || h.name === '추석 연휴') {
      if (dow === 0) { // 일요일
        // 연휴 기간 중 하나가 일요일 → 연휴 마지막 날 다음 날부터 빈 날 찾기
        const baseDate = h.date
        let subDate = addDays(baseDate, 1)
        while (dateSet.has(subDate) || getDayOfWeek(subDate) === 0 || getDayOfWeek(subDate) === 6) {
          subDate = addDays(subDate, 1)
        }
        if (!dateSet.has(subDate)) {
          result.push({ date: subDate, name: `대체공휴일(${h.name.replace(' 연휴', '')})`, isSubstitute: true })
          dateSet.add(subDate)
        }
      }
    }

    // 어린이날: 토/일 겹치면
    if (h.name === '어린이날') {
      if (dow === 0 || dow === 6) {
        let subDate = addDays(h.date, dow === 6 ? 2 : 1)
        while (dateSet.has(subDate)) {
          subDate = addDays(subDate, 1)
        }
        result.push({ date: subDate, name: '대체공휴일(어린이날)', isSubstitute: true })
        dateSet.add(subDate)
      }
    }

    // 2021년부터: 삼일절, 광복절, 개천절, 한글날 일요일 겹침
    if (year >= 2021) {
      if (['삼일절', '광복절', '개천절', '한글날', '크리스마스'].includes(h.name)) {
        if (dow === 0) { // 일요일
          let subDate = addDays(h.date, 1)
          while (dateSet.has(subDate) || getDayOfWeek(subDate) === 0 || getDayOfWeek(subDate) === 6) {
            subDate = addDays(subDate, 1)
          }
          if (!dateSet.has(subDate)) {
            result.push({ date: subDate, name: `대체공휴일(${h.name})`, isSubstitute: true })
            dateSet.add(subDate)
          }
        }
      }
    }

    // 2022년부터 토요일도 대체 공휴일 (부처님오신날, 크리스마스 제외한 나머지)
    if (year >= 2022) {
      if (['삼일절', '광복절', '개천절', '한글날'].includes(h.name)) {
        if (dow === 6) { // 토요일
          let subDate = addDays(h.date, 2)
          while (dateSet.has(subDate) || getDayOfWeek(subDate) === 0 || getDayOfWeek(subDate) === 6) {
            subDate = addDays(subDate, 1)
          }
          if (!dateSet.has(subDate)) {
            result.push({ date: subDate, name: `대체공휴일(${h.name})`, isSubstitute: true })
            dateSet.add(subDate)
          }
        }
      }
    }
  }

  return result
}

/** 특정 연도의 모든 한국 공휴일 반환 */
export function getHolidaysForYear(year: number): Holiday[] {
  const holidays: Holiday[] = []

  // 양력 고정 공휴일
  for (const sh of SOLAR_HOLIDAYS) {
    const date = `${year}-${String(sh.month).padStart(2, '0')}-${String(sh.day).padStart(2, '0')}`
    holidays.push({ date, name: sh.name })
  }

  // 음력 공휴일
  const lunar = LUNAR_TABLE[year]
  if (lunar) {
    // 설날 연휴 (전날, 당일, 다음날)
    holidays.push({ date: addDays(lunar.seollal, -1), name: '설날 연휴' })
    holidays.push({ date: lunar.seollal, name: '설날' })
    holidays.push({ date: addDays(lunar.seollal, 1), name: '설날 연휴' })

    // 부처님오신날
    holidays.push({ date: lunar.buddha, name: '부처님오신날' })

    // 추석 연휴 (전날, 당일, 다음날)
    holidays.push({ date: addDays(lunar.chuseok, -1), name: '추석 연휴' })
    holidays.push({ date: lunar.chuseok, name: '추석' })
    holidays.push({ date: addDays(lunar.chuseok, 1), name: '추석 연휴' })
  }

  // 대체 공휴일 적용
  return applySubstituteHolidays(holidays, year)
}

/** 특정 월의 공휴일 맵 반환 { 'YYYY-MM-DD': '공휴일 이름' } */
export function getHolidayMap(yearMonth: string): Record<string, string> {
  const year = parseInt(yearMonth.slice(0, 4))
  const month = yearMonth.slice(5, 7)
  const allHolidays = getHolidaysForYear(year)

  // 이전/다음 달도 포함 (달력에 이전/다음 달 날짜가 보이므로)
  const prevYear = month === '01' ? year - 1 : year
  const nextYear = month === '12' ? year + 1 : year
  let holidays = allHolidays

  if (prevYear !== year) {
    holidays = [...getHolidaysForYear(prevYear), ...holidays]
  }
  if (nextYear !== year) {
    holidays = [...holidays, ...getHolidaysForYear(nextYear)]
  }

  const map: Record<string, string> = {}
  for (const h of holidays) {
    if (map[h.date]) {
      map[h.date] += `, ${h.name}`
    } else {
      map[h.date] = h.name
    }
  }
  return map
}
