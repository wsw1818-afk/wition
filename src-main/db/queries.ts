import type Database from 'better-sqlite3'

/* ────────────────────────────── 타입 ────────────────────────────── */
export interface NoteDayRow {
  id: string
  mood: string | null
  summary: string | null
  note_count: number
  has_notes: number
  updated_at: number
}

export interface NoteItemRow {
  id: string
  day_id: string
  type: string
  content: string
  tags: string
  pinned: number
  order_index: number
  created_at: number
  updated_at: number
}

/* ────────────────────────────── READ ────────────────────────────── */

/** 월 단위 NoteDay 조회 (달력 dot 표시용) — 실제 note_item 기준으로 count 보정 */
export function getNoteDaysByMonth(db: Database.Database, yearMonth: string): NoteDayRow[] {
  const pattern = `${yearMonth}-%`
  // note_day와 note_item 양쪽 모두에서 해당 월의 날짜를 수집
  // note_day가 없지만 note_item이 있는 날도 포함 (동기화 후 캐시 불일치 방지)
  return db
    .prepare(`
      SELECT
        all_days.id,
        d.mood,
        d.summary,
        COALESCE(c.cnt, 0) as note_count,
        CASE WHEN COALESCE(c.cnt, 0) > 0 THEN 1 ELSE 0 END as has_notes,
        COALESCE(d.updated_at, 0) as updated_at
      FROM (
        SELECT id FROM note_day WHERE id LIKE @p
        UNION
        SELECT DISTINCT day_id as id FROM note_item WHERE day_id LIKE @p
      ) all_days
      LEFT JOIN note_day d ON d.id = all_days.id
      LEFT JOIN (
        SELECT day_id, COUNT(*) as cnt FROM note_item GROUP BY day_id
      ) c ON c.day_id = all_days.id
      ORDER BY all_days.id
    `)
    .all({ p: pattern }) as NoteDayRow[]
}

/** 단일 NoteDay 조회 */
export function getNoteDay(db: Database.Database, date: string): NoteDayRow | undefined {
  return db
    .prepare('SELECT * FROM note_day WHERE id = ?')
    .get(date) as NoteDayRow | undefined
}

/** 해당 날짜의 NoteItem 목록 (pinned 우선, order_index 순) */
export function getNoteItems(db: Database.Database, dayId: string): NoteItemRow[] {
  return db
    .prepare('SELECT * FROM note_item WHERE day_id = ? ORDER BY pinned DESC, order_index ASC')
    .all(dayId) as NoteItemRow[]
}

/** 전체 검색 (content, tags 대상, 최대 100건) */
export function searchItems(db: Database.Database, query: string): NoteItemRow[] {
  const like = `%${query}%`
  return db
    .prepare(`
      SELECT * FROM note_item
      WHERE content LIKE @q OR tags LIKE @q
      ORDER BY updated_at DESC
      LIMIT 100
    `)
    .all({ q: like }) as NoteItemRow[]
}

/* ────────────────────────────── WRITE ───────────────────────────── */

/** NoteItem 추가 또는 수정 + NoteDay 캐시 자동 갱신 (트랜잭션) */
export function upsertNoteItem(db: Database.Database, item: NoteItemRow): NoteDayRow | undefined {
  const now = Date.now()
  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
      VALUES (@id, @day_id, @type, @content, @tags, @pinned, @order_index, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        type=@type, content=@content, tags=@tags,
        pinned=@pinned, order_index=@order_index, updated_at=@updated_at
    `).run({ ...item, updated_at: now })

    refreshDayCache(db, item.day_id, now)
    return getNoteDay(db, item.day_id)
  })
  return run()
}

/** NoteItem 삭제 + NoteDay 캐시 자동 갱신 + tombstone 기록 (트랜잭션) */
export function deleteNoteItem(db: Database.Database, id: string, dayId: string): NoteDayRow | undefined {
  const now = Date.now()
  const run = db.transaction(() => {
    db.prepare('DELETE FROM note_item WHERE id = ?').run(id)
    addTombstone(db, 'note_item', id)
    refreshDayCache(db, dayId, now)
    return getNoteDay(db, dayId)
  })
  return run()
}

/** 특정 날짜의 모든 NoteItem 일괄 삭제 + tombstone 기록 (트랜잭션) */
export function deleteAllItemsByDay(db: Database.Database, dayId: string): number {
  const now = Date.now()
  const run = db.transaction(() => {
    const items = db.prepare('SELECT id FROM note_item WHERE day_id = ?').all(dayId) as { id: string }[]
    for (const item of items) {
      addTombstone(db, 'note_item', item.id)
    }
    const result = db.prepare('DELETE FROM note_item WHERE day_id = ?').run(dayId)
    refreshDayCache(db, dayId, now)
    return result.changes
  })
  return run()
}

/** NoteItem 순서 변경 + updated_at 갱신 (트랜잭션) */
export function reorderNoteItems(db: Database.Database, dayId: string, orderedIds: string[]): void {
  const now = Date.now()
  const run = db.transaction(() => {
    const stmt = db.prepare(
      'UPDATE note_item SET order_index = @idx, updated_at = @now WHERE id = @id AND day_id = @dayId'
    )
    orderedIds.forEach((id, idx) => stmt.run({ idx, now, id, dayId }))
    refreshDayCache(db, dayId, now)
  })
  run()
}

/** 감정 이모지 설정 */
export function updateMood(db: Database.Database, dayId: string, mood: string | null): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO note_day (id, mood, note_count, has_notes, updated_at)
    VALUES (@id, @mood, 0, 0, @now)
    ON CONFLICT(id) DO UPDATE SET mood = @mood, updated_at = @now
  `).run({ id: dayId, mood, now })
}

/* ────────────────────────── 알람 CRUD ──────────────────────────── */

export type RepeatType = 'none' | 'daily' | 'weekdays' | 'weekly'

export interface AlarmRow {
  id: string
  day_id: string
  time: string        // "HH:mm"
  label: string
  repeat: RepeatType  // 반복 유형
  enabled: number     // 0 | 1
  fired: number       // 0 | 1
  created_at: number
  updated_at: number
}

export function getAlarmsByDay(db: Database.Database, dayId: string): AlarmRow[] {
  return db
    .prepare('SELECT * FROM alarm WHERE day_id = ? ORDER BY time ASC')
    .all(dayId) as AlarmRow[]
}

export function getPendingAlarms(db: Database.Database): AlarmRow[] {
  return db
    .prepare('SELECT * FROM alarm WHERE enabled = 1 AND fired = 0 ORDER BY day_id, time')
    .all() as AlarmRow[]
}

export function upsertAlarm(db: Database.Database, alarm: AlarmRow): void {
  db.prepare(`
    INSERT INTO alarm (id, day_id, time, label, repeat, enabled, fired, created_at, updated_at)
    VALUES (@id, @day_id, @time, @label, @repeat, @enabled, @fired, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      day_id=@day_id, time=@time, label=@label, repeat=@repeat,
      enabled=@enabled, fired=@fired, updated_at=@updated_at
  `).run(alarm)
}

export function deleteAlarm(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM alarm WHERE id = ?').run(id)
  addTombstone(db, 'alarm', id)
}

export function markAlarmFired(db: Database.Database, id: string): void {
  db.prepare('UPDATE alarm SET fired = 1, updated_at = ? WHERE id = ?').run(Date.now(), id)
}

/** 월간 알람이 있는 날짜 목록 (달력 아이콘 표시용) */
export function getAlarmDaysByMonth(db: Database.Database, yearMonth: string): string[] {
  const pattern = `${yearMonth}-%`
  const rows = db
    .prepare('SELECT DISTINCT day_id FROM alarm WHERE day_id LIKE ? AND enabled = 1')
    .all(pattern) as Array<{ day_id: string }>
  return rows.map(r => r.day_id)
}

/** 다가오는 알람 (일회성은 오늘 이후, 반복은 시작일 이전도 포함, 최대 20건) */
export function getUpcomingAlarms(db: Database.Database, todayStr: string): AlarmRow[] {
  return db
    .prepare(`
      SELECT * FROM alarm
      WHERE enabled = 1 AND (fired = 0 OR repeat != 'none')
        AND (day_id >= ? OR repeat != 'none')
      ORDER BY
        CASE WHEN repeat != 'none' THEN 0 ELSE 1 END,
        day_id ASC, time ASC
      LIMIT 20
    `)
    .all(todayStr) as AlarmRow[]
}

/** 반복 알람 목록 (repeat != 'none') */
export function getRepeatingAlarms(db: Database.Database): AlarmRow[] {
  return db
    .prepare("SELECT * FROM alarm WHERE repeat != 'none' AND enabled = 1 ORDER BY time ASC")
    .all() as AlarmRow[]
}

/** 반복 알람 fired 리셋 (매일 자정 호출용) */
export function resetRepeatingAlarmsFired(db: Database.Database): void {
  db.prepare("UPDATE alarm SET fired = 0, updated_at = ? WHERE repeat != 'none' AND fired = 1")
    .run(Date.now())
}

/* ────────────────────────── 통계 쿼리 ──────────────────────────── */

/** 월별 일간 메모 수 */
export function getMonthlyStats(db: Database.Database, yearMonth: string): Array<{ day: string; count: number }> {
  const pattern = `${yearMonth}-%`
  return db
    .prepare(`
      SELECT day_id as day, COUNT(*) as count
      FROM note_item
      WHERE day_id LIKE ?
      GROUP BY day_id
      ORDER BY day_id
    `)
    .all(pattern) as Array<{ day: string; count: number }>
}

/** 월별 기분 이모지 카운트 */
export function getMoodStats(db: Database.Database, yearMonth: string): Array<{ mood: string; count: number }> {
  const pattern = `${yearMonth}-%`
  return db
    .prepare(`
      SELECT mood, COUNT(*) as count
      FROM note_day
      WHERE id LIKE ? AND mood IS NOT NULL AND mood != ''
      GROUP BY mood
      ORDER BY count DESC
    `)
    .all(pattern) as Array<{ mood: string; count: number }>
}

/** 전체 태그별 카운트 (상위 10) */
export function getTagStats(db: Database.Database): Array<{ tag: string; count: number }> {
  // tags 컬럼은 JSON 배열 문자열. SQLite의 json_each로 파싱
  try {
    return db
      .prepare(`
        SELECT j.value as tag, COUNT(*) as count
        FROM note_item, json_each(note_item.tags) j
        WHERE j.value != ''
        GROUP BY j.value
        ORDER BY count DESC
        LIMIT 10
      `)
      .all() as Array<{ tag: string; count: number }>
  } catch {
    // json_each가 지원 안 되는 SQLite 버전 fallback
    return []
  }
}

/* ────────────────────────── 반복 메모 CRUD ──────────────────────── */

export interface RecurringBlockRow {
  id: string
  type: string
  content: string
  repeat: string        // 'daily' | 'weekdays' | 'weekly'
  day_of_week: number   // 0-6
  created_at: number
}

export function getRecurringBlocks(db: Database.Database): RecurringBlockRow[] {
  return db
    .prepare('SELECT * FROM recurring_blocks ORDER BY created_at ASC')
    .all() as RecurringBlockRow[]
}

export function upsertRecurringBlock(db: Database.Database, block: RecurringBlockRow): void {
  db.prepare(`
    INSERT INTO recurring_blocks (id, type, content, repeat, day_of_week, created_at)
    VALUES (@id, @type, @content, @repeat, @day_of_week, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      type=@type, content=@content, repeat=@repeat, day_of_week=@day_of_week
  `).run(block)
}

export function deleteRecurringBlock(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM recurring_blocks WHERE id = ?').run(id)
}

/** 반복 메모 자동 생성: 오늘 날짜에 맞는 반복 블록을 note_item으로 생성 */
export function checkRecurringBlocks(db: Database.Database, todayStr: string): number {
  // 이미 오늘 체크했는지 확인
  const lastCheck = db.prepare("SELECT value FROM app_meta WHERE key = 'last_recurring_check'").get() as { value: string } | undefined
  if (lastCheck?.value === todayStr) return 0

  const now = Date.now()
  const todayDate = new Date(todayStr + 'T00:00:00')
  const todayDow = todayDate.getDay() // 0=일, 6=토

  const blocks = getRecurringBlocks(db)
  let created = 0

  const uuidFn = () => {
    // 간단한 UUID v4 생성
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
  }

  db.transaction(() => {
    for (const block of blocks) {
      let shouldCreate = false

      switch (block.repeat) {
        case 'daily':
          shouldCreate = true
          break
        case 'weekdays':
          shouldCreate = todayDow >= 1 && todayDow <= 5
          break
        case 'weekly':
          shouldCreate = todayDow === block.day_of_week
          break
      }

      if (shouldCreate) {
        const itemId = uuidFn()
        // 현재 아이템 수 조회해서 order_index 결정
        const stat = db.prepare('SELECT COUNT(*) as cnt FROM note_item WHERE day_id = ?').get(todayStr) as { cnt: number }
        db.prepare(`
          INSERT INTO note_item (id, day_id, type, content, tags, pinned, order_index, created_at, updated_at)
          VALUES (@id, @day_id, @type, @content, '[]', 0, @order_index, @now, @now)
        `).run({
          id: itemId,
          day_id: todayStr,
          type: block.type,
          content: block.content,
          order_index: stat.cnt,
          now,
        })
        created++
      }
    }

    // 체크 완료 기록
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('last_recurring_check', ?)").run(todayStr)

    // 생성된 블록이 있으면 day 캐시 갱신
    if (created > 0) {
      refreshDayCache_external(db, todayStr, now)
    }
  })()

  return created
}

/* ────────────────────── 전체 NoteItem 조회 (내보내기용) ──────────── */

/** 전체 NoteItem 조회 (day_id 기준 정렬) */
export function getAllNoteItems(db: Database.Database): NoteItemRow[] {
  return db
    .prepare('SELECT * FROM note_item ORDER BY day_id ASC, order_index ASC')
    .all() as NoteItemRow[]
}

/* ────────────────── 토글 블록 접기/펼치기 상태 저장 ────────────── */

/** 토글 블록 상태 조회 (app_meta의 toggle_states) */
export function getToggleStates(db: Database.Database): Record<string, boolean> {
  try {
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'toggle_states'").get() as { value: string } | undefined
    return row?.value ? JSON.parse(row.value) : {}
  } catch { return {} }
}

/** 개별 토글 블록 상태 저장 */
export function setToggleState(db: Database.Database, blockId: string, open: boolean): void {
  const states = getToggleStates(db)
  if (open) {
    states[blockId] = true
  } else {
    delete states[blockId]  // 닫힌 상태는 기본값이므로 제거하여 저장 공간 절약
  }
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('toggle_states', ?)").run(JSON.stringify(states))
}

/* ────────────────────────── 내부 헬퍼 ──────────────────────────── */

/** NoteDay의 캐시 컬럼(note_count, has_notes, summary)을 재계산 (외부 호출용) */
export function refreshDayCache_external(db: Database.Database, dayId: string, now: number): void {
  refreshDayCache(db, dayId, now)
}

/** NoteDay의 캐시 컬럼(note_count, has_notes, summary)을 재계산 */
function refreshDayCache(db: Database.Database, dayId: string, now: number): void {
  // 모든 아이템 조회 (최대 10개) — 각 메모의 첫 줄을 summary에 포함
  const allItems = db.prepare(`
    SELECT content, type FROM note_item
    WHERE day_id = @dayId ORDER BY order_index ASC LIMIT 10
  `).all({ dayId }) as Array<{ content: string; type: string }>

  const count = db.prepare('SELECT COUNT(*) AS cnt FROM note_item WHERE day_id = @dayId').get({ dayId }) as { cnt: number }
  let summary: string | null = null

  if (allItems.length > 0) {
    const lines: string[] = []
    for (const item of allItems) {
      const line = extractOneLine(item.content, item.type)
      if (line) lines.push(line)
    }
    summary = lines.join('\n').slice(0, 300) || null
  }

  db.prepare(`
    INSERT INTO note_day (id, note_count, has_notes, summary, updated_at)
    VALUES (@id, @count, @hasNotes, @summary, @now)
    ON CONFLICT(id) DO UPDATE SET
      note_count = @count, has_notes = @hasNotes, summary = @summary, updated_at = @now
  `).run({ id: dayId, count: count.cnt, hasNotes: count.cnt > 0 ? 1 : 0, summary, now })
}

/** 아이템 content에서 한 줄 요약 텍스트 추출 */
function extractOneLine(content: string, type: string): string | null {
  if (!content) return null
  if (type === 'checklist') {
    try {
      const items = JSON.parse(content) as Array<{ text: string; done?: boolean }>
      const first = items[0]
      return first ? `☐ ${first.text}`.slice(0, 50) : null
    } catch { return null }
  }
  if (type === 'image') {
    try {
      const imgData = JSON.parse(content) as { caption?: string }
      return imgData.caption ? `🖼 ${imgData.caption}`.slice(0, 50) : '🖼 이미지'
    } catch { return '🖼 이미지' }
  }
  if (type === 'divider') return '───'
  return content
    .replace(/\[file:.+?\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .split('\n')[0]
    .trim()
    .slice(0, 50) || null
}

/** 모든 날짜의 summary 캐시를 재계산 (앱 시작 시 1회, updated_at 유지) */
export function refreshAllSummaries(db: Database.Database): void {
  const days = db.prepare('SELECT id, updated_at FROM note_day WHERE has_notes = 1').all() as Array<{ id: string; updated_at: number }>
  for (const day of days) {
    // updated_at을 기존 값으로 유지하여 push 트리거 방지
    refreshDayCache(db, day.id, day.updated_at)
  }
}

/* ────────────────────── 삭제 Tombstone ──────────────────────── */

export interface DeletedItem {
  table_name: string
  item_id: string
  deleted_at: number
}

/** 삭제 tombstone 기록 */
export function addTombstone(db: Database.Database, tableName: string, itemId: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO deleted_items (table_name, item_id, deleted_at)
    VALUES (?, ?, ?)
  `).run(tableName, itemId, Date.now())
}

/** 미처리 tombstone 조회 */
export function getTombstones(db: Database.Database): DeletedItem[] {
  return db.prepare('SELECT * FROM deleted_items').all() as DeletedItem[]
}

/** tombstone 존재 여부 확인 */
export function isTombstoned(db: Database.Database, tableName: string, itemId: string): boolean {
  const row = db.prepare('SELECT 1 FROM deleted_items WHERE table_name = ? AND item_id = ?').get(tableName, itemId)
  return !!row
}

/* ────────────────────────── 템플릿 CRUD ──────────────────────────── */

export interface TemplateRow {
  id: string
  name: string
  blocks: string  // JSON 배열 문자열
  created_at: number
}

/** 전체 템플릿 목록 */
export function getTemplates(db: Database.Database): TemplateRow[] {
  return db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all() as TemplateRow[]
}

/** 단일 템플릿 조회 */
export function getTemplateById(db: Database.Database, id: string): TemplateRow | undefined {
  return db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined
}

/** 템플릿 추가/수정 */
export function upsertTemplate(db: Database.Database, tpl: TemplateRow): void {
  db.prepare(`
    INSERT INTO templates (id, name, blocks, created_at)
    VALUES (@id, @name, @blocks, @created_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, blocks=@blocks
  `).run(tpl)
}

/** 템플릿 삭제 */
export function deleteTemplate(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM templates WHERE id = ?').run(id)
}

/* ────────────────────── 태그 필터 달력 조회 ──────────────────────── */

/** 특정 태그를 포함하는 날짜 목록 (달력 필터용) */
export function getNoteDaysByMonthWithTag(db: Database.Database, yearMonth: string, tag: string): NoteDayRow[] {
  const pattern = `${yearMonth}-%`
  try {
    return db
      .prepare(`
        SELECT DISTINCT d.*
        FROM note_day d
        INNER JOIN note_item i ON i.day_id = d.id
        INNER JOIN json_each(i.tags) j ON j.value = @tag
        WHERE d.id LIKE @p
        ORDER BY d.id
      `)
      .all({ p: pattern, tag }) as NoteDayRow[]
  } catch {
    // json_each 미지원 fallback: LIKE 검색
    const tagLike = `%"${tag}"%`
    return db
      .prepare(`
        SELECT DISTINCT d.*
        FROM note_day d
        INNER JOIN note_item i ON i.day_id = d.id
        WHERE d.id LIKE @p AND i.tags LIKE @tagLike
        ORDER BY d.id
      `)
      .all({ p: pattern, tagLike }) as NoteDayRow[]
  }
}

/** 동기화 완료된 tombstone 삭제 */
export function clearTombstones(db: Database.Database, tableName: string, itemIds: string[]): void {
  if (itemIds.length === 0) return
  const placeholders = itemIds.map(() => '?').join(',')
  db.prepare(`DELETE FROM deleted_items WHERE table_name = ? AND item_id IN (${placeholders})`).run(tableName, ...itemIds)
}
